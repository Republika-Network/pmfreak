import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ─── Load source files ────────────────────────────────────────────────────────

const migration = fs.readFileSync("supabase/migrations/20260828000001_workspace_pmo_project_hierarchy.sql", "utf8");
const contract = fs.readFileSync("src/lib/db/database-contract.ts", "utf8");
const chatService = fs.readFileSync("src/lib/chat/context-chat-service.ts", "utf8");
const chatResponder = fs.readFileSync("src/lib/chat/context-chat-responder.ts", "utf8");
const pmoService = fs.readFileSync("src/lib/pmos/pmo-service.ts", "utf8");
const onboardingState = fs.readFileSync("src/lib/auth/resolve-onboarding-state.ts", "utf8");
const savePmoTenant = fs.readFileSync("src/lib/pmo/save-pmo-tenant.ts", "utf8");
const projectsAction = fs.readFileSync("src/app/(protected)/projects/actions.ts", "utf8");
// First Execution Experience sprint: projects/actions.ts now delegates
// project creation (including PMO attachment) to this shared service, also
// used by POST /api/projects.
const createMinimalProject = fs.readFileSync("src/lib/projects/create-minimal-project.ts", "utf8");
const saveProjectOnboarding = fs.readFileSync("src/lib/projects/save-project-onboarding.ts", "utf8");
const operationalShell = fs.readFileSync("src/components/pmfreak/operational-shell.tsx", "utf8");
const routePolicy = fs.readFileSync("src/lib/auth/route-policy-registry.ts", "utf8");

// ─── Pure module imports ──────────────────────────────────────────────────────

const { contextIdFor, parseContextScope } = await import("../src/lib/context/context-scope.ts");
const { NAVIGATION_HIERARCHY } = await import("../src/lib/workspace/navigation-hierarchy.ts");

// ─── Migration: pmos as first-class entity ────────────────────────────────────

test("migration creates the pmos table scoped to workspaces", () => {
  assert.ok(/create table if not exists pmos/.test(migration));
  assert.ok(/workspace_id\s+uuid\s+not null references workspaces\(id\) on delete cascade/.test(migration));
});

test("migration adds projects.pmo_id with SET NULL semantics", () => {
  assert.ok(/alter table projects add column if not exists pmo_id uuid references pmos\(id\) on delete set null/.test(migration));
});

test("migration backfills a default PMO and attaches existing projects", () => {
  assert.ok(/insert into pmos \(workspace_id, name, pmo_type, created_by_user_id\)/.test(migration));
  assert.ok(/update projects p\s+set pmo_id = pm\.id/.test(migration));
});

test("migration enables RLS on every new table", () => {
  for (const table of ["pmos", "context_conversations", "context_messages"]) {
    assert.ok(migration.includes(`alter table ${table} enable row level security`), `RLS missing on ${table}`);
    assert.ok(new RegExp(`on ${table} for select`).test(migration), `select policy missing on ${table}`);
  }
});

test("conversation scope shape is enforced by CHECK constraint", () => {
  assert.ok(/context_type = 'workspace' and pmo_id is null and project_id is null/.test(migration));
  assert.ok(/context_type = 'pmo' and pmo_id is not null and project_id is null/.test(migration));
  assert.ok(/context_type = 'project' and project_id is not null/.test(migration));
});

test("one active conversation per scope is enforced by unique index", () => {
  assert.ok(/context_conversations_scope_unique_idx/.test(migration));
  assert.ok(/where status = 'active'/.test(migration));
});

// ─── DB contract declarations ─────────────────────────────────────────────────

test("contract declares PmoRow and selectable columns", () => {
  assert.ok(contract.includes("export type PmoRow"));
  assert.ok(contract.includes("PMO_SELECTABLE_COLUMNS"));
});

test("contract declares context conversation/message rows", () => {
  assert.ok(contract.includes("export type ContextConversationRow"));
  assert.ok(contract.includes("export type ContextMessageRow"));
});

test("projects contract includes pmo_id, methodology, icon, color", () => {
  for (const col of ['"pmo_id"', '"methodology"', '"icon"', '"color"']) {
    assert.ok(contract.includes(col), `projects contract missing ${col}`);
  }
});

// ─── Context IDs (Change 12) ──────────────────────────────────────────────────

test("each hierarchy level derives a distinct context id", () => {
  const workspaceId = "w-1";
  const workspace = contextIdFor({ type: "workspace", workspaceId });
  const pmo = contextIdFor({ type: "pmo", workspaceId, pmoId: "p-1" });
  const project = contextIdFor({ type: "project", workspaceId, projectId: "pr-1" });
  assert.equal(workspace, "workspace:w-1");
  assert.equal(pmo, "pmo:p-1");
  assert.equal(project, "project:pr-1");
  assert.equal(new Set([workspace, pmo, project]).size, 3);
});

test("parseContextScope rejects malformed scopes", () => {
  assert.equal(parseContextScope({ workspaceId: "", contextType: "workspace" }), null);
  assert.equal(parseContextScope({ workspaceId: "w", contextType: "pmo" }), null);
  assert.equal(parseContextScope({ workspaceId: "w", contextType: "project" }), null);
  assert.equal(parseContextScope({ workspaceId: "w", contextType: "everything" }), null);
  assert.deepEqual(parseContextScope({ workspaceId: "w", contextType: "pmo", pmoId: "p" }), { type: "pmo", workspaceId: "w", pmoId: "p" });
});

// ─── Chat isolation (Changes 5–7) ─────────────────────────────────────────────

test("conversation lookup filters on the full scope shape, never workspace alone", () => {
  assert.ok(chatService.includes('query.eq("pmo_id", pmoId) : query.is("pmo_id", null)'));
  assert.ok(chatService.includes('query.eq("project_id", projectId) : query.is("project_id", null)'));
});

test("responder narrows PMO scope to its own projects and project scope to itself", () => {
  assert.ok(chatResponder.includes('projectsQuery.eq("pmo_id", scope.pmoId)'));
  assert.ok(chatResponder.includes('projectsQuery.eq("id", scope.projectId)'));
});

test("context chat API exists for all three levels", () => {
  const route = fs.readFileSync("src/app/api/context-chat/route.ts", "utf8");
  // Scope resolution derives workspace_id from the pmo/project entity
  // itself (getPmoWorkspaceId/getProjectWorkspaceId) rather than the
  // caller's preferred workspace — see
  // tests/workspace-pmo-project-validation-sprint.test.mjs for the
  // regression test covering this directly.
  assert.ok(route.includes("resolveAndAuthorizeScope"));
  assert.ok(route.includes("requireProjectAccess"));
  assert.ok(route.includes("getPmoWorkspaceId"));
});

test("chat pages exist per level", () => {
  assert.ok(fs.existsSync("src/app/(protected)/chat/page.tsx"));
  assert.ok(fs.existsSync("src/app/(protected)/pmos/[pmoId]/chat/page.tsx"));
  assert.ok(fs.existsSync("src/app/(protected)/projects/[id]/chat/page.tsx"));
});

// ─── PMO administration (Change 3) ────────────────────────────────────────────

test("pmo service exposes full admin surface", () => {
  for (const fn of ["listPmos", "createPmo", "updatePmo", "deletePmo", "duplicatePmo", "moveProjectToPmo", "ensureDefaultPmo"]) {
    assert.ok(pmoService.includes(`export async function ${fn}`), `pmo-service missing ${fn}`);
  }
});

test("pmo admin API routes exist", () => {
  assert.ok(fs.existsSync("src/app/api/pmos/route.ts"));
  assert.ok(fs.existsSync("src/app/api/pmos/[id]/route.ts"));
  assert.ok(fs.existsSync("src/app/api/pmos/[id]/duplicate/route.ts"));
  assert.ok(fs.existsSync("src/app/(protected)/pmos/page.tsx"));
});

// ─── Project administration (Change 4) ────────────────────────────────────────

test("project admin API supports update, move, delete, duplicate", () => {
  const route = fs.readFileSync("src/app/api/projects/[id]/route.ts", "utf8");
  assert.ok(route.includes("export async function PATCH"));
  assert.ok(route.includes("export async function DELETE"));
  assert.ok(route.includes("pmoId"));
  assert.ok(fs.existsSync("src/app/api/projects/[id]/duplicate/route.ts"));
});

// ─── Creation flows (Change 1) ────────────────────────────────────────────────

test("every project creation path attaches a PMO", () => {
  // A PMO is always attached (auto-created via ensureDefaultPmo when not
  // explicit) as an internal implementation detail of project creation —
  // this is distinct from and does not reintroduce a PMO *precondition* for
  // reaching Project creation, which resolveOnboardingState never checks
  // (PMF-001/PMF-002). The retired api/getting-started/route.ts (a former,
  // separate creation path) is no longer checked here — it was deleted.
  assert.ok(createMinimalProject.includes("pmo_id: resolvedPmoId"), "projects/actions.ts (via createMinimalProject) must attach a PMO");
  assert.ok(saveProjectOnboarding.includes("pmo_id: pmoId"));
  const commandCenterAction = fs.readFileSync("src/app/(protected)/command-center/actions.ts", "utf8");
  assert.ok(commandCenterAction.includes("pmo_id: defaultPmo.id"));
});

test("PMO onboarding materializes a pmos row", () => {
  // PMF-004: materialization now goes through ensure_default_pmo (an
  // advisory-lock-guarded RPC), not a raw check-then-insert against pmos.
  assert.ok(savePmoTenant.includes('supabaseClient.rpc("ensure_default_pmo"'));
});

test("workspace creation flow exists", () => {
  assert.ok(fs.existsSync("src/app/(protected)/workspaces/new/page.tsx"));
  assert.ok(fs.existsSync("src/app/(protected)/workspaces/actions.ts"));
  const workspacesLib = fs.readFileSync("src/lib/workspaces.ts", "utf8");
  assert.ok(workspacesLib.includes("export async function createWorkspace"));
});

test("onboarding state resolution has no PMO precondition (PMF-001/PMF-002)", () => {
  // Superseded: resolveOnboardingState previously queried pmos and returned
  // a distinct "needs_pmo_setup" state that gated Project creation behind
  // PMO existence — exactly PMF-002's routing-layer defect. Canonical
  // onboarding consolidation removed the PMO check and the state entirely.
  assert.ok(!onboardingState.includes('.from("pmos")'));
  assert.ok(!onboardingState.includes("needs_pmo_setup"));
});

// ─── Navigation (Changes 2 & 8) ───────────────────────────────────────────────

test("navigation registry exposes the three-level surfaces", () => {
  // Workspace → PMO → Project each keep a navigation destination. /chat and /projects/new
  // dropped out of this list with W1 — they are still reachable, just not persistent
  // navigation; the next test is what now guards them.
  const hrefs = NAVIGATION_HIERARCHY.map((n) => n.href);
  for (const href of ["/workspaces", "/pmos", "/projects"]) {
    assert.ok(hrefs.includes(href), `navigation missing ${href}`);
  }
});

test("navigation-hidden surfaces remain route-reachable (hidden is not deleted)", () => {
  // The whole basis for removing them from navigation is that nothing was lost. If the page
  // ever disappears, this fails and the claim stops being true.
  for (const page of [
    "src/app/(protected)/chat/page.tsx",
    "src/app/(protected)/dashboard/page.tsx",
    "src/app/(protected)/projects/new/page.tsx",
  ]) {
    assert.ok(fs.existsSync(page), `${page} must still exist — navigation-hidden, not removed`);
  }
});

test("sidebar renders the PMO tree (PMOs never mixed with flat projects)", () => {
  assert.ok(operationalShell.includes("SidebarPmoTree"));
});

test("new routes are registered in the route access policy", () => {
  for (const route of ['"/workspaces"', '"/pmos"', '"/chat"']) {
    assert.ok(routePolicy.includes(route), `route policy missing ${route}`);
  }
});

// ─── Project creation lands in the Command Center (Founder Loop sprint) ──────

test("project creation lands in the command center scoped to the new project", () => {
  assert.ok(projectsAction.includes("redirect(`/command-center?projectId=${project.id}"));
  const wizard = fs.readFileSync("src/components/pmfreak/projects/create-project-wizard.tsx", "utf8");
  assert.ok(wizard.includes("router.push(`/command-center?projectId=${result.projectId}"));
});

test("project overview exposes chat as one tab among many", () => {
  // The strip moved to src/components/pmfreak/projects/ with the canonical
  // Project Home slice: it is now rendered by canonical Project Home
  // (/workspaces/[workspaceId]/projects/[projectId]) as well as by legacy Project
  // Chat and Settings, so it belongs to none of those route folders. Its content
  // is what this test is about, and that is unchanged.
  const tabNav = fs.readFileSync("src/components/pmfreak/projects/project-tab-nav.tsx", "utf8");
  assert.ok(tabNav.includes('{ label: "Overview"'));
  assert.ok(tabNav.includes('{ label: "Chat"'));
  assert.ok(tabNav.includes("Settings"));
});
