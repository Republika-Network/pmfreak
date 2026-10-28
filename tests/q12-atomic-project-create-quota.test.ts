import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Q12 (five-persona QA, Wave 2 residual). Live coverage is in
// tests/security-regression/q12-project-create-quota.test.mjs and the QA browser harness;
// these pin the decisions those journeys depend on.

const migration = readFileSync("supabase/migrations/20261028000000_q12_project_create_quota.sql", "utf8");
const pd14Migration = readFileSync("supabase/migrations/20261027000000_pd14_project_duplicate_quota.sql", "utf8");
const projectQuota = readFileSync("src/lib/quota/project-quota.ts", "utf8");
const createMinimal = readFileSync("src/lib/projects/create-minimal-project.ts", "utf8");
const saveOnboarding = readFileSync("src/lib/projects/save-project-onboarding.ts", "utf8");
const commandCenter = readFileSync("src/app/(protected)/command-center/actions.ts", "utf8");

const body = (sql: string) => sql.slice(sql.indexOf("as $$"), sql.lastIndexOf("$$;"));
const fnBody = body(migration);
const lockOf = (sql: string) => body(sql).match(/perform pg_advisory_xact_lock\(([^;]+)\);/)?.[1];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

test("Q12: no application code inserts a project except through the quota RPCs", () => {
  const offenders = sourceFiles("src").filter((file) => /\.from\("projects"\)\s*\.(insert|upsert)\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("Q12: every create path inserts through createProjectWithinLimit", () => {
  for (const [name, source] of [["createMinimalProject", createMinimal], ["saveProjectOnboarding", saveOnboarding], ["activateContextAction", commandCenter]] as const) {
    assert.match(source, /from "@\/lib\/quota\/project-quota"/, `${name} imports the quota engine`);
    assert.match(source, /await createProjectWithinLimit\(\{\s*actorUserId: user(Id|\.id),/, `${name} creates through the engine as the authenticated user`);
  }
});

test("Q12: creates and duplicates share ONE per-actor lock, and the limit comes from the server", () => {
  assert.equal(lockOf(migration), "hashtextextended('pmfreak.project_quota:' || p_actor_user_id::text, 0)");
  assert.equal(lockOf(migration), lockOf(pd14Migration));
  const creator = projectQuota.slice(projectQuota.indexOf("export async function createProjectWithinLimit"));
  assert.match(creator, /await projectQuotaContext\(actorUserId, "create_project_within_limit"\)/);
  assert.match(creator, /p_project_limit: entitlement\.projectLimit/);
  assert.match(projectQuota, /const entitlement = await resolveProjectLimit\(actorUserId\);/);
});

test("Q12: the RPC is service-role only and re-checks role and PMO before counting and inserting in one transaction", () => {
  assert.match(migration, /revoke execute on function public\.create_project_within_limit\(uuid, uuid, uuid, text, text, jsonb, integer\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.create_project_within_limit\(uuid, uuid, uuid, text, text, jsonb, integer\) to service_role;/);
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/);
  const role = fnBody.indexOf("wm.role in ('owner', 'admin', 'pm')");
  const pmo = fnBody.indexOf("select 1 from public.pmos where id = p_pmo_id and workspace_id = p_workspace_id");
  const lock = fnBody.indexOf("pg_advisory_xact_lock");
  const count = fnBody.indexOf("select count(*) into v_count from public.projects where user_id = p_actor_user_id");
  const insert = fnBody.indexOf("insert into public.projects");
  assert.ok(role > 0 && role < pmo && pmo < lock && lock < count && count < insert, "authorize, then lock, count, insert");
  assert.match(fnBody, /if p_project_limit is not null and v_count >= p_project_limit then\s+return jsonb_build_object\('ok', false, 'reason', 'project_limit_reached'/);
});

test("Q12: refusals keep each entry point's existing reply", () => {
  assert.match(createMinimal, /reason === "project_limit_reached"\) return \{ ok: false, error: "Project limit reached for your plan\.", failureClass: "upgrade_required" \}/);
  assert.match(createMinimal, /catch \(error\) \{\s*return \{ ok: false, error: [^}]*failureClass: "persistence_failed" \}/);
  assert.match(saveOnboarding, /\{ status: "fatal_failure" as const, error: "upgrade_required", failureClass: "upgrade_required" \}/);
  assert.match(saveOnboarding, /failureClass: "db_insert_error"/);
  assert.match(commandCenter, /redirect\(`\/projects\?error=\$\{encodeURIComponent\("upgrade_required"\)\}/);
});

test("Q12: the wizard's compensating rollback still covers the row the engine inserted", () => {
  const create = saveOnboarding.indexOf("createProjectWithinLimit({");
  const remember = saveOnboarding.indexOf("insertedProject = { id: data.id, workspaceId: ensured.workspaceId, userId: user.id };");
  const rollback = saveOnboarding.indexOf('reason: "compensating_rollback_of_own_insert"');
  assert.ok(create > 0 && create < remember && remember < rollback);
  assert.match(saveOnboarding, /const data = \{ id: created\.project\.id \};/);
});
