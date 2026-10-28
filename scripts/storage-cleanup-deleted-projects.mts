/**
 * PD-26 — drains the pending deleted-project Storage cleanup jobs.
 *
 * Deleting a project (DELETE /api/projects/[id]) enqueues one storage_cleanup_jobs row in the
 * deleting transaction and drains it right away; anything that fails (Storage unavailable, the
 * function timed out) stays pending. This command retries those jobs — idempotently — and is
 * meant for an operator or a scheduler. It uses the application's own module and privileged
 * client, so it needs the same two variables the application uses for the target project:
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 *   npm run storage:cleanup-deleted-projects                  # up to 20 jobs
 *   npm run storage:cleanup-deleted-projects -- --max-jobs 100
 *
 * Prints one JSON summary line. Exits 1 when jobs remain pending, so a scheduler retries.
 */
import { drainDeletedProjectStorage } from "../src/lib/project-evidence/deleted-project-storage-cleanup";

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf("--max-jobs");
const maxJobs = flagIndex >= 0 ? Number.parseInt(argv[flagIndex + 1] ?? "", 10) : 20;
if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 200) {
  console.error("--max-jobs must be an integer between 1 and 200");
  process.exit(2);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}

const summary = await drainDeletedProjectStorage({ maxJobs });
console.log(JSON.stringify({ event: "storage_cleanup.deleted_projects", ...summary }));
process.exit(summary.pending > 0 ? 1 : 0);
