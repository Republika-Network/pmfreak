import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// PD-14 / PD-15 (five-persona QA, Wave 2). Live coverage is in
// tests/security-regression/pd14-project-duplicate-quota.test.mjs and the QA browser harness;
// these pin the decisions those journeys depend on.

const migration = readFileSync("supabase/migrations/20261027000000_pd14_project_duplicate_quota.sql", "utf8");
const projectQuota = readFileSync("src/lib/quota/project-quota.ts", "utf8");
const adminService = readFileSync("src/lib/projects/project-admin-service.ts", "utf8");
const duplicateRoute = readFileSync("src/app/api/projects/[id]/duplicate/route.ts", "utf8");
const featureGates = readFileSync("src/lib/feature-gates.ts", "utf8");
const projectsPage = readFileSync("src/app/(protected)/projects/page.tsx", "utf8");

const duplicateFn = adminService.slice(adminService.indexOf("export async function duplicateProject"));
const fnBody = migration.slice(migration.indexOf("as $$"), migration.lastIndexOf("$$;"));

// ─── PD-14: a duplicate is a create for quota purposes ───────────────────────

test("PD-14: duplicateProject inserts only through the quota engine", () => {
  assert.doesNotMatch(duplicateFn, /\.from\("projects"\)\s*\.insert/);
  assert.match(duplicateFn, /duplicateProjectWithinLimit\(\{ actorUserId: createdByUserId, workspaceId, sourceProjectId: source\.id, targetPmoId \}\)/);
  assert.match(duplicateFn, /project_limit_reached"\) return \{ ok: false, failureClass: "upgrade_required"/);
});

test("PD-14: the limit comes from the actor's own subscription, never the request", () => {
  assert.match(projectQuota, /const entitlement = await resolveProjectLimit\(actorUserId\);/);
  assert.match(projectQuota, /p_project_limit: entitlement\.projectLimit/);
  // Same plan table as canCreateMoreProjects; PMO (unlimited) maps to null.
  const resolver = featureGates.slice(featureGates.indexOf("export async function resolveProjectLimit"));
  assert.match(resolver, /const limit = PROJECT_LIMITS\[plan\];/);
  assert.match(resolver, /projectLimit: limit > 2_147_483_647 \? null : limit/);
  assert.doesNotMatch(duplicateRoute, /request\.json\(\)|searchParams/);
});

test("PD-14: the RPC is service-role only and serialises count + insert per actor in one transaction", () => {
  assert.match(migration, /revoke execute on function public\.duplicate_project_within_limit\(uuid, uuid, uuid, uuid, integer\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.duplicate_project_within_limit\(uuid, uuid, uuid, uuid, integer\) to service_role;/);
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/);
  const lock = fnBody.indexOf("pg_advisory_xact_lock");
  const count = fnBody.indexOf("select count(*) into v_count from public.projects where user_id = p_actor_user_id");
  const insert = fnBody.indexOf("insert into public.projects");
  assert.ok(lock > 0 && lock < count && count < insert, "lock, then count, then insert");
  assert.match(fnBody, /if p_project_limit is not null and v_count >= p_project_limit then\s+return jsonb_build_object\('ok', false, 'reason', 'project_limit_reached'/);
});

test("PD-14: the RPC re-checks writer role, source workspace and PMO workspace itself", () => {
  assert.match(fnBody, /wm\.role in \('owner', 'admin', 'pm'\)/);
  assert.match(fnBody, /where id = p_source_project_id and workspace_id = p_workspace_id/);
  assert.match(fnBody, /select 1 from public\.pmos where id = p_target_pmo_id and workspace_id = p_workspace_id/);
  assert.ok(fnBody.indexOf("insufficient_role") < fnBody.indexOf("pg_advisory_xact_lock"), "authorization before the critical section");
});

test("PD-14: the route answers like POST /api/projects (402 / 403 / 404)", () => {
  // PD-25: duplicating reads the source and writes a new project, so an archived source is allowed.
  assert.match(duplicateRoute, /await requireProjectAccessAllowingArchived\(projectId, "write"\);/);
  assert.match(duplicateRoute, /upgrade_required: 402, insufficient_role: 403, not_found: 404/);
});

// ─── PD-15: /projects lists the selected workspace's projects ────────────────

test("PD-15: /projects reads the selected workspace's projects, not the caller's own rows", () => {
  assert.doesNotMatch(projectsPage, /\.eq\("user_id", user\.id\)/);
  assert.match(projectsPage, /const selectedWorkspaceId = await readPreferredWorkspaceId\(\);/);
  assert.match(projectsPage, /resolveCanonicalWorkspace\(user\.id, selectedWorkspaceId\)/);
  assert.match(projectsPage, /\.from\("projects"\)\s*\.select\("id, workspace_id, name, description, status, created_at"\)\s*\.eq\("workspace_id", workspaceId\)/);
  // RLS is the enforcing boundary: the list must use the user-scoped client.
  assert.match(projectsPage, /const supabase = await createSupabaseServerClient\(\);/);
  assert.doesNotMatch(projectsPage, /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/);
});

test("PD-15: an unavailable selection is refused before any project is read", () => {
  const guard = "if ((selectedWorkspaceId && workspaceResolution.workspaceId !== selectedWorkspaceId) || !workspaceResolution.workspaceId)";
  assert.ok(projectsPage.includes(guard));
  assert.ok(projectsPage.indexOf(guard) < projectsPage.indexOf('.from("projects")'));
  const branch = projectsPage.slice(projectsPage.indexOf(guard), projectsPage.indexOf("const workspaceId = workspaceResolution.workspaceId;"));
  assert.match(branch, /href="\/workspaces"/);
  assert.doesNotMatch(branch, /createProjectAction|EmptyProjects/);
});

test("PD-15: the create form follows the role in the same selected workspace", () => {
  assert.match(projectsPage, /const canCreateProjects = workspaceResolution\.role !== null && workspaceResolution\.role !== "viewer";/);
  assert.match(projectsPage, /data-testid="projects-workspace-name"/);
});
