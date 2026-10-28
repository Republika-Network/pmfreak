import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  PROJECT_ARCHIVED_CODE,
  PROJECT_MUTATING_PERMISSIONS,
  isArchivedProjectStatus,
  isProjectArchivedDenial,
  projectArchivedResponse,
} from "../src/lib/projects/archived-project";
import { isArchivedProjectLifecycleOperation, runArchivedProjectLifecycleOperation } from "../src/lib/projects/archived-project-lifecycle";
import { isDeletedProjectObjectPath } from "../src/lib/project-evidence/deleted-project-storage-cleanup";

// PD-25 / PD-26 (five-persona QA, Wave 3). An archived project accepted uploads, vault intake,
// Brain turns and operational captures (LC-01); a hard project delete cascaded the evidence rows
// but left the bucket objects and orphaned the project's vault documents (LC-02). The behaviour
// is proven against real sessions in tests/security-regression/pd25-pd26-project-lifecycle.test.mjs
// and the QA browser harness; these pin the decisions and the pure logic.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PD25_MIGRATION = "supabase/migrations/20261031000000_pd25_archived_project_operational_writes.sql";
const PD26_MIGRATION = "supabase/migrations/20261101000000_pd26_deleted_project_storage_cleanup.sql";

test("PD-25: only `archived` is read-only; `completed` and `active` are not", () => {
  assert.equal(isArchivedProjectStatus("archived"), true);
  for (const status of ["active", "completed", "", null, undefined, "ARCHIVED"]) assert.equal(isArchivedProjectStatus(status), false, String(status));
});

test("PD-25: every archived-write refusal is one 409 with a stable code", async () => {
  const response = projectArchivedResponse();
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, PROJECT_ARCHIVED_CODE);
  assert.equal(body.ok, false);
  assert.equal(isProjectArchivedDenial(PROJECT_ARCHIVED_CODE), true);
  assert.equal(isProjectArchivedDenial(`denied:${PROJECT_ARCHIVED_CODE}`), true);
  for (const reason of ["role_missing_permission", "project_not_found", "", null]) assert.equal(isProjectArchivedDenial(reason), false, String(reason));
});

test("PD-25: the mutating permission set is exactly the project-scoped write permissions the governance policies require", () => {
  const core = read("src/lib/governance/authority/runtime/governance-core.ts");
  const projectScopedRequired = new Set<string>();
  for (const [, action, permission] of core.matchAll(/"([a-z_.]+)": \{ requiredPermission: "([a-z_]+)"[^\n]*projectScoped: true/g)) {
    if (permission !== "read") projectScopedRequired.add(permission);
    assert.ok(action);
  }
  assert.deepEqual([...projectScopedRequired].sort(), ["upload_documents", "write", "write_memory"]);
  for (const permission of projectScopedRequired) assert.ok(PROJECT_MUTATING_PERMISSIONS.has(permission), permission);
  assert.ok(PROJECT_MUTATING_PERMISSIONS.has("delete"));
  assert.equal(PROJECT_MUTATING_PERMISSIONS.has("read"), false);
});

test("PD-25: the lifecycle scope is explicit, bounded to its callback and never leaks", async () => {
  assert.equal(isArchivedProjectLifecycleOperation(), false);
  let seenInside: boolean | null = null;
  let seenInNestedAwait: boolean | null = null;
  const result = await runArchivedProjectLifecycleOperation(async () => {
    seenInside = isArchivedProjectLifecycleOperation();
    await new Promise((resolve) => setTimeout(resolve, 1));
    seenInNestedAwait = isArchivedProjectLifecycleOperation();
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(seenInside, true);
  assert.equal(seenInNestedAwait, true);
  assert.equal(isArchivedProjectLifecycleOperation(), false);
  // A concurrent, unscoped continuation does not inherit the scope.
  const sibling = new Promise<boolean>((resolve) => setTimeout(() => resolve(isArchivedProjectLifecycleOperation()), 2));
  await runArchivedProjectLifecycleOperation(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(await sibling, false);
});

test("PD-25: the project-permission adapter refuses mutating permissions on an archived project after the role check, except inside the lifecycle scope", () => {
  const adapter = read("src/lib/aoc/adapters/access-verification.ts");
  const roleCheck = adapter.indexOf("requireDirectPermission(role, permission, {");
  const archivedCheck = adapter.indexOf("PROJECT_MUTATING_PERMISSIONS.has(permission) && isArchivedProjectStatus(project.status) && !isArchivedProjectLifecycleOperation()");
  assert.ok(roleCheck > 0 && archivedCheck > roleCheck, "the archived rule must run after the role check so only authorized writers see it");
  assert.match(adapter, /reason: PROJECT_ARCHIVED_CODE/);
  assert.match(adapter, /\.select\("workspace_id, status"\)/);
});

test("PD-25: requireProjectAccessAllowingArchived lifts only the archived rule and catches nothing", () => {
  const source = read("src/lib/security/server-authorization.ts");
  const fn = source.slice(source.indexOf("export async function requireProjectAccessAllowingArchived"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /runArchivedProjectLifecycleOperation\(\(\) => requireProjectAccess\(projectId, permission\)\)/);
  assert.doesNotMatch(body, /catch/);
  assert.doesNotMatch(body, /allowed:\s*true/);
});

test("PD-25: the archived refusal reaches every write surface, and reactivation / deletion / duplication stay possible", () => {
  const route = read("src/app/api/projects/[id]/route.ts");
  assert.match(route, /const reactivating = requestedStatus !== null && !isArchivedProjectStatus\(requestedStatus\)/);
  assert.match(route, /authorizeWrite\(id, \{ allowArchived: reactivating \}\)/);
  assert.match(route, /authorizeWrite\(id, \{ allowArchived: true \}\)/, "permanent deletion is the step after archival");
  assert.match(read("src/app/api/projects/[id]/duplicate/route.ts"), /requireProjectAccessAllowingArchived\(projectId, "write"\)/);

  assert.match(read("src/lib/aoc/enterprise/runtime.ts"), /isProjectArchivedDenial\(decision\.reason\)\) return \{ decision, response: projectArchivedResponse\(\) \}/);
  assert.match(read("src/lib/security/deny-response.ts"), /isProjectArchivedDenial\(error\.metadata\.reason\)\) return projectArchivedResponse\(\)/);

  const upload = read("src/app/api/upload/route.ts");
  assert.match(upload, /governance\.response\.status === 409/);
  assert.match(upload, /"PROJECT_ARCHIVED"/);
  assert.ok(upload.indexOf("governance.response.status === 409") < upload.indexOf("reserveUploadQuota("), "refused before any quota is reserved");

  const brain = read("src/app/api/projects/[id]/brain/turns/route.ts");
  assert.ok(brain.indexOf("isArchivedProjectStatus(projectState?.status)) return projectArchivedResponse()") < brain.indexOf("runProjectBrainRequest("), "no turn is recorded on an archived project");
  assert.match(read("src/app/api/vault/intake/route.ts"), /isArchivedProjectStatus\(project\.status\)\) return projectArchivedResponse\(\)/);
  assert.match(read("src/app/api/operational-flow/route.ts"), /permission === "write" && isArchivedProjectStatus\(project\.status\)/);
  assert.match(read("src/app/api/analyze-ai/route.ts"), /isArchivedProjectStatus\(project\.status\)\) return projectArchivedResponse\(\)/);
  assert.match(read("src/app/(protected)/command-center/ingestion-actions.ts"), /isArchivedProjectStatus\(row\.status\)/);
  assert.match(read("src/app/api/execution-tasks/internal-execution/route.ts"), /permission === "write" && isArchivedProjectStatus\(project\.status\)[\s\S]*reason: "archived"/);
  assert.match(read("src/app/api/copilot/route.ts"), /await isArchivedProject\(ingestionProjectId\)\)\s*\? \{ status: "skipped", reason: "project_archived"/);
  assert.match(read("src/lib/project-discovery/discovery-repository.ts"), /reason: "project_archived"/);
});

test("PD-25: the database gate refuses operational writes on an archived project, same grants as before", () => {
  const migration = read(PD25_MIGRATION);
  assert.match(migration, /create or replace function public\.can_write_operational_project\(p_workspace_id uuid, p_project_id uuid\)/);
  assert.match(migration, /p\.status <> 'archived'/);
  assert.match(migration, /public\.can_access_operational_project\(p_workspace_id, p_project_id\)/);
  assert.match(migration, /revoke execute on function public\.can_write_operational_project\(uuid,uuid\) from public, anon;/);
  assert.match(migration, /grant execute on function public\.can_write_operational_project\(uuid,uuid\) to authenticated, service_role;/);
  assert.doesNotMatch(migration, /can_access_operational_project\([^)]*\)\s*\n\s*returns/, "reads are unchanged");
});

test("PD-26: deleted-project object paths are validated as <uploader uuid>/<this project uuid>/<file>", () => {
  const uploader = "11111111-2222-4333-8444-555555555555";
  const project = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const other = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${project}/notes.txt`, project), true);
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${project}/1730000000-report.pdf`, project), true);
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${other}/notes.txt`, project), false, "another project's folder");
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${project}/nested/notes.txt`, project), false, "no nested segments");
  assert.equal(isDeletedProjectObjectPath(`${project}/notes.txt`, project), false, "no uploader segment");
  assert.equal(isDeletedProjectObjectPath(`not-a-uuid/${project}/notes.txt`, project), false);
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${project}/notes.txt`, "not-a-uuid"), false, "the project id itself must be a uuid");
  assert.equal(isDeletedProjectObjectPath(`${uploader}/${project}/`, project), false);
});

test("PD-26: the delete trigger removes the project's own vault content and enqueues exactly one cleanup job, in the deleting transaction", () => {
  const migration = read(PD26_MIGRATION);
  assert.match(migration, /create trigger projects_enqueue_deleted_project_cleanup\s+before delete on public\.projects\s+for each row execute function public\.enqueue_deleted_project_cleanup\(\)/);
  for (const table of ["vault_operational_signals", "vault_documents", "vault_digestion_runs"]) {
    assert.match(migration, new RegExp(`delete from public\\.${table} where project_id = old\\.id;`), table);
  }
  assert.match(migration, /insert into public\.storage_cleanup_jobs \(project_id, workspace_id\)\s+values \(old\.id, old\.workspace_id\)\s+on conflict \(project_id, bucket_id\) do nothing;/);
  // Nothing here touches audit, security, provenance or task history.
  for (const table of ["platform_events", "security_events", "evidence_items", "material_action_audit_events", "execution_tasks", "governance_delegations", "operational_raw_inputs"]) {
    assert.doesNotMatch(migration, new RegExp(`(delete from|truncate|drop)[^\\n]*${table}`), table);
  }
});

test("PD-26: the job table and the object lister are service-role only, and the lister returns nothing for a live project", () => {
  const migration = read(PD26_MIGRATION);
  assert.match(migration, /alter table public\.storage_cleanup_jobs enable row level security;/);
  assert.match(migration, /revoke all on table public\.storage_cleanup_jobs from public, anon, authenticated;/);
  assert.match(migration, /grant select, insert, update on table public\.storage_cleanup_jobs to service_role;/);
  assert.doesNotMatch(migration, /create policy[^\n]*storage_cleanup_jobs/);
  assert.match(migration, /and not exists \(select 1 from public\.projects p where p\.id = p_project_id\)/);
  assert.match(migration, /\(storage\.foldername\(o\.name\)\)\[2\] = p_project_id::text/);
  for (const fn of ["enqueue_deleted_project_cleanup()", "list_deleted_project_storage_objects(uuid, integer)"]) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon, authenticated;`), fn);
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to service_role;`), fn);
  }
  const matrix = JSON.parse(read("supabase/security/security-definer-grant-matrix.json")) as { functions: Array<Record<string, unknown>> };
  for (const signature of ["public.enqueue_deleted_project_cleanup()", "public.list_deleted_project_storage_objects(uuid,integer)"]) {
    const entry = matrix.functions.find((f) => f.signature === signature);
    assert.ok(entry, signature);
    assert.deepEqual([entry.public, entry.anon, entry.authenticated, entry.service_role], [false, false, false, true], signature);
  }
});

test("PD-26: retained history refuses a hard delete as 409 with nothing deleted; the route drains storage after a successful delete", () => {
  const service = read("src/lib/projects/project-admin-service.ts");
  assert.match(service, /error\.code === "23503"/);
  assert.match(service, /class ProjectHasRetainedHistoryError extends Error/);
  const route = read("src/app/api/projects/[id]/route.ts");
  assert.match(route, /error instanceof ProjectHasRetainedHistoryError[\s\S]*code: "project_has_retained_history" \}, \{ status: 409 \}/);
  assert.ok(route.indexOf("await deleteProject(") < route.indexOf("drainDeletedProjectStorage({ projectId: authorized.projectId })"), "objects are removed only after the row delete committed");
  assert.match(route, /storageCleanup = summary\.pending === 0 \? "completed" : "pending"/);
});

test("PD-26: the cleanup module is a registered privileged surface with a retry command", () => {
  const registry = read("src/lib/security/privileged-access-registry.ts");
  assert.match(registry, /file: "src\/lib\/project-evidence\/deleted-project-storage-cleanup\.ts"/);
  assert.match(read("docs/security/service-role-risk-register.md"), /deleted-project-storage-cleanup\.ts/);
  const cleanup = read("src/lib/project-evidence/deleted-project-storage-cleanup.ts");
  assert.match(cleanup, /PRIVILEGED_ACCESS:/);
  assert.match(cleanup, /AUDIT_REF: service-role-risk-register\.md/);
  assert.match(cleanup, /\.rpc\("list_deleted_project_storage_objects"/);
  assert.match(cleanup, /filter\(\(path\) => isDeletedProjectObjectPath\(path, job\.project_id\)\)/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["storage:cleanup-deleted-projects"], "tsx scripts/storage-cleanup-deleted-projects.mts");
  assert.ok(existsSync(new URL("../scripts/storage-cleanup-deleted-projects.mts", import.meta.url)));
});
