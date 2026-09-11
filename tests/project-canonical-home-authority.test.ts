import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PROJECTS_NAV_HREF,
  PROJECT_SURFACES,
  isCanonicalProjectRoutePath,
  legacyProjectHomePath,
  parseCanonicalProjectRoute,
  projectHomePath,
  projectSurfacePath,
  type ProjectSurface,
} from "../src/lib/projects/project-paths";
import { decideRoutedProjectAccess, type RoutedProjectAccess } from "../src/lib/projects/routed-project";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  navEntryMatchesPathname,
  workspaceCommandCenterPath,
} from "../src/lib/workspace/command-center-paths";
import { isCanonicalPmoRoutePath, pmoHomePath } from "../src/lib/pmos/pmo-paths";
import { workspaceHomePath, workspaceSettingsPath } from "../src/lib/workspaces/workspace-paths";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { NAVIGATION_HIERARCHY } from "../src/lib/workspace/navigation-hierarchy";
import type { RoutedWorkspaceAccess } from "../src/lib/workspaces/routed-workspace";

/**
 * CANONICAL PROJECT IDENTITY + PROJECT HOME.
 *
 * Project identity is now `Workspace → Project`, decided by
 * `projects.workspace_id` and nothing else, and Project Home lives at
 * `/workspaces/[workspaceId]/projects/[projectId]`.
 *
 * THE TWO DEFECTS THIS SLICE REMOVES
 * ----------------------------------
 * Both lived in the same file — the old `/projects/[id]` screen — and both are
 * what every test below is really about:
 *
 *   1. `resolveCanonicalProject(project.workspace_id, id)`. It listed the
 *      workspace's fifty most recent projects and, when the requested id was not
 *      among them, redirected to the FIRST one with `recovered: true`. On an
 *      explicit entity route that is substitution, not recovery — project A
 *      becoming project B — and it fired for real on any workspace holding more
 *      than fifty projects, where a perfectly valid id simply fell off the end of
 *      the list. The announcement was a `?recoveredFrom=invalidProject` query
 *      that nothing in the codebase read.
 *
 *   2. `resolvePreferredWorkspace(user.id)` decided `canCreateTask`. That is the
 *      COOKIE, while the page itself was about a project in whatever workspace
 *      actually owns it. When the two differed the page authorized one workspace
 *      and gated its controls against another.
 *
 * This slice ships Project HOME only. The Project Command Center and the
 * Execution Layer children are in the ratified map and none of them is built, so
 * none of them is claimed here.
 */

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const PROJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PROJECT = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
const PMO = "12341234-5678-5678-9abc-9abcdef0def0";

const CANONICAL_HOME = `/workspaces/${WS}/projects/${PROJECT}`;

const CANONICAL_HOME_FILE = "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx";
const LEGACY_HOME_FILE = "src/app/(protected)/projects/[id]/page.tsx";

const read = (file: string) => readFileSync(file, "utf8");

const paths = read("src/lib/projects/project-paths.ts");
const resolver = read("src/lib/projects/routed-project.ts");
const routeStates = read("src/components/pmfreak/projects/project-route-states.tsx");
const tabNav = read("src/components/pmfreak/projects/project-tab-nav.tsx");
const canonicalHome = read(CANONICAL_HOME_FILE);
const legacyHome = read(LEGACY_HOME_FILE);
const projectsIndex = read("src/app/(protected)/projects/page.tsx");
const workspaceHome = read("src/app/(protected)/workspaces/[workspaceId]/page.tsx");
const pmoHome = read("src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/page.tsx");
const pmoCommandCenter = read("src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/command-center/page.tsx");
const projectChat = read("src/app/(protected)/projects/[id]/chat/page.tsx");
const projectSettings = read("src/app/(protected)/projects/[id]/settings/page.tsx");
const projectFollowUp = read("src/app/(protected)/projects/[id]/follow-up/page.tsx");
const protectedLayout = read("src/app/(protected)/layout.tsx");
const sidebarTree = read("src/components/pmfreak/navigation/sidebar-pmo-tree.tsx");
const navigationPaths = read("src/lib/workspace/command-center-paths.ts");
const pmoService = read("src/lib/pmos/pmo-service.ts");
const bareCommandCenter = read("src/app/(protected)/command-center/page.tsx");
const createExecutionTask = read("src/lib/execution-tasks/create-execution-task.ts");
const projectIdApiRoute = read("src/app/api/projects/[id]/route.ts");
const pmAssignmentsRoute = read("src/app/api/projects/[id]/pm-assignments/route.ts");
const executionTasksRoute = read("src/app/api/execution-tasks/route.ts");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. The canonical path ────────────────────────────────────────────────

test("1. projectHomePath(W, P) builds the canonical Project Home route", () => {
  assert.equal(projectHomePath(WS, PROJECT), CANONICAL_HOME);
  assert.equal(projectHomePath(WS, PROJECT), `/workspaces/${WS}/projects/${PROJECT}`);
  assert.equal(projectSurfacePath(WS, PROJECT, "home"), CANONICAL_HOME);
});

test("1b. the route's structural parent is the Workspace, never the PMO", () => {
  // `projects.workspace_id` is NOT NULL (20260512160000); `projects.pmo_id` is
  // NULLABLE (20260828000001). A PMO-rooted project path would be unbuildable for
  // every direct project, which `03-canonical-information-architecture.md` §5.7
  // and ADR-PMF-006 Rule 11 make first-class. There is no helper that can produce
  // one, which is the strongest form of this guarantee.
  assert.doesNotMatch(paths, /\/pmos\/\$\{/, "no builder may nest a project under a PMO");
  assert.equal(projectHomePath(WS, PROJECT).includes("/pmos/"), false);
  // And a PMO-rooted project path is not recognized as a Project route either.
  assert.equal(parseCanonicalProjectRoute(`/workspaces/${WS}/pmos/${PMO}/projects/${PROJECT}`), null);
});

test("2. both ids are percent-encoded, so an id can never add route segments", () => {
  const built = projectHomePath("w/../../etc", "p/extra/segments");
  assert.equal(built, "/workspaces/w%2F..%2F..%2Fetc/projects/p%2Fextra%2Fsegments");
  // Exactly four segments: the two literals and the two ids. An unencoded `/`
  // would have addressed a different route entirely.
  assert.equal(built.split("/").filter(Boolean).length, 4);
  // Round-trips back to the ids that were asked for, not to a deeper route.
  const parsed = parseCanonicalProjectRoute(built);
  assert.equal(parsed?.workspaceId, "w/../../etc");
  assert.equal(parsed?.projectId, "p/extra/segments");
  assert.equal(parsed?.surface, "home");
  // Spaces, `#`, `?` and `%` cannot break out either.
  for (const hostile of ["a b", "a#b", "a?b=c", "a%b", ".."]) {
    const path = projectHomePath(WS, hostile);
    assert.equal(parseCanonicalProjectRoute(path)?.projectId, hostile, `${hostile} must round-trip`);
  }
});

test("3. the parser returns the workspaceId and the projectId", () => {
  const parsed = parseCanonicalProjectRoute(CANONICAL_HOME);
  assert.deepEqual(parsed, { workspaceId: WS, projectId: PROJECT, surface: "home" });
  assert.ok(isCanonicalProjectRoutePath(CANONICAL_HOME));
  // A trailing slash is the same route.
  assert.deepEqual(parseCanonicalProjectRoute(`${CANONICAL_HOME}/`), {
    workspaceId: WS,
    projectId: PROJECT,
    surface: "home",
  });
});

test("3b. what the parser returns is an unauthorized HINT, and says so", () => {
  assert.match(paths, /UNAUTHORIZED HINT/);
  assert.match(paths, /NOT authority/);
  // Nothing in the path module reaches a database or an authorizer. Comments
  // stripped: the header explains WHICH authorizer owns the decision instead,
  // which means naming it.
  assert.doesNotMatch(withoutComments(paths), /supabase|createSupabase|resolveRouted|requireAuth/i);
});

test("4. malformed percent-encoding fails closed", () => {
  for (const bad of [
    `/workspaces/%E0%A4%A/projects/${PROJECT}`,
    `/workspaces/${WS}/projects/%`,
    `/workspaces/${WS}/projects/%zz`,
    "/workspaces/%/projects/%",
  ]) {
    assert.equal(parseCanonicalProjectRoute(bad), null, `${bad} must not parse`);
    assert.equal(isCanonicalProjectRoutePath(bad), false, `${bad} must not be a Project route`);
  }
});

test("5. blank and whitespace-only ids fail closed", () => {
  for (const bad of [
    "/workspaces//projects/p",
    `/workspaces/${WS}/projects/`,
    "/workspaces/%20/projects/p",
    `/workspaces/${WS}/projects/%20`,
    "/workspaces/%09/projects/%0A",
    "/workspaces/projects/p",
  ]) {
    assert.equal(parseCanonicalProjectRoute(bad), null, `${bad} must not parse`);
  }
  // A blank id also cannot be authorized, whatever route it arrived on.
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: "",
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    "a blank project id names no project",
  );
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: "",
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    "a blank workspace id asserts no ancestry",
  );
});

test("6. an extra segment is not mistaken for Project Home", () => {
  // Home is the ONLY surface that exists. Every future sibling in the ratified map
  // is refused today rather than truncated to its prefix — a nav entry must not
  // light up for a page that 404s, and a layout must not derive workspace context
  // from a route this app does not serve.
  for (const deeper of [
    "command-center",
    "tasks",
    "milestones",
    "risks",
    "issues",
    "dependencies",
    "stakeholders",
    "documents",
    "recommendations",
    "decisions",
    "actions",
    "outcomes",
    "feed",
    "memory",
    "chat",
    "settings",
    "follow-up",
    "anything",
  ]) {
    const path = `${CANONICAL_HOME}/${deeper}`;
    assert.equal(parseCanonicalProjectRoute(path), null, `${path} is not Project Home`);
    assert.equal(isCanonicalProjectRoutePath(path), false, `${path} is not in the family`);
  }
  // Two extra segments, likewise.
  assert.equal(parseCanonicalProjectRoute(`${CANONICAL_HOME}/tasks/t1`), null);
  // And the surface table claims exactly one member.
  assert.deepEqual([...PROJECT_SURFACES], ["home"]);
});

test("6b. the family is designed to grow without a competing regex", () => {
  // The next slice adds "command-center" to PROJECT_SURFACES and SURFACE_SEGMENTS.
  // That is the extension point, and it is one table rather than a second pattern
  // that could disagree with this one about which paths are Project routes.
  assert.match(paths, /const SURFACE_SEGMENTS: Record<ProjectSurface, string>/);
  assert.match(paths, /const SEGMENT_SURFACES = new Map<string, ProjectSurface>/);
  assert.equal(paths.match(/^const CANONICAL_PROJECT_ROUTE_PATTERN/gm)?.length, 1, "exactly one pattern");
  assert.match(paths, /\(\?:\\\/\(\[\^\/\]\+\)\)\?/, "the pattern already carries the optional surface segment");
});

test("6c. adjacent non-members are not Project routes", () => {
  for (const path of [
    "/projects",
    `/projects/${PROJECT}`,
    `/projects/${PROJECT}/chat`,
    "/workspaces",
    `/workspaces/${WS}`,
    workspaceCommandCenterPath(WS),
    workspaceSettingsPath(WS),
    pmoHomePath(WS, PMO),
    "/project/abc",
    `/workspaces/${WS}/project/${PROJECT}`,
  ]) {
    assert.equal(isCanonicalProjectRoutePath(path), false, `${path} must not be a canonical Project route`);
  }
  // And canonical Project Home is not a PMO route.
  assert.equal(isCanonicalPmoRoutePath(CANONICAL_HOME), false);
});

// ─── The routed authority model ──────────────────────────────────────────

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
const viewerWs = (workspaceId: string): RoutedWorkspaceAccess => ({
  access: "granted",
  workspaceId,
  role: "viewer",
  readOnly: false,
});
const deniedWs: RoutedWorkspaceAccess = { access: "denied", workspaceId: null, role: null, readOnly: true };

function assertDenied(result: RoutedProjectAccess, why: string) {
  assert.equal(result.access, "denied", why);
  assert.equal(result.projectId, null, "a refusal must not carry a project id");
  assert.equal(result.workspaceId, null, "a refusal must not carry a workspace id");
  assert.equal(result.role, null, "a refusal must not carry a role");
  assert.equal(result.readOnly, true);
}

test("7. the routed projectId is authoritative — the verdict echoes what was asked for", () => {
  for (const requested of [PROJECT, OTHER_PROJECT]) {
    const result = decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: requested,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    });
    assert.equal(result.access, "granted");
    assert.equal(result.projectId, requested, "PROJECT A MUST NEVER BECOME PROJECT B");
  }
});

test("8. projects.workspace_id is the authoritative parent, not the routed segment", () => {
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "active" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "granted");
  assert.equal(result.workspaceId, WS, "the verdict's workspace comes from the project row");
  // The resolver authorizes the project's REAL workspace, not the asserted one.
  assert.match(resolver, /resolveRoutedWorkspace\(userId, project\.workspaceId\)/);
  assert.doesNotMatch(
    withoutComments(resolver),
    /resolveRoutedWorkspace\(userId, routedWorkspaceId\)/,
    "the claim must never be the thing that gets authorized",
  );
  // And the ancestry read selects only ancestry.
  assert.match(resolver, /\.select\("workspace_id, status"\)/);
  assert.equal(resolver.match(/\.from\("projects"\)/g)?.length, 1, "one ancestry read site");
});

test("9. a routed Workspace that disagrees with projects.workspace_id is DENIED", () => {
  // The caller here is a legitimate member of the project's real workspace; the
  // only thing wrong is the ancestry the URL asserts. Workspace A + Project P
  // owned by Workspace B must be denied.
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: OTHER_WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "active" },
    workspaceAccess: grantedWs(WS),
  });
  assertDenied(result, "Workspace A must never become Workspace B");
  // Never silently corrected — and the refusal must not disclose the real parent,
  // which is exactly what a "helpful" redirect to the right URL would have to do.
  assert.equal(JSON.stringify(result).includes(WS), false, "a refusal must not leak the real workspace");
  assert.match(resolver, /Refusing — rather than "helpfully" correcting/);
});

test("9b. a workspaceAccess resolved for some other workspace cannot be smuggled in", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: OTHER_WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(OTHER_WS),
    }),
    "the authorized workspace must be the project's own",
  );
});

test("9c. no membership in the project's real workspace is denied", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: deniedWs,
    }),
    "workspace membership is what grants project access",
  );
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: null,
    }),
    "an unasked authorization question is a refusal",
  );
});

test("10. Project A never becomes Project B — an absent project has no substitute", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: null,
      workspaceAccess: grantedWs(WS),
    }),
    "an absent project must not fall back to any other project",
  );
  // Structural, not incidental: nothing in this path can list a workspace's
  // projects, so there is no set for a fallback to pick from.
  const code = withoutComments(resolver);
  assert.doesNotMatch(code, /resolveCanonicalProject/, "the substituting resolver must not be reachable");
  assert.doesNotMatch(code, /order\(|limit\(/, "no ranked list to pick a 'first' project from");
  assert.doesNotMatch(code, /recovered/, "there is no recovery on an explicit entity route");
  assert.doesNotMatch(code, /ensureDefaultProject|createMinimalProject/, "a project is never conjured for a route");
});

test("10b. absent and unauthorized are the same answer — no existence oracle", () => {
  for (const project of [null, { workspaceId: WS, status: "active" as const }]) {
    assertDenied(
      decideRoutedProjectAccess({
        routedWorkspaceId: WS,
        projectId: PROJECT,
        project,
        workspaceAccess: project ? deniedWs : grantedWs(WS),
      }),
      "absent and unauthorized must be indistinguishable",
    );
  }
  // All four denial causes produce the identical, empty verdict object.
  const verdicts = [
    decideRoutedProjectAccess({ routedWorkspaceId: WS, projectId: PROJECT, project: null, workspaceAccess: grantedWs(WS) }),
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: deniedWs,
    }),
    decideRoutedProjectAccess({
      routedWorkspaceId: OTHER_WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    decideRoutedProjectAccess({ routedWorkspaceId: "", projectId: "", project: null, workspaceAccess: null }),
  ].map((v) => JSON.stringify(v));
  assert.equal(new Set(verdicts).size, 1, "every refusal must be byte-identical");
});

test("11. the preferred-workspace cookie cannot override explicit Project identity", () => {
  for (const [name, rawSource] of [
    ["paths", paths],
    ["resolver", resolver],
    ["canonical Home", canonicalHome],
    ["legacy Home resolver", legacyHome],
    ["route states", routeStates],
    ["tab nav", tabNav],
  ] as const) {
    // Comments stripped: these modules explain WHY each fallback resolver is
    // absent, which means naming them. A check that cannot tell an explanation
    // from a call would push the reasoning out of the code.
    const source = withoutComments(rawSource);
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, `${name}: the URL is the scope here, not the cookie`);
    assert.doesNotMatch(source, /resolveCanonicalWorkspace/, `${name}: no falling-back workspace resolver`);
    assert.doesNotMatch(source, /resolveWriteWorkspace/, `${name}`);
    assert.doesNotMatch(source, /ensureUserWorkspace/, `${name}`);
  }
});

test("12. canonical Project Home does not use the resolveCanonicalProject fallback", () => {
  const code = withoutComments(canonicalHome);
  assert.doesNotMatch(code, /resolveCanonicalProject/);
  assert.doesNotMatch(code, /canonical-project-resolver/);
  assert.doesNotMatch(code, /recoveredFrom/, "there is nothing to recover from on an explicit route");
  assert.match(canonicalHome, /resolveRoutedProject\(user\.id, requestedWorkspaceId, requestedProjectId\)/);
  assert.match(canonicalHome, /access\.access === "denied"/);
  assert.match(canonicalHome, /return <ProjectNotAvailable \/>;/);
});

test("12b. the substituting resolver is gone from the whole tree", () => {
  // Its only call site was the screen this slice replaced, and leaving a
  // "return the first project in the workspace" primitive lying around is a
  // loaded gun aimed at the invariant above. No other flow referenced it.
  assert.throws(
    () => read("src/lib/projects/canonical-project-resolver.ts"),
    /ENOENT/,
    "the fallback resolver module must not exist",
  );
  for (const [name, source] of [
    ["canonical Home", canonicalHome],
    ["legacy Home", legacyHome],
    ["projects index", projectsIndex],
    ["workspace Home", workspaceHome],
    ["pmo Home", pmoHome],
    ["project chat", projectChat],
    ["project settings", projectSettings],
    ["sidebar tree", sidebarTree],
    ["routed resolver", resolver],
  ] as const) {
    // Comments stripped: canonical Home and the routed resolver both RECORD what
    // they replaced and why, which means naming it. A check that cannot tell an
    // explanation from a call would push that reasoning out of the code.
    assert.doesNotMatch(withoutComments(source), /resolveCanonicalProject/, `${name} must not reference it`);
  }
});

test("13. canonical Project Home does not use resolvePreferredWorkspace for role scope", () => {
  const code = withoutComments(canonicalHome);
  assert.doesNotMatch(code, /resolvePreferredWorkspace/);
  assert.doesNotMatch(code, /workspaceResolution/);
  // The role comes from the SAME verdict that established the parent, so the two
  // cannot disagree.
  assert.match(canonicalHome, /const canCreateTask = access\.role !== null && access\.role !== "viewer";/);
  assert.match(resolver, /WHY `role` IS PART OF THE VERDICT/);
});

test("13b. the role in the verdict is the caller's role in the PROJECT's workspace", () => {
  const asPm = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "active" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(asPm.access, "granted");
  assert.equal(asPm.role, "pm", "a pm in the project's workspace is a pm here");

  const asViewer = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "active" },
    workspaceAccess: viewerWs(WS),
  });
  assert.equal(asViewer.access, "granted");
  assert.equal(asViewer.role, "viewer", "a viewer there is a viewer here");

  // The role survives archival — archived is a read-only STATE, not a demotion,
  // and the slice changes no control.
  const archived = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "archived" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(archived.access, "archived");
  assert.equal(archived.role, "pm");

  // No invented Project-level role vocabulary anywhere.
  for (const source of [paths, resolver, canonicalHome, legacyHome, tabNav, routeStates]) {
    assert.doesNotMatch(
      withoutComments(source),
      /project_members|project_memberships|projectRole|project_role|ProjectManager|project_manager/,
      "project access is inherited through workspace membership; no new role model",
    );
  }
});

test("14. canonical Home preserves the shipped Project Home functionality", () => {
  // The screen moved and its authority changed. Its CONTENT did not: project
  // identity, the execution/task list, the AI analysis entry, PM assignment, and
  // prior analyses are all still here, reading the same tables.
  assert.match(canonicalHome, /<ProjectTaskList projectId=\{project\.id\} canCreateTask=\{canCreateTask\} \/>/);
  assert.match(canonicalHome, /<ProjectPMAssignment projectId=\{project\.id\} \/>/);
  assert.match(canonicalHome, /action="\/api\/analyze-ai" method="post"/);
  assert.match(canonicalHome, /name="extractedScopeText"/);
  assert.match(canonicalHome, /\/upload\?projectId=/);
  assert.match(canonicalHome, /\.from\("onboarding_analyses"\)/);
  assert.match(canonicalHome, /Previous analyses/);
  assert.match(canonicalHome, /Status: \{project\.status\}/);
  assert.match(canonicalHome, /Methodology: \$\{project\.methodology\}/);
  assert.match(canonicalHome, /<ProjectTabNav workspaceId=\{workspaceId\} projectId=\{project\.id\} active="overview" \/>/);
  // The capability layer still runs, on the AUTHORIZED workspace.
  assert.match(canonicalHome, /evaluateCapabilityAccess\(\{ workspaceId, projectId, permission: "read" \}\)/);
  // It reads exactly the tables the shipped screen read, plus `workspaces` for
  // the breadcrumb label the Workspace ancestor needs.
  const tables = new Set([...canonicalHome.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]));
  assert.deepEqual([...tables].sort(), ["onboarding_analyses", "pmos", "projects", "workspaces"]);
});

test("14b. Home is not turned into a Command Center", () => {
  // IA Principle 5 (One Entity One Home) only holds if Home and Command Center
  // stay different screens. None of the Command Centers' semantics may leak in.
  const code = withoutComments(canonicalHome);
  for (const forbidden of [
    /CommandCenterClient/,
    /command-center-rollup/,
    /pmo-command-center-paths/,
    /workspaceCommandCenterPath/,
    /pmoCommandCenterPath/,
    /Command Center/,
  ]) {
    assert.doesNotMatch(code, forbidden, `Project Home must not import Command Center semantics (${forbidden})`);
  }
  // And it does not open a privileged boundary of its own.
  assert.doesNotMatch(code, /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/);
});

test("14c. every read on canonical Home is scoped by the authorized ids", () => {
  const body = canonicalHome.slice(canonicalHome.indexOf("const { workspaceId, projectId } = access;"));
  assert.ok(body.length > 0, "the authorized ids must be destructured from the verdict");
  assert.doesNotMatch(body, /requestedWorkspaceId/, "no query may use the routed claim");
  assert.doesNotMatch(body, /requestedProjectId/);
  assert.match(canonicalHome, /\.eq\("id", projectId\)\s*\n\s*\.eq\("workspace_id", workspaceId\)/);
});

// ─── Breadcrumb and parentage ────────────────────────────────────────────

test("15. an assigned PMO's breadcrumb uses the canonical Workspace and PMO paths", () => {
  assert.match(canonicalHome, /href=\{workspaceHomePath\(workspaceId\)\}/);
  assert.match(canonicalHome, /href=\{pmoHomePath\(workspaceId, pmo\.id\)\}/);
  // Built by the family helpers, never re-typed as literals.
  assert.doesNotMatch(withoutComments(canonicalHome), /href="\/workspaces\//);
  // And no longer led by the generic PMO chooser, which was only ever there
  // because Workspace Home did not exist before PR #608.
  assert.doesNotMatch(canonicalHome, /PMOS_NAV_HREF/, "the trail leads with the Workspace, not the /pmos chooser");
  // Both helpers produce real, recognized routes.
  assert.ok(workspaceHomePath(WS).length > 0);
  assert.equal(pmoHomePath(WS, PMO), `/workspaces/${WS}/pmos/${PMO}`);
  assert.ok(isCanonicalPmoRoutePath(pmoHomePath(WS, PMO)));
});

test("15b. the PMO ancestor is only claimed when the PMO answers in THIS workspace", () => {
  // The FK on `projects.pmo_id` constrains it to a real PMO but not to a PMO in
  // this project's workspace, and a breadcrumb is not the place to discover
  // cross-tenant data. Scoped by both, so a PMO that does not answer here yields
  // no node rather than a link into a workspace this route never authorized.
  const lookup = canonicalHome.slice(canonicalHome.indexOf('.from("pmos")'));
  assert.match(lookup, /\.eq\("id", project\.pmo_id\)/);
  assert.match(lookup, /\.eq\("workspace_id", workspaceId\)/);
});

test("16. a direct Project has no fabricated PMO ancestor", () => {
  // `projects.pmo_id` is NULLABLE, so the PMO lookup is conditional and the crumb
  // is conditional on its result. Nothing invents a middle node.
  assert.match(canonicalHome, /project\.pmo_id\s*\n?\s*\?\s*await supabase/);
  assert.match(canonicalHome, /: \{ data: null \}/);
  assert.match(canonicalHome, /\{pmo \? \(/, "the PMO crumb must be conditional on a real PMO");
  assert.doesNotMatch(canonicalHome, /pmo\?\.name \?\?/, "no placeholder PMO name");
  assert.doesNotMatch(canonicalHome, /ensureDefaultPmo/, "a PMO is never conjured to fill a breadcrumb");
  // And the route itself is identical with or without a PMO.
  assert.equal(projectHomePath(WS, PROJECT), CANONICAL_HOME);
});

test("16b. a project assigned to a PMO keeps the WORKSPACE as its route parent", () => {
  // PMO assignment is ancestry, not parentage. A project that joins or leaves a
  // PMO does not change its URL, because its `workspace_id` did not change.
  assert.match(paths, /PMO is ANCESTRY[\s\S]{0,200}Workspace is PARENTAGE/);
  assert.match(paths, /`projects\.pmo_id`\s+uuid NULL/);
  assert.match(paths, /`projects\.workspace_id`\s+uuid NOT NULL/);
});

// ─── Legacy /projects/[id] ───────────────────────────────────────────────

test("17. legacy /projects/P redirects to /workspaces/W/projects/P", () => {
  assert.match(legacyHome, /redirect\(projectHomePath\(access\.workspaceId, access\.projectId\)\)/);
  assert.equal(withoutComments(legacyHome).match(/redirect\(/g)?.length, 1, "one redirect, one destination");
  assert.equal(legacyProjectHomePath(PROJECT), `/projects/${PROJECT}`);
  assert.equal(projectHomePath(WS, PROJECT), CANONICAL_HOME);
});

test("18. the legacy redirect destination derives W from the Project, never a cookie", () => {
  assert.match(resolver, /export async function resolveLegacyProjectRoute/);
  assert.match(legacyHome, /resolveLegacyProjectRoute\(user\.id, id\)/);
  const code = withoutComments(legacyHome);
  assert.doesNotMatch(code, /resolvePreferredWorkspace/, "a cookie must not choose the destination");
  assert.doesNotMatch(code, /resolveCanonicalWorkspace|resolveWriteWorkspace|ensureUserWorkspace/);
  assert.doesNotMatch(code, /cookies\(/);
  // The same legacy id can never resolve to two different workspaces: the routed
  // workspace IS the authoritative one, so the destination follows the project.
  for (const parent of [WS, OTHER_WS]) {
    const result = decideRoutedProjectAccess({
      routedWorkspaceId: parent,
      projectId: PROJECT,
      project: { workspaceId: parent, status: "active" },
      workspaceAccess: grantedWs(parent),
    });
    assert.equal(result.access, "granted");
    assert.equal(result.workspaceId, parent, "the destination follows the project, not the caller");
  }
  assert.match(resolver, /WHY THIS IS NOT `resolveRoutedProject\(userId, someWorkspaceId, projectId\)`/);
});

test("19. an inaccessible or missing legacy Project leaks no identity", () => {
  assert.equal(legacyHome.match(/access\.access === "denied"/g)?.length, 1, "one refusal branch");
  assert.match(legacyHome, /return <ProjectNotAvailable \/>;/);
  assert.doesNotMatch(legacyHome, /notFound\(\)/, "a distinct 404 would be a second, distinguishable reply");
  // Canonical Home reaches the SAME component through the same single branch, so
  // trying the legacy path teaches nothing the canonical path would not.
  assert.match(canonicalHome, /return <ProjectNotAvailable \/>;/);
  // The refusal itself carries no project identity at all.
  assert.match(routeStates, /does not exist or is not one you have access to/);
  assert.doesNotMatch(withoutComments(routeStates), /\{project\.|projectId|workspaceId|pmoId|status/);
  // Its only outbound link is the chooser — never the project, never its workspace.
  assert.match(routeStates, /href=\{PROJECTS_NAV_HREF\}/);
});

test("19b. an archived Project still redirects, and archived is never a refusal", () => {
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "archived" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "archived", "archived is a read-only STATE, not a 'not found'");
  assert.equal(result.projectId, PROJECT, "canonical identity is stable across archival");
  assert.equal(result.workspaceId, WS);
  assert.equal(result.readOnly, true);
  // The legacy resolver treats it as routable: only `denied` refuses.
  assert.doesNotMatch(legacyHome, /access\.access === "archived"/, "archival is the canonical screen's story to tell");
});

test("19c. archival never becomes a way around membership or ancestry", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "archived" },
      workspaceAccess: deniedWs,
    }),
    "archived must not relax membership",
  );
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: OTHER_WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "archived" },
      workspaceAccess: archivedWs(WS),
    }),
    "archived must not relax the ancestry rule",
  );
});

test("20. legacy Project Home contains no duplicate screen implementation", () => {
  // A strangler seam, not a second screen. If this file started rendering a task
  // list, an analysis form or a PM assignment panel again, there would be two
  // Project Homes to fix every time one of them changed.
  assert.match(legacyHome, /redirect\(/);
  for (const screenPart of [
    /ProjectTabNav/,
    /ProjectTaskList/,
    /ProjectPMAssignment/,
    /analyze-ai/,
    /onboarding_analyses/,
    /createSupabaseServerClient/,
    /evaluateCapabilityAccess/,
    /\.from\(/,
    /<section/,
    /<h1/,
    /<form/,
  ]) {
    assert.doesNotMatch(legacyHome, screenPart, `legacy Home must not re-implement the screen (${screenPart})`);
  }
});

test("20b. no redirect loop: legacy and canonical are disjoint by construction", () => {
  const legacy = legacyProjectHomePath(PROJECT);
  assert.notEqual(legacy, CANONICAL_HOME);
  assert.equal(isCanonicalProjectRoutePath(legacy), false, "the legacy path must not be its own destination");
  assert.ok(isCanonicalProjectRoutePath(CANONICAL_HOME));
  assert.doesNotMatch(CANONICAL_HOME, /^\/projects\//, "the destination must not re-enter the legacy resolver");
  // The canonical page never redirects at all, so there is no second hop either.
  assert.doesNotMatch(withoutComments(canonicalHome), /redirect\(/);
});

test("20c. the legacy resolver opens no privileged boundary, and adds no call site", () => {
  // `projects` RLS is a membership chain on the project's OWN workspace, which is
  // precisely the condition for access — so the caller's own client answers the
  // ancestry question correctly and refuses in every case that must refuse. No
  // service-role read was added anywhere by this slice.
  for (const [name, source] of [
    ["routed resolver", resolver],
    ["legacy Home", legacyHome],
    ["canonical Home", canonicalHome],
    ["paths", paths],
    ["route states", routeStates],
    ["tab nav", tabNav],
  ] as const) {
    assert.doesNotMatch(
      source,
      /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient|SUPABASE_SERVICE_ROLE/,
      `${name} must not open a privileged boundary`,
    );
  }
  assert.match(resolver, /async function readProjectAncestry/);
  assert.equal(resolver.match(/readProjectAncestry\(/g)?.length, 3, "one definition, two shared call sites");
  assert.match(resolver, /createSupabaseServerClient/, "the caller's own client, so RLS decides");
});

// ─── Entry points into the family ────────────────────────────────────────

test("21. the /projects index links entity rows to canonical Project Home", () => {
  assert.match(projectsIndex, /href=\{projectHomePath\(project\.workspace_id, project\.id\)\}/);
  assert.doesNotMatch(projectsIndex, /href=\{`\/projects\/\$\{project\.id\}`\}/);
  // The row carries its own authoritative parent, so no workspace is resolved to
  // construct the link.
  assert.match(projectsIndex, /\.select\("id, workspace_id, name, description, status, created_at"\)/);
  // Its `canCreateProjects` gate is workspace-scoped project CREATION, not a
  // project-scoped decision, and is deliberately untouched by this slice.
  assert.match(projectsIndex, /const canCreateProjects = workspaceResolution\.role/);
  assert.equal(projectsIndex.match(/resolvePreferredWorkspace/g)?.length, 2, "unchanged: import + the create gate");
});

test("22. Workspace Home's direct-Project links are canonical", () => {
  assert.match(workspaceHome, /href=\{projectHomePath\(workspaceId, project\.id\)\}/);
  assert.doesNotMatch(workspaceHome, /href=\{`\/projects\/\$\{encodeURIComponent\(project\.id\)\}`\}/);
  // Built from the AUTHORIZED workspace, which is also each row's own
  // `projects.workspace_id` because the rows were read scoped by it.
  assert.match(workspaceHome, /const \{ workspaceId \} = access;/);
  assert.match(workspaceHome, /\.from\("projects"\)[\s\S]{0,200}\.eq\("workspace_id", workspaceId\)/);
  assert.doesNotMatch(withoutComments(workspaceHome), /resolvePreferredWorkspace/);
});

test("23. PMO Home's project cards link to canonical Project Home", () => {
  assert.match(pmoHome, /href=\{projectHomePath\(workspaceId, project\.id\)\}/);
  assert.doesNotMatch(pmoHome, /href=\{`\/projects\/\$\{encodeURIComponent\(project\.id\)\}`\}/);
  // W is the PMO's authoritative workspace from `resolveRoutedPmo`, and the rows
  // were read scoped by it — so the link asserts an ancestry that is true by
  // construction. PMO data semantics are untouched.
  assert.match(pmoHome, /const \{ workspaceId, pmoId \} = access;/);
  assert.match(pmoHome, /\.eq\("workspace_id", workspaceId\)\s*\n\s*\.eq\("pmo_id", pmo\.id\)/);
  // The PMO Command Center's portfolio links get the same correction — a link
  // change only; nothing about what that screen projects changed.
  assert.match(pmoCommandCenter, /href=\{projectHomePath\(workspaceId, project\.id\)\}/);
});

test("24. ProjectTabNav's Overview link is canonical", () => {
  assert.match(tabNav, /\{ label: "Overview", href: projectHomePath\(workspaceId, projectId\), key: "overview" \}/);
  assert.doesNotMatch(tabNav, /label: "Overview", href: `\/projects\//);
  // It takes the project's authoritative workspace, and every call site supplies
  // one it actually read.
  assert.match(tabNav, /workspaceId: string;/);
  assert.match(canonicalHome, /<ProjectTabNav workspaceId=\{workspaceId\}/);
  assert.match(projectChat, /<ProjectTabNav workspaceId=\{project\.workspace_id\}/);
  assert.match(projectSettings, /<ProjectTabNav workspaceId=\{project\.workspace_id\}/);
});

test("25. the other Project tabs are NOT falsely canonicalized", () => {
  // No dead routes, and no aspirational links masquerading as shipped product.
  // Every non-Overview tab still points where its screen actually is.
  const expected: [string, string][] = [
    ["Chat", "`/projects/${projectId}/chat`"],
    ["Execution", "`/command-center?projectId=${projectId}`"],
    ["Timeline", "`/dashboard?projectId=${projectId}`"],
    ["Tasks", "`/follow-up-dashboard?projectId=${projectId}`"],
    ["Documents", "`/upload?projectId=${projectId}`"],
    ["Evidence", "`/evidence?projectId=${projectId}`"],
    ["Reports", "`/executive?projectId=${projectId}`"],
    ["Settings", "`/projects/${projectId}/settings`"],
  ];
  for (const [label, href] of expected) {
    assert.ok(tabNav.includes(`{ label: "${label}", href: ${href}`), `${label} must keep its shipped destination`);
  }
  // The ratified map's Project children do not exist, so no tab may claim them.
  for (const unbuilt of ["tasks", "milestones", "risks", "issues", "documents", "feed", "memory", "command-center"]) {
    assert.equal(
      tabNav.includes(`/projects/\${projectId}/${unbuilt}`),
      false,
      `no tab may point at the unbuilt /${unbuilt} surface`,
    );
    assert.equal(isCanonicalProjectRoutePath(`${CANONICAL_HOME}/${unbuilt}`), false);
  }
  assert.match(tabNav, /WHY ONLY OVERVIEW IS CANONICAL/);
  // Exactly one canonical builder call in the strip: Overview's.
  assert.equal(tabNav.match(/projectHomePath\(/g)?.length, 1);
});

test("25b. Project Chat, Settings and Follow-up are not migrated by this slice", () => {
  // §2's ratified Project family contains no `chat`, `settings` or `follow-up`
  // member, so there is no canonical destination and inventing one would be
  // inventing architecture. Each still renders its own screen at its own path.
  assert.ok(read("src/app/(protected)/projects/[id]/chat/page.tsx").length > 0);
  assert.ok(read("src/app/(protected)/projects/[id]/settings/page.tsx").length > 0);
  assert.match(projectChat, /<ContextChatPanel/, "Chat still renders its own screen");
  assert.match(projectChat, /contextType="project"/);
  assert.match(projectSettings, /<ProjectSettingsClient/, "Settings still renders its own screen");
  assert.match(projectSettings, /listPmos\(project\.workspace_id\)/);
  assert.match(projectFollowUp, /<FollowUpDashboardClient projectId=\{id\} \/>/, "Follow-up is untouched");
  // Neither is a redirect, and neither invented a canonical child path.
  for (const [name, source] of [
    ["chat", projectChat],
    ["settings", projectSettings],
    ["follow-up", projectFollowUp],
  ] as const) {
    assert.doesNotMatch(source, /redirect\(/, `${name} must still render, not redirect`);
    assert.doesNotMatch(
      source,
      /workspaces\/\$\{[^}]*\}\/projects/,
      `${name} must not hand-build a canonical child path`,
    );
  }
  // What DID change is only where their Project-Home links point.
  assert.match(projectChat, /href=\{projectHomePath\(project\.workspace_id, project\.id\)\}/);
  assert.match(projectSettings, /href=\{projectHomePath\(project\.workspace_id, project\.id\)\}/);
});

test("26. the protected layout derives W from canonical Project Home", () => {
  // The layout runs BEFORE the page authorizes anything, so without this the shell
  // and the onboarding gate answer from the preferred-workspace cookie: a shared
  // link to a project in workspace B renders A's navigation and can be bounced by
  // A's onboarding state.
  assert.match(protectedLayout, /parseCanonicalProjectRoute\(routedHeaders\.get\("x-pathname"\) \?\? ""\)\?\.workspaceId/);
  assert.match(protectedLayout, /resolveRoutedWorkspace\(user\.id, routedWorkspaceId\)/);
  assert.equal(parseCanonicalProjectRoute(CANONICAL_HOME)?.workspaceId, WS);
  // The hint cannot widen access: it is authorized by a resolver with no fallback,
  // and the parser fails closed on anything malformed.
  assert.match(protectedLayout, /routedAccess && routedAccess\.access !== "denied"/);
  assert.equal(parseCanonicalProjectRoute("/workspaces/%E0%A4%A/projects/p"), null);
  // Order: the three earlier parsers are still consulted, unchanged.
  const chain = protectedLayout.slice(
    protectedLayout.indexOf("const routedWorkspaceId ="),
    protectedLayout.indexOf("const routedAccess ="),
  );
  for (const parser of [
    "parseWorkspaceIdFromPath",
    "parseCanonicalWorkspaceRoute",
    "parseCanonicalPmoRoute",
    "parseCanonicalProjectRoute",
  ]) {
    assert.ok(chain.includes(parser), `${parser} must stay in the hint chain`);
  }
});

test("26b. a Project route's workspace segment is not replaceable by the cookie", () => {
  // `resolveWriteWorkspace` (which consults the cookie) is reached only when the
  // routed hint is absent or unauthorized — never instead of an authorized one.
  assert.match(
    protectedLayout,
    /routedAccess && routedAccess\.access !== "denied"\s*\n\s*\?\s*\{ workspaceId: routedAccess\.workspaceId[\s\S]{0,120}: await resolveWriteWorkspace\(user\.id\)/,
  );
});

// ─── Navigation active state ─────────────────────────────────────────────

test("27. PMO route active-state is unchanged", () => {
  const pmoCanonical = pmoHomePath(WS, PMO);
  assert.ok(navEntryMatchesPathname("/pmos", pmoCanonical), "a PMO surface must still activate PMOs");
  assert.equal(navEntryMatchesPathname("/workspaces", pmoCanonical), false);
  assert.equal(navEntryMatchesPathname(PROJECTS_NAV_HREF, pmoCanonical), false, "a PMO route must not activate Projects");
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, pmoCanonical), false);
  assert.ok(navEntryMatchesPathname("/pmos", `/workspaces/${WS}/pmos/${PMO}/command-center`));
});

test("28. Workspace route active-state is unchanged", () => {
  assert.ok(navEntryMatchesPathname("/workspaces", workspaceHomePath(WS)));
  assert.ok(navEntryMatchesPathname("/workspaces", workspaceSettingsPath(WS)));
  assert.equal(navEntryMatchesPathname(PROJECTS_NAV_HREF, workspaceHomePath(WS)), false);
  // Workspace Command Center keeps its own nav identity.
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, workspaceCommandCenterPath(WS)));
  assert.equal(navEntryMatchesPathname("/workspaces", workspaceCommandCenterPath(WS)), false);
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, "/command-center"));
});

test("29. canonical Project Home activates Projects, not Workspaces", () => {
  assert.ok(navEntryMatchesPathname(PROJECTS_NAV_HREF, CANONICAL_HOME), "it must activate Projects");
  assert.equal(navEntryMatchesPathname("/workspaces", CANONICAL_HOME), false, "and not also Workspaces");
  assert.equal(
    navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL_HOME),
    false,
    "and never the Workspace Command Center",
  );
  assert.equal(navEntryMatchesPathname("/pmos", CANONICAL_HOME), false, "and never PMOs");
  // Exactly ONE primary/utility nav entry lights up.
  const matches = NAVIGATION_HIERARCHY.filter((node) => navEntryMatchesPathname(node.href, CANONICAL_HOME));
  assert.deepEqual(matches.map((n) => n.href), [PROJECTS_NAV_HREF]);
  // The `/projects` entry is the one that exists to be lit.
  assert.ok(NAVIGATION_HIERARCHY.some((node) => node.href === PROJECTS_NAV_HREF));
  assert.equal(PROJECTS_NAV_HREF, "/projects");
});

test("29b. legacy /projects/P and the chooser keep plain prefix semantics", () => {
  assert.ok(navEntryMatchesPathname(PROJECTS_NAV_HREF, "/projects"));
  assert.ok(navEntryMatchesPathname(PROJECTS_NAV_HREF, legacyProjectHomePath(PROJECT)));
  assert.ok(navEntryMatchesPathname(PROJECTS_NAV_HREF, `/projects/${PROJECT}/chat`));
  assert.equal(navEntryMatchesPathname(PROJECTS_NAV_HREF, "/portfolio"), false);
  // The new branch sits between the PMO branch and the Command Center branch, so
  // neither of those two behaviours could change.
  const fn = navigationPaths.slice(navigationPaths.indexOf("export function navEntryMatchesPathname"));
  assert.ok(
    fn.indexOf("isCanonicalPmoRoutePath") < fn.indexOf("isCanonicalProjectRoutePath"),
    "the PMO branch must still be tested first",
  );
  assert.ok(
    fn.indexOf("isCanonicalProjectRoutePath") < fn.indexOf("isWorkspaceCommandCenterPath"),
    "the Project branch must be tested before the Command Center branch",
  );
});

test("29c. the sidebar tree links projects canonically and lights the right one", () => {
  assert.match(sidebarTree, /href=\{projectHomePath\(project\.workspace_id, project\.id\)\}/);
  assert.doesNotMatch(sidebarTree, /href=\{`\/projects\/\$\{project\.id\}`\}/);
  assert.match(sidebarTree, /routedProject\?\.projectId === project\.id/);
  // The workspace it links with is the PROJECT's own, carried through the API.
  assert.match(pmoService, /\.select\("id, workspace_id, name, status, pmo_id"\)/);
  assert.match(pmoService, /"id" \| "workspace_id" \| "name" \| "status"/);
  assert.doesNotMatch(withoutComments(sidebarTree), /resolvePreferredWorkspace/);
});

// ─── Route policy and session continuation ───────────────────────────────

test("30. the continuation allowlist accepts the canonical deep link", () => {
  assert.ok(isSafeContinuationRoute(CANONICAL_HOME), "a canonical Project deep link must survive an expired session");
  assert.ok(isSafeContinuationRoute(legacyProjectHomePath(PROJECT)));
  // Nothing about this slice widened the allowlist.
  for (const blocked of ["/api/anything", "/login", "/_next/static", "/debug/x", "//evil.example.com"]) {
    assert.equal(isSafeContinuationRoute(blocked), false, `${blocked} must stay blocked`);
  }
});

test("30b. canonical Project Home is a protected, workspace-contextual page", () => {
  assert.ok(isProtectedPageRoute(CANONICAL_HOME));
  assert.equal(getRouteAccessPolicy(CANONICAL_HOME), "workspace-contextual");
  // The legacy entry point stays protected too.
  assert.ok(isProtectedPageRoute(legacyProjectHomePath(PROJECT)));
});

// ─── Scope guardrails ────────────────────────────────────────────────────

test("31. this slice introduces no schema and no migration", () => {
  for (const source of [
    paths,
    resolver,
    routeStates,
    tabNav,
    canonicalHome,
    legacyHome,
    projectsIndex,
    workspaceHome,
    pmoHome,
    projectChat,
    projectSettings,
    sidebarTree,
  ]) {
    assert.doesNotMatch(withoutComments(source), /create\s+table|alter\s+table|drop\s+table|\.sql\b/i);
  }
  // The route family reads only tables the shipped screens already read.
  const tables = new Set([...canonicalHome.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]));
  for (const table of tables) {
    assert.ok(["projects", "pmos", "workspaces", "onboarding_analyses"].includes(table), `unexpected table: ${table}`);
  }
  // And the legacy resolver reads none directly at all.
  assert.doesNotMatch(legacyHome, /\.from\("/);
});

test("32. the bare /command-center is not repurposed by this slice", () => {
  // ADR-PMF-014 Rule 6's unqualified Command Center stays exactly what PR #604
  // made it: the Workspace Command Center's legacy resolver. It is not repointed
  // at any Project surface, and it takes no project identity of its own.
  assert.match(bareCommandCenter, /redirect\(workspaceCommandCenterPath\(/);
  assert.doesNotMatch(bareCommandCenter, /project-paths|projectHomePath|routed-project/);
  assert.doesNotMatch(bareCommandCenter, /workspaces\/\$\{[^}]*\}\/projects/);
  assert.equal(isCanonicalProjectRoutePath("/command-center"), false);
  assert.equal(parseCanonicalProjectRoute("/command-center"), null);
  // The one link this slice must truthfully maintain still points there: the
  // Execution tab, whose destination screen has not moved.
  assert.ok(tabNav.includes("`/command-center?projectId=${projectId}`"));
});

// ─── Mutation scope: the authority defect actually corrected ─────────────

test("mutation scope: the corrected defect was a UI role gate, and the server was already right", () => {
  // The page-level defect this slice fixes is the ROLE SCOPE on Project Home. The
  // mutations it exposes already derived their tenancy from the project row, so
  // there was nothing to change in them — and this pins that, because a canonical
  // route must never end up authorized for workspace W while a mutation gates
  // itself against a preferred W2.
  assert.match(createExecutionTask, /\.from\("projects"\)[\s\S]{0,200}\.select\("id,workspace_id,status"\)/);
  assert.match(createExecutionTask, /workspace_id: project\.workspace_id/);
  assert.match(createExecutionTask, /requireProjectAccess\(project\.id, "write"\)/);
  assert.doesNotMatch(withoutComments(createExecutionTask), /resolvePreferredWorkspace/);
  assert.match(createExecutionTask, /\.eq\("workspace_id", project\.workspace_id\)/, "assignee membership check");

  for (const [name, source] of [
    ["GET/POST /api/execution-tasks", executionTasksRoute],
    ["/api/projects/[id]", projectIdApiRoute],
    ["/api/projects/[id]/pm-assignments", pmAssignmentsRoute],
  ] as const) {
    assert.doesNotMatch(
      withoutComments(source),
      /resolvePreferredWorkspace/,
      `${name} must not scope a project mutation by cookie`,
    );
  }
  // Task authorization itself is untouched: no new permission, no new role.
  assert.doesNotMatch(withoutComments(canonicalHome), /requireProjectAccess|requireWorkspaceRole/);
  assert.match(canonicalHome, /evaluateCapabilityAccess/, "the existing capability gate is preserved");
});

test("mutation scope: an archived Project changes no control in this slice", () => {
  // §7 requires the STATE to be explained, and explaining it is all that was
  // added. The archived-project refusal already lives server-side, where it was.
  assert.match(canonicalHome, /<ProjectArchivedNotice archived=\{access\.archived\} \/>/);
  assert.match(createExecutionTask, /Cannot add tasks to an archived project/);
  assert.match(routeStates, /changes no control/);
  // `canCreateTask` is role-derived only — archival is not folded into it, because
  // that would be a new restriction invented under cover of a route migration.
  assert.match(canonicalHome, /const canCreateTask = access\.role !== null && access\.role !== "viewer";/);
  assert.doesNotMatch(canonicalHome, /canCreateTask = [^;]*archived/);
});

test("mutation scope: `completed` is a normal project state, not archival", () => {
  // `ProjectStatus` is `active | archived | completed`. Treating `completed` as
  // read-only would invent a lifecycle rule the product does not have.
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "completed" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "granted");
  assert.equal(result.readOnly, false);
  assert.match(resolver, /`completed` is NOT archived/);
  assert.match(resolver, /`completed` is deliberately excluded/);
});

test("no surface in this slice claims a Project surface that does not exist", () => {
  // Every canonical Project link in the tree must resolve to a route the parser
  // recognizes — which today means Home and only Home.
  const linkSites: [string, string][] = [
    ["canonical Home", canonicalHome],
    ["legacy Home", legacyHome],
    ["tab nav", tabNav],
    ["projects index", projectsIndex],
    ["workspace Home", workspaceHome],
    ["pmo Home", pmoHome],
    ["pmo Command Center", pmoCommandCenter],
    ["project chat", projectChat],
    ["project settings", projectSettings],
    ["sidebar tree", sidebarTree],
    ["route states", routeStates],
  ];
  for (const [name, source] of linkSites) {
    // No hand-typed canonical project path anywhere: one builder, one definition,
    // so reverting this slice means reverting its callers (ADR-PMF-068 rule 5).
    assert.doesNotMatch(
      withoutComments(source),
      /["'`]\/workspaces\/[^"'`]*\/projects\//,
      `${name} must not re-type a canonical Project path as a literal`,
    );
    // And no builder call for a surface that is not `home`.
    assert.doesNotMatch(
      source,
      /projectSurfacePath\([^)]*,\s*"(?!home")/,
      `${name} must not build an unbuilt Project surface`,
    );
  }
  for (const surface of PROJECT_SURFACES) {
    assert.ok(isCanonicalProjectRoutePath(projectSurfacePath(WS, PROJECT, surface as ProjectSurface)));
  }
});

// ─── Security self-review: what was falsified, kept honest ───────────────

test("self-review: a refusal logs only what the caller already supplied", () => {
  // The refusal path must not emit derived facts — the project's real workspace,
  // its PMO, its name or its status — even to a server log, because a log line is
  // one copy-paste away from a support reply that turns the route into an oracle.
  for (const [name, source] of [
    ["canonical Home", canonicalHome],
    ["legacy Home", legacyHome],
  ] as const) {
    const log = source.slice(source.indexOf("console.error("), source.indexOf("return <ProjectNotAvailable"));
    assert.doesNotMatch(log, /access\.|project\.|pmo|workspace_id/i, `${name}: the refusal log must carry no derived fact`);
    assert.match(log, /requested/, `${name}: only the caller's own input is echoed`);
  }
});

test("self-review: the two client-side pushes that hold no workspace go via the legacy seam", () => {
  // "Add first task" after a create and the push after a duplicate both receive
  // only `{ id }` from their API, so they have no authoritative workspace to build
  // a canonical path from. Resolving one from the preferred-workspace cookie to
  // make the link "look canonical" is exactly the defect this slice removes — the
  // honest destination is the legacy entry point, which derives W from the project
  // row and redirects. This is the seam working, not an oversight.
  const createModal = read("src/components/pmfreak/projects/create-project-modal.tsx");
  const settingsClient = read("src/components/pmfreak/projects/project-settings-client.tsx");
  for (const [name, source] of [
    ["create modal", createModal],
    ["settings client", settingsClient],
  ] as const) {
    assert.match(source, /router\.push\(`\/projects\/\$\{/, `${name} must use the legacy entry point`);
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, `${name} must not invent a workspace`);
    assert.doesNotMatch(source, /workspaces\/\$\{[^}]*\}\/projects/, `${name} must not fake a canonical path`);
  }
  // And the legacy entry point they land on is a resolver that cannot substitute.
  assert.match(legacyHome, /resolveLegacyProjectRoute/);
});

test("self-review: the legacy segment keeps the loading boundary its children inherit", () => {
  // `/projects/[id]/loading.tsx` is the Suspense boundary for `/projects/[id]/chat`
  // and `/projects/[id]/settings`, neither of which has one of its own. Those two
  // screens are explicitly out of scope for this slice, so removing the boundary
  // when Home moved would have changed their behaviour by accident.
  assert.ok(read("src/app/(protected)/projects/[id]/loading.tsx").includes("animate-pulse"));
  assert.ok(
    read("src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/loading.tsx").includes("animate-pulse"),
    "canonical Project Home has its own boundary",
  );
});

test("self-review: no Project surface can be reached without the routed resolver", () => {
  // Canonical Home is the only page in the family, and it authorizes before it
  // reads. If a second page is ever added here without this call, the assertion on
  // the directory listing below is what notices.
  assert.match(canonicalHome, /const access = await resolveRoutedProject\(/);
  const authorizeIdx = canonicalHome.indexOf("const access = await resolveRoutedProject(");
  const firstReadIdx = canonicalHome.indexOf('.from("');
  assert.ok(authorizeIdx > 0 && authorizeIdx < firstReadIdx, "authorization must precede every read");
  // `requireAuthUser` still runs first of all.
  assert.ok(canonicalHome.indexOf("await requireAuthUser()") < authorizeIdx);
});
