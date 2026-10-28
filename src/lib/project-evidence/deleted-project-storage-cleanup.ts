import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

// PD-26 — removes the Storage objects of DELETED projects.
//
// Deleting a project enqueues one storage_cleanup_jobs row in the same transaction
// (20261101000000_pd26_deleted_project_storage_cleanup.sql). Storage is not transactional, so
// removal is this explicit job: list the deleted project's objects through
// list_deleted_project_storage_objects() — which returns nothing while the project exists —
// remove them, and mark the job completed. A failure records the error and leaves the job
// pending; the next drain (the next project delete, or `npm run storage:cleanup-deleted-projects`)
// retries it. Removing an object that is already gone is a no-op, so retries are idempotent.

const BUCKET = "pmfreak-documents";
const BATCH = 100;
const MAX_BATCHES_PER_JOB = 50;

type CleanupJob = { id: string; project_id: string; workspace_id: string; attempts: number; removed_objects: number };

export type StorageCleanupSummary = { jobs: number; completed: number; pending: number; removedObjects: number };

// `<uploader uuid>/<project uuid>/<file>`, and the project segment must be the job's project.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const isDeletedProjectObjectPath = (path: string, projectId: string): boolean =>
  new RegExp(`^${UUID}$`, "i").test(projectId) && new RegExp(`^${UUID}/${projectId}/[^/]+$`, "i").test(path);

export async function drainDeletedProjectStorage(options: { projectId?: string; maxJobs?: number } = {}): Promise<StorageCleanupSummary> {
  // PRIVILEGED_ACCESS: the bucket and storage_cleanup_jobs are service-role only, and the project
  // being cleaned up no longer exists, so there is no project-scoped session to act through.
  // AUDIT_REF: service-role-risk-register.md
  const admin = createSupabaseServiceRoleClient({
    routeId: "lib.project-evidence.deleted-project-storage-cleanup",
    operation: "storage.remove_deleted_project_objects",
    reason: "deleted_project_storage_cleanup",
    systemActor: "system",
  });

  let query = admin
    .from("storage_cleanup_jobs")
    .select("id, project_id, workspace_id, attempts, removed_objects")
    .eq("bucket_id", BUCKET)
    .is("completed_at", null)
    .order("enqueued_at", { ascending: true })
    .limit(Math.max(1, Math.min(options.maxJobs ?? 20, 200)));
  if (options.projectId) query = query.eq("project_id", options.projectId);
  const { data: jobs, error: jobsError } = await query;
  if (jobsError) throw new Error(`Unable to read storage cleanup jobs: ${jobsError.message}`);

  const summary: StorageCleanupSummary = { jobs: jobs?.length ?? 0, completed: 0, pending: 0, removedObjects: 0 };
  for (const job of (jobs ?? []) as CleanupJob[]) {
    let removed = 0;
    let failure: string | null = null;
    let drained = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_JOB; batch += 1) {
      const { data: names, error: listError } = await admin.rpc("list_deleted_project_storage_objects", { p_project_id: job.project_id, p_limit: BATCH });
      if (listError) { failure = `list: ${listError.message}`; break; }
      const paths = ((names ?? []) as string[]).filter((path) => isDeletedProjectObjectPath(path, job.project_id));
      if (paths.length === 0) { drained = true; break; }
      const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
      if (removeError) { failure = `remove: ${removeError.message}`; break; }
      removed += paths.length;
    }
    if (!drained && !failure) failure = "batch limit reached; more objects remain";

    const now = new Date().toISOString();
    const { error: updateError } = await admin
      .from("storage_cleanup_jobs")
      .update({
        attempts: job.attempts + 1,
        last_attempt_at: now,
        last_error: failure,
        removed_objects: job.removed_objects + removed,
        completed_at: drained ? now : null,
      })
      .eq("id", job.id);
    if (updateError) failure = failure ?? `record: ${updateError.message}`;

    summary.removedObjects += removed;
    if (drained && !updateError) summary.completed += 1;
    else {
      summary.pending += 1;
      console.warn("[storage_cleanup] deleted_project_cleanup_pending", { jobId: job.id, projectId: job.project_id, attempts: job.attempts + 1, error: failure });
    }
  }
  return summary;
}
