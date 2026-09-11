import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldRedirectForOnboarding } from "../src/lib/auth/onboarding-gate";
import { hasWorkspaceAccess } from "../src/lib/auth/onboarding-route-map";
import type { OnboardingState } from "../src/lib/auth/resolve-onboarding-state";
import { decideRoutedProjectAccess, type RoutedProjectAccess } from "../src/lib/projects/routed-project";
import { parseCanonicalProjectRoute, projectHomePath } from "../src/lib/projects/project-paths";
import { parseCanonicalPmoRoute, pmoHomePath } from "../src/lib/pmos/pmo-paths";
import type { RoutedWorkspaceAccess } from "../src/lib/workspaces/routed-workspace";

/**
 * PR #609 REVIEW FINDINGS — three places where canonical Project identity was
 * established correctly and then quietly overruled by something else.
 *
 * All three are the same mistake wearing different clothes: an ENTITY that
 * carries its own ancestry (`projects.workspace_id`, `pmos.workspace_id`) had its
 * scope decided by something that is not that ancestry — a client-controlled
 * cookie, an onboarding probe that cannot see archived rows, or the caller's
 * arbitrary first workspace. Each fix removes the substitute authority; none adds
 * a new one.
 *
 *   1. the sidebar PMO tree fetched `/api/pmos`, which answered from the
 *      preferred-workspace COOKIE, so on `/workspaces/B/projects/P` the chrome
 *      came back holding workspace A;
 *   2. an archived Project under an ACTIVE workspace was redirected to
 *      `/projects/new` by the onboarding gate, so its read-only render was
 *      unreachable; and
 *   3. PM assignment GET/assign/remove derived `workspaceId` from
 *      `getUserWorkspaces(user.id)[0]`.
 *
 * WHAT IS PROVED HERE AND WHAT IS PINNED
 * --------------------------------------
 * Everything decidable without a database is EXECUTED: the onboarding gate and
 * `decideRoutedProjectAccess` are pure, and are composed here exactly as the
 * layout composes them, so the security claims about finding 2 are results, not
 * readings. The route handlers are I/O, so their seam is pinned as source the way
 * `workspace-scoped-command-center-review-findings.test.ts` already pins the
 * identical `/api/projects` fix — a regex that fails the moment the substitute
 * authority comes back.
 */

const WS_A = "aaaaaaaa-1111-2222-3333-444444444444";
const WS_B = "bbbbbbbb-1111-2222-3333-444444444444";
const PROJECT_A = "a0a0a0a0-1111-2222-3333-444444444444";
const PROJECT_B = "b0b0b0b0-1111-2222-3333-444444444444";
const PMO_B = "b1b1b1b1-1111-2222-3333-444444444444";

const read = (file: string) => readFileSync(file, "utf8");

const pmosApi = read("src/app/api/pmos/route.ts");
const projectsApi = read("src/app/api/projects/route.ts");
const pmoService = read("src/lib/pmos/pmo-service.ts");
const sidebarTree = read("src/components/pmfreak/navigation/sidebar-pmo-tree.tsx");
const shell = read("src/components/pmfreak/operational-shell.tsx");
const layout = read("src/app/(protected)/layout.tsx");
const gate = read("src/lib/auth/onboarding-gate.ts");
const pmAssignments = read("src/app/api/projects/[id]/pm-assignments/route.ts");
const pmAssignmentRemoval = read("src/app/api/projects/[id]/pm-assignments/[assignmentId]/route.ts");
const projectAdminService = read("src/lib/projects/project-admin-service.ts");
const canonicalHome = read("src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const grantedWs = (workspaceId: string): RoutedWorkspaceAccess => ({
  access: "granted",
  workspaceId,
  role: "pm",
  readOnly: false,
});
const archivedWs = (workspaceId: string): RoutedWorkspaceAccess => ({
  access: "archived",
  workspaceId,
  role: "pm",
  readOnly: true,
});
const deniedWs: RoutedWorkspaceAccess = { access: "denied", workspaceId: null, role: null, readOnly: true };

// ══ FINDING 1 — the PMO tree must be scoped to the ROUTED workspace ═══════
//
// On `/workspaces/B/projects/P` the protected layout authorizes B and the shell
// renders B, but `GET /api/pmos` resolved the preferred-workspace cookie. So the
// tree held workspace A's PMOs and A's projects: the routed project was not in
// the list, nothing could light, and every link pointed back into A.

test("F1: GET /api/pmos accepts an explicit workspace, exactly as GET /api/projects does", () => {
  assert.match(pmosApi, /const requestedWorkspaceId = params\.get\("workspaceId"\)/);
  assert.match(pmosApi, /requestedWorkspaceId \?\? resolution\?\.workspaceId \?\? null/);
  // Same precedent, same shape — one seam in two routes, not two designs.
  assert.match(projectsApi, /requestedWorkspaceId \?\? resolution\?\.workspaceId \?\? null/);
});

test("F1: an explicit workspace makes the preferred-workspace cookie UNREADABLE, not merely outranked", () => {
  // The strongest form of "explicit route context beats cookie context": when the
  // parameter is present the cookie resolver is never called at all, so there is
  // no value for a later edit to accidentally prefer.
  assert.match(
    pmosApi,
    /const resolution = requestedWorkspaceId \? null : await resolvePreferredWorkspace\(user\.id\);/,
  );
  // And every downstream use reads the RESOLVED id, never `resolution.workspaceId`.
  const get = pmosApi.slice(pmosApi.indexOf("export async function GET"), pmosApi.indexOf("export async function POST"));
  assert.match(get, /await requireWorkspaceMember\(workspaceId\);/);
  assert.match(get, /listPmosWithProjects\(workspaceId, \{ includeArchived \}\)/);
  assert.match(get, /NextResponse\.json\(\{ workspaceId, pmos \}\)/);
  assert.doesNotMatch(withoutComments(get), /resolution\.workspaceId/);
});

test("F1: the requested workspace is authorized before it is queried, and cannot widen access", () => {
  const get = pmosApi.slice(pmosApi.indexOf("export async function GET"), pmosApi.indexOf("export async function POST"));
  // Application-layer defence in depth runs on the REQUESTED id …
  assert.ok(
    get.indexOf("requireWorkspaceMember(workspaceId)") < get.indexOf("listPmosWithProjects(workspaceId"),
    "membership must be checked before the rows are read",
  );
  // … and the enforcing boundary stays the caller's own RLS-scoped client.
  assert.match(pmoService, /import \{ createSupabaseServerClient \} from "@\/lib\/supabase\/server";/);
  assert.doesNotMatch(withoutComments(pmosApi), /createSupabaseServiceRoleClient|supabase\/admin/);
  assert.doesNotMatch(withoutComments(pmoService), /createSupabaseServiceRoleClient|supabase\/admin/);
});

test("F1: the rows the tree receives are scoped by workspace on BOTH queries", () => {
  // PMOs and their projects are each filtered by the requested workspace, so a
  // workspace-A row cannot ride along inside a workspace-B answer.
  const listWithProjects = pmoService.slice(pmoService.indexOf("export async function listPmosWithProjects"));
  assert.match(listWithProjects, /listPmos\(workspaceId, opts\)/);
  assert.match(listWithProjects, /\.from\("projects"\)[\s\S]{0,160}\.eq\("workspace_id", workspaceId\)/);
  assert.match(pmoService, /\.from\("pmos"\)[\s\S]{0,160}\.eq\("workspace_id", workspaceId\)/);
});

test("F1: the tree asks for the workspace the shell is rendering", () => {
  assert.match(sidebarTree, /workspaceId \? `\/api\/pmos\?workspaceId=\$\{encodeURIComponent\(workspaceId\)\}` : "\/api\/pmos"/);
  assert.match(sidebarTree, /\}, \[pathname, workspaceId\]\);/, "the fetch must re-run when the workspace changes");
  assert.doesNotMatch(withoutComments(sidebarTree), /resolvePreferredWorkspace/);
});

test("F1: and the shell hands it the workspace the LAYOUT authorized, not a cookie", () => {
  assert.match(shell, /<SidebarPmoTree workspaceId=\{workspaceId\}/);
  // Which is the routed workspace whenever there is one: the layout prefers the
  // authorized route segment and only falls back to the preferred workspace.
  assert.match(layout, /workspaceId=\{resolvedWorkspace\.workspaceId\}/);
  assert.match(layout, /routedAccess && routedAccess\.access !== "denied"/);
  assert.match(layout, /parseCanonicalProjectRoute\(routedHeaders\.get\("x-pathname"\) \?\? ""\)\?\.workspaceId/);
});

test("F1: every link the tree renders therefore stays under the routed workspace", () => {
  // The tree builds each link from the ROW's own `workspace_id` — which is why
  // scoping the QUERY is the fix: once the rows are B's, the links are B's. This
  // executes both halves of that claim.
  const rowsFromB = {
    pmo: { id: PMO_B, workspace_id: WS_B },
    project: { id: PROJECT_B, workspace_id: WS_B },
  };
  assert.equal(parseCanonicalPmoRoute(pmoHomePath(rowsFromB.pmo.workspace_id, rowsFromB.pmo.id))?.workspaceId, WS_B);
  assert.equal(
    parseCanonicalProjectRoute(projectHomePath(rowsFromB.project.workspace_id, rowsFromB.project.id))?.workspaceId,
    WS_B,
  );
  // And the converse, which is the defect stated as an assertion: a row that
  // belongs to A produces a link that leaves B. Nothing in the tree rewrites it,
  // deliberately — a link must be a property of the entity — so the ONLY way to
  // keep navigation inside B is to not fetch A's rows in the first place.
  assert.equal(parseCanonicalProjectRoute(projectHomePath(WS_A, PROJECT_A))?.workspaceId, WS_A);
  assert.match(sidebarTree, /href=\{projectHomePath\(project\.workspace_id, project\.id\)\}/);
  assert.match(sidebarTree, /href=\{pmoHomePath\(pmo\.workspace_id, pmo\.id\)\}/);
});

test("F1: callers that legitimately still use the preferred workspace are untouched", () => {
  // The `/pmos` chooser is not workspace-qualified, so omitting the parameter has
  // to keep behaving exactly as before — and PMO creation still writes into the
  // preferred workspace, which this slice does not canonicalize.
  const post = pmosApi.slice(pmosApi.indexOf("export async function POST"));
  assert.match(post, /const resolution = await resolvePreferredWorkspace\(user\.id\);/);
  assert.match(post, /createPmo\(\{\s*workspaceId: resolution\.workspaceId,/);
  assert.match(read("src/components/pmfreak/pmos/pmo-admin-client.tsx"), /fetch\("\/api\/pmos\?includeArchived=true"/);
});

// ══ FINDING 2 — an archived Project must survive the onboarding gate ══════
//
// An ACTIVE workspace whose only projects are archived derives `needs_project`,
// because the evidence probe is `projects … .neq("status", "archived")`. So
// `/workspaces/W/projects/P` was redirected to `/projects/new` before
// `resolveRoutedProject` could return its archived/read-only verdict.

const ALL_STATES: OnboardingState[] = [
  "no_workspace",
  "needs_project",
  "needs_task",
  "execution_started",
  "active",
  "trial_blocked",
];

/**
 * The layout's decision, composed from the two REAL functions exactly as
 * `(protected)/layout.tsx` composes them. Every finding-2 claim below is a result
 * of running this, not a reading of it.
 */
function layoutWouldRedirect(state: OnboardingState, routedProject: RoutedProjectAccess | null): boolean {
  return shouldRedirectForOnboarding({
    state,
    routedWorkspaceArchived: false,
    routedProjectArchived: routedProject?.access === "archived",
  });
}

const archivedProjectInActiveWorkspace = decideRoutedProjectAccess({
  routedWorkspaceId: WS_B,
  projectId: PROJECT_B,
  project: { workspaceId: WS_B, status: "archived" },
  workspaceAccess: grantedWs(WS_B),
});

test("F2: the exact scenario — active workspace, archived project, needs_project — is NOT redirected", () => {
  assert.equal(archivedProjectInActiveWorkspace.access, "archived", "the resolver's verdict is the input");
  assert.equal(archivedProjectInActiveWorkspace.readOnly, true);
  assert.equal(
    layoutWouldRedirect("needs_project", archivedProjectInActiveWorkspace),
    false,
    "the archived read-only render must be reachable",
  );
  // And the copy it exists to show is on the page it could not previously reach.
  assert.match(canonicalHome, /<ProjectArchivedNotice archived=\{access\.archived\} \/>/);
});

test("F2: an archived WORKSPACE was already covered, and still is", () => {
  const bothArchived = decideRoutedProjectAccess({
    routedWorkspaceId: WS_B,
    projectId: PROJECT_B,
    project: { workspaceId: WS_B, status: "archived" },
    workspaceAccess: archivedWs(WS_B),
  });
  assert.equal(bothArchived.access, "archived");
  assert.equal(shouldRedirectForOnboarding({ state: "needs_project", routedWorkspaceArchived: true }), false);
  assert.equal(layoutWouldRedirect("needs_project", bothArchived), false);
});

test("F2: an UNAUTHORIZED project id cannot bypass onboarding", () => {
  // No membership in the project's real workspace: the resolver refuses, so the
  // flag is never set and the gate behaves exactly as it did before the exemption.
  const unauthorized = decideRoutedProjectAccess({
    routedWorkspaceId: WS_B,
    projectId: PROJECT_B,
    project: { workspaceId: WS_B, status: "archived" },
    workspaceAccess: deniedWs,
  });
  assert.equal(unauthorized.access, "denied");
  assert.equal(layoutWouldRedirect("needs_project", unauthorized), true);
});

test("F2: a RANDOM project id in the URL cannot bypass onboarding", () => {
  // Absent, deleted, or invisible to this caller — all read as `project: null`.
  const random = decideRoutedProjectAccess({
    routedWorkspaceId: WS_B,
    projectId: "not-a-project",
    project: null,
    workspaceAccess: grantedWs(WS_B),
  });
  assert.equal(random.access, "denied");
  assert.equal(layoutWouldRedirect("needs_project", random), true);
});

test("F2: an ancestry-mismatched URL cannot bypass onboarding either", () => {
  // `/workspaces/A/projects/P` where P actually lives in B: refused, not corrected.
  const mismatched = decideRoutedProjectAccess({
    routedWorkspaceId: WS_A,
    projectId: PROJECT_B,
    project: { workspaceId: WS_B, status: "archived" },
    workspaceAccess: grantedWs(WS_B),
  });
  assert.equal(mismatched.access, "denied");
  assert.equal(layoutWouldRedirect("needs_project", mismatched), true);
});

test("F2: no routed project at all leaves the gate exactly as it was", () => {
  assert.equal(layoutWouldRedirect("needs_project", null), true);
});

test("F2: trial_blocked is never bypassed, by either archival flag", () => {
  // An entitlement decision has nothing to do with archival; exempting it would
  // turn a read-only viewing affordance into a billing bypass.
  assert.equal(layoutWouldRedirect("trial_blocked", archivedProjectInActiveWorkspace), true);
  assert.equal(
    shouldRedirectForOnboarding({ state: "trial_blocked", routedWorkspaceArchived: true, routedProjectArchived: true }),
    true,
  );
});

test("F2: no_workspace is never bypassed, by either archival flag", () => {
  assert.equal(layoutWouldRedirect("no_workspace", archivedProjectInActiveWorkspace), true);
  assert.equal(
    shouldRedirectForOnboarding({ state: "no_workspace", routedWorkspaceArchived: true, routedProjectArchived: true }),
    true,
  );
});

test("F2: the new flag changes exactly one state, and no other", () => {
  const changed = ALL_STATES.filter(
    (state) =>
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false, routedProjectArchived: true }) !==
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false, routedProjectArchived: false }),
  );
  assert.deepEqual(changed, ["needs_project"]);
});

test("F2: every render without an archived routed entity is identical to the previous rule", () => {
  // "Normal needs_project behavior outside an authorized routed archived Project
  // must remain unchanged", asserted exhaustively rather than by inspection —
  // including with the new field omitted entirely, which is how every existing
  // caller passes it.
  for (const state of ALL_STATES) {
    assert.equal(
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false }),
      !hasWorkspaceAccess(state),
      `behaviour changed for "${state}" with the field omitted`,
    );
    assert.equal(
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false, routedProjectArchived: false }),
      !hasWorkspaceAccess(state),
      `behaviour changed for "${state}" with the field false`,
    );
  }
});

test("F2: an ACTIVE routed project is not exempted — the exemption is archival, not projecthood", () => {
  const active = decideRoutedProjectAccess({
    routedWorkspaceId: WS_B,
    projectId: PROJECT_B,
    project: { workspaceId: WS_B, status: "active" },
    workspaceAccess: grantedWs(WS_B),
  });
  assert.equal(active.access, "granted");
  assert.equal(layoutWouldRedirect("needs_project", active), true);
  // `completed` is a normal mutable state too, not archival.
  const completed = decideRoutedProjectAccess({
    routedWorkspaceId: WS_B,
    projectId: PROJECT_B,
    project: { workspaceId: WS_B, status: "completed" },
    workspaceAccess: grantedWs(WS_B),
  });
  assert.equal(completed.access, "granted");
  assert.equal(layoutWouldRedirect("needs_project", completed), true);
});

test("F2: the layout derives the flag from the RESOLVER, never from the URL", () => {
  // The parsed route supplies ids only; the verdict comes from resolveRoutedProject.
  assert.match(layout, /import \{ resolveRoutedProject \} from "@\/lib\/projects\/routed-project";/);
  assert.match(
    layout,
    /await resolveRoutedProject\(user\.id, routedProjectRoute\.workspaceId, routedProjectRoute\.projectId\)\)\.access ===\s*\n?\s*"archived"/,
  );
  const flagBlock = layout.slice(layout.indexOf("const routedProjectArchived ="), layout.indexOf("if (shouldRedirectForOnboarding"));
  assert.doesNotMatch(
    flagBlock,
    /routedProjectRoute \?\?|= Boolean\(routedProjectRoute\)|routedProjectRoute !== null/,
    "the presence of a project id in the URL must never set the flag on its own",
  );
  assert.match(layout, /shouldRedirectForOnboarding\(\{ state: onboardingState, routedWorkspaceArchived, routedProjectArchived \}\)/);
});

test("F2: the flag is only resolved for the one state where it can matter", () => {
  // Narrowest possible exception, and no extra authorization round-trip on any
  // other render.
  assert.match(layout, /onboardingState === "needs_project" && routedProjectRoute/);
  assert.ok(
    layout.indexOf("const onboardingState =") < layout.indexOf("const routedProjectArchived ="),
    "the state must be known before the flag is resolved",
  );
});

test("F2: the gate itself still refuses to exempt anything but needs_project", () => {
  assert.match(gate, /if \(state === "trial_blocked"\) return true;/);
  assert.match(gate, /if \(state === "no_workspace"\) return true;/);
  assert.match(gate, /if \(state === "needs_project"\) return !routedWorkspaceArchived && !routedProjectArchived;/);
});

test("F2: skipping the gate enables no mutation — the archived verdict still gates the page", () => {
  // Reachability changed; capability did not. The archived-project task refusal
  // lives server-side and is unaffected by how the request arrived.
  assert.match(canonicalHome, /const access = await resolveRoutedProject\(user\.id, requestedWorkspaceId, requestedProjectId\);/);
  assert.match(canonicalHome, /if \(access\.access === "denied"\)/);
  assert.match(read("src/lib/execution-tasks/create-execution-task.ts"), /Cannot add tasks to an archived project/);
});

// ══ FINDING 3 — PM assignments must follow the Project, not a first workspace ══
//
// GET/assign/remove derived `workspaceId` from `getUserWorkspaces(user.id)[0]`,
// so canonical Project Home could render a project in workspace B while every
// assignment operation on that same page authorized against workspace A.

test("F3: first-workspace authority is gone from every PM-assignment handler", () => {
  for (const [name, source] of [
    ["/api/projects/[id]/pm-assignments", pmAssignments],
    ["/api/projects/[id]/pm-assignments/[assignmentId]", pmAssignmentRemoval],
  ] as const) {
    // The MODULE is no longer imported — matching the bare identifier would pass
    // on the prose above each handler explaining what was removed.
    assert.doesNotMatch(source, /from "@\/lib\/workspaces"/, `${name} must not import the workspace list`);
    assert.doesNotMatch(withoutComments(source), /getUserWorkspaces/, `${name} must not derive a first workspace`);
    assert.doesNotMatch(withoutComments(source), /workspaces\[0\]/, `${name} must not index a workspace list`);
    // Nor may the cookie replace it.
    assert.doesNotMatch(withoutComments(source), /resolvePreferredWorkspace/, `${name} must not scope by cookie`);
  }
});

test("F3: all three operations derive the workspace from the exact project row", () => {
  // GET and POST in the collection route …
  assert.equal(
    (withoutComments(pmAssignments).match(/const workspaceId = await getProjectWorkspaceId\(projectId\);/g) ?? []).length,
    2,
    "both GET and POST must resolve the project's own workspace",
  );
  // … and DELETE in the item route.
  assert.equal(
    (withoutComments(pmAssignmentRemoval).match(/const workspaceId = await getProjectWorkspaceId\(projectId\);/g) ?? []).length,
    1,
  );
  for (const source of [pmAssignments, pmAssignmentRemoval]) {
    assert.match(source, /import \{ getProjectWorkspaceId \} from "@\/lib\/projects\/project-admin-service";/);
  }
  // And that helper reads the project's OWN parent, through the caller's client.
  const helper = projectAdminService.slice(projectAdminService.indexOf("export async function getProjectWorkspaceId"));
  assert.match(helper, /\.from\("projects"\)[\s\S]{0,120}\.select\("workspace_id"\)[\s\S]{0,80}\.eq\("id", projectId\)/);
  assert.match(helper, /createSupabaseServerClient\(\)/);
});

test("F3: authorization happens on the derived workspace, before anything is read or written", () => {
  const get = pmAssignments.slice(pmAssignments.indexOf("export async function GET"), pmAssignments.indexOf("export async function POST"));
  const post = pmAssignments.slice(pmAssignments.indexOf("export async function POST"));
  for (const [name, handler, firstUse] of [
    ["GET", get, "listProjectAssignments(workspaceId, projectId)"],
    ["POST", post, "assignProjectManager({"],
    ["DELETE", pmAssignmentRemoval, 'from("pm_assignments")'],
  ] as const) {
    assert.ok(handler.includes("await requireWorkspaceMember(workspaceId);"), `${name} must authorize the derived workspace`);
    assert.ok(
      handler.indexOf("await getProjectWorkspaceId(projectId)") <
        handler.indexOf("await requireWorkspaceMember(workspaceId)"),
      `${name} must derive before it authorizes`,
    );
    assert.ok(
      handler.indexOf("await requireWorkspaceMember(workspaceId)") < handler.indexOf(firstUse),
      `${name} must authorize before it acts`,
    );
  }
});

test("F3: a project the caller cannot see is a 404, not another workspace's answer", () => {
  // `getProjectWorkspaceId` reads through RLS, so a non-member gets `null` — the
  // same answer as a project that does not exist. No handler falls back.
  for (const source of [pmAssignments, pmAssignmentRemoval]) {
    assert.match(source, /if \(!workspaceId\) \{\s*\n\s*return NextResponse\.json\(\{ ok: false, error: \{ code: "not_found"/);
    assert.doesNotMatch(withoutComments(source), /createSupabaseServiceRoleClient|supabase\/admin/);
  }
});

test("F3: assign and remove are handed the PROJECT's workspace, so Project A cannot become Project B", () => {
  assert.match(pmAssignments, /assignProjectManager\(\{\s*\n\s*workspaceId,\s*\n\s*pmId: body\.pmId,\s*\n\s*projectId,/);
  assert.match(pmAssignmentRemoval, /unassignProjectManager\(\{\s*\n\s*workspaceId,\s*\n\s*pmId: assignment\.pm_id,\s*\n\s*projectId,/);
  // The removal still requires the assignment to belong to THIS project AND to
  // that project's workspace — the two filters now agree instead of contradicting,
  // so a cross-workspace mismatch matches no row and mutates nothing.
  assert.match(
    pmAssignmentRemoval,
    /\.eq\("id", assignmentId\)\s*\n\s*\.eq\("project_id", projectId\)\s*\n\s*\.eq\("workspace_id", workspaceId\)/,
  );
  // And the registry itself scopes every write by the workspaceId it is given.
  const registry = read("src/lib/pm-registry/pm-assignments.ts");
  assert.match(registry, /\.eq\("workspace_id", input\.workspaceId\)/);
});

test("F3: the PM assignment panel still addresses one project, and adds no workspace of its own", () => {
  // The client says WHICH project; the server decides which workspace that is.
  const panel = read("src/components/pmfreak/ProjectPMAssignment.tsx");
  assert.match(panel, /\/api\/projects\/\$\{projectId\}\/pm-assignments/);
  assert.doesNotMatch(withoutComments(panel), /workspaceId/);
  assert.match(canonicalHome, /<ProjectPMAssignment projectId=\{project\.id\} \/>/);
});

// ══ Scope guardrails ═════════════════════════════════════════════════════

test("these three fixes introduce no schema, no migration and no new privileged access", () => {
  for (const source of [pmosApi, pmoService, sidebarTree, layout, gate, pmAssignments, pmAssignmentRemoval]) {
    assert.doesNotMatch(withoutComments(source), /create\s+table|alter\s+table|drop\s+table|\.sql\b/i);
  }
  // The layout's ONE service-role user is the pre-existing trial event log; the
  // new resolution reuses resolveRoutedWorkspace's already-registered boundary.
  const serviceRoleUses = (withoutComments(layout).match(/createSupabaseServiceRoleClient\(/g) ?? []).length;
  assert.equal(serviceRoleUses, 1, "no new service-role call site in the protected layout");
});
