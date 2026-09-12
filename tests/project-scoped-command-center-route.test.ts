import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  isProjectCommandCenterPath,
  projectCommandCenterBreadcrumb,
  projectCommandCenterPath,
  resolveProjectPmoAncestry,
} from "../src/lib/projects/project-command-center-paths";
import {
  PROJECTS_NAV_HREF,
  PROJECT_SURFACES,
  isCanonicalProjectRoutePath,
  legacyProjectHomePath,
  parseCanonicalProjectRoute,
  projectHomePath,
  projectSurfacePath,
} from "../src/lib/projects/project-paths";
import {
  PROJECT_COMMAND_CENTER_ZONES,
  PROJECT_RECOMMENDATION_COLUMNS,
  PROPOSED_RECOMMENDATION_STATUS,
  ZONE_ROW_LIMIT,
  countRaidByCategory,
  projectPendingDecisionsQuery,
  projectRaidQuery,
  projectRecommendationsQuery,
  resolveVisibleTotal,
  runProjectScopedQuery,
  selectProjectGovernanceFacts,
  selectProjectRaid,
  selectProjectRecommendations,
  GOVERNED_RAID_CATEGORY_LABELS,
  PROJECT_RAID_COLUMNS,
  collectSupportingRaidIds,
  evidenceInputLabel,
  governedRaidCategoryLabel,
  projectEvidenceRepositoryPath,
  projectSupportingRaidQuery,
  recordDetectionConfidence,
  resolveRecommendationDisclosure,
  resolveSupportingRaid,
  selectRaidRecommendationEvidence,
  selectRaidRecommendationWhy,
  selectSupportingRaidRecords,
  storedDetectionDate,
  supportingRaidPanelPresentation,
  type ProjectRaidRow,
  type ProjectRecommendationRow,
} from "../src/lib/projects/project-command-center-projection";
import { CLOSED_RAID_STATUSES } from "../src/lib/pmos/pmo-command-center-rollup";
import { RECOMMENDED_ACTION_SELECTABLE_COLUMNS } from "../src/lib/db/database-contract";
import { generateRecommendedActions } from "../src/lib/recommended-actions/generate-recommended-actions";
import { decideRoutedProjectAccess, type RoutedProjectAccess } from "../src/lib/projects/routed-project";
import type { RoutedWorkspaceAccess } from "../src/lib/workspaces/routed-workspace";
import { isCanonicalPmoRoutePath, pmoCommandCenterPath, pmoHomePath, PMOS_NAV_HREF } from "../src/lib/pmos/pmo-paths";
import { workspaceHomePath, workspaceSettingsPath } from "../src/lib/workspaces/workspace-paths";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  isWorkspaceCommandCenterPath,
  navEntryMatchesPathname,
  workspaceCommandCenterPath,
} from "../src/lib/workspace/command-center-paths";
import { NAVIGATION_HIERARCHY } from "../src/lib/workspace/navigation-hierarchy";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { PM_OPERATIONS_PATH } from "../src/lib/pm-operations/pm-operations-paths";

/**
 * Project Command Center — Slice 1.
 *
 * The canonical, entity-qualified route
 * `/workspaces/[workspaceId]/projects/[projectId]/command-center`
 * (`07-route-layout-and-navigation-architecture.md` §2), composed of the four
 * zones ADR-PMF-070 fixes, over Project-scoped data only.
 *
 * The properties this file exists to pin, in the order the sections run:
 *
 *   1. the path is exactly the ratified one, and one parser family recognizes it
 *   2. project identity is exact — no substitution, no fallback of any kind
 *   3. workspace ancestry is checked and REFUSED on mismatch, never corrected
 *   4. every projection is scoped by BOTH ids, twice, and Zone 2/Zone 3 are disjoint
 *   5. no cross-scope source is reachable from any new file
 *   6. four zones, in order, present when empty, Health last, no invented health
 *   7. archived stays readable and no mutation exists to withhold
 *   8. missing / unauthorized / mismatched are one indistinguishable refusal
 *   9. breadcrumb, tab and nav integration
 *  10. nothing else moved
 */

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const PROJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PROJECT = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
const PMO = "12121212-3434-5656-7878-909090909090";
const CANONICAL = `/workspaces/${WS}/projects/${PROJECT}/command-center`;
const CANONICAL_HOME = `/workspaces/${WS}/projects/${PROJECT}`;

const ROUTE_FILE = "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/command-center/page.tsx";
const route = readFileSync(ROUTE_FILE, "utf8");
const paths = readFileSync("src/lib/projects/project-command-center-paths.ts", "utf8");
const projection = readFileSync("src/lib/projects/project-command-center-projection.ts", "utf8");
const familyPaths = readFileSync("src/lib/projects/project-paths.ts", "utf8");
const tabNav = readFileSync("src/components/pmfreak/projects/project-tab-nav.tsx", "utf8");
const projectHome = readFileSync("src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx", "utf8");
const legacyProjectRoute = readFileSync("src/app/(protected)/projects/[id]/page.tsx", "utf8");
const bareCommandCenter = readFileSync("src/app/(protected)/command-center/page.tsx", "utf8");
const legacyPmoCommandCenter = readFileSync("src/app/(protected)/pmo-command-center/page.tsx", "utf8");
const workspaceCommandCenter = readFileSync(
  "src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx",
  "utf8",
);
const pmoCommandCenter = readFileSync(
  "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/command-center/page.tsx",
  "utf8",
);
const protectedLayout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
const sidebarTree = readFileSync("src/components/pmfreak/navigation/sidebar-pmo-tree.tsx", "utf8");
const routeStates = readFileSync("src/components/pmfreak/projects/project-route-states.tsx", "utf8");
const EVIDENCE_PANEL_FILE = "src/components/pmfreak/projects/supporting-raid-evidence-panel.tsx";
/** The ONLY client component this slice owns — the Evidence Panel's interaction. */
const evidencePanel = readFileSync(EVIDENCE_PANEL_FILE, "utf8");
/** The repository primitive it reuses, rather than reimplementing dialog mechanics. */
const drawerPrimitive = readFileSync("src/components/pmfreak/ui/drawer.tsx", "utf8");

/** Every file this slice adds or rewrites, for the whole-slice prohibitions. */
const NEW_SLICE_FILES: [string, string][] = [
  ["route", route],
  ["command-center paths", paths],
  ["projection", projection],
  ["evidence panel", evidencePanel],
];

/**
 * Strip comments before checking copy and import rules.
 *
 * ADR-PMF-014 Rule 1 governs what a USER sees, and prose that explains a rule
 * necessarily quotes the phrase it forbids. The same applies to the cross-scope
 * import ban: these modules document exactly which sources they refuse, by name,
 * and a check that cannot tell an explanation from an import would push the
 * reasoning out of the code. Everything a user can read is a string literal or
 * JSX text, and every import is a statement; both survive this.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. The canonical path ────────────────────────────────────────────────

test("the canonical path is the entity-qualified route named by the route map", () => {
  assert.equal(projectCommandCenterPath(WS, PROJECT), CANONICAL);
  // Terminal segment under the Project, per §4 rule 3 — mirroring the breadcrumb
  // rule that a Command Center is only ever a trail's last node.
  assert.ok(CANONICAL.endsWith("/command-center"));
  // Workspace-rooted, never PMO-rooted: `projects.workspace_id` is the mandatory
  // parent and `projects.pmo_id` is nullable (§1).
  assert.ok(CANONICAL.startsWith(`/workspaces/${WS}/projects/${PROJECT}`));
  assert.equal(CANONICAL.includes("/pmos/"), false);
  // And it is exactly Project Home plus one segment.
  assert.equal(CANONICAL, `${projectHomePath(WS, PROJECT)}/command-center`);
});

test("it is built from the family table, not from a hand-typed literal", () => {
  assert.equal(projectCommandCenterPath(WS, PROJECT), projectSurfacePath(WS, PROJECT, "command-center"));
  assert.deepEqual([...PROJECT_SURFACES], ["home", "command-center"]);
  // One family, one pattern. A second regex could disagree with this one about
  // which paths are Project routes.
  assert.equal(familyPaths.match(/^const CANONICAL_PROJECT_ROUTE_PATTERN/gm)?.length, 1);
  assert.doesNotMatch(paths, /new RegExp|\/\^\\\/workspaces/);
  assert.match(paths, /projectSurfacePath\(workspaceId, projectId, "command-center"\)/);
});

test("both ids are encoded, so neither can escape its path segment", () => {
  const built = projectCommandCenterPath("w/../evil", "p/../other");
  assert.equal(built, "/workspaces/w%2F..%2Fevil/projects/p%2F..%2Fother/command-center");
  // "", workspaces, <id>, projects, <id>, command-center — the ids added no
  // segments of their own, so the path still addresses this route and no other.
  assert.equal(built.split("/").length, 6);
  assert.deepEqual(parseCanonicalProjectRoute(built), {
    workspaceId: "w/../evil",
    projectId: "p/../other",
    surface: "command-center",
  });
});

test("the parser recovers exactly the two ids and names the surface", () => {
  const parsed = parseCanonicalProjectRoute(CANONICAL);
  assert.deepEqual(parsed, { workspaceId: WS, projectId: PROJECT, surface: "command-center" });
  assert.equal(isCanonicalProjectRoutePath(CANONICAL), true);
  assert.equal(isProjectCommandCenterPath(CANONICAL), true);
  // Round-trips through the encoder.
  assert.deepEqual(parseCanonicalProjectRoute(projectCommandCenterPath("a b", "c d")), {
    workspaceId: "a b",
    projectId: "c d",
    surface: "command-center",
  });
});

test("the one-surface predicate does not claim Project Home or an unbuilt sibling", () => {
  assert.equal(isProjectCommandCenterPath(CANONICAL_HOME), false);
  for (const unbuilt of ["tasks", "milestones", "risks", "issues", "decisions", "feed", "memory"]) {
    assert.equal(isProjectCommandCenterPath(`${CANONICAL_HOME}/${unbuilt}`), false);
    assert.equal(isCanonicalProjectRoutePath(`${CANONICAL_HOME}/${unbuilt}`), false);
  }
});

test("malformed and deeper paths are refused rather than guessed at", () => {
  for (const bad of [
    `${CANONICAL}/`.concat("anything"),
    `${CANONICAL}/1`,
    `/workspaces/${WS}/projects//command-center`,
    `/workspaces//projects/${PROJECT}/command-center`,
    `/workspaces/${WS}/projects/${PROJECT}/command-center/extra`,
    "/workspaces/%E0%A4%A/projects/p/command-center",
    `/workspaces/${WS}/project/${PROJECT}/command-center`,
  ]) {
    assert.equal(parseCanonicalProjectRoute(bad), null, `${bad} must not parse`);
    assert.equal(isProjectCommandCenterPath(bad), false, `${bad} must not be the Command Center`);
  }
  // A trailing slash on the real path is still the real path.
  assert.equal(isProjectCommandCenterPath(`${CANONICAL}/`), true);
});

test("adjacent Command Centers and legacy paths are not this route", () => {
  for (const other of [
    WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
    workspaceCommandCenterPath(WS),
    workspaceSettingsPath(WS),
    workspaceHomePath(WS),
    pmoHomePath(WS, PMO),
    pmoCommandCenterPath(WS, PMO),
    "/pmo-command-center",
    PM_OPERATIONS_PATH,
    legacyProjectHomePath(PROJECT),
    `${legacyProjectHomePath(PROJECT)}/command-center`,
    "/projects",
  ]) {
    assert.equal(isProjectCommandCenterPath(other), false, `${other} must not be the Project Command Center`);
  }
  // And this route is not any of THEIR families.
  assert.equal(isWorkspaceCommandCenterPath(CANONICAL), false);
  assert.equal(isCanonicalPmoRoutePath(CANONICAL), false);
});

test("no second canonical Project Command Center route exists in the app tree", () => {
  // `/projects/[projectId]/command-center` has no prior surface behind it, so it
  // would not be a compatibility seam — it would be a second Project Command
  // Center identity, which is the entity confusion ADR-PMF-007 ruled against.
  assert.equal(existsSync("src/app/(protected)/projects/[id]/command-center"), false);
  assert.equal(existsSync("src/app/(protected)/projects/[projectId]"), false);
  assert.equal(existsSync(ROUTE_FILE), true);
  assert.match(paths, /has NO LEGACY ENTRY POINT|no prior surface/i);
});

// ─── 2. Project identity is exact ─────────────────────────────────────────

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

function assertDenied(result: RoutedProjectAccess, why: string) {
  assert.equal(result.access, "denied", why);
  assert.equal(result.projectId, null, "a refusal must not carry a project id");
  assert.equal(result.workspaceId, null, "a refusal must not carry a workspace id");
  assert.equal(result.role, null, "a refusal must not carry a role");
  assert.equal(result.readOnly, true);
}

test("the routed projectId is authoritative — the verdict echoes only what was asked for", () => {
  for (const requested of [PROJECT, OTHER_PROJECT]) {
    const result = decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: requested,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    });
    assert.equal(result.access, "granted");
    assert.equal(result.projectId, requested);
    assert.equal(result.workspaceId, WS);
  }
});

test("Project A never becomes Project B — an absent project has no substitute", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: null,
      workspaceAccess: grantedWs(WS),
    }),
    "an unresolvable project must not be replaced by another",
  );
});

test("no fallback resolver, no picker and no query-param project reach this route", () => {
  const body = withoutComments(route);
  for (const forbidden of [
    "resolveActiveProject",
    "resolveCanonicalProject",
    "resolvePreferredWorkspace",
    "ensureUserWorkspace",
    "resolveWriteWorkspace",
    "getUserWorkspaces",
    "searchParams",
    // The QUERY form specifically. `projectId={...}` as a component prop is the
    // authorized id being passed down, which is the opposite of a picker.
    "?projectId=",
    "projects[0]",
    "selectedProject",
    "onSelectProject",
  ]) {
    assert.equal(body.includes(forbidden), false, `the Project Command Center must not use ${forbidden}`);
  }
  // The screen takes `params` and nothing else — there is no query surface at all.
  assert.match(route, /params: Promise<\{ workspaceId: string; projectId: string \}>/);
  assert.equal(body.includes("firstQueryValue"), false);
});

test("the route authorizes the URL's project id, passing both routed segments", () => {
  assert.match(route, /const access = await resolveRoutedProject\(user\.id, requestedWorkspaceId, requestedProjectId\)/);
  // And every read afterwards uses the VERDICT's ids, never the segments again.
  assert.match(route, /const \{ workspaceId, projectId \} = access;/);
  const afterVerdict = route.slice(route.indexOf("const { workspaceId, projectId } = access;"));
  assert.equal(
    withoutComments(afterVerdict).includes("requestedWorkspaceId"),
    false,
    "the routed segment must not be used after the verdict",
  );
  assert.equal(withoutComments(afterVerdict).includes("requestedProjectId"), false);
});

test("authorization happens before any project data is read", () => {
  const body = withoutComments(route);
  const authIndex = body.indexOf("resolveRoutedProject(");
  const capabilityIndex = body.indexOf("evaluateCapabilityAccess(");
  const clientIndex = body.indexOf("createSupabaseServerClient(");
  const firstRead = body.indexOf('.from("projects")');
  assert.ok(authIndex > -1 && capabilityIndex > -1 && clientIndex > -1 && firstRead > -1);
  assert.ok(authIndex < capabilityIndex, "the routed resolver runs before the capability gate");
  assert.ok(capabilityIndex < clientIndex, "no client is created before authorization");
  assert.ok(clientIndex < firstRead, "no project data is read before authorization");
  // The capability gate is asked about the AUTHORIZED pair.
  assert.match(route, /evaluateCapabilityAccess\(\{ workspaceId, projectId, permission: "read" \}\)/);
});

// ─── 3. Workspace ancestry ────────────────────────────────────────────────

test("a routed workspace that disagrees with projects.workspace_id is REFUSED, not corrected", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: OTHER_WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    "an ancestry mismatch must be refused",
  );
});

test("a workspace verdict resolved for some other workspace cannot authorize this project", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(OTHER_WS),
    }),
    "the authorized workspace must be the project's own",
  );
});

test("no membership in the project's real workspace is denied", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "active" },
      workspaceAccess: deniedWs,
    }),
    "membership is required in the project's own workspace",
  );
});

test("the preferred-workspace cookie cannot influence this route", () => {
  // Not by import, and not by any other name. The resolver derives the parent
  // from `projects.workspace_id`; the cookie is not consulted anywhere on the
  // path, so the same URL resolves identically for every caller and session.
  for (const [name, source] of NEW_SLICE_FILES) {
    assert.equal(
      withoutComments(source).includes("preferred-workspace"),
      false,
      `${name} must not reach for the preferred workspace`,
    );
    assert.equal(withoutComments(source).includes("resolvePreferredWorkspace"), false, name);
  }
});

// ─── 4. Projection scope ──────────────────────────────────────────────────

const raidRow = (over: Partial<ProjectRaidRow> = {}): ProjectRaidRow => ({
  id: "r1",
  workspace_id: WS,
  project_id: PROJECT,
  category: "risk",
  title: "t",
  description: "d",
  status: "open",
  confidence_score: 80,
  occurrence_count: 1,
  auto_generated: true,
  last_detected_at: "2026-09-01T00:00:00Z",
  ...over,
});

const recRow = (over: Partial<ProjectRecommendationRow> = {}): ProjectRecommendationRow => ({
  id: "a1",
  workspace_id: WS,
  project_id: PROJECT,
  raid_item_id: null,
  governance_event_id: null,
  title: "t",
  description: "d",
  recommended_action_type: "follow_up",
  status: "proposed",
  confidence_score: 70,
  impact_level: "medium",
  rationale: null,
  evidence_summary: null,
  recommended_owner: null,
  recommended_due_window: null,
  created_at: "2026-09-01T00:00:00Z",
  ...over,
});

test("every descriptor carries the authorized workspace AND the exact project", () => {
  for (const query of [
    projectRaidQuery(WS, PROJECT),
    projectRecommendationsQuery(WS, PROJECT),
    projectPendingDecisionsQuery(WS, PROJECT),
  ]) {
    assert.equal(query.workspaceId, WS);
    assert.equal(query.projectId, PROJECT);
    assert.equal(query.limit, ZONE_ROW_LIMIT);
  }
});

test("the RAID descriptor excludes closed statuses using the SHARED definition", () => {
  const query = projectRaidQuery(WS, PROJECT);
  assert.equal(query.table, "raid_items");
  assert.equal(query.excludeStatuses, CLOSED_RAID_STATUSES);
  // Not a copy — the same reference, so the Project and PMO Command Centers
  // cannot disagree about what "open" means for the same project.
  assert.deepEqual([...CLOSED_RAID_STATUSES], ["closed", "resolved"]);
  assert.equal(withoutComments(projection).includes('"closed"'), false, "open-ness must not be re-declared here");
});

test("workspace-scoped RAID with no project cannot enter the zone", () => {
  const kept = selectProjectRaid([raidRow({ id: "keep" }), raidRow({ id: "drop", project_id: null })], WS, PROJECT);
  assert.deepEqual(kept.map((r) => r.id), ["keep"]);
});

test("a sibling project's RAID cannot enter the zone", () => {
  const kept = selectProjectRaid([raidRow({ id: "keep" }), raidRow({ id: "drop", project_id: OTHER_PROJECT })], WS, PROJECT);
  assert.deepEqual(kept.map((r) => r.id), ["keep"]);
});

test("a foreign workspace's RAID cannot enter the zone", () => {
  const kept = selectProjectRaid([raidRow({ id: "keep" }), raidRow({ id: "drop", workspace_id: OTHER_WS })], WS, PROJECT);
  assert.deepEqual(kept.map((r) => r.id), ["keep"]);
});

test("closed RAID cannot enter the zone, by the shared definition", () => {
  const rows = [raidRow({ id: "open", status: "open" }), raidRow({ id: "monitoring", status: "monitoring" })];
  for (const closed of CLOSED_RAID_STATUSES) {
    rows.push(raidRow({ id: `x-${closed}`, status: closed as ProjectRaidRow["status"] }));
  }
  assert.deepEqual(selectProjectRaid(rows, WS, PROJECT).map((r) => r.id), ["open", "monitoring"]);
});

test("a sibling project's or foreign workspace's Recommendation cannot enter Zone 2 or Zone 3", () => {
  for (const governed of [false, true]) {
    const gov = governed ? "g1" : null;
    const rows = [
      recRow({ id: "keep", governance_event_id: gov }),
      recRow({ id: "sibling", project_id: OTHER_PROJECT, governance_event_id: gov }),
      recRow({ id: "foreign", workspace_id: OTHER_WS, governance_event_id: gov }),
    ];
    assert.deepEqual(
      selectProjectRecommendations(rows, WS, PROJECT, governed).map((r) => r.id),
      ["keep"],
      `governed=${governed}`,
    );
  }
});

test("only `proposed` Recommendations enter either zone", () => {
  const rows = [
    recRow({ id: "proposed", status: "proposed" }),
    recRow({ id: "accepted", status: "accepted" }),
    recRow({ id: "rejected", status: "rejected" }),
    recRow({ id: "deferred", status: "deferred" }),
    recRow({ id: "converted", status: "converted_to_task" }),
  ];
  assert.deepEqual(selectProjectRecommendations(rows, WS, PROJECT, false).map((r) => r.id), ["proposed"]);
  assert.equal(PROPOSED_RECOMMENDATION_STATUS, "proposed");
  assert.equal(projectRecommendationsQuery(WS, PROJECT).status, "proposed");
  assert.equal(projectPendingDecisionsQuery(WS, PROJECT).status, "proposed");
});

test("Zone 2 and Zone 3 are provably disjoint, and together lose nothing", () => {
  // The whole distinction is `governance_event_id`, which is either NULL or NOT
  // NULL on every row — so the two selectors partition the proposed set exactly.
  const rows = [
    recRow({ id: "u1", governance_event_id: null }),
    recRow({ id: "u2", governance_event_id: null }),
    recRow({ id: "g1", governance_event_id: "ge-1" }),
    recRow({ id: "g2", governance_event_id: "ge-2" }),
  ];
  const zone2 = selectProjectRecommendations(rows, WS, PROJECT, false).map((r) => r.id);
  const zone3 = selectProjectRecommendations(rows, WS, PROJECT, true).map((r) => r.id);
  assert.deepEqual(zone2, ["u1", "u2"]);
  assert.deepEqual(zone3, ["g1", "g2"]);
  assert.deepEqual(zone2.filter((id) => zone3.includes(id)), [], "the two zones must never share a row");
  assert.equal(zone2.length + zone3.length, rows.length, "and together they must lose nothing");
  // The descriptors say the same thing.
  assert.equal(projectRecommendationsQuery(WS, PROJECT).governed, false);
  assert.equal(projectPendingDecisionsQuery(WS, PROJECT).governed, true);
});

test("the Zone 3 count predicate is EXACTLY the Zone 3 item predicate", () => {
  // The headline count and the rows are the same query — `count: "exact"` rides
  // along on one request, so they are one predicate at one snapshot. This is
  // stronger than matching the assurance RPC's `openRecommendations`, which was
  // verified to carry the same predicate but is a separate statement.
  const query = projectPendingDecisionsQuery(WS, PROJECT);
  assert.deepEqual(
    { table: query.table, workspaceId: query.workspaceId, projectId: query.projectId, governed: query.governed, status: query.status },
    { table: "recommended_actions", workspaceId: WS, projectId: PROJECT, governed: true, status: "proposed" },
  );
  // The route reads the total from the SAME result object it reads the rows from.
  assert.match(route, /const pendingDecisionsTotal = decisionsRead\s*\?\s*resolveVisibleTotal\(\s*decisionsRead\.rows\.length,\s*pendingDecisions\.length,\s*decisionsRead\.total,?\s*\)/);
  // And it does NOT take the count from the assurance payload.
  assert.equal(withoutComments(route).includes("openRecommendations"), false);
  assert.equal(withoutComments(projection).includes("openRecommendations"), false);
});

test("a guard that drops anything withholds the total instead of contradicting the list", () => {
  assert.equal(resolveVisibleTotal(8, 8, 40), 40);
  assert.equal(resolveVisibleTotal(8, 7, 40), null, "a dropped row means the total no longer describes the list");
  assert.equal(resolveVisibleTotal(8, 8, null), null, "no count read means no count claimed");
});

test("category counts count stored categories and invent no band", () => {
  const counts = countRaidByCategory([
    raidRow({ category: "risk" }),
    raidRow({ category: "risk" }),
    raidRow({ category: "issue" }),
    raidRow({ category: "dependency" }),
    raidRow({ category: "assumption" }),
  ]);
  assert.deepEqual(counts, { risk: 2, issue: 1, dependency: 1, assumption: 1 });
});

test("the query descriptor is what actually reaches the database", () => {
  const applied: {
    table?: string;
    columns?: string;
    options?: unknown;
    eq: [string, unknown][];
    is: [string, unknown][];
    not: [string, string, unknown][];
    order: [string, unknown][];
    limit?: number;
  } = { eq: [], is: [], not: [], order: [] };

  const builder = {
    eq(column: string, value: unknown) {
      applied.eq.push([column, value]);
      return builder;
    },
    is(column: string, value: unknown) {
      applied.is.push([column, value]);
      return builder;
    },
    not(column: string, operator: string, value: unknown) {
      applied.not.push([column, operator, value]);
      return builder;
    },
    order(column: string, options: unknown) {
      applied.order.push([column, options]);
      return builder;
    },
    limit(value: number) {
      applied.limit = value;
      return { then: (resolve: (r: unknown) => void) => resolve({ data: [], count: 0, error: null }) };
    },
  };
  const fake = {
    from(table: string) {
      applied.table = table;
      return {
        select(columns: string, options: unknown) {
          applied.columns = columns;
          applied.options = options;
          return builder;
        },
      };
    },
  };
  const reset = () => {
    applied.eq.length = 0;
    applied.is.length = 0;
    applied.not.length = 0;
    applied.order.length = 0;
  };

  return (async () => {
    type Client = Parameters<typeof runProjectScopedQuery>[0];

    await runProjectScopedQuery(fake as unknown as Client, projectRaidQuery(WS, PROJECT));
    assert.equal(applied.table, "raid_items");
    assert.deepEqual(applied.options, { count: "exact" });
    assert.deepEqual(applied.eq, [["workspace_id", WS], ["project_id", PROJECT]]);
    assert.deepEqual(applied.not, [["status", "in", "(closed,resolved)"]]);
    assert.deepEqual(applied.is, []);
    assert.deepEqual(applied.order, [
      ["last_detected_at", { ascending: false }],
      ["id", { ascending: true }],
    ]);
    assert.equal(applied.limit, ZONE_ROW_LIMIT);

    reset();
    await runProjectScopedQuery(fake as unknown as Client, projectRecommendationsQuery(WS, PROJECT));
    assert.equal(applied.table, "recommended_actions");
    assert.deepEqual(applied.eq, [["workspace_id", WS], ["project_id", PROJECT], ["status", "proposed"]]);
    assert.deepEqual(applied.is, [["governance_event_id", null]], "Zone 2 is the UNGOVERNED half");
    assert.deepEqual(applied.not, []);

    reset();
    await runProjectScopedQuery(fake as unknown as Client, projectPendingDecisionsQuery(WS, PROJECT));
    assert.equal(applied.table, "recommended_actions");
    assert.deepEqual(applied.eq, [["workspace_id", WS], ["project_id", PROJECT], ["status", "proposed"]]);
    assert.deepEqual(applied.not, [["governance_event_id", "is", null]], "Zone 3 is the GOVERNED half");
    assert.deepEqual(applied.is, []);
  })();
});

test("the assurance payload is discarded unless it is about THIS project", () => {
  const ok = { scope: "project", workspaceId: WS, projectId: PROJECT, totalGovernanceEvents: 3, decisionRequiredCount: 1, violationsCount: 0 };
  assert.deepEqual(selectProjectGovernanceFacts(ok, WS, PROJECT), {
    totalGovernanceEvents: 3,
    violationsCount: 0,
  });
  assert.equal(selectProjectGovernanceFacts({ ...ok, projectId: OTHER_PROJECT }, WS, PROJECT), null);
  assert.equal(selectProjectGovernanceFacts({ ...ok, workspaceId: OTHER_WS }, WS, PROJECT), null);
  assert.equal(selectProjectGovernanceFacts({ ...ok, scope: "workspace" }, WS, PROJECT), null);
});

test("a malformed or missing assurance payload yields NO facts, never zeroes", () => {
  for (const bad of [null, undefined, [], "x", 3, {}, { scope: "project", workspaceId: WS, projectId: PROJECT }]) {
    assert.equal(selectProjectGovernanceFacts(bad, WS, PROJECT), null);
  }
  // A genuine zero is a genuine zero.
  assert.deepEqual(
    selectProjectGovernanceFacts(
      { scope: "project", workspaceId: WS, projectId: PROJECT, totalGovernanceEvents: 0, decisionRequiredCount: 0, violationsCount: 0 },
      WS,
      PROJECT,
    ),
    { totalGovernanceEvents: 0, violationsCount: 0 },
  );
});

// ─── 5. Cross-scope prohibition (ADR-PMF-020) ─────────────────────────────

test("no new file imports a workspace-scoped Command Center surface", () => {
  for (const [name, source] of NEW_SLICE_FILES) {
    const body = withoutComments(source);
    for (const forbidden of [
      "@/modules/workspace",
      "@/features/command-center",
      "@/lib/command-center",
      "@/lib/operational-command-center",
      "@/lib/pmo-command-center",
      "@/lib/personal-portfolio",
    ]) {
      assert.equal(body.includes(forbidden), false, `${name} must not import ${forbidden}`);
    }
  }
});

test("no new file reaches a cross-scope data source", () => {
  for (const [name, source] of NEW_SLICE_FILES) {
    const body = withoutComments(source);
    for (const forbidden of [
      "listPmosWithProjects",
      "summarizePortfolio",
      "portfolio-summary",
      "pmo_command_center_snapshots",
      "operational_command_centers",
      "operational_focus_items",
      "project_os_snapshots",
      "pmo_attention_items",
      "pmo_recommendations",
      "pmo_executive_reports",
      "personal-portfolio",
      "getPMOCommandCenter",
    ]) {
      assert.equal(body.includes(forbidden), false, `${name} must not reach ${forbidden}`);
    }
  }
});

test("the route reads only the tables this slice is allowed to read", () => {
  const tables = [...withoutComments(route).matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["projects", "pmos", "workspaces"].sort());
  // RAID and Recommendations go through the descriptors, never inline.
  assert.equal(withoutComments(route).includes('.from("raid_items")'), false);
  assert.equal(withoutComments(route).includes('.from("recommended_actions")'), false);
  const projectionTables = [...withoutComments(projection).matchAll(/"(raid_items|recommended_actions)"/g)].map((m) => m[1]);
  assert.ok(projectionTables.length > 0);
  assert.deepEqual([...new Set(projectionTables)].sort(), ["raid_items", "recommended_actions"]);
});

test("the only RPC is the project-scoped assurance summary", () => {
  const rpcs = [...withoutComments(route).matchAll(/\.rpc\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rpcs, ["get_operational_assurance_summary"]);
  assert.match(route, /p_workspace_id: workspaceId, p_project_id: projectId/);
});

test("every read in the route is scoped by the authorized workspace", () => {
  // Every `.from(...)` chain must constrain the workspace. `workspaces` is
  // constrained by its own id, which IS the workspace.
  assert.match(route, /\.from\("projects"\)[\s\S]{0,200}\.eq\("workspace_id", workspaceId\)[\s\S]{0,80}\.eq\("id", projectId\)/);
  assert.match(route, /\.from\("pmos"\)[\s\S]{0,200}\.eq\("workspace_id", workspaceId\)/);
  assert.match(route, /\.from\("workspaces"\)[\s\S]{0,160}\.eq\("id", workspaceId\)/);
});

// ─── 6. Four-zone grammar (ADR-PMF-070) ───────────────────────────────────

test("the zone model is exactly the four ratified zones, in the ratified order", () => {
  assert.deepEqual(
    PROJECT_COMMAND_CENTER_ZONES.map((z) => z.title),
    ["Attention Required", "AI Recommendations", "Pending Decisions", "Execution Health"],
  );
  assert.equal(PROJECT_COMMAND_CENTER_ZONES.length, 4, "no fifth zone, no missing zone");
  // Execution Health is last — "always last, never the first or largest zone".
  assert.equal(PROJECT_COMMAND_CENTER_ZONES[3].key, "execution-health");
});

test("the route renders all four zones, in that order, exactly once each", () => {
  const order = ["ZONE_ATTENTION", "ZONE_RECOMMENDATIONS", "ZONE_DECISIONS", "ZONE_HEALTH"];
  // Bound from the zone table in its own order, so the names cannot be shuffled
  // relative to the ratified list without the destructure changing too.
  assert.match(
    route,
    /const \[ZONE_ATTENTION, ZONE_RECOMMENDATIONS, ZONE_DECISIONS, ZONE_HEALTH\] = PROJECT_COMMAND_CENTER_ZONES;/,
  );
  const positions = order.map((name) => route.indexOf(`zone={${name}}`));
  for (const [index, position] of positions.entries()) {
    assert.ok(position > -1, `${order[index]} must be rendered`);
    if (index > 0) assert.ok(position > positions[index - 1], `${order[index]} must follow ${order[index - 1]}`);
  }
  assert.equal(route.match(/<Zone\s/g)?.length, 4, "exactly four zones");
});

test("zone presence is structural — no zone is conditionally omitted", () => {
  // Each `<Zone>` sits at the top level of the returned tree, never behind a
  // guard. ADR-PMF-070 Frontend Rule 2: presence is structural, population is
  // data-dependent. The conditionals live INSIDE each zone's body.
  for (const zoneVar of ["ZONE_ATTENTION", "ZONE_RECOMMENDATIONS", "ZONE_DECISIONS", "ZONE_HEALTH"]) {
    const at = route.indexOf(`zone={${zoneVar}}`);
    const preceding = route.slice(Math.max(0, at - 260), at);
    assert.equal(/\{\s*\w+\s*(&&|\?)[^}]*<Zone$/.test(preceding.trimEnd()), false, `${zoneVar} must not be conditional`);
  }
  // And every zone body has all three branches available to it.
  assert.equal(route.match(/<ZoneDegraded /g)?.length, 4, "every zone can degrade on its own");
  assert.equal(route.match(/<ZoneEmpty>/g)?.length, 3, "the three list zones have an Empty state");
});

test("empty and degraded are different statements, and a failed read is never a zero", () => {
  assert.match(route, /No open risks, issues, assumptions or dependencies are recorded for this project\./);
  assert.match(route, /No unreviewed recommendation has been produced for this project\./);
  assert.match(route, /No governed recommendation is waiting on a decision for this project\./);
  assert.match(route, /We couldn&apos;t load \{what\}/);
  assert.match(route, /temporary problem reading this project, not a permissions issue/);
  // The Empty copy must not claim a conclusion the source cannot support.
  for (const forbidden of ["on track", "all clear", "everything is fine", "healthy"]) {
    assert.equal(withoutComments(route).toLowerCase().includes(forbidden), false, `must not claim "${forbidden}"`);
  }
});

test("one zone's failure removes no other zone and no header", () => {
  // `allSettled`, never `all`: a rejection must not take three healthy zones and
  // the header down with it.
  assert.match(route, /await Promise\.allSettled\(\[/);
  assert.equal(withoutComments(route).includes("Promise.all("), false, "Promise.all would blank the screen");
  // Each zone's degraded branch is keyed on its OWN read.
  assert.match(route, /raidRead === null \? \(\s*<ZoneDegraded/);
  assert.match(route, /recommendationsRead === null \? \(\s*<ZoneDegraded/);
  assert.match(route, /decisionsRead === null \? \(\s*<ZoneDegraded/);
  assert.match(route, /governance === null \? \(\s*<ZoneDegraded/);
});

test("no health score, no band, no fabricated health state", () => {
  const body = withoutComments(route) + withoutComments(projection);
  for (const forbidden of [
    "healthScore",
    "health_score",
    "detectedRaidOverview",
    "loadLatestOperationalGovernanceBrief",
    "operational_governance_briefs",
    "Monitoring",
    "at risk",
    "off track",
    "green",
    "yellow",
    "amber-rating",
  ]) {
    assert.equal(body.includes(forbidden), false, `Execution Health must not introduce ${forbidden}`);
  }
  // Zone 4's facts are exactly two counted values plus the stored status.
  assert.match(route, /label: "Project status", value: project\.status/);
  assert.match(route, /label: "Governance events recorded", value: governance\.totalGovernanceEvents/);
  assert.match(route, /label: "Governance violations recorded", value: governance\.violationsCount/);
  // And the two deliberately-omitted metrics stay omitted.
  assert.equal(body.includes("unresolvedRisksIssues"), false, "risk_issue_records would conflict with Zone 1");
  assert.equal(body.includes("incompleteChainCount"), false);
});

test("Zone 1 applies no severity gate and claims none", () => {
  // `raid_items` has no severity column and no ratified Project threshold exists,
  // so Slice 1 orders by recency and says so. Claiming a threshold would be
  // inventing a governed semantic in a sort order.
  assert.equal(projectRaidQuery(WS, PROJECT).orderBy, "last_detected_at");
  const body = withoutComments(route) + withoutComments(projection);
  for (const forbidden of ["severity", "threshold", "high priority", "critical attention", "above threshold"]) {
    assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false, `must not claim "${forbidden}"`);
  }
  // And no numeric score is derived from a field that is not one.
  assert.equal(body.includes("categoryWeight"), false);
  assert.equal(body.includes("severityOf"), false);
  assert.match(route, /most recently detected first/);
});

test("extracted RAID is disclosed as extracted, not as certified fact", () => {
  assert.match(route, /Detected automatically · confidence \{Math\.round\(confidence\)\}% · seen \{occurrences\}×/);
  assert.match(route, /autoGenerated=\{item\.auto_generated\}/);
  assert.match(route, /Generated by PMFreak/);
});

test('"+N more" is only claimed from a total taken with the rows', () => {
  assert.match(route, /function MoreThanShown\(\{ shown, total \}/);
  assert.match(route, /if \(total === null \|\| total <= shown\) return null;/);
  assert.match(projection, /count: "exact"/);
  assert.equal(route.match(/<MoreThanShown /g)?.length, 3);
});

// ─── 7. Archived ──────────────────────────────────────────────────────────

test("an archived project stays readable — archived is not an access failure", () => {
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "archived" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "archived");
  assert.equal(result.projectId, PROJECT);
  assert.equal(result.readOnly, true);
});

test("an archived parent workspace makes an active project read-only too, and both is both", () => {
  const workspaceOnly = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "active" },
    workspaceAccess: archivedWs(WS),
  });
  assert.equal(workspaceOnly.access, "archived");
  assert.deepEqual(workspaceOnly.access === "archived" ? workspaceOnly.archived : null, { project: false, workspace: true });

  const both = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "archived" },
    workspaceAccess: archivedWs(WS),
  });
  assert.deepEqual(both.access === "archived" ? both.archived : null, { project: true, workspace: true });
});

test("`completed` is a normal project state, not archival", () => {
  const result = decideRoutedProjectAccess({
    routedWorkspaceId: WS,
    projectId: PROJECT,
    project: { workspaceId: WS, status: "completed" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "granted");
  assert.equal(result.readOnly, false);
});

test("the archived notice is the shared one, and the zones still render beneath it", () => {
  assert.match(route, /\{isArchived \? <ProjectArchivedNotice archived=\{access\.archived\} \/> : null\}/);
  // The notice sits ABOVE the zones and gates none of them: archival is a
  // read-only state, not a reason to hide last-known data (§7).
  const noticeAt = route.indexOf("<ProjectArchivedNotice");
  const firstZoneAt = route.indexOf("zone={ZONE_ATTENTION}");
  assert.ok(noticeAt > -1 && firstZoneAt > noticeAt);
  assert.equal(/isArchived\s*(\?|&&)[^\n]*<Zone\s/.test(route), false, "no zone is hidden when archived");
});

test("the route is read-only — there is no mutation to withhold", () => {
  const body = withoutComments(route);
  for (const mutation of [
    '"use server"',
    "<form",
    "action=",
    "method=",
    'method: "POST"',
    'method: "PATCH"',
    'method: "PUT"',
    'method: "DELETE"',
    ".insert(",
    ".update(",
    ".upsert(",
    ".delete(",
    "revalidatePath",
    "redirect(",
    "onClick",
    "useState",
    "Accept",
    "Reject",
    "Defer",
    "Record Decision",
    "Approve",
    "Recompute",
    "Regenerate",
  ]) {
    assert.equal(body.includes(mutation), false, `Slice 1 must not contain ${mutation}`);
  }
  assert.equal(body.includes('"use client"'), false, "the screen is a server component");
  // And the projection layer writes nothing either.
  for (const mutation of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.equal(withoutComments(projection).includes(mutation), false, `the projection must not ${mutation}`);
  }
});

// ─── 8. Leakage ───────────────────────────────────────────────────────────

test("missing, unauthorized and mismatched render the one shared refusal", () => {
  assert.match(route, /import \{ ProjectArchivedNotice, ProjectNotAvailable \} from "@\/components\/pmfreak\/projects\/project-route-states"/);
  assert.equal(route.match(/<ProjectNotAvailable \/>/g)?.length, 2, "denied, and authorized-then-unreadable");
  // The component itself reveals nothing — it is the same one Project Home uses.
  // Comments stripped: the file EXPLAINS what it must not disclose, by name.
  const rendered = withoutComments(routeStates);
  assert.equal(rendered.includes("project.name"), false);
  assert.doesNotMatch(rendered, /workspaceId|pmo_id|\bstatus\b/);
});

test("the refusal log carries only what the caller already supplied", () => {
  const deniedBlock = route.slice(route.indexOf('event: "project_command_center.project_not_accessible"'));
  const logged = deniedBlock.slice(0, deniedBlock.indexOf("}),"));
  assert.match(logged, /userId: user\.id/);
  assert.match(logged, /requestedWorkspaceId,/);
  assert.match(logged, /requestedProjectId,/);
  for (const derived of ["access.workspaceId", "project.name", "project.status", "pmo", "role"]) {
    assert.equal(logged.includes(derived), false, `a refusal must not log ${derived}`);
  }
});

test("the resolver collapses absent, unauthorized and mismatched into one answer", () => {
  const outcomes = [
    decideRoutedProjectAccess({ routedWorkspaceId: WS, projectId: PROJECT, project: null, workspaceAccess: grantedWs(WS) }),
    decideRoutedProjectAccess({ routedWorkspaceId: WS, projectId: PROJECT, project: { workspaceId: WS, status: "active" }, workspaceAccess: deniedWs }),
    decideRoutedProjectAccess({ routedWorkspaceId: OTHER_WS, projectId: PROJECT, project: { workspaceId: WS, status: "active" }, workspaceAccess: grantedWs(WS) }),
    decideRoutedProjectAccess({ routedWorkspaceId: "", projectId: PROJECT, project: { workspaceId: WS, status: "active" }, workspaceAccess: grantedWs(WS) }),
  ];
  for (const outcome of outcomes) assertDenied(outcome, "every failure mode is the same answer");
  // Byte-identical verdicts, so nothing is learned from the difference.
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
});

test("an archived project in a workspace the caller cannot reach is still denied", () => {
  assertDenied(
    decideRoutedProjectAccess({
      routedWorkspaceId: WS,
      projectId: PROJECT,
      project: { workspaceId: WS, status: "archived" },
      workspaceAccess: deniedWs,
    }),
    "archival is never a way around membership",
  );
});

// ─── 9. Breadcrumb, tab and navigation ────────────────────────────────────

test("the breadcrumb is Workspace → Project → Project Command Center", () => {
  const nodes = projectCommandCenterBreadcrumb({
    workspaceLabel: "Acme",
    workspaceId: WS,
    pmo: null,
    projectName: "Apollo",
    projectId: PROJECT,
  });
  assert.deepEqual(nodes, [
    { label: "Acme", href: workspaceHomePath(WS) },
    { label: "Apollo", href: projectHomePath(WS, PROJECT) },
    { label: "Project Command Center", href: null },
  ]);
});

test("a PMO ancestor appears between Workspace and Project when the project has one", () => {
  const nodes = projectCommandCenterBreadcrumb({
    workspaceLabel: "Acme",
    workspaceId: WS,
    pmo: { id: PMO, name: "Delivery PMO" },
    projectName: "Apollo",
    projectId: PROJECT,
  });
  assert.deepEqual(nodes.map((n) => n.label), ["Acme", "Delivery PMO", "Apollo", "Project Command Center"]);
  assert.equal(nodes[1].href, pmoHomePath(WS, PMO));
});

test("the terminal node is not a link, and every ancestor links to a HOME", () => {
  const nodes = projectCommandCenterBreadcrumb({
    workspaceLabel: "Acme",
    workspaceId: WS,
    pmo: { id: PMO, name: "Delivery PMO" },
    projectName: "Apollo",
    projectId: PROJECT,
  });
  assert.equal(nodes[nodes.length - 1].href, null, "a Command Center is a trail's last node");
  assert.equal(nodes.filter((n) => n.href === null).length, 1);
  for (const node of nodes.slice(0, -1)) {
    assert.ok(node.href);
    // Never an ancestor's Command Center (§2.3 rule 1) — including the Project's
    // own, which is this very screen.
    assert.equal(isProjectCommandCenterPath(node.href!), false);
    assert.equal(isWorkspaceCommandCenterPath(node.href!), false);
    assert.equal(node.href!.endsWith("/command-center"), false);
  }
  // The Project ancestor is Project HOME: Home and Command Center are siblings.
  assert.equal(nodes[2].href, projectHomePath(WS, PROJECT));
});

test("no Portfolio or Program ancestry is fabricated, because the schema has none", () => {
  const body = withoutComments(paths) + withoutComments(route);
  for (const absent of ["portfolio_id", "program_id", "portfolioId", "programId"]) {
    assert.equal(body.includes(absent), false, `there is no ${absent} to build a node from`);
  }
  const nodes = projectCommandCenterBreadcrumb({
    workspaceLabel: "Acme",
    workspaceId: WS,
    pmo: null,
    projectName: "Apollo",
    projectId: PROJECT,
  });
  assert.equal(nodes.length, 3, "no invented middle node for a direct project");
});

test("the breadcrumb is fed resolved ancestry, not the URL", () => {
  // The PMO node is only claimed when `pmo_id` answers inside the AUTHORIZED
  // workspace; the workspace label comes from a read of the authorized id.
  assert.match(route, /\.from\("pmos"\)[\s\S]{0,200}\.eq\("id", project\.pmo_id\)[\s\S]{0,80}\.eq\("workspace_id", workspaceId\)/);
  assert.match(route, /const pmo: ProjectBreadcrumbPmo = ancestry\.pmo;/);
  assert.match(route, /workspaceLabel: workspace\?\.name \?\? "Workspace"/);
  assert.match(route, /workspaceId,\s*\n\s*pmo,/);
});

test("the Project tab strip gains exactly one canonical entry, built by the helper", () => {
  assert.match(
    tabNav,
    /\{ label: "Project Command Center", href: projectCommandCenterPath\(workspaceId, projectId\), key: "command-center" \}/,
  );
  assert.match(tabNav, /active: "overview" \| "command-center" \| "chat" \| "settings"/);
  // One entry, not two, and no hand-typed path anywhere in the strip.
  assert.equal(tabNav.match(/projectCommandCenterPath\(/g)?.length, 1);
  assert.doesNotMatch(withoutComments(tabNav), /["'`]\/workspaces\/[^"'`]*\/projects\//);
});

test("the tab label is entity-qualified — never a bare Command Center", () => {
  // ADR-PMF-014 Rules 1 and 3.
  for (const [name, source] of [["tab nav", tabNav], ["route", route]] as const) {
    const copy = withoutComments(source);
    const bare = [...copy.matchAll(/(\w+\s+)?Command Center/g)].filter((m) => {
      const prefix = (m[1] ?? "").trim();
      return prefix !== "Project" && prefix !== "PMO" && prefix !== "Workspace";
    });
    assert.deepEqual(bare.map((m) => m[0]), [], `${name} must qualify every Command Center mention`);
  }
  assert.match(route, /\{project\.name\} — Project Command Center/);
});

test("the route uses the shared tab strip and marks itself active", () => {
  assert.match(route, /<ProjectTabNav workspaceId=\{workspaceId\} projectId=\{project\.id\} active="command-center" \/>/);
});

test("on the Project Command Center, Projects is the active nav entry", () => {
  assert.equal(navEntryMatchesPathname(PROJECTS_NAV_HREF, CANONICAL), true);
  assert.equal(navEntryMatchesPathname("/workspaces", CANONICAL), false, "Workspaces must not also light up");
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL), false, "nor the Workspace Command Center");
  assert.equal(navEntryMatchesPathname(PMOS_NAV_HREF, CANONICAL), false);
  // Exactly one primary entry claims it.
  const claiming = NAVIGATION_HIERARCHY.filter((node) => navEntryMatchesPathname(node.href, CANONICAL));
  assert.deepEqual(claiming.map((n) => n.href), [PROJECTS_NAV_HREF]);
});

test("global navigation is unchanged — no new entry, no relabelled entry", () => {
  assert.deepEqual(
    NAVIGATION_HIERARCHY.filter((n) => n.tier === "primary").map((n) => `${n.label}|${n.href}`),
    ["Command Center|/command-center", "Projects|/projects", "Execution|/execution", "Portfolio|/portfolio"],
  );
  assert.equal(
    NAVIGATION_HIERARCHY.some((n) => n.href.includes("/projects/")),
    false,
    "a Project surface is reached from its Project, never from global nav",
  );
});

test("the sidebar lights the routed project on the Command Center path", () => {
  // It reads `parseCanonicalProjectRoute(pathname)?.projectId`, which is
  // surface-agnostic — so this needed no edit and must keep needing none.
  assert.match(sidebarTree, /const routedProject = parseCanonicalProjectRoute\(pathname\)/);
  assert.match(sidebarTree, /routedProject\?\.projectId === project\.id/);
  assert.equal(parseCanonicalProjectRoute(CANONICAL)?.projectId, PROJECT);
});

test("the protected layout derives workspace context from this route already", () => {
  assert.match(protectedLayout, /parseCanonicalProjectRoute\(routedHeaders\.get\("x-pathname"\) \?\? ""\)\?\.workspaceId/);
  assert.match(protectedLayout, /const routedProjectRoute = parseCanonicalProjectRoute\(/);
  assert.equal(parseCanonicalProjectRoute(CANONICAL)?.workspaceId, WS);
});

test("route policy and session continuation accept it without widening any allowlist", () => {
  assert.equal(isProtectedPageRoute(CANONICAL), true);
  assert.equal(getRouteAccessPolicy(CANONICAL), "workspace-contextual");
  assert.equal(isSafeContinuationRoute(CANONICAL), true);
  // Both already cover it through the `/workspaces` prefix they had at base.
  const registry = readFileSync("src/lib/auth/route-policy-registry.ts", "utf8");
  const continuation = readFileSync("src/lib/auth/validate-continuation-route.ts", "utf8");
  assert.equal(registry.includes("/projects/"), false, "no per-surface registry entry was added");
  assert.equal(continuation.includes("command-center/"), false, "the allowlist was not widened");
});

// ─── 10. Nothing else moved ───────────────────────────────────────────────

test("/command-center remains the Workspace Command Center's compatibility resolver", () => {
  assert.match(bareCommandCenter, /redirect\(workspaceCommandCenterPath\(/);
  assert.doesNotMatch(bareCommandCenter, /project-paths|projectHomePath|routed-project|projectCommandCenterPath/);
  assert.equal(isProjectCommandCenterPath("/command-center"), false);
  // The Execution tab still points there, because that destination screen has
  // not moved. Truthful, not a half-finished migration.
  assert.ok(tabNav.includes("`/command-center?projectId=${projectId}`"));
});

test("/pmo-command-center still redirects to PM Operations", () => {
  assert.match(legacyPmoCommandCenter, /redirect\(PM_OPERATIONS_PATH\)/);
  assert.doesNotMatch(legacyPmoCommandCenter, /project/i);
});

test("/projects/[id] remains the Project HOME resolver, not a Command Center one", () => {
  assert.match(legacyProjectRoute, /resolveLegacyProjectRoute/);
  assert.match(legacyProjectRoute, /redirect\(projectHomePath\(/);
  assert.equal(withoutComments(legacyProjectRoute).includes("projectCommandCenterPath"), false);
});

test("the Workspace and PMO Command Centers are untouched by this slice", () => {
  for (const [name, source] of [
    ["Workspace Command Center", workspaceCommandCenter],
    ["PMO Command Center", pmoCommandCenter],
  ] as const) {
    assert.equal(
      withoutComments(source).includes("project-command-center"),
      false,
      `${name} must not import this slice`,
    );
    assert.equal(withoutComments(source).includes("projectCommandCenterPath"), false, name);
  }
  // The Workspace Command Center keeps its picker and its portfolio strip — this
  // slice does not redesign it, and does not borrow from it either.
  assert.match(workspaceCommandCenter, /resolveActiveProject/);
  assert.match(workspaceCommandCenter, /listPmosWithProjects/);
});

test("Project Home keeps everything it had, and stays a different screen", () => {
  for (const kept of [
    "<ProjectTaskList",
    "<ProjectPMAssignment",
    "Run PMFreak AI",
    "Previous analyses",
    "onboarding_analyses",
    "/api/analyze-ai",
  ]) {
    assert.ok(projectHome.includes(kept), `Project Home must keep ${kept}`);
  }
  // Home is not the Command Center, and the Command Center is not Home.
  assert.equal(projectHome.includes("Project Command Center</h1>"), false);
  assert.equal(withoutComments(route).includes("ProjectTaskList"), false);
  assert.equal(withoutComments(route).includes("ProjectPMAssignment"), false);
  assert.equal(withoutComments(route).includes("analyze-ai"), false);
  assert.match(route, /It is NOT Project Home/);
});

test("this slice introduces no schema change and no migration", () => {
  for (const [name, source] of NEW_SLICE_FILES) {
    assert.equal(withoutComments(source).includes("supabase/migrations"), false, `${name} must not reference a migration`);
    assert.equal(/create (table|policy|function)/i.test(withoutComments(source)), false, name);
  }
  // Every table and RPC this slice reads existed at base.
  const baseMigration = readFileSync("supabase/migrations/20260602020000_raid_auto_extraction.sql", "utf8");
  assert.match(baseMigration, /create table if not exists public\.raid_items/);
  const loopMigration = readFileSync("supabase/migrations/20260908000000_p2_02_attention_membership_snapshot.sql", "utf8");
  assert.match(loopMigration, /function public\.get_operational_assurance_summary/);
});

test("the assurance RPC's own SQL still carries the predicate Zone 3 relies on", () => {
  // Zone 3 does not read `openRecommendations`, but the Phase 1 verification that
  // the two predicates agree is worth pinning: if the RPC ever broadens, a future
  // slice must not adopt it without noticing.
  const sql = readFileSync("supabase/migrations/20260908000000_p2_02_attention_membership_snapshot.sql", "utf8");
  assert.match(
    sql,
    /'openRecommendations',\(select count\(\*\) from public\.recommended_actions where workspace_id=p_workspace_id and project_id=p_project_id and governance_event_id is not null and status='proposed'\)/,
  );
});

test("no file under src/modules/workspace is reachable from this slice", () => {
  for (const [name, source] of [...NEW_SLICE_FILES, ["tab nav", tabNav] as [string, string]]) {
    assert.equal(withoutComments(source).includes("modules/workspace"), false, `${name} must not reach the workspace module`);
  }
});

test("no canonical Project path is hand-typed anywhere this slice touched", () => {
  // One builder, one definition, so reverting the slice means reverting its
  // callers rather than hunting literals (ADR-PMF-068 rule 5).
  for (const [name, source] of [
    ["route", route],
    ["command-center paths", paths],
    ["tab nav", tabNav],
    ["project home", projectHome],
  ] as const) {
    assert.doesNotMatch(
      withoutComments(source),
      /["'`]\/workspaces\/[^"'`$]*\/projects\//,
      `${name} must not re-type a canonical Project path`,
    );
  }
  // And every surface in the table resolves.
  for (const surface of PROJECT_SURFACES) {
    assert.equal(isCanonicalProjectRoutePath(projectSurfacePath(WS, PROJECT, surface)), true);
  }
});

// ─── 11. PR #610 review corrections (Codex P2 #1, #2, #3) ─────────────────
//
// Three unresolved P2 findings from the merged Project Command Center PR. Each
// is a DATA-HONESTY defect rather than a layout one, so each is pinned by the
// property that was violated, not by the pixel that changed.

// P2 #1 — a historical governance-event classification is never presented as
//         work currently awaiting a person.

test("Execution Health no longer restates a historical governance-event count", () => {
  // `decisionRequiredCount` counts `governance_events.governance_status =
  // 'decision_required'` — the classification the event was RAISED under.
  // `record_operational_decision` writes an `operational_decision_records` row
  // and moves `recommended_actions.status` off `proposed`; it never rewrites the
  // event's classification. Pinned against the shipped SQL so this stays a fact
  // about the database rather than a claim in a comment.
  const loop = readFileSync("supabase/migrations/20260611000000_operational_evidence_decision_loop.sql", "utf8");
  const decisionFn = loop.slice(loop.indexOf("function public.record_operational_decision"));
  const body = decisionFn.slice(0, decisionFn.indexOf("create or replace function public.get_operational_assurance_summary"));
  assert.ok(body.includes("update public.recommended_actions set status=target_status"));
  assert.equal(
    /update\s+public\.governance_events\s+set[^;]*governance_status/.test(body),
    false,
    "a recorded decision does not reclassify the governance event, so the count does not fall",
  );

  // So the projection does not carry it, and the screen cannot render it.
  assert.equal(withoutComments(projection).includes("decisionRequiredCount"), false);
  assert.equal(withoutComments(route).includes("decisionRequiredCount"), false);
  const facts = selectProjectGovernanceFacts(
    { scope: "project", workspaceId: WS, projectId: PROJECT, totalGovernanceEvents: 9, decisionRequiredCount: 4, violationsCount: 1 },
    WS,
    PROJECT,
  );
  assert.deepEqual(facts, { totalGovernanceEvents: 9, violationsCount: 1 });
  assert.equal("decisionRequiredCount" in (facts as object), false, "the historical count is dropped, not renamed");
});

test("a decided recommendation leaves no copy claiming a decision is still awaited", () => {
  // The scenario the finding describes, end to end: the governance event keeps
  // its `decision_required` classification forever, while the recommendation it
  // produced has been accepted. Zone 3 — the authoritative CURRENT population —
  // is empty, and Execution Health states only counted facts, so nothing on the
  // screen can be sourced from the stale classification.
  const decided = recRow({ governance_event_id: "g1", status: "accepted" });
  assert.deepEqual(selectProjectRecommendations([decided], WS, PROJECT, true), [], "a decided row leaves Zone 3");

  const stillClassifiedDecisionRequired = selectProjectGovernanceFacts(
    { scope: "project", workspaceId: WS, projectId: PROJECT, totalGovernanceEvents: 1, decisionRequiredCount: 1, violationsCount: 0 },
    WS,
    PROJECT,
  );
  assert.deepEqual(stillClassifiedDecisionRequired, { totalGovernanceEvents: 1, violationsCount: 0 });

  // Every Execution Health tile label, and the value each is bound to. The zone
  // may only ever say what it counted.
  const zone4 = route.slice(route.indexOf("zone={ZONE_HEALTH}"));
  const tiles = [...zone4.matchAll(/label: "([^"]+)", value: ([A-Za-z.]+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tiles, [
    ["Project status", "project.status"],
    ["Governance events recorded", "governance.totalGovernanceEvents"],
    ["Governance violations recorded", "governance.violationsCount"],
  ]);
  for (const [label] of tiles) {
    for (const forbidden of ["awaiting", "pending", "needs decision", "requires action", "outstanding", "unresolved"]) {
      assert.equal(label.toLowerCase().includes(forbidden), false, `Execution Health tile "${label}" must not claim "${forbidden}"`);
    }
  }

  // "awaiting a decision" survives in exactly one place — Zone 3, whose count and
  // rows come from the live `status='proposed'` predicate.
  const zone3 = route.slice(route.indexOf("zone={ZONE_DECISIONS}"), route.indexOf("zone={ZONE_HEALTH}"));
  assert.match(zone3, /\{pendingDecisionsTotal\} awaiting a decision/);
  assert.equal(projectPendingDecisionsQuery(WS, PROJECT).status, PROPOSED_RECOMMENDATION_STATUS);
  assert.equal(projectPendingDecisionsQuery(WS, PROJECT).governed, true);
  assert.equal(zone4.toLowerCase().includes("awaiting"), false, "Execution Health claims nothing is awaited");
});

// P2 #2 — a failed PMO lookup is a different state from a project with no PMO.

test("a null pmo_id is a legitimate absence, not a failure", () => {
  assert.deepEqual(resolveProjectPmoAncestry({ pmoId: null, row: null, error: null }), { state: "none", pmo: null });
  // And with no `pmo_id` the route issues no read at all, so there is nothing
  // that could have failed.
  assert.match(route, /const pmoLookup = project\.pmo_id\s*\n\s*\? await supabase/);
  assert.match(route, /: \{ data: null, error: null \};/);
});

test("a failed PMO lookup is its own state and never claims the project has no PMO", () => {
  const failed = resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: { message: "connection reset" } });
  assert.deepEqual(failed, { state: "unavailable", pmo: null });
  assert.notEqual(failed.state, "none", "an unanswered question is not a recorded absence");

  // A succeeded read with no accessible row is a third state again — kept apart
  // so it can never be silently re-labelled as "this project has no PMO".
  assert.deepEqual(resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: null }), { state: "not-visible", pmo: null });

  // Four distinguishable outcomes, four distinct states.
  const states = [
    resolveProjectPmoAncestry({ pmoId: null, row: null, error: null }).state,
    resolveProjectPmoAncestry({ pmoId: PMO, row: { id: PMO, name: "Delivery PMO" }, error: null }).state,
    resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: null }).state,
    resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: { message: "x" } }).state,
  ];
  assert.equal(new Set(states).size, 4);
});

test("a failed PMO lookup fabricates no ancestry", () => {
  // The error is checked BEFORE the row, so a driver that returns both cannot
  // have its row adopted.
  const both = resolveProjectPmoAncestry({ pmoId: PMO, row: { id: PMO, name: "Delivery PMO" }, error: { message: "timeout" } });
  assert.equal(both.state, "unavailable");
  assert.equal(both.pmo, null);

  // Only `resolved` carries a pmo, so no failure path can reach the trail.
  for (const ancestry of [
    resolveProjectPmoAncestry({ pmoId: null, row: null, error: null }),
    resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: null }),
    resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: { message: "x" } }),
  ]) {
    assert.equal(ancestry.pmo, null);
    const nodes = projectCommandCenterBreadcrumb({
      workspaceLabel: "Acme",
      workspaceId: WS,
      pmo: ancestry.pmo,
      projectName: "Apollo",
      projectId: PROJECT,
    });
    assert.deepEqual(nodes.map((n) => n.label), ["Acme", "Apollo", "Project Command Center"]);
  }

  // No stand-in name, no borrowed workspace, no other PMO.
  const degraded = withoutComments(route).slice(withoutComments(route).indexOf("resolveProjectPmoAncestry({"));
  for (const forbidden of ["Unknown PMO", "resolvePreferredWorkspace", "preferredWorkspace", "firstPmo", '.from("pmos").select("id, name").limit']) {
    assert.equal(degraded.includes(forbidden), false, `ancestry degradation must not reach ${forbidden}`);
  }
  // Exactly one `pmos` read on the whole screen, and it is scoped by both ids.
  assert.equal(withoutComments(route).match(/\.from\("pmos"\)/g)?.length, 1);
});

test("a failed PMO lookup does not blank the Project Command Center", () => {
  const afterAncestry = route.slice(route.indexOf("resolveProjectPmoAncestry({"));
  // The degraded branch logs and falls through — it introduces no early return,
  // so the single final `return (` is still the only one left in the component.
  assert.equal(afterAncestry.match(/^  return \(/gm)?.length, 1, "ancestry degradation adds no early exit");
  assert.equal(/return <ProjectNotAvailable/.test(afterAncestry), false);
  assert.equal(/notFound\(|redirect\(/.test(afterAncestry), false);

  // The notice is non-blocking: it sits inside the same tree as all four zones,
  // between the breadcrumb and the heading, and replaces no crumb.
  const notice = route.indexOf("PMO ancestry is temporarily unavailable.");
  assert.ok(notice > -1, "the degraded state is stated, not swallowed");
  assert.ok(notice > route.indexOf('<nav aria-label="Breadcrumb"'));
  assert.ok(notice < route.indexOf("zone={ZONE_ATTENTION}"));
  assert.match(route, /\{ancestry\.state === "unavailable" \? \(\s*\n\s*<p[^>]*>PMO ancestry is temporarily unavailable\.<\/p>/);
  assert.equal(route.match(/<Zone\s/g)?.length, 4, "all four zones still render");

  // Logged with scoped identifiers only — and never the unresolved pmo_id.
  const log = route.slice(route.indexOf("project_command_center.pmo_ancestry_unavailable"));
  const fields = log.slice(0, log.indexOf("}),"));
  assert.match(fields, /workspaceId,/);
  assert.match(fields, /projectId,/);
  assert.equal(fields.includes("pmo_id"), false, "the unverified ancestry id is not logged");
  assert.equal(fields.includes("project.name"), false);
});

test("a foreign-workspace PMO still cannot appear in the trail", () => {
  // The read is filtered by the AUTHORIZED workspace, so a PMO in another
  // workspace comes back as no row — `not-visible`, never `resolved`.
  assert.match(
    route,
    /\.from\("pmos"\)[\s\S]{0,200}\.eq\("id", project\.pmo_id\)[\s\S]{0,80}\.eq\("workspace_id", workspaceId\)/,
  );
  assert.deepEqual(resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: null }), { state: "not-visible", pmo: null });
  // And `not-visible` says nothing on screen: reporting "a PMO exists but you
  // cannot see it" would be the existence oracle this route refuses to be.
  assert.equal(withoutComments(route).includes('ancestry.state === "not-visible"'), false);
});

// P2 #3 — an AI Recommendation carries its stored Why, Evidence and Confidence.

test("Zone 2 selects the stored rationale and evidence_summary", () => {
  for (const column of ["rationale", "evidence_summary"]) {
    assert.ok(PROJECT_RECOMMENDATION_COLUMNS.split(", ").includes(column), `${column} must be selected`);
    assert.ok(
      RECOMMENDED_ACTION_SELECTABLE_COLUMNS.includes(column as (typeof RECOMMENDED_ACTION_SELECTABLE_COLUMNS)[number]),
      `${column} must be an existing database-contract column, not a new one`,
    );
  }
  // The descriptors both zones use carry it to the database.
  for (const query of [projectRecommendationsQuery(WS, PROJECT), projectPendingDecisionsQuery(WS, PROJECT)]) {
    assert.equal(query.columns, PROJECT_RECOMMENDATION_COLUMNS);
  }
});

/**
 * The REAL stored shape, from the real producer.
 *
 * Zone 2 lists ungoverned `proposed` rows, and in this repository those have
 * exactly one writer: `generate-recommended-actions.ts`, persisted verbatim by
 * `materialize-recommended-actions.ts` (`rationale: action.rationale`,
 * `evidence_summary: action.evidenceSummary`). Generating the fixture rather
 * than hand-copying it is the point — if the producer's schema moves, these
 * assertions move with it instead of testing a stale transcription.
 */
const RAID_ITEM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SOURCE_SIGNAL_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const PRODUCED = generateRecommendedActions({
  id: RAID_ITEM_ID,
  workspaceId: WS,
  projectId: PROJECT,
  category: "risk",
  title: "Vendor approval may delay launch",
  description: "Vendor sign-off on the integration contract is still outstanding.",
  confidenceScore: 82,
  owner: "Dana",
  sourceSignalId: SOURCE_SIGNAL_ID,
})[0];
const STORED_RATIONALE = PRODUCED.rationale;
const STORED_EVIDENCE = PRODUCED.evidenceSummary;

test("the producer really does persist the machine-contract fields this mapper must hide", () => {
  // Without this, every assertion below would pass vacuously.
  assert.equal(STORED_RATIONALE.trigger, "approval_dependency_detected");
  assert.equal(STORED_RATIONALE.raidCategory, "risk");
  assert.equal(STORED_RATIONALE.riskText, "Vendor approval may delay launch");
  assert.equal(STORED_EVIDENCE.raidItemId, RAID_ITEM_ID);
  assert.equal(STORED_EVIDENCE.raidCategory, "risk");
  assert.equal(STORED_EVIDENCE.raidTitle, "Vendor approval may delay launch");
  assert.equal(STORED_EVIDENCE.raidConfidenceScore, 82);
  assert.equal(STORED_EVIDENCE.discoveryOrigin, "project_discovery");
  assert.equal(STORED_EVIDENCE.sourceSignalId, SOURCE_SIGNAL_ID);
});

/** Everything a user could read out of the two selectors, as one string. */
const disclosureText = (rationale: unknown, evidenceSummary: unknown) =>
  JSON.stringify({
    why: selectRaidRecommendationWhy(rationale, evidenceSummary),
    evidence: selectRaidRecommendationEvidence(rationale, evidenceSummary, PROJECT),
  });

test("no internal producer vocabulary survives into the disclosure", () => {
  const shown = disclosureText(STORED_RATIONALE, STORED_EVIDENCE);
  for (const internal of [
    // Rule-engine enums. The stored Risk and its title already say what was
    // detected; the trigger explains PMFreak's implementation instead.
    "approval_dependency_detected",
    "trigger",
    // A pipeline classification the producer hard-codes.
    "project_discovery",
    "discoveryOrigin",
    // Opaque identifiers. A uuid is not evidence copy.
    RAID_ITEM_ID,
    "raidItemId",
    SOURCE_SIGNAL_ID,
    "sourceSignalId",
  ]) {
    assert.equal(shown.includes(internal), false, `${internal} must not reach a user`);
  }
  // Nor may a prettified pseudo-label for any of them appear in the screen's copy.
  for (const label of ["Trigger:", "Discovery origin:", "Raid item id:", "Source signal id:", "Raid category:"]) {
    assert.equal(withoutComments(route).includes(label), false, `${label} must not be rendered`);
  }
});

test("an arbitrary future producer key cannot start rendering on its own", () => {
  // This is the forward-facing half of the finding: a generic Object.entries()
  // mapper renders whatever a producer adds, with nobody having decided it should.
  const widened = {
    ...STORED_EVIDENCE,
    someFutureFlag: true,
    newProducerKey: "a value nobody reviewed",
    modelTemperature: 0.7,
    promptVersion: "v42",
  };
  const shown = disclosureText({ ...STORED_RATIONALE, internalRuleId: "rule-1189" }, widened);
  for (const unknownKey of [
    "someFutureFlag",
    "newProducerKey",
    "a value nobody reviewed",
    "modelTemperature",
    "0.7",
    "promptVersion",
    "v42",
    "internalRuleId",
    "rule-1189",
  ]) {
    assert.equal(shown.includes(unknownKey), false, `${unknownKey} is not an allowlisted disclosure fact`);
  }
  // And the disclosure is unchanged by the extra keys — allowlist, not filter-list.
  assert.equal(shown, disclosureText(STORED_RATIONALE, STORED_EVIDENCE));
  // Structurally: neither selector iterates the stored object at all.
  const body = withoutComments(projection);
  for (const generic of ["Object.entries", "Object.keys", "Object.values", "selectRecommendationDisclosure"]) {
    assert.equal(body.includes(generic), false, `the generic JSON presentation must be gone (${generic})`);
  }
});

test("Why is the stored detected condition, in governed RAID vocabulary", () => {
  assert.deepEqual(selectRaidRecommendationWhy(STORED_RATIONALE, STORED_EVIDENCE), {
    category: "Risk",
    condition: "Vendor approval may delay launch",
  });
  // The four nouns `02-canonical-product-language.md` ratifies — exactly the four
  // values `raid_items.category` is CHECK-constrained to, and nothing else.
  assert.deepEqual(GOVERNED_RAID_CATEGORY_LABELS, {
    risk: "Risk",
    issue: "Issue",
    dependency: "Dependency",
    assumption: "Assumption",
  });
  assert.match(
    readFileSync("supabase/migrations/20260602020000_raid_auto_extraction.sql", "utf8"),
    /category text not null check \(category in \('risk', 'assumption', 'issue', 'dependency'\)\)/,
  );
  // `rationale.riskText` is the SAME stored string the producer writes as
  // `raidTitle`, so it is a fallback and never a second, duplicated line.
  assert.deepEqual(selectRaidRecommendationWhy(STORED_RATIONALE, { raidCategory: "risk" }), {
    category: "Risk",
    condition: "Vendor approval may delay launch",
  });
  // A category the enum does not name is dropped rather than prettified.
  assert.deepEqual(selectRaidRecommendationWhy({}, { raidCategory: "raid_unknown", raidTitle: "Integration testing is blocked" }), {
    category: null,
    condition: "Integration testing is blocked",
  });
  // Every other stored category still reads as its governed noun.
  for (const [stored, label] of Object.entries(GOVERNED_RAID_CATEGORY_LABELS)) {
    assert.equal(selectRaidRecommendationWhy({}, { raidCategory: stored, raidTitle: "x" })?.category, label);
  }
  // No stored human condition — no Why at all. Nothing is composed from the
  // Recommendation's own title or description.
  for (const empty of [null, undefined, [], "text", 7, {}, { raidTitle: "   " }, { raidTitle: 7 }, { raidCategory: "risk" }]) {
    assert.equal(selectRaidRecommendationWhy(null, empty), null, "an absent condition is omitted, never invented");
    assert.equal(selectRaidRecommendationWhy(empty, null), null);
  }
});

test("Evidence names the stored RAID item and never its identifiers", () => {
  assert.deepEqual(selectRaidRecommendationEvidence(STORED_RATIONALE, STORED_EVIDENCE, PROJECT), {
    inputs: [{ category: "Risk", name: "Vendor approval may delay launch", detectedConfidence: 82 }],
    repositoryHref: `/evidence?projectId=${PROJECT}`,
  });
  // §2 forbids "based on project data": with nothing NAMED there is no Evidence
  // section, not a vague one.
  for (const empty of [null, undefined, [], "text", 7, {}, { raidItemId: RAID_ITEM_ID }, { raidTitle: "  " }]) {
    assert.equal(selectRaidRecommendationEvidence(null, empty, PROJECT), null);
  }
  // The RAID item's own recorded confidence is provenance, and it is only read
  // when it is a real 0–100 percentage.
  for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "82"]) {
    assert.equal(
      selectRaidRecommendationEvidence(null, { raidTitle: "t", raidConfidenceScore: bad }, PROJECT)?.inputs[0]
        .detectedConfidence,
      null,
    );
  }
});

test("the evidence link is truthful: the collection, never a fabricated item route", () => {
  const evidence = selectRaidRecommendationEvidence(STORED_RATIONALE, STORED_EVIDENCE, PROJECT);
  assert.ok(evidence);

  // The MAPPER still carries no href of its own — it names the input and holds no
  // identifier. The item-level destination is composed at render time from the
  // lineage column, and only for a record that actually loaded
  // (`resolveSupportingRaid`), which is what keeps this selector free of ids.
  assert.equal("href" in evidence.inputs[0], false, "the mapper names the input; it does not address it");
  // And no per-record ROUTE was invented to host the panel. Audited, not assumed:
  //   - no page or API route under src/app addresses a `raid_items` row by id;
  //   - `03-canonical-information-architecture.md` §5.8's Risks / Issues /
  //     Dependencies screens are unbuilt, which is why `project-paths.ts` refuses
  //     to list them in PROJECT_SURFACES;
  //   - `/evidence?projectId=` lists `project_evidence` documents — a different
  //     table from `raid_items`, with no item selector.
  // The panel is hosted by the authorized Project Command Center instead, and
  // reached by a same-document fragment.
  assert.deepEqual(PROJECT_SURFACES.filter((s) => ["risks", "issues", "dependencies", "documents"].includes(s)), []);
  assert.equal(existsSync("src/app/(protected)/risks/page.tsx"), false);
  assert.equal(existsSync("src/app/(protected)/raid/page.tsx"), false);

  // The one destination offered DOES exist, IS protected, and enforces the same
  // project scope the user arrived with.
  assert.equal(projectEvidenceRepositoryPath(PROJECT), `/evidence?projectId=${PROJECT}`);
  assert.equal(evidence.repositoryHref, projectEvidenceRepositoryPath(PROJECT));
  assert.ok(existsSync("src/app/(protected)/evidence/page.tsx"));
  assert.equal(isProtectedPageRoute("/evidence"), true);
  assert.match(
    readFileSync("src/app/api/project-evidence/route.ts", "utf8"),
    /await requireProjectAccess\(projectId, "read"\)/,
  );
  // Query-string ids are encoded — an id carrying `&` must not become a second
  // parameter, and must never address another project.
  assert.equal(projectEvidenceRepositoryPath("a&projectId=b"), "/evidence?projectId=a%26projectId%3Db");

  // And the copy says what the link opens, so it cannot be read as this item.
  assert.match(route, /Open project evidence/);
  assert.match(route, /the project&apos;s evidence collection, not this specific item\./);
});

test("Zone 2 renders Why, then Evidence, then Confidence", () => {
  const zone2 = route.slice(route.indexOf("zone={ZONE_RECOMMENDATIONS}"), route.indexOf("zone={ZONE_DECISIONS}"));
  // One pure combiner produces both halves — the stored snapshot and the exact
  // resolved supporting row, decided in one place rather than by conditionals
  // spread through this JSX (section 12).
  assert.match(
    zone2,
    /const disclosure = resolveRecommendationDisclosure\(\s*item\.rationale,\s*item\.evidence_summary,\s*supporting,\s*projectId,\s*\);/,
  );
  const why = zone2.indexOf("<RecommendationWhy why={disclosure.why} />");
  const evidence = zone2.indexOf("<RecommendationEvidence evidence={disclosure.evidence} supporting={supporting} />");
  const confidence = zone2.indexOf("Recommendation confidence {Math.round(item.confidence_score)}%");
  assert.ok(why > -1, "Why is mapped from the stored disclosure");
  assert.ok(evidence > why, "Evidence follows Why");
  assert.ok(confidence > evidence, "Confidence follows Evidence");
  // The directive still leads, and the stored basis sits under it.
  assert.ok(zone2.indexOf("{item.title}") < why);
  // Both sections vanish with their stored basis rather than rendering empty.
  assert.match(route, /function RecommendationWhy\(\{ why \}[\s\S]{0,140}if \(why === null\) return null;/);
  assert.match(route, /function RecommendationEvidence\(\{\s*evidence,\s*supporting,[\s\S]{0,220}if \(evidence === null\) return null;/);
  // Evidence is scoped to the AUTHORIZED project id, never a routed segment.
  assert.equal(zone2.includes("requestedProjectId"), false);
});

test("the two confidences stay distinct, visible and adjacent to their basis", () => {
  const zone2 = route.slice(route.indexOf("zone={ZONE_RECOMMENDATIONS}"), route.indexOf("zone={ZONE_DECISIONS}"));
  // §2.1: never a bare number, never colour-only. The Recommendation's own
  // confidence stays visible, and its absence is stated rather than implied.
  assert.match(zone2, /item\.confidence_score !== null \? \(/);
  assert.match(zone2, /Recommendation confidence \{Math\.round\(item\.confidence_score\)\}%/);
  assert.match(zone2, /Recommendation confidence not recorded/);
  // The RAID item's recorded confidence is provenance and is labelled as a
  // different number about a different thing — never as the Recommendation's.
  assert.match(route, /detection confidence \{input\.detectedConfidence\}%/);
  assert.notEqual("detection confidence", "Recommendation confidence");
  // The SNAPSHOT mapper still reads `evidence_summary.raidConfidenceScore`,
  // because that is a real stored fact about what the producer saw. What a reader
  // is SHOWN is a separate decision, and it is never
  // `recommended_actions.confidence_score` and never a stale snapshot value under
  // a present-tense label — see section 12.
  assert.match(withoutComments(projection), /storedPercentage\(evidence, "raidConfidenceScore"\)/);
  assert.equal(
    selectRaidRecommendationEvidence(null, { raidTitle: "t", raidConfidenceScore: 40 }, PROJECT)?.inputs[0]
      .detectedConfidence,
    40,
  );
  assert.equal(
    resolveRecommendationDisclosure(
      null,
      { raidTitle: "t", raidConfidenceScore: 40 },
      resolveSupportingRaid(null, new Map()),
      PROJECT,
    ).evidence?.inputs[0].detectedConfidence,
    null,
    "with no resolved row there is no current detection confidence to state",
  );
  assert.equal(recRow({ confidence_score: 70 }).confidence_score, 70, "and the Recommendation's own stays its own");
  // No band, no threshold, no colour-only meaning introduced.
  for (const forbidden of ["low confidence", "high confidence", "band", "threshold", "text-red-", "text-green-"]) {
    assert.equal(zone2.toLowerCase().includes(forbidden.toLowerCase()), false, `Zone 2 must not introduce ${forbidden}`);
  }
});

test("Zone 2 makes no claim it cannot source, and stays read-only", () => {
  const zone2 = withoutComments(route).slice(
    withoutComments(route).indexOf("zone={ZONE_RECOMMENDATIONS}"),
    withoutComments(route).indexOf("zone={ZONE_DECISIONS}"),
  );
  // No bare directive presentation, and no rationale synthesized from the text
  // the rationale is supposed to justify.
  for (const forbidden of ["AI says", "AI recommends", "Based on project data", "item.description}\", ", "summariz"]) {
    assert.equal(zone2.toLowerCase().includes(forbidden.toLowerCase()), false, `Zone 2 must not present "${forbidden}"`);
  }
  // The selectors read their arguments and nothing else — they cannot see, and
  // so cannot borrow from, the recommendation's own title or description.
  const body = withoutComments(projection);
  for (const selector of ["export function selectRaidRecommendationWhy", "export function selectRaidRecommendationEvidence"]) {
    const from = body.slice(body.indexOf(selector));
    const selectorBody = from.slice(0, from.indexOf("\n}") + 2);
    for (const name of ["title", "description", "recommended_action_type"]) {
      assert.equal(selectorBody.includes(name), false, `${selector} must not read ${name}`);
    }
  }
  // Still read-only: the decision controls arrive in a later slice.
  for (const forbidden of ["Accept", "Reject", "Defer", "<form", "<button", "action=", "use server", "onClick"]) {
    assert.equal(zone2.includes(forbidden), false, `Zone 2 must not gain ${forbidden}`);
  }
});

test("Zone 2 stays project-scoped and ungoverned-only", () => {
  const query = projectRecommendationsQuery(WS, PROJECT);
  assert.equal(query.table, "recommended_actions");
  assert.equal(query.workspaceId, WS);
  assert.equal(query.projectId, PROJECT);
  assert.equal(query.governed, false, "governance_event_id IS NULL");
  assert.equal(query.status, PROPOSED_RECOMMENDATION_STATUS);
  // And the in-memory guard still rejects everything the predicate excludes,
  // disclosure columns or not.
  const withDisclosure = { rationale: { trigger: "t" }, evidence_summary: { raidItemId: "r1" } };
  assert.deepEqual(
    selectProjectRecommendations(
      [
        recRow({ id: "keep", ...withDisclosure }),
        recRow({ id: "governed", governance_event_id: "g1", ...withDisclosure }),
        recRow({ id: "decided", status: "accepted", ...withDisclosure }),
        recRow({ id: "sibling", project_id: OTHER_PROJECT, ...withDisclosure }),
        recRow({ id: "foreign", workspace_id: OTHER_WS, ...withDisclosure }),
      ],
      WS,
      PROJECT,
      false,
    ).map((r) => r.id),
    ["keep"],
  );
});

// ─── 11. Zone 2's item-level Evidence Panel ───────────────────────────────
//
// `08-ai-interaction-patterns.md` §2 requires each NAMED evidence input to be a
// link into the Evidence Panel (§5), and §5 requires that panel "reachable in
// exactly one interaction from wherever the claim is shown". §5 does not require
// a separate route, and this repository has none to offer for a `raid_items` row
// — so the panel is hosted by the authorized Project Command Center that already
// holds the claim, reads the REAL supporting record, and — since the PR #611
// correction in section 12 — is opened by a focus-managing control rather than
// addressed by a same-document fragment.
//
// The properties this section pins:
//   1. the lineage column is read, and never rendered
//   2. supporting ids are deduplicated
//   3. ONE batched statement, never one per Recommendation
//   4. that statement carries workspace W + project P + exactly the referenced ids
//   5. a foreign workspace's row is refused in memory
//   6. a sibling project's row is refused in memory
//   7. a closed/resolved record is still valid evidence
//   8. the evidence text is the control that opens the exact panel
//   9. the panel renders the STORED record, not a re-print of evidence_summary
//  10. stored status is labelled as recorded, not as current attention
//  11. the two confidences stay distinct
//  12. a record that did not load is never substituted
//  13. a supporting failure does not blank Zone 2
//  14. a supporting failure does not blank the page
//  15. no uuid is user-facing
//  16. no fabricated per-record route

/** Two supporting records, and one nobody referenced. */
const SUPPORT_A = RAID_ITEM_ID;
const SUPPORT_B = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const SUPPORT_C = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UNREFERENCED = "00000000-1111-2222-3333-444444444444";

const routeBody = withoutComments(route);
/**
 * The panel's own source. It moved out of the route in the PR #611 correction:
 * focus management is behaviour, behaviour needs a client boundary, and the page
 * stays a server component (section 12).
 */
const panelSource = evidencePanel;
/** The server-side mapper that turns one guarded row into the panel's text. */
const presentationSource = (() => {
  const body = withoutComments(projection);
  const from = body.slice(body.indexOf("export function supportingRaidPanelPresentation"));
  return from.slice(0, from.indexOf("\n}") + 2);
})();
const zone2Body = routeBody.slice(
  routeBody.indexOf("zone={ZONE_RECOMMENDATIONS}"),
  routeBody.indexOf("zone={ZONE_DECISIONS}"),
);

test("the lineage column is selected for Zone 2 and never rendered as copy", () => {
  // `recommended_actions.raid_item_id` already exists — nothing was added.
  assert.ok(PROJECT_RECOMMENDATION_COLUMNS.split(", ").includes("raid_item_id"));
  assert.ok(
    RECOMMENDED_ACTION_SELECTABLE_COLUMNS.includes(
      "raid_item_id" as (typeof RECOMMENDED_ACTION_SELECTABLE_COLUMNS)[number],
    ),
    "raid_item_id must be an existing database-contract column, not a new one",
  );
  for (const query of [projectRecommendationsQuery(WS, PROJECT), projectPendingDecisionsQuery(WS, PROJECT)]) {
    assert.equal(query.columns, PROJECT_RECOMMENDATION_COLUMNS);
  }

  // It is read as LINEAGE and for nothing else: one call site, feeding the
  // supporting lookup. It is never a text node and never a label.
  assert.match(routeBody, /resolveSupportingRaid\(item\.raid_item_id, supportingRaidRecords\)/);
  assert.equal(routeBody.match(/item\.raid_item_id/g)?.length, 1, "the lineage column has exactly one reader");
  assert.equal(routeBody.includes("{item.raid_item_id}"), false, "an id is not copy");

  // And the disclosure mappers still cannot see the producer's copy of it.
  assert.equal(disclosureText(STORED_RATIONALE, STORED_EVIDENCE).includes(RAID_ITEM_ID), false);
});

test("supporting RAID ids are deduplicated, and nulls carry no lookup", () => {
  // Two Recommendations routinely derive from ONE RAID item — one read, one panel.
  assert.deepEqual(
    collectSupportingRaidIds([
      recRow({ id: "a1", raid_item_id: SUPPORT_A }),
      recRow({ id: "a2", raid_item_id: SUPPORT_A }),
      recRow({ id: "a3", raid_item_id: SUPPORT_B }),
      recRow({ id: "a4", raid_item_id: null }),
      recRow({ id: "a5", raid_item_id: SUPPORT_A }),
      recRow({ id: "a6", raid_item_id: SUPPORT_B }),
    ]),
    [SUPPORT_A, SUPPORT_B],
    "first-reference order, each id once",
  );
  assert.deepEqual(collectSupportingRaidIds([]), []);
  assert.deepEqual(collectSupportingRaidIds([recRow({ raid_item_id: null })]), [], "no lineage, no lookup");
});

test("ONE batched statement reads every supporting record, carrying all three scopes", () => {
  const query = projectSupportingRaidQuery(WS, PROJECT, [SUPPORT_A, SUPPORT_B]);
  assert.equal(query.table, "raid_items");
  assert.equal(query.columns, PROJECT_RAID_COLUMNS);
  assert.equal(query.workspaceId, WS, "the AUTHORIZED workspace");
  assert.equal(query.projectId, PROJECT, "the boundary RLS cannot enforce");
  assert.deepEqual([...(query.ids ?? [])], [SUPPORT_A, SUPPORT_B], "exactly the referenced ids");
  assert.equal(query.limit, 2, "the read must not truncate evidence for a row already shown");

  // What actually reaches the database.
  const applied: { froms: number; columns?: string; eq: [string, unknown][]; in: [string, unknown][]; not: unknown[]; is: unknown[]; limit?: number } =
    { froms: 0, eq: [], in: [], not: [], is: [] };
  const builder = {
    eq(column: string, value: unknown) {
      applied.eq.push([column, value]);
      return builder;
    },
    in(column: string, value: unknown) {
      applied.in.push([column, value]);
      return builder;
    },
    is(column: string, value: unknown) {
      applied.is.push([column, value]);
      return builder;
    },
    not(...args: unknown[]) {
      applied.not.push(args);
      return builder;
    },
    order() {
      return builder;
    },
    limit(value: number) {
      applied.limit = value;
      return { then: (resolve: (r: unknown) => void) => resolve({ data: [], count: 0, error: null }) };
    },
  };
  const fake = {
    from(table: string) {
      applied.froms += 1;
      assert.equal(table, "raid_items");
      return {
        select(columns: string) {
          applied.columns = columns;
          return builder;
        },
      };
    },
  };

  return (async () => {
    type Client = Parameters<typeof runProjectScopedQuery>[0];
    await runProjectScopedQuery(fake as unknown as Client, query);
    assert.equal(applied.froms, 1, "ONE statement for the whole referenced set — never one per Recommendation");
    assert.equal(applied.columns, PROJECT_RAID_COLUMNS);
    assert.deepEqual(applied.eq, [["workspace_id", WS], ["project_id", PROJECT]]);
    assert.deepEqual(applied.in, [["id", [SUPPORT_A, SUPPORT_B]]]);
    assert.deepEqual(applied.not, [], "provenance is not Attention Required: no status exclusion");
    assert.deepEqual(applied.is, []);
    assert.equal(applied.limit, 2);

    // And the route issues it exactly once, outside every per-row render.
    assert.equal(routeBody.match(/projectSupportingRaidQuery\(/g)?.length, 1);
    assert.match(routeBody, /const supportingRaidIds = collectSupportingRaidIds\(recommendations\);/);
    assert.equal(zone2Body.includes("runProjectScopedQuery"), false, "no read happens per rendered Recommendation");
    assert.equal(zone2Body.includes("await"), false, "Zone 2's JSX awaits nothing");
  })();
});

test("a referenced id does not make a foreign workspace's or sibling project's row evidence", () => {
  // Every one of these ids WAS referenced. Membership in the referenced set is a
  // claim, exactly like the routed workspace segment — never a permission.
  const referenced = [SUPPORT_A, SUPPORT_B, SUPPORT_C, UNREFERENCED];
  const records = selectSupportingRaidRecords(
    [
      raidRow({ id: SUPPORT_A }),
      raidRow({ id: SUPPORT_B, workspace_id: OTHER_WS }),
      raidRow({ id: SUPPORT_C, project_id: OTHER_PROJECT }),
      raidRow({ id: UNREFERENCED, project_id: null }),
      raidRow({ id: "never-asked-for" }),
    ],
    WS,
    PROJECT,
    referenced,
  );
  assert.deepEqual([...records.keys()], [SUPPORT_A]);
  assert.equal(records.get(SUPPORT_B), undefined, "a foreign workspace's row is refused in memory");
  assert.equal(records.get(SUPPORT_C), undefined, "a sibling project's row is refused in memory");
  assert.equal(records.get(UNREFERENCED), undefined, "a workspace-scoped row with no project is refused");
  assert.equal(records.get("never-asked-for"), undefined, "a row nobody referenced is not evidence");

  // The query says the same thing, so the guard is belt-and-braces, not the only
  // defence — and neither is trusted alone.
  const query = projectSupportingRaidQuery(WS, PROJECT, referenced);
  assert.equal(query.workspaceId, WS);
  assert.equal(query.projectId, PROJECT);
  assert.equal(withoutComments(projection).includes("selectSupportingRaidRecords"), true);
});

test("a closed or resolved supporting record is still valid evidence", () => {
  // A Recommendation may legitimately retain lineage to a RAID item that was
  // closed after it was written. The panel is provenance, not a queue.
  for (const closed of CLOSED_RAID_STATUSES) {
    const status = closed as ProjectRaidRow["status"];
    const records = selectSupportingRaidRecords([raidRow({ id: SUPPORT_A, status })], WS, PROJECT, [SUPPORT_A]);
    assert.equal(records.get(SUPPORT_A)?.status, status, `${closed} must remain inspectable`);
    assert.equal(resolveSupportingRaid(SUPPORT_A, records).state, "resolved");
  }
  // Zone 1 still refuses exactly those rows — the two reads differ in that one
  // filter and in nothing else about scope.
  assert.deepEqual(selectProjectRaid([raidRow({ id: SUPPORT_A, status: "closed" })], WS, PROJECT), []);
  assert.equal(projectRaidQuery(WS, PROJECT).excludeStatuses, CLOSED_RAID_STATUSES);
  assert.equal(
    projectSupportingRaidQuery(WS, PROJECT, [SUPPORT_A]).excludeStatuses,
    undefined,
    "the supporting read must not inherit Zone 1's open-only semantics",
  );
  // And the route does not route the supporting rows through Zone 1's selector.
  assert.equal(routeBody.includes("selectProjectRaid(supportingRead"), false);
  assert.match(routeBody, /selectSupportingRaidRecords\(supportingRead\.rows, workspaceId, projectId, supportingRaidIds\)/);
});

test("each named evidence input is the CONTROL that opens its own record's panel", () => {
  // One interaction still — but a control, not an anchor. `08-accessibility-
  // guidelines.md` §2 requires this panel to move focus on open and to return it
  // on dismissal, and a fragment can do neither, so the prefix, the escaper and
  // the href builder that composed those anchors are GONE rather than left behind
  // as a second, inaccessible way in.
  const projectionBody = withoutComments(projection);
  const panelBody = withoutComments(evidencePanel);
  for (const gone of [
    "SUPPORTING_RAID_PANEL_ID_PREFIX",
    "supportingRaidPanelId",
    "supportingRaidPanelHref",
    "fragmentSafeId",
    "recommendation-evidence-",
  ]) {
    assert.equal(projectionBody.includes(gone), false, `${gone} must not survive the correction`);
    assert.equal(routeBody.includes(gone), false, `${gone} must not survive the correction`);
    assert.equal(panelBody.includes(gone), false, `${gone} must not survive the correction`);
  }
  assert.equal(routeBody.includes('href="#'), false, "no fragment-only interaction remains");
  assert.equal(panelBody.includes("href"), false, "the panel addresses nothing and links nowhere");

  // The named input IS the trigger, labelled by exactly the governed text the
  // Evidence line reads, and offered ONLY for a record that actually loaded.
  assert.match(
    route,
    /const panelRecord = supporting\.state === "resolved" \? supportingRaidPanelPresentation\(supporting\.record\) : null;/,
  );
  assert.match(route, /\{panelRecord !== null \? \(/);
  assert.match(route, /<SupportingRaidEvidencePanel label=\{evidenceInputLabel\(input\)\} record=\{panelRecord\} \/>/);
  assert.equal(
    evidenceInputLabel({ category: "Risk", name: "Vendor approval may delay launch", detectedConfidence: 82 }),
    "Risk — Vendor approval may delay launch",
  );
  assert.equal(
    evidenceInputLabel({ category: null, name: "Vendor approval may delay launch", detectedConfidence: null }),
    "Vendor approval may delay launch",
    "an unratified category is dropped, never prettified into the label",
  );
  // Not "Recommendation → generic collection → search by hand": the item control
  // exists and is separate from the collection link.
  assert.match(routeBody, /<Link href=\{evidence\.repositoryHref\}/);
  assert.equal(projectEvidenceRepositoryPath(PROJECT).startsWith("#"), false);
});

test("the panel renders the STORED record, never a re-print of evidence_summary", () => {
  // Governed noun, off `raid_items.category`, through the same closed map.
  assert.equal(governedRaidCategoryLabel("risk"), "Risk");
  assert.equal(governedRaidCategoryLabel("DEPENDENCY"), "Dependency");
  assert.equal(governedRaidCategoryLabel("raid_unknown"), null, "an unratified value is not prettified");
  assert.equal(supportingRaidPanelPresentation(raidRow({ category: "dependency" })).categoryLabel, "Dependency");
  // An unratified stored value is shown AS STORED — the row exists and its
  // category is a stored fact — never prettified into a noun the enum lacks.
  assert.equal(
    supportingRaidPanelPresentation(raidRow({ category: "raid_unknown" as ProjectRaidRow["category"] })).categoryLabel,
    "raid_unknown",
  );

  // The stored facts, and only stored facts. Mapped on the SERVER, from the row
  // this page already scope-guarded.
  assert.deepEqual(
    supportingRaidPanelPresentation(
      raidRow({
        category: "risk",
        title: "Vendor approval may delay launch",
        description: "Vendor sign-off is outstanding.",
        status: "closed",
        confidence_score: 82,
        occurrence_count: 3,
        auto_generated: true,
        last_detected_at: "2026-09-01T12:34:56Z",
      }),
    ),
    {
      panelTitle: "Supporting record: Risk — Vendor approval may delay launch",
      categoryLabel: "Risk",
      title: "Vendor approval may delay launch",
      description: "Vendor sign-off is outstanding.",
      status: "closed",
      detectionConfidence: 82,
      occurrenceCount: 3,
      lastDetected: "2026-09-01",
      autoGenerated: true,
    },
  );
  assert.match(panelSource, /\{record\.categoryLabel\}/);
  assert.match(panelSource, /\{record\.title\}/);
  assert.match(panelSource, /\{record\.description\}/);
  assert.match(panelSource, /\{record\.status\}/);
  assert.match(panelSource, /record\.detectionConfidence/);
  assert.match(panelSource, /\{record\.occurrenceCount\}/);
  assert.match(panelSource, /\{record\.lastDetected\}/);
  assert.equal(storedDetectionDate("2026-09-01T12:34:56Z"), "2026-09-01");
  for (const bad of [null, "", "   ", "not a date"]) {
    assert.equal(storedDetectionDate(bad), null, "an unparseable timestamp states nothing");
  }

  // It reads the ROW. Nothing from the producer's jsonb snapshot reaches either
  // the mapper or the panel, so the panel cannot be the same claim twice under a
  // heading promising its source.
  const body = withoutComments(panelSource);
  for (const snapshot of ["evidence_summary", "rationale", "raidTitle", "raidCategory", "raidConfidenceScore", "selectRaidRecommendation"]) {
    assert.equal(body.includes(snapshot), false, `the panel must not read ${snapshot}`);
    assert.equal(presentationSource.includes(snapshot), false, `the panel mapper must not read ${snapshot}`);
  }
  // And it invents nothing `raid_items` does not store.
  for (const invented of ["severity", "priority", "health", "sourceSignalId", "source_signal_id", "source_document_id", "urgency", "impact"]) {
    assert.equal(body.toLowerCase().includes(invented.toLowerCase()), false, `the panel must not invent ${invented}`);
    assert.equal(presentationSource.toLowerCase().includes(invented.toLowerCase()), false, `the mapper must not invent ${invented}`);
  }
  // No fabricated destination of its own — an unlinkable signal stays unlinked.
  assert.equal(body.includes("href"), false, "the panel fabricates no Document/Evidence link");
});

test("the panel states a recorded status without implying current attention", () => {
  // Checked against the comment-stripped source, for the reason `withoutComments`
  // exists on this file at all: prose explaining a rule necessarily quotes the
  // phrase the rule forbids, and everything a user reads is JSX text.
  const body = withoutComments(panelSource);
  assert.match(body, /Recorded status/);
  // Never Zone 1's vocabulary: this is history, not a queue.
  for (const attention of ["Attention", "Open risk", "needs", "awaiting", "Action required", "overdue"]) {
    assert.equal(body.toLowerCase().includes(attention.toLowerCase()), false, `the panel must not imply ${attention}`);
  }
  // The caveat moved with the panel, and is now stated where the record is read.
  assert.match(body, /a record here may already be closed or resolved/);
  assert.equal(routeBody.includes("a record here may already be closed or resolved"), false, "stated once, not twice");
  // Read-only. The panel owns exactly one interaction — open and dismiss — and no
  // decision control, no form, no write and no request of any kind.
  for (const forbidden of ["<form", "use server", "action=", "Accept", "Reject", "Defer", "Record Decision", ".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.equal(body.includes(forbidden), false, `the panel must not gain ${forbidden}`);
  }
});

test("the panel's confidence is the RAID item's, never the Recommendation's", () => {
  const body = withoutComments(panelSource);
  // Same label the Evidence line uses, and a different label from the
  // Recommendation's own number (§2.1).
  assert.match(body, /Detection confidence/);
  assert.equal(body.includes("Recommendation confidence"), false);
  assert.equal(body.includes("item.confidence_score"), false);
  assert.match(zone2Body, /Recommendation confidence \{Math\.round\(item\.confidence_score\)\}%/);
  // It is the ROW's own number, read off the row and validated exactly as the
  // snapshot's is — an impossible stored score is "not recorded", not rendered.
  assert.equal(recordDetectionConfidence(raidRow({ confidence_score: 82 })), 82);
  assert.equal(recordDetectionConfidence(raidRow({ confidence_score: 82.4 })), 82);
  for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(recordDetectionConfidence(raidRow({ confidence_score: bad })), null, `${bad} is not a percentage`);
  }
  assert.match(body, /record\.detectionConfidence === null \? "not recorded"/);
  // Two different numbers about two different things, and they stay apart.
  const record = raidRow({ id: SUPPORT_A, confidence_score: 82 });
  const recommendation = recRow({ raid_item_id: SUPPORT_A, confidence_score: 70 });
  assert.equal(record.confidence_score, 82);
  assert.equal(recommendation.confidence_score, 70);
  assert.equal(
    selectRaidRecommendationEvidence(null, { raidTitle: "t", raidConfidenceScore: 82 }, PROJECT)?.inputs[0]
      .detectedConfidence,
    82,
  );
});

test("a supporting record that did not load is never substituted by another", () => {
  const records = selectSupportingRaidRecords([raidRow({ id: SUPPORT_B })], WS, PROJECT, [SUPPORT_A, SUPPORT_B]);
  // The read SUCCEEDED and this exact row was not in it.
  assert.deepEqual(resolveSupportingRaid(SUPPORT_A, records), { state: "not-visible", record: null });
  assert.equal(resolveSupportingRaid(SUPPORT_B, records).record?.id, SUPPORT_B);
  // No lineage at all is a fifth thing again, and claims nothing.
  assert.deepEqual(resolveSupportingRaid(null, records), { state: "none", record: null });
  assert.deepEqual(resolveSupportingRaid(null, null), { state: "none", record: null });

  // Resolution is by id ONLY. There is no positional fallback in any of the three
  // files, so "the first row" cannot become "this Recommendation's record".
  const bodies = withoutComments(projection) + withoutComments(route) + withoutComments(evidencePanel);
  for (const fallback of ["rows[0]", "records[0]", ".at(0)", ".find(", "[0] ??"]) {
    assert.equal(bodies.includes(fallback), false, `no positional fallback (${fallback})`);
  }
  // And nothing else stands in for the record: not documents, not the snapshot.
  assert.equal(routeBody.includes("project_evidence"), false);
  assert.equal(routeBody.includes("evidence_summary as"), false);
  // The panel a Recommendation can open is built from THAT Recommendation's own
  // resolved lookup, and from nothing else.
  assert.match(routeBody, /const supporting = resolveSupportingRaid\(item\.raid_item_id, supportingRaidRecords\);/);
  assert.match(
    routeBody,
    /supporting\.state === "resolved" \? supportingRaidPanelPresentation\(supporting\.record\) : null/,
  );
});

test("a supporting read failure degrades the Evidence Panel and nothing else", () => {
  // `null` is the failed read; an empty Map is a successful read that found
  // nothing. The two are different facts and stay different.
  assert.deepEqual(resolveSupportingRaid(SUPPORT_A, null), { state: "unavailable", record: null });
  assert.deepEqual(resolveSupportingRaid(SUPPORT_A, new Map()), { state: "not-visible", record: null });

  // Truthful, small, and distinct from both the Empty and the Degraded copy.
  assert.match(route, /Supporting RAID record is temporarily unavailable\./);
  assert.match(route, /Supporting RAID record is not available to open\./);
  assert.equal(routeBody.includes("Supporting RAID record is temporarily unavailable.We"), false);
  // It names nothing — no ancestry, no title, no sibling project, no existence oracle.
  const notice = route.slice(route.indexOf("function SupportingRaidUnavailable"), route.indexOf("function RecommendationEvidence"));
  for (const leak of ["workspace", "project_id", "record.title", "record.id", "OTHER"]) {
    assert.equal(notice.includes(leak), false, `the notice must not name ${leak}`);
  }

  // Zone 2's own branches are chosen by Zone 2's OWN read. A supporting failure
  // cannot make a real Recommendation render as an empty or degraded zone.
  assert.match(zone2Body, /\{recommendationsRead === null \? \(\s*<ZoneDegraded/);
  assert.match(zone2Body, /recommendations\.length === 0 \? \(\s*<ZoneEmpty>/);
  assert.equal(zone2Body.includes("supportingRaidRecords === null ?"), false);
  assert.equal(zone2Body.includes("supportingRaidPanels"), false, "there is no aggregate panel list to blank");
  // The Recommendation still renders in full; only the control that would open
  // its record is absent, and the notice beside it says why.
  assert.match(zone2Body, /<RecommendationEvidence evidence=\{disclosure\.evidence\} supporting=\{supporting\} \/>/);
  assert.match(route, /\{panelRecord !== null \? \(/);

  // And it cannot take the page down: the four zone reads stay their own
  // allSettled unit, the supporting read is a separate awaited one, and no
  // `Promise.all` makes any of them one failure unit.
  assert.equal(routeBody.match(/Promise\.all\(/g), null, "never one giant failure unit");
  assert.equal(routeBody.match(/Promise\.allSettled\(/g)?.length, 2);
  assert.match(
    routeBody,
    /await Promise\.allSettled\(\[\s*runProjectScopedQuery<ProjectRaidRow>\(\s*supabase,\s*projectSupportingRaidQuery\(workspaceId, projectId, supportingRaidIds\),\s*\),\s*\]\)/,
  );
  // Its failure is logged under its own event, like every other degraded read.
  assert.match(routeBody, /"project_command_center\.supporting_raid_unavailable"/);
  // The four zones are still rendered unconditionally.
  assert.deepEqual(
    [...routeBody.matchAll(/zone=\{ZONE_([A-Z]+)\}/g)].map((m) => m[1]),
    ["ATTENTION", "RECOMMENDATIONS", "DECISIONS", "HEALTH"],
  );
});

test("no identifier reaches a user as copy, panel included", () => {
  // No uuid crosses into the client AT ALL now. The fragment was the last thing
  // on this screen that needed one, and the presentation record carries none.
  const presented = supportingRaidPanelPresentation(raidRow({ id: RAID_ITEM_ID }));
  assert.equal("id" in presented, false, "the panel record carries no identifier");
  assert.equal(JSON.stringify(presented).includes(RAID_ITEM_ID), false);
  // And nowhere a user reads. No uuid-shaped literal exists in the route's copy
  // or the panel's, and no id expression is a text node.
  assert.doesNotMatch(routeBody, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(withoutComments(evidencePanel), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  for (const asCopy of ["{record.id}", "{item.id}", "{item.raid_item_id}", "{supporting.record.id}"]) {
    assert.equal(routeBody.includes(`>${asCopy}`), false, `${asCopy} must not be rendered as text`);
    assert.equal(routeBody.includes(`${asCopy}<`), false, `${asCopy} must not be rendered as text`);
    assert.equal(withoutComments(evidencePanel).includes(asCopy), false, `${asCopy} must not reach the panel`);
  }
  // The producer's own copies of the same identifiers stay off screen too.
  const shown = disclosureText(STORED_RATIONALE, STORED_EVIDENCE);
  for (const internal of [RAID_ITEM_ID, "raidItemId", SOURCE_SIGNAL_ID, "sourceSignalId"]) {
    assert.equal(shown.includes(internal), false);
  }
  assert.equal(withoutComments(panelSource).includes("sourceSignalId"), false);
});

test("no fabricated per-record route was introduced to host the panel", () => {
  for (const fake of ["/risks/", "/issues/", "/dependencies/", "/documents/", "/raid/"]) {
    assert.equal(routeBody.includes(fake), false, `${fake} does not exist and must not be linked`);
    assert.equal(withoutComments(projection).includes(fake), false);
    assert.equal(withoutComments(evidencePanel).includes(fake), false);
  }
  assert.deepEqual([...PROJECT_SURFACES], ["home", "command-center"], "the Project route family did not grow");
  for (const unbuilt of ["risks", "issues", "dependencies", "documents", "raid"]) {
    assert.equal(existsSync(`src/app/(protected)/${unbuilt}/page.tsx`), false);
    assert.equal(
      existsSync(`src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/${unbuilt}`),
      false,
      `${unbuilt} must not have been created as a canonical child route`,
    );
  }
  // The panel opens IN PLACE on the page that already holds the claim — it is not
  // a route, not a fragment, and it navigates nowhere.
  const panelBody = withoutComments(evidencePanel);
  for (const navigation of ["next/link", "next/navigation", "useRouter", "href", "window.location"]) {
    assert.equal(panelBody.includes(navigation), false, `the panel must not navigate (${navigation})`);
  }
});

test("the generic project evidence link stays, and stays explicitly collection-level", () => {
  // §5's Source Documents section wants the canonical Document/Evidence screen,
  // and `/evidence?projectId=` is the real, authorized one — a DIFFERENT
  // population from `raid_items`, on its own line, in its own words.
  assert.match(route, /Open project evidence/);
  assert.match(route, /the project&apos;s evidence collection, not this specific item\./);
  assert.equal(
    selectRaidRecommendationEvidence(STORED_RATIONALE, STORED_EVIDENCE, PROJECT)?.repositoryHref,
    projectEvidenceRepositoryPath(PROJECT),
  );
  // It is never offered AS the supporting record: the record opens in place, the
  // collection is a link to a different screen, and the copy distinguishes them.
  assert.match(routeBody, /<Link href=\{evidence\.repositoryHref\}/);
  assert.equal(withoutComments(evidencePanel).includes("repositoryHref"), false);
  assert.equal(projectEvidenceRepositoryPath(PROJECT).startsWith("#"), false);
});

test("Zone 2's population and the earlier corrections are untouched by this change", () => {
  // Zone 2 is still exactly: workspace W, project P, governance_event_id IS NULL,
  // status = 'proposed'.
  const query = projectRecommendationsQuery(WS, PROJECT);
  assert.deepEqual(
    { table: query.table, workspaceId: query.workspaceId, projectId: query.projectId, governed: query.governed, status: query.status },
    { table: "recommended_actions", workspaceId: WS, projectId: PROJECT, governed: false, status: "proposed" },
  );
  assert.deepEqual(
    selectProjectRecommendations(
      [
        recRow({ id: "keep", raid_item_id: SUPPORT_A }),
        recRow({ id: "governed", governance_event_id: "g1", raid_item_id: SUPPORT_A }),
        recRow({ id: "decided", status: "accepted", raid_item_id: SUPPORT_A }),
        recRow({ id: "sibling", project_id: OTHER_PROJECT, raid_item_id: SUPPORT_A }),
        recRow({ id: "foreign", workspace_id: OTHER_WS, raid_item_id: SUPPORT_A }),
      ],
      WS,
      PROJECT,
      false,
    ).map((r) => r.id),
    ["keep"],
    "a lineage column changes nothing about who enters the zone",
  );
  // P2 #1 — `decisionRequiredCount` is still absent from Zone 4.
  assert.equal(routeBody.includes("decisionRequiredCount"), false);
  assert.equal(withoutComments(projection).includes("decisionRequiredCount"), false);
  // P2 #2 — PMO ancestry still has its four outcomes, and the notice is intact.
  assert.equal(resolveProjectPmoAncestry({ pmoId: null, row: null, error: null }).state, "none");
  assert.equal(resolveProjectPmoAncestry({ pmoId: PMO, row: { id: PMO, name: "P" }, error: null }).state, "resolved");
  assert.equal(resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: null }).state, "not-visible");
  assert.equal(resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: { message: "x" } }).state, "unavailable");
  assert.match(route, /PMO ancestry is temporarily unavailable\./);
  // Previous Zone 2 P2 — no JSON presentation, no enums, no raw ids on screen.
  for (const generic of ["Object.entries", "Object.keys", "Object.values"]) {
    assert.equal(withoutComments(projection).includes(generic), false);
  }
  for (const internal of ["trigger", "discoveryOrigin", "raidItemId", "sourceSignalId"]) {
    assert.equal(disclosureText(STORED_RATIONALE, STORED_EVIDENCE).includes(internal), false);
  }
  // And the whole screen is still read-only.
  for (const forbidden of ["use server", "<form", "<button", "onClick", "revalidatePath", ".insert(", ".update(", ".delete("]) {
    assert.equal(routeBody.includes(forbidden), false, `the page must stay read-only (${forbidden})`);
  }
});

// ─── 12. PR #611 review corrections (Codex P2 #1, #2, #3) ─────────────────
//
// Three findings against the item-level Evidence Panel section 11 added. All
// three are read/presentation defects: no schema moved, no producer changed, and
// the reads, their scopes and their failure isolation are the same statements.
//
//   P2 #1  the Evidence line's "detection confidence" came from the producer's
//          FROZEN `evidence_summary.raidConfidenceScore` while the panel directly
//          beneath it showed the row's CURRENT `raid_items.confidence_score`. A
//          later detection updates the row and never rewrites the snapshot, so one
//          screen could state two different numbers, under one label, about one
//          record — contradictory disclosure a reader cannot resolve.
//   P2 #2  Why and Evidence were built from the nullable, unvalidated jsonb
//          columns ONLY. A Recommendation whose exact supporting row was in memory
//          could therefore render no disclosure at all, which §2 makes mandatory.
//   P2 #3  the panel was an `<a href="#…">` onto a non-focusable `<li>`. Activation
//          moved the viewport and left focus on the Recommendation; there was no
//          dismissal and nothing to return focus to —
//          `08-accessibility-guidelines.md` §2 requires both.
//
// The properties this section pins:
//   1. the visible detection confidence is the RESOLVED ROW's, not the snapshot's
//   2. a stale snapshot number is never presented as a current one
//   3. Recommendation confidence stays a separate number under a separate label
//   4. a valid snapshot keeps its own wording
//   5. an unusable snapshot plus a resolved row still produces Why and Evidence
//   6. that fallback is the EXACT resolved row, never a sibling or a neighbour
//   7. neither source, no fabricated basis
//   8. the trigger is keyboard-operable, focus-visible and state-exposing
//   9. the panel has an accessible name, a dismissal, Escape, and focus return
//  10. the interaction is client-owned; the authorization and the reads are not
//  11. the batched, project-scoped supporting read is untouched

/** A resolved lookup for one row, exactly as the page builds it. */
const resolved = (over: Partial<ProjectRaidRow> = {}) =>
  resolveSupportingRaid(SUPPORT_A, selectSupportingRaidRecords([raidRow({ id: SUPPORT_A, ...over })], WS, PROJECT, [SUPPORT_A]));

/** The three non-resolving outcomes, for the "no current number" cases. */
const UNRESOLVED = [
  resolveSupportingRaid(SUPPORT_A, null),
  resolveSupportingRaid(SUPPORT_A, new Map<string, ProjectRaidRow>()),
  resolveSupportingRaid(null, null),
];

// P2 #1 — the detection confidence a reader sees.

test("the visible detection confidence is the resolved RAID row's, not the snapshot's", () => {
  // The snapshot says 82 — what the producer saw. The row says 35 now, because a
  // later detection updated it and left the Recommendation's copy alone.
  const snapshot = { raidCategory: "risk", raidTitle: "Vendor approval may delay launch", raidConfidenceScore: 82 };
  const disclosure = resolveRecommendationDisclosure(null, snapshot, resolved({ confidence_score: 35 }), PROJECT);
  assert.equal(disclosure.evidence?.inputs[0].detectedConfidence, 35, "the current number comes from the row");
  assert.equal(
    selectRaidRecommendationEvidence(null, snapshot, PROJECT)?.inputs[0].detectedConfidence,
    82,
    "the snapshot mapper still reports the snapshot, unchanged — it is a real stored fact",
  );

  // Which is the same number the panel beneath it shows, off the same row. That
  // identity is the whole finding: one record, one current detection confidence.
  assert.equal(supportingRaidPanelPresentation(raidRow({ confidence_score: 35 })).detectionConfidence, 35);
  assert.equal(
    disclosure.evidence?.inputs[0].detectedConfidence,
    supportingRaidPanelPresentation(raidRow({ id: SUPPORT_A, confidence_score: 35 })).detectionConfidence,
  );

  // And it is read from the row, not from `evidence_summary`, in one place.
  const combiner = withoutComments(projection).slice(
    withoutComments(projection).indexOf("export function resolveRecommendationDisclosure"),
  );
  assert.match(combiner.slice(0, combiner.indexOf("\n}") + 2), /recordDetectionConfidence\(record\)/);
});

test("a stale snapshot confidence is never presented as a current one", () => {
  // No resolved row means no current number. The snapshot's copy is NOT promoted
  // into a present-tense label — §2.1 prefers no number to an ambiguous one.
  for (const supporting of UNRESOLVED) {
    const disclosure = resolveRecommendationDisclosure(
      null,
      { raidCategory: "risk", raidTitle: "Vendor approval may delay launch", raidConfidenceScore: 82 },
      supporting,
      PROJECT,
    );
    assert.equal(disclosure.evidence?.inputs.length, 1, "the named input survives — only the number is withheld");
    assert.equal(disclosure.evidence?.inputs[0].name, "Vendor approval may delay launch");
    assert.equal(disclosure.evidence?.inputs[0].detectedConfidence, null, `${supporting.state} states no confidence`);
  }
  // The line is omitted rather than rendered empty or labelled vaguely.
  assert.match(route, /\{input\.detectedConfidence !== null \? \(/);
  assert.match(route, /detection confidence \{input\.detectedConfidence\}%/);
  // A resolved row whose own score is not a percentage says nothing either.
  assert.equal(
    resolveRecommendationDisclosure(null, { raidTitle: "t", raidConfidenceScore: 82 }, resolved({ confidence_score: 900 }), PROJECT)
      .evidence?.inputs[0].detectedConfidence,
    null,
    "an impossible stored score is not backfilled from the snapshot",
  );
});

test("Recommendation confidence remains a separate number under a separate label", () => {
  // `recommended_actions.confidence_score` is untouched by any of this: it is not
  // an argument to the combiner and cannot reach a detection-confidence line.
  const combiner = withoutComments(projection).slice(
    withoutComments(projection).indexOf("export function resolveRecommendationDisclosure"),
  );
  const body = combiner.slice(0, combiner.indexOf("\n}") + 2);
  for (const name of ["item.confidence_score", "confidence_score:"]) {
    assert.equal(body.includes(name), false, `the combiner must not see ${name}`);
  }
  assert.match(zone2Body, /Recommendation confidence \{Math\.round\(item\.confidence_score\)\}%/);
  assert.match(zone2Body, /Recommendation confidence not recorded/);
  assert.equal(zone2Body.includes("Recommendation confidence {input.detectedConfidence}"), false);
  // Two labels, two sources, never interchanged.
  const disclosure = resolveRecommendationDisclosure(
    null,
    { raidTitle: "t", raidConfidenceScore: 82 },
    resolved({ confidence_score: 35 }),
    PROJECT,
  );
  assert.equal(disclosure.evidence?.inputs[0].detectedConfidence, 35);
  assert.equal(recRow({ confidence_score: 70 }).confidence_score, 70);
});

// P2 #2 — the disclosure falls back to the resolved record.

test("a valid snapshot keeps its own wording when the record also resolved", () => {
  // The snapshot records the basis AS CAPTURED when the Recommendation was
  // produced. Rewriting it from a row that has since moved would silently restate
  // history, so the wording is preserved — only the confidence is current.
  const disclosure = resolveRecommendationDisclosure(
    STORED_RATIONALE,
    STORED_EVIDENCE,
    resolved({ category: "issue", title: "Retitled after a later detection", confidence_score: 35 }),
    PROJECT,
  );
  assert.deepEqual(disclosure.why, { category: "Risk", condition: "Vendor approval may delay launch" });
  assert.deepEqual(disclosure.evidence, {
    inputs: [{ category: "Risk", name: "Vendor approval may delay launch", detectedConfidence: 35 }],
    repositoryHref: projectEvidenceRepositoryPath(PROJECT),
  });
  // And the snapshot selectors themselves are unchanged by any of this.
  assert.deepEqual(selectRaidRecommendationWhy(STORED_RATIONALE, STORED_EVIDENCE), {
    category: "Risk",
    condition: "Vendor approval may delay launch",
  });
  assert.deepEqual(selectRaidRecommendationEvidence(STORED_RATIONALE, STORED_EVIDENCE, PROJECT), {
    inputs: [{ category: "Risk", name: "Vendor approval may delay launch", detectedConfidence: 82 }],
    repositoryHref: projectEvidenceRepositoryPath(PROJECT),
  });
});

test("an unusable snapshot plus a resolved record still produces Why, and named Evidence", () => {
  // Every way the two jsonb columns can fail to say anything: null, missing,
  // malformed, wrong type, blank text.
  const unusable: [unknown, unknown][] = [
    [null, null],
    [undefined, undefined],
    [{}, {}],
    ["not an object", 7],
    [[], []],
    [{ trigger: "approval_dependency_detected" }, { raidItemId: RAID_ITEM_ID, discoveryOrigin: "project_discovery" }],
    [{ riskText: "   " }, { raidTitle: "   " }],
    [{ riskText: 7 }, { raidTitle: 7, raidConfidenceScore: 82 }],
  ];
  for (const [rationale, evidenceSummary] of unusable) {
    // Nothing from the snapshot alone.
    assert.equal(selectRaidRecommendationWhy(rationale, evidenceSummary), null);
    assert.equal(selectRaidRecommendationEvidence(rationale, evidenceSummary, PROJECT), null);

    // But the exact supporting row IS in memory, so the mandatory disclosure is
    // built from it rather than omitted.
    const disclosure = resolveRecommendationDisclosure(
      rationale,
      evidenceSummary,
      resolved({ category: "dependency", title: "Integration testing is blocked", confidence_score: 64 }),
      PROJECT,
    );
    assert.deepEqual(disclosure.why, { category: "Dependency", condition: "Integration testing is blocked" });
    assert.deepEqual(disclosure.evidence, {
      inputs: [{ category: "Dependency", name: "Integration testing is blocked", detectedConfidence: 64 }],
      repositoryHref: projectEvidenceRepositoryPath(PROJECT),
    });
  }

  // The fallback is the row's governed category and its STORED title, and nothing
  // else — no id, no trigger, no discoveryOrigin, no arbitrary jsonb key.
  const shown = JSON.stringify(
    resolveRecommendationDisclosure(
      { trigger: "approval_dependency_detected", riskType: "vendor" },
      { raidItemId: RAID_ITEM_ID, sourceSignalId: SOURCE_SIGNAL_ID, discoveryOrigin: "project_discovery" },
      resolved({ title: "Integration testing is blocked" }),
      PROJECT,
    ),
  );
  for (const internal of [RAID_ITEM_ID, SOURCE_SIGNAL_ID, "raidItemId", "sourceSignalId", "discoveryOrigin", "trigger", "approval_dependency_detected", "riskType", "vendor"]) {
    assert.equal(shown.includes(internal), false, `the fallback must not expose ${internal}`);
  }
  // An unratified stored category is dropped from the disclosure rather than
  // prettified — the same closed map the snapshot path uses.
  assert.deepEqual(
    resolveRecommendationDisclosure(null, null, resolved({ category: "raid_unknown" as ProjectRaidRow["category"], title: "x" }), PROJECT).why,
    { category: null, condition: "x" },
  );
});

test("the fallback never reaches a sibling, foreign or unrequested RAID row", () => {
  // The fallback reads `supporting.record` and nothing else, and that record has
  // already survived the batched query's three filters AND the in-memory guard.
  // A referenced id is a claim, not a permission — so none of these resolves, and
  // none of them can become somebody's Why.
  const referenced = [SUPPORT_A];
  for (const [what, row] of [
    ["a foreign workspace's row", raidRow({ id: SUPPORT_A, workspace_id: OTHER_WS, title: "Foreign condition" })],
    ["a sibling project's row", raidRow({ id: SUPPORT_A, project_id: OTHER_PROJECT, title: "Sibling condition" })],
    ["a workspace-scoped row with no project", raidRow({ id: SUPPORT_A, project_id: null, title: "Unscoped condition" })],
    ["a row nobody referenced", raidRow({ id: SUPPORT_B, title: "Unrequested condition" })],
  ] as [string, ProjectRaidRow][]) {
    const records = selectSupportingRaidRecords([row], WS, PROJECT, referenced);
    const supporting = resolveSupportingRaid(SUPPORT_A, records);
    assert.notEqual(supporting.state, "resolved", what);
    const disclosure = resolveRecommendationDisclosure(null, null, supporting, PROJECT);
    assert.equal(disclosure.why, null, `${what} must not become a Why`);
    assert.equal(disclosure.evidence, null, `${what} must not become Evidence`);
    assert.equal(JSON.stringify(disclosure).includes(row.title), false, `${what} must not reach a reader`);
  }
  // And a neighbour that DID resolve never stands in for the one that did not.
  const records = selectSupportingRaidRecords([raidRow({ id: SUPPORT_B, title: "Neighbour condition" })], WS, PROJECT, [SUPPORT_A, SUPPORT_B]);
  const disclosure = resolveRecommendationDisclosure(null, null, resolveSupportingRaid(SUPPORT_A, records), PROJECT);
  assert.equal(disclosure.why, null);
  assert.equal(JSON.stringify(disclosure).includes("Neighbour condition"), false);
});

test("with neither a usable snapshot nor a resolved record, no basis is fabricated", () => {
  for (const supporting of UNRESOLVED) {
    const disclosure = resolveRecommendationDisclosure(null, null, supporting, PROJECT);
    assert.deepEqual(disclosure, { why: null, evidence: null }, `${supporting.state} states nothing`);
  }
  // Both sections then vanish rather than rendering empty, and the truthful
  // unavailable notice is the only thing said.
  assert.match(route, /function RecommendationWhy\(\{ why \}[\s\S]{0,140}if \(why === null\) return null;/);
  assert.match(route, /function RecommendationEvidence\(\{\s*evidence,\s*supporting,[\s\S]{0,220}if \(evidence === null\) return null;/);
  assert.match(route, /Supporting RAID record is temporarily unavailable\./);
  assert.match(route, /Supporting RAID record is not available to open\./);
  // The Recommendation's own directive is never a source for its own basis: the
  // combiner cannot see it, because it is not an argument.
  const combiner = withoutComments(projection).slice(
    withoutComments(projection).indexOf("export function resolveRecommendationDisclosure"),
  );
  const body = combiner.slice(0, combiner.indexOf("\n}") + 2);
  for (const name of ["item.title", "item.description", "recommended_action_type"]) {
    assert.equal(body.includes(name), false, `the combiner must not read ${name}`);
  }
});

// P2 #3 — the focus-managed Evidence Panel.

test("the evidence trigger is a keyboard-operable control with a visible focus treatment", () => {
  const panelBody = withoutComments(evidencePanel);
  // A real button: Tab reaches it, Enter and Space activate it. Not a div with a
  // handler, not an anchor with no href, not a fragment.
  assert.match(panelBody, /<button\s+type="button"/);
  assert.equal(panelBody.includes("<a "), false);
  assert.equal(panelBody.includes("tabIndex"), false, "nothing is bolted into or out of the tab order by hand");
  assert.equal(panelBody.includes('href="#'), false);
  // Focus is visible, and not by colour alone (§3's focus-appearance rule).
  assert.match(panelBody, /focus-visible:outline-2/);
  assert.match(panelBody, /focus-visible:outline-offset-2/);
  // The trigger says what it opens and whether it is open — which the anchor it
  // replaces could not say at all.
  assert.match(panelBody, /aria-haspopup="dialog"/);
  assert.match(panelBody, /aria-expanded=\{open\}/);
  // Exactly one interaction opens the panel.
  assert.equal(panelBody.match(/onClick=/g)?.length, 1);
  assert.match(panelBody, /onClick=\{\(\) => setOpen\(true\)\}/);
  // No bare fragment-only interaction remains anywhere in the slice.
  for (const [name, source] of NEW_SLICE_FILES) {
    assert.equal(withoutComments(source).includes('href="#'), false, `${name} must not ship a fragment interaction`);
  }
});

test("activation opens the exact supporting record in a named, dismissible panel", () => {
  const panelBody = withoutComments(evidencePanel);
  // The panel is the repository's OWN primitive, reused rather than reinvented —
  // and no UI dependency was added to do it.
  assert.match(panelBody, /import \{ Drawer \} from "@\/components\/pmfreak\/ui\/drawer";/);
  assert.match(panelBody, /<Drawer title=\{record\.panelTitle\} onClose=\{\(\) => setOpen\(false\)\}/);
  // Portalled to the document body: the trigger sits inside the Evidence line's
  // running text, and a block-level dialog is not valid content inside a
  // paragraph — the parser would reparent it out from under the claim it belongs
  // to. Only reachable when `open`, which a server render can never be.
  assert.match(panelBody, /\{open\s*\?\s*createPortal\(/);
  assert.match(panelBody, /document\.body,/);
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const added of ["@radix-ui/react-dialog", "@headlessui/react", "react-modal", "@reach/dialog", "vaul", "focus-trap-react"]) {
    assert.equal(added in packageJson.dependencies, false, `${added} must not have been added`);
    assert.equal(added in packageJson.devDependencies, false, `${added} must not have been added`);
  }

  // Dialog semantics, with an accessible name that identifies THIS record in the
  // same governed words the trigger carries — never "Details", never an id.
  assert.match(drawerPrimitive, /role="dialog"/);
  assert.match(drawerPrimitive, /aria-modal="true"/);
  assert.match(drawerPrimitive, /aria-labelledby="drawer-title"/);
  assert.match(drawerPrimitive, /<h2 id="drawer-title"[\s\S]{0,120}\{title\}/);
  const presented = supportingRaidPanelPresentation(
    raidRow({ category: "risk", title: "Vendor approval may delay launch" }),
  );
  assert.equal(presented.panelTitle, "Supporting record: Risk — Vendor approval may delay launch");
  assert.equal(
    supportingRaidPanelPresentation(raidRow({ category: "raid_unknown" as ProjectRaidRow["category"], title: "x" })).panelTitle,
    "Supporting record: x",
  );
  assert.equal(presented.panelTitle.includes("undefined"), false);
  assert.equal(presented.panelTitle.includes(RAID_ITEM_ID), false);
  // The trigger's own name is the same governed line, so a screen-reader user
  // hears what they activated.
  assert.equal(
    evidenceInputLabel({ category: "Risk", name: "Vendor approval may delay launch", detectedConfidence: null }),
    "Risk — Vendor approval may delay launch",
  );
  assert.ok(presented.panelTitle.endsWith("Risk — Vendor approval may delay launch"));

  // An explicit dismissal exists, it is labelled, and Escape closes too.
  assert.match(drawerPrimitive, /aria-label="Close"/);
  assert.match(drawerPrimitive, /onClick=\{onClose\}/);
  assert.match(drawerPrimitive, /if \(event\.key === "Escape"\)[\s\S]{0,120}onClose\(\);/);
});

test("opening moves focus into the panel, and dismissal returns it to the same trigger", () => {
  // Opening focuses the first focusable element INSIDE the panel — predictable,
  // and it is the panel's own Close control rather than anything on the page
  // behind it. Focus is never moved without an activation having asked for it.
  assert.match(drawerPrimitive, /const focusable = container\?\.querySelectorAll<HTMLElement>\(FOCUSABLE_SELECTOR\);/);
  assert.match(drawerPrimitive, /focusable\?\.\[0\]\?\.focus\(\);/);
  // The element that was focused when the panel mounted — the trigger that
  // activated it — is captured and refocused on unmount, whichever dismissal ran.
  assert.match(drawerPrimitive, /triggerElementRef\.current = document\.activeElement as HTMLElement \| null;/);
  assert.match(drawerPrimitive, /return \(\) => \{[\s\S]{0,200}triggerElementRef\.current\?\.focus\(\);/);
  // Unmounting IS the dismissal, so Escape, the Close control and the scrim all
  // take the same path back to the same trigger.
  assert.match(withoutComments(evidencePanel), /\{open\s*\?\s*createPortal\([\s\S]{0,5000}\)\s*: null\}/);
  assert.equal(withoutComments(evidencePanel).match(/setOpen\(false\)/g)?.length, 1, "one close path, one focus return");
  // The focus trap is the dialog pattern's own requirement, implemented by the
  // repository primitive — not invented in this slice.
  assert.match(drawerPrimitive, /if \(event\.key !== "Tab" \|\| !container\) return;/);
  assert.equal(withoutComments(evidencePanel).includes("Tab"), false);
  assert.equal(withoutComments(evidencePanel).includes("addEventListener"), false);
  assert.equal(withoutComments(evidencePanel).includes(".focus()"), false);
});

test("only the interaction is client-owned — authorization, reads and scope are not", () => {
  const panelBody = withoutComments(evidencePanel);
  // The page is still a server component, and still the only thing that reads.
  assert.equal(routeBody.includes('"use client"'), false);
  assert.match(evidencePanel, /^"use client";/);
  assert.equal(routeBody.includes("useState"), false);
  assert.equal(routeBody.includes("onClick"), false);

  // No client fetch of any kind, and nothing to fetch WITH: the component gets
  // presentation text, not a row, not an id, not a scope.
  for (const forbidden of [
    "fetch(",
    "/api/",
    "useEffect",
    "supabase",
    "createClient",
    "createSupabase",
    "useSWR",
    "axios",
    "XMLHttpRequest",
    "workspaceId",
    "projectId",
    "raid_item_id",
    "raid_items",
    "recommended_actions",
    "record.id",
  ]) {
    assert.equal(panelBody.includes(forbidden), false, `the panel must not reach for ${forbidden}`);
  }
  // Its only imports are React state and the repository's own primitive, plus a
  // TYPE that erases at build time.
  assert.deepEqual(
    [...panelBody.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(),
    ["@/components/pmfreak/ui/drawer", "@/lib/projects/project-command-center-projection", "react", "react-dom"],
  );
  assert.match(panelBody, /import type \{ SupportingRaidPanelRecord \} from "@\/lib\/projects\/project-command-center-projection";/);
  assert.match(panelBody, /import \{ useState \} from "react";/);
  assert.match(panelBody, /import \{ createPortal \} from "react-dom";/);

  // The server builds the presentation, from a row it already guarded twice.
  assert.match(routeBody, /supportingRaidPanelPresentation\(supporting\.record\)/);
  assert.equal(presentationSource.includes("use client"), false);

  // And the panel is still read-only, like every other part of this screen.
  for (const forbidden of ["<form", "use server", "revalidatePath", "router.refresh", "Accept", "Reject", "Defer"]) {
    assert.equal(panelBody.includes(forbidden), false, `the panel must stay read-only (${forbidden})`);
  }
});

test("the supporting read, its scope and its failure isolation survive the correction", () => {
  // ONE batched statement, three filters, the exact referenced ids.
  const query = projectSupportingRaidQuery(WS, PROJECT, [SUPPORT_A, SUPPORT_B]);
  assert.equal(query.table, "raid_items");
  assert.equal(query.workspaceId, WS);
  assert.equal(query.projectId, PROJECT);
  assert.deepEqual([...(query.ids ?? [])], [SUPPORT_A, SUPPORT_B]);
  assert.equal(query.limit, 2);
  assert.equal(query.excludeStatuses, undefined, "Zone 1's open-only filter is still not inherited");
  assert.equal(routeBody.match(/projectSupportingRaidQuery\(/g)?.length, 1, "no N+1");
  assert.equal(zone2Body.includes("runProjectScopedQuery"), false);
  assert.equal(zone2Body.includes("await"), false);
  assert.match(routeBody, /selectSupportingRaidRecords\(supportingRead\.rows, workspaceId, projectId, supportingRaidIds\)/);

  // A closed record is still inspectable — provenance is not attention — and the
  // fallback disclosure works for one too.
  for (const closed of CLOSED_RAID_STATUSES) {
    const status = closed as ProjectRaidRow["status"];
    const supporting = resolved({ status, title: "Vendor approval may delay launch" });
    assert.equal(supporting.state, "resolved", `${closed} must remain inspectable`);
    assert.equal(supportingRaidPanelPresentation(raidRow({ status })).status, status);
    assert.deepEqual(resolveRecommendationDisclosure(null, null, supporting, PROJECT).why, {
      category: "Risk",
      condition: "Vendor approval may delay launch",
    });
  }

  // A supporting failure degrades that line only: the four zones still render
  // unconditionally, Zone 2's branches still come from Zone 2's OWN read, and no
  // read was merged into a single failure unit.
  assert.deepEqual(
    [...routeBody.matchAll(/zone=\{ZONE_([A-Z]+)\}/g)].map((m) => m[1]),
    ["ATTENTION", "RECOMMENDATIONS", "DECISIONS", "HEALTH"],
  );
  assert.match(zone2Body, /\{recommendationsRead === null \? \(\s*<ZoneDegraded/);
  assert.match(zone2Body, /recommendations\.length === 0 \? \(\s*<ZoneEmpty>/);
  assert.equal(routeBody.match(/Promise\.all\(/g), null);
  assert.equal(routeBody.match(/Promise\.allSettled\(/g)?.length, 2);
  assert.match(routeBody, /"project_command_center\.supporting_raid_unavailable"/);

  // Zone 2's population is untouched, and so is every earlier correction.
  const zone2Query = projectRecommendationsQuery(WS, PROJECT);
  assert.deepEqual(
    { workspaceId: zone2Query.workspaceId, projectId: zone2Query.projectId, governed: zone2Query.governed, status: zone2Query.status },
    { workspaceId: WS, projectId: PROJECT, governed: false, status: "proposed" },
  );
  assert.equal(routeBody.includes("decisionRequiredCount"), false, "PR #610 P2 #1 stands");
  assert.match(route, /PMO ancestry is temporarily unavailable\./);
  assert.equal(resolveProjectPmoAncestry({ pmoId: PMO, row: null, error: { message: "x" } }).state, "unavailable");
  for (const generic of ["Object.entries", "Object.keys", "Object.values"]) {
    assert.equal(withoutComments(projection).includes(generic), false, "PR #610 P2 #3 stands");
  }

  // No workspace module, and no database client, reachable from the correction.
  assert.equal(withoutComments(evidencePanel).includes("supabase"), false);
  assert.equal(withoutComments(evidencePanel).includes("@/modules/workspace"), false);
});
