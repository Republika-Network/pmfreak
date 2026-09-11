import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PMOS_NAV_HREF,
  isPmoCommandCenterPath,
  parsePmoRouteFromPath,
  pmoCommandCenterBreadcrumb,
  pmoCommandCenterPath,
} from "../src/lib/pmos/pmo-command-center-paths";
// MIGRATED by the PMO canonical route-family slice: PMO Home moved from the
// legacy `/pmos/[pmoId]` to `/workspaces/[workspaceId]/pmos/[pmoId]`, so the
// breadcrumb's PMO ancestor now points at a canonical route and needs the
// workspace id. `legacyPmoHomePath` is gone with the seam it described.
import { pmoHomePath } from "../src/lib/pmos/pmo-paths";
// MIGRATED by the canonical Workspace route-family slice: the trail's WORKSPACE
// ancestor was the last placeholder in it. PR #606 could not point it at the
// singular `/workspace` (quarantined to a Command Center) and PR #607 left it at
// `/workspaces`, the chooser, because no per-workspace Home existed. Workspace
// Home now does, so `LEGACY_WORKSPACE_HOME_PATH` is gone with the seam it named.
import { workspaceHomePath } from "../src/lib/workspaces/workspace-paths";
import { decideRoutedPmoAccess, type RoutedPmoAccess } from "../src/lib/pmos/routed-pmo";
import {
  CLOSED_RAID_STATUSES,
  pmoProjectsQuery,
  pmoRaidQuery,
  runPmoScopedQuery,
  selectPmoProjects,
  selectPmoRaid,
  summarizeOpenRaid,
  summarizePmoProjects,
  type PmoProjectRow,
  type PmoRaidRow,
} from "../src/lib/pmos/pmo-command-center-rollup";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  isWorkspaceCommandCenterPath,
  navEntryMatchesPathname,
  parseWorkspaceIdFromPath,
  workspaceCommandCenterPath,
} from "../src/lib/workspace/command-center-paths";
import { NAVIGATION_HIERARCHY } from "../src/lib/workspace/navigation-hierarchy";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { PM_OPERATIONS_LEGACY_PATH, PM_OPERATIONS_PATH } from "../src/lib/pm-operations/pm-operations-paths";
import type { RoutedWorkspaceAccess } from "../src/lib/workspaces/routed-workspace";

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const PMO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PMO = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
const CANONICAL = `/workspaces/${WS}/pmos/${PMO}/command-center`;

/**
 * Paths that LOOK like an ancestor Home but resolve onward to a Command
 * Center. `/workspace` is quarantined by src/proxy.ts; `/command-center` is the
 * Workspace Command Center's own legacy resolver.
 */
const QUARANTINED_TO_COMMAND_CENTER = ["/workspace", "/command-center"];

const ROUTE_FILE = "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/command-center/page.tsx";
const route = readFileSync(ROUTE_FILE, "utf8");
const resolver = readFileSync("src/lib/pmos/routed-pmo.ts", "utf8");
const rollup = readFileSync("src/lib/pmos/pmo-command-center-rollup.ts", "utf8");
const paths = readFileSync("src/lib/pmos/pmo-command-center-paths.ts", "utf8");
const protectedLayout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
// MIGRATED: PmoTabNav moved into the canonical family it now links to.
const tabNav = readFileSync("src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/pmo-tab-nav.tsx", "utf8");
const pmoCommandCenterLegacyRoute = readFileSync("src/app/(protected)/pmo-command-center/page.tsx", "utf8");
const pmOperationsScreen = readFileSync("src/app/(protected)/pm-operations/page.tsx", "utf8");

/**
 * Strip comments before checking user-facing copy rules.
 *
 * ADR-PMF-014 Rule 1 governs what a USER sees. Prose that explains the rule
 * necessarily quotes the bare phrase it forbids, and a check that cannot tell
 * an explanation from a label would push the reasoning out of the code — which
 * is the opposite of what these modules are for. Everything a user can read is
 * a string literal or JSX text, and both survive this.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. The canonical path ────────────────────────────────────────────────

test("the canonical path is the entity-qualified route named by the route map", () => {
  assert.equal(pmoCommandCenterPath(WS, PMO), CANONICAL);
  assert.ok(isPmoCommandCenterPath(CANONICAL));
});

test("both ids are encoded, so neither can escape its path segment", () => {
  // Not expected input — this is the assertion that a malformed id cannot add
  // segments and address a different route entirely.
  const path = pmoCommandCenterPath("a/b?c=d", "e/f");
  assert.equal(path, "/workspaces/a%2Fb%3Fc%3Dd/pmos/e%2Ff/command-center");
  // "" / workspaces / <id> / pmos / <id> / command-center
  assert.equal(path.split("/").length, 6, "encoded ids must not add path segments");
  assert.ok(isPmoCommandCenterPath(path), "an encoded id still addresses this route");
});

test("parsePmoRouteFromPath recovers exactly the two ids the path names", () => {
  assert.deepEqual(parsePmoRouteFromPath(CANONICAL), { workspaceId: WS, pmoId: PMO });
  // Round-trips through encoding, so a link built by the helper is readable by
  // the parser — which is what the protected layout depends on.
  const odd = { workspaceId: "ws with space", pmoId: "pmo/slash" };
  assert.deepEqual(parsePmoRouteFromPath(pmoCommandCenterPath(odd.workspaceId, odd.pmoId)), odd);
});

test("parsePmoRouteFromPath refuses anything that is not this route", () => {
  for (const other of [
    "/",
    "/pmos",
    `/pmos/${PMO}`,
    `/workspaces/${WS}/command-center`,
    "/command-center",
    "/pm-operations",
    "/pmo-command-center",
    `/workspaces/${WS}/pmos/${PMO}`,
  ]) {
    assert.equal(parsePmoRouteFromPath(other), null, `${other} must not parse as a PMO Command Center`);
    assert.equal(isPmoCommandCenterPath(other), false, `${other} must not match`);
  }
});

test("a malformed percent-escape is refused rather than guessed at", () => {
  assert.equal(parsePmoRouteFromPath("/workspaces/%E0%A4%A/pmos/p/command-center"), null);
});

// ─── 2. The two Command Centers stay separate predicates ──────────────────

test("the Workspace Command Center's own helpers do not claim the PMO route", () => {
  // isWorkspaceCommandCenterPath must NOT be widened to cover both: they are
  // different entity scopes (ADR-PMF-014 Rule 1), and that predicate is
  // load-bearing for the Workspace screen's nav active-state.
  assert.equal(isWorkspaceCommandCenterPath(CANONICAL), false);
  assert.equal(parseWorkspaceIdFromPath(CANONICAL), null);
});

test("the PMO predicate does not claim the Workspace Command Center route", () => {
  assert.equal(isPmoCommandCenterPath(workspaceCommandCenterPath(WS)), false);
  assert.equal(isPmoCommandCenterPath(WORKSPACE_COMMAND_CENTER_LEGACY_PATH), false);
});

// ─── 3. Breadcrumb contract ───────────────────────────────────────────────

test("the breadcrumb is Workspace → PMO → PMO Command Center", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery PMO", pmoId: PMO });
  assert.deepEqual(
    trail.map((node) => node.label),
    ["Acme", "Delivery PMO", "PMO Command Center"],
  );
});

test("the terminal node is not a link", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery PMO", pmoId: PMO });
  const terminal = trail[trail.length - 1];
  assert.equal(terminal.label, "PMO Command Center");
  assert.equal(terminal.href, null, "Command Center is where a trail ends (nav-contracts §2.3 rule 4)");
});

test("every ancestor links to a Home, never to a Command Center", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery PMO", pmoId: PMO });
  const ancestors = trail.slice(0, -1);
  assert.equal(ancestors.length, 2);
  for (const node of ancestors) {
    assert.ok(node.href, "an ancestor node must be clickable (nav-contracts §2.3 rule 1)");
    assert.doesNotMatch(node.href!, /command-center/, `${node.href} must be a Home, not a Command Center`);
    // A literal href is not enough. `/workspace` looks innocent and is
    // quarantined by src/proxy.ts straight to /command-center, so linking an
    // ancestor there would navigate to a Command Center anyway — putting one
    // mid-trail, which §2.3 rule 4 and ADR-PMF-014 Rule 4 both forbid.
    assert.ok(
      !QUARANTINED_TO_COMMAND_CENTER.includes(node.href!),
      `${node.href} redirects to a Command Center, so it cannot be an ancestor node`,
    );
  }
  // MIGRATED: the Workspace ancestor is that workspace's own canonical Home, not
  // the chooser and not a path that redirects into a Command Center.
  assert.equal(ancestors[0].href, workspaceHomePath(WS));
  // MIGRATED: the PMO ancestor is its canonical Home, not the legacy seam.
  assert.equal(ancestors[1].href, pmoHomePath(WS, PMO));
});

test("the paths that redirect to a Command Center really do still redirect", () => {
  // Pins the premise of the test above: if the quarantine is ever lifted,
  // this fails and the ancestor target can be reconsidered deliberately
  // rather than by accident.
  const proxy = readFileSync("src/proxy.ts", "utf8");
  assert.match(proxy, /pathname === "\/workspace"/);
  assert.match(proxy, /new URL\("\/command-center", request\.url\)/);
});

test("the breadcrumb preserves the PMO identity it was given", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery PMO", pmoId: OTHER_PMO });
  assert.match(trail[1].href!, new RegExp(OTHER_PMO));
});

// ─── 4. Routed PMO authorization ──────────────────────────────────────────

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

const assertDenied = (result: RoutedPmoAccess, why: string) => {
  assert.equal(result.access, "denied", why);
  // A refusal carries no identity at all — not even the ids the caller sent,
  // so nothing downstream can accidentally render or log them as resolved.
  assert.equal(result.pmoId, null, "a refusal must not carry a PMO id");
  assert.equal(result.workspaceId, null, "a refusal must not carry a workspace id");
  assert.equal(result.readOnly, true);
};

test("an active PMO in an authorized workspace is granted, with its own ids", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "active" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "granted");
  assert.equal(result.pmoId, PMO, "the resolved PMO is the one that was requested");
  assert.equal(result.workspaceId, WS);
  assert.equal(result.readOnly, false);
});

test("PMO A never resolves as PMO B — the verdict echoes the requested id only", () => {
  for (const requested of [PMO, OTHER_PMO]) {
    const result = decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: requested,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    });
    assert.equal(result.pmoId, requested);
  }
});

test("a PMO that does not resolve is denied, with no substitute", () => {
  assertDenied(
    decideRoutedPmoAccess({ routedWorkspaceId: WS, pmoId: PMO, pmo: null, workspaceAccess: grantedWs(WS) }),
    "an absent PMO must not fall back to any other PMO",
  );
});

test("a caller with no membership in the PMO's workspace is denied", () => {
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: deniedWs,
    }),
    "workspace membership is what grants PMO access",
  );
});

test("a routed workspace that disagrees with pmos.workspace_id is REFUSED, not corrected", () => {
  // The caller is a legitimate member of the PMO's real workspace here — the
  // only thing wrong is the ancestry the URL asserts. Rendering anyway would
  // serve this PMO under a workspace id that does not own it, and would leak
  // its real workspace by correcting the address.
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: OTHER_WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    "an ancestry mismatch must refuse",
  );
});

test("a workspace verdict resolved for some other workspace cannot authorize this PMO", () => {
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(OTHER_WS),
    }),
    "the authorized workspace must be the PMO's own",
  );
});

test("empty ids are denied before anything else happens", () => {
  assertDenied(
    decideRoutedPmoAccess({ routedWorkspaceId: "", pmoId: PMO, pmo: { workspaceId: "", status: "active" }, workspaceAccess: grantedWs("") }),
    "an empty workspace id is not a request",
  );
  assertDenied(
    decideRoutedPmoAccess({ routedWorkspaceId: WS, pmoId: "", pmo: { workspaceId: WS, status: "active" }, workspaceAccess: grantedWs(WS) }),
    "an empty PMO id is not a request",
  );
});

test("an archived PMO stays readable — archived is not an access failure", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "archived" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "archived");
  assert.equal(result.readOnly, true, "archived is read-only");
  assert.equal(result.pmoId, PMO, "the viewer still sees the PMO they asked for");
  assert.deepEqual(result.access === "archived" ? result.archived : null, { pmo: true, workspace: false });
});

test("an archived parent workspace makes an active PMO read-only too", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "active" },
    workspaceAccess: archivedWs(WS),
  });
  assert.equal(result.access, "archived");
  assert.deepEqual(result.access === "archived" ? result.archived : null, { pmo: false, workspace: true });
});

test("both archived is reported as both, so the banner can say something true", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "archived" },
    workspaceAccess: archivedWs(WS),
  });
  assert.deepEqual(result.access === "archived" ? result.archived : null, { pmo: true, workspace: true });
});

test("an archived PMO in a workspace the caller cannot reach is still denied", () => {
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "archived" },
      workspaceAccess: deniedWs,
    }),
    "archived must not become a way around membership",
  );
});

// ─── 5. Rollup scoping ────────────────────────────────────────────────────

test("the projects query is scoped by workspace AND by exact pmo_id", () => {
  const query = pmoProjectsQuery(WS, PMO);
  assert.equal(query.table, "projects");
  assert.equal(query.workspaceId, WS);
  assert.equal(query.pmoId, PMO);
  assert.equal(query.projectIds, undefined);
});

test("the RAID query is restricted to this PMO's own project ids", () => {
  const query = pmoRaidQuery(WS, ["p1", "p2"]);
  assert.ok(query);
  assert.equal(query!.table, "raid_items");
  assert.equal(query!.workspaceId, WS);
  assert.deepEqual(query!.projectIds, ["p1", "p2"]);
});

test("a PMO with no projects issues NO RAID query at all", () => {
  // The regression this guards: dropping the restriction when there is nothing
  // to restrict to, which would read the whole workspace's RAID.
  assert.equal(pmoRaidQuery(WS, []), null);
});

test("sibling-PMO projects cannot enter the rollup", () => {
  const rows: PmoProjectRow[] = [
    { id: "p1", name: "Mine", description: null, status: "active", icon: null, color: null, pmo_id: PMO },
    { id: "p2", name: "Sibling", description: null, status: "active", icon: null, color: null, pmo_id: OTHER_PMO },
  ];
  assert.deepEqual(
    selectPmoProjects(rows, PMO).map((r) => r.id),
    ["p1"],
  );
});

test("unassigned projects (pmo_id IS NULL) cannot enter the rollup", () => {
  // ADR-PMF-003 rule 4 makes "unassigned" a legitimate Workspace-level state,
  // but it is not a descendant of any PMO, so it has no place in this
  // projection (ADR-PMF-020 descendant-only rule).
  const rows: PmoProjectRow[] = [
    { id: "p1", name: "Mine", description: null, status: "active", icon: null, color: null, pmo_id: PMO },
    { id: "p2", name: "Unassigned", description: null, status: "active", icon: null, color: null, pmo_id: null },
  ];
  assert.deepEqual(
    selectPmoProjects(rows, PMO).map((r) => r.id),
    ["p1"],
  );
});

test("RAID from projects outside the PMO cannot enter the rollup", () => {
  const items: PmoRaidRow[] = [
    { project_id: "p1", category: "risk", status: "open" },
    { project_id: "elsewhere", category: "risk", status: "open" },
    { project_id: null, category: "issue", status: "open" },
  ];
  const kept = selectPmoRaid(items, ["p1"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].project_id, "p1");
});

test("project buckets are exactly the statuses the schema stores", () => {
  const rows: PmoProjectRow[] = (
    [
      ["p1", "active"],
      ["p2", "active"],
      ["p3", "completed"],
      ["p4", "archived"],
    ] as const
  ).map(([id, status]) => ({ id, name: id, description: null, status, icon: null, color: null, pmo_id: PMO }));
  assert.deepEqual(summarizePmoProjects(rows), { total: 4, active: 2, completed: 1, archived: 1 });
  assert.deepEqual(summarizePmoProjects([]), { total: 0, active: 0, completed: 0, archived: 0 });
});

test("open RAID follows the shipped /pmos/[pmoId]/reports semantics exactly", () => {
  const items: PmoRaidRow[] = [
    { project_id: "p1", category: "risk", status: "open" },
    { project_id: "p1", category: "risk", status: "monitoring" },
    { project_id: "p1", category: "risk", status: "closed" },
    { project_id: "p1", category: "issue", status: "mitigated" },
    { project_id: "p1", category: "issue", status: "resolved" },
    { project_id: "p1", category: "assumption", status: "open" },
    { project_id: "p1", category: "dependency", status: "open" },
  ];
  assert.deepEqual(summarizeOpenRaid(items), { openRisks: 2, openIssues: 1 });
  assert.deepEqual([...CLOSED_RAID_STATUSES], ["closed", "resolved"]);
});

test("the query descriptor is what actually reaches the database", () => {
  // Closes the loop between the descriptors asserted above and the filters the
  // client receives, so "scoped by pmo_id" is proven end to end rather than by
  // reading the page for a string.
  const applied: { table?: string; columns?: string; eq: [string, unknown][]; in: [string, unknown][] } = {
    eq: [],
    in: [],
  };
  const builder = {
    eq(column: string, value: unknown) {
      applied.eq.push([column, value]);
      return builder;
    },
    in(column: string, value: unknown) {
      applied.in.push([column, value]);
      return builder;
    },
    then(resolve: (r: { data: unknown[]; error: null }) => void) {
      resolve({ data: [], error: null });
    },
  };
  const fake = {
    from(table: string) {
      applied.table = table;
      return {
        select(columns: string) {
          applied.columns = columns;
          return builder;
        },
      };
    },
  };

  return (async () => {
    type Client = Parameters<typeof runPmoScopedQuery>[0];
    await runPmoScopedQuery(fake as unknown as Client, pmoProjectsQuery(WS, PMO));
    assert.equal(applied.table, "projects");
    assert.deepEqual(applied.eq, [
      ["workspace_id", WS],
      ["pmo_id", PMO],
    ]);
    assert.deepEqual(applied.in, []);

    applied.eq.length = 0;
    applied.in.length = 0;
    await runPmoScopedQuery(fake as unknown as Client, pmoRaidQuery(WS, ["p1", "p2"])!);
    assert.equal(applied.table, "raid_items");
    assert.deepEqual(applied.eq, [["workspace_id", WS]]);
    assert.deepEqual(applied.in, [["project_id", ["p1", "p2"]]]);
  })();
});

// ─── 6. Navigation active-state ───────────────────────────────────────────

test("on the PMO Command Center, PMOs is the active nav entry", () => {
  assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, CANONICAL));
});

test("on the PMO Command Center, Workspaces is NOT also active", () => {
  // The canonical PMO route nests under /workspaces/<id>/, and "/workspaces" is
  // a real nav entry, so a plain prefix test would light up both.
  assert.equal(navEntryMatchesPathname("/workspaces", CANONICAL), false);
});

test("on the PMO Command Center, the Workspace Command Center entry is NOT active", () => {
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL), false);
});

test("the PMOs nav entry this depends on exists with that exact href", () => {
  assert.ok(
    NAVIGATION_HIERARCHY.some((node) => node.href === PMOS_NAV_HREF),
    "PMOS_NAV_HREF must match a real NAVIGATION_HIERARCHY entry",
  );
});

test("PR #604's Workspace Command Center active-state behaviour is unchanged", () => {
  const workspaceCanonical = workspaceCommandCenterPath(WS);
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, workspaceCanonical));
  assert.equal(navEntryMatchesPathname("/workspaces", workspaceCanonical), false);
  assert.ok(navEntryMatchesPathname("/workspaces", "/workspaces"));
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, "/command-center"));
  assert.ok(navEntryMatchesPathname("/projects", "/projects/abc"));
  assert.equal(navEntryMatchesPathname("/projects", "/portfolio"), false);
  assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, "/pmos"));
  assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, `/pmos/${PMO}`));
});

// ─── 7. Route classification and session continuation ─────────────────────

test("the canonical PMO route is a protected page", () => {
  assert.ok(isProtectedPageRoute(CANONICAL));
  assert.equal(getRouteAccessPolicy(CANONICAL), "workspace-contextual");
});

test("a canonical PMO deep link survives an expired session", () => {
  // Already covered by the existing "/workspaces" allowlist prefix — asserted
  // so a future narrowing of that entry cannot silently drop PMO deep links.
  assert.ok(isSafeContinuationRoute(CANONICAL));
});

test("nothing about this slice widened the continuation allowlist", () => {
  for (const blocked of ["/api/anything", "/login", "/_next/static", "/debug/x"]) {
    assert.equal(isSafeContinuationRoute(blocked), false, `${blocked} must stay blocked`);
  }
  assert.equal(isSafeContinuationRoute("//evil.example.com"), false);
});

// ─── 8. PM Operations stays a separate surface ────────────────────────────

test("neither PM Operations path is a PMO Command Center path", () => {
  assert.equal(isPmoCommandCenterPath(PM_OPERATIONS_PATH), false);
  assert.equal(isPmoCommandCenterPath(PM_OPERATIONS_LEGACY_PATH), false);
});

test("/pmo-command-center still redirects to PM Operations, not here", () => {
  assert.match(pmoCommandCenterLegacyRoute, /redirect\(PM_OPERATIONS_PATH\)/);
  assert.doesNotMatch(
    pmoCommandCenterLegacyRoute,
    /pmo-command-center-paths/,
    "the compatibility redirect must not be repointed at the new screen",
  );
});

test("the PM Operations screen still takes no pmoId", () => {
  assert.doesNotMatch(pmOperationsScreen, /pmoId/, "that surface is workspace-scoped internal PM ops");
});

test("the new route does not reach into the internal PM-ops surface", () => {
  // The route's own prose names /pm-operations to say what this screen is NOT,
  // which is the point — so this checks for a dependency, not a mention.
  const code = withoutComments(route);
  assert.doesNotMatch(code, /pm-operations/, "no import of, or link to, the internal dashboard");
  assert.doesNotMatch(code, /pmo_command_center_snapshots/);
});

// ─── 9. Route wiring the pure functions cannot prove ──────────────────────

test("the route authorizes the URL's PMO id, passing both routed segments", () => {
  assert.match(route, /resolveRoutedPmo\(user\.id, requestedWorkspaceId, requestedPmoId\)/);
  assert.match(route, /access\.access === "denied"/);
});

test("no resolver with a fallback appears anywhere in this route's path", () => {
  for (const source of [route, resolver]) {
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, "the URL is the scope here, not the cookie");
    assert.doesNotMatch(source, /resolveCanonicalWorkspace/, "the falling-back resolver must not return");
    assert.doesNotMatch(source, /ensureUserWorkspace/);
    assert.doesNotMatch(source, /ensureDefaultPmo/, "a PMO is never auto-created to satisfy a route");
  }
});

test("the refusal reveals nothing about whether the PMO exists", () => {
  // MIGRATED: the copy moved into a component shared by all nine PMO routes (the
  // five canonical surfaces and the four legacy resolvers), so one wording serves
  // every surface and they cannot drift into distinguishable replies. The copy is
  // still pinned — just in its new home.
  const refusal = readFileSync("src/components/pmfreak/pmos/pmo-route-states.tsx", "utf8");
  assert.match(refusal, /does not exist or is not one you have access to/);
  assert.match(route, /pmo-route-states/, "the route must use the shared refusal");
  // One refusal component, reached from both the denial and the vanished-row
  // path, so the two cannot drift into distinguishable replies.
  assert.equal(route.match(/<PmoNotAvailable \/>/g)?.length, 2);
});

test("the route is read-only — no mutation reaches the database", () => {
  for (const [name, source] of [
    ["route", route],
    ["resolver", resolver],
    ["rollup", rollup],
  ] as const) {
    for (const mutation of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.rpc\(/]) {
      assert.doesNotMatch(source, mutation, `${name} must contain no mutation call`);
    }
  }
});

test("this slice introduces no schema and no migration", () => {
  // The paths module cites `supabase/migrations` when recording WHY the
  // pmo_*-named tables are excluded, so the check is for DDL in code, not for
  // the word appearing in an explanation.
  for (const source of [route, resolver, rollup, paths]) {
    assert.doesNotMatch(withoutComments(source), /create\s+table|alter\s+table|drop\s+table|\.sql\b/i);
  }
});

test("none of the excluded data sources is used", () => {
  // Every one of these is workspace-scoped despite its name, or has no PMO edge
  // at all. Using one would rebuild PM Operations under a PMO label.
  const excluded = [
    "pmo_command_center_snapshots",
    "pmo_attention_items",
    "pmo_recommendations",
    "pmo_executive_reports",
    "pmo_intervention_actions",
    "operational_command_centers",
    "governance_compliance_gaps",
    "governance_signals",
    "personal_portfolios",
    "context_conversations",
    "recommended_actions",
    "project_evidence",
    "project_decisions",
    "risk_issue_records",
  ];
  for (const table of excluded) {
    assert.doesNotMatch(route, new RegExp(`from\\(\\s*["']${table}["']`), `${table} is not PMO-scoped data`);
    assert.doesNotMatch(rollup, new RegExp(`from\\(\\s*["']${table}["']`), `${table} is not PMO-scoped data`);
  }
  // `programs` has no pmo_id and no Program↔Project FK, so it cannot be rolled
  // up to a PMO at all.
  assert.doesNotMatch(route, /from\(\s*["']programs["']/);
});

test("the route reads only the two tables this slice is allowed to read", () => {
  const tables = new Set([...route.matchAll(/\.from\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]));
  assert.deepEqual([...tables].sort(), ["pmos"]);
  // The other two reads go through the scoped-query helpers, whose tables are
  // constrained by PmoScopedQuery's own union type.
  assert.match(rollup, /table: "projects" \| "raid_items"/);
});

test("no workspace-scoped Command Center component is mounted here", () => {
  for (const component of [/CommandCenterClient/, /CommandCenterEmptyState/, /WorkspaceContextBanner/, /summarizePortfolio/, /listPmosWithProjects/]) {
    assert.doesNotMatch(route, component, "workspace semantics must not leak into a PMO projection");
  }
});

test("every user-facing Command Center mention in the route is entity-qualified", () => {
  // ADR-PMF-014 Rule 1, as a literal, checkable rule.
  const copy = withoutComments(route);
  const bare = /(?<!PMO |Workspace |Project |Portfolio |Program |Enterprise )Command Center/.exec(copy);
  assert.equal(bare, null, `bare "Command Center" in: ${copy.slice(Math.max(0, (bare?.index ?? 0) - 60), (bare?.index ?? 0) + 40)}`);
  assert.match(copy, /PMO Command Center/);
});

// ─── 10. Shell and navigation integration ─────────────────────────────────

test("the protected layout derives workspace context from the PMO route", () => {
  // Without this the shell and the onboarding gate answer from the
  // preferred-workspace cookie, so the chrome disagrees with the route and an
  // incomplete other workspace can redirect the user away from this one.
  // MIGRATED: the layout now serves the whole PMO family, not just the Command
  // Center, so it uses the family parser. Same defect, four more surfaces.
  assert.match(protectedLayout, /parseCanonicalPmoRoute\([\s\S]*?\)\?\.workspaceId/);
  // The Workspace Command Center's own derivation is still tried first and is
  // untouched, so PR #604's behaviour is a strict prefix of this one.
  assert.match(protectedLayout, /parseWorkspaceIdFromPath\(routedHeaders\.get\("x-pathname"\)/);
});

test("the PMO tab nav links to the canonical route, preserving both ids", () => {
  // MIGRATED: every tab is now one row of the same canonical family, built by the
  // shared surface helper, so the Command-Center-only call site is gone. The
  // stronger property — no tab leaves canonical space — is proved behaviourally in
  // tests/pmo-canonical-route-family.test.ts.
  assert.match(tabNav, /pmoSurfacePath\(workspaceId, pmoId, tab\.surface\)/);
  assert.doesNotMatch(tabNav, /"\/workspaces\//, "the path must not be re-typed as a literal");
  assert.doesNotMatch(tabNav, /"\/pmos\//, "no tab may point back into legacy PMO space");
});

test("the PMO tab entry is entity-qualified", () => {
  assert.match(tabNav, /label: "PMO Command Center"/);
  const copy = withoutComments(tabNav);
  const bare = /(?<!PMO |Workspace |Project |Portfolio |Program |Enterprise )Command Center/.exec(copy);
  assert.equal(bare, null, `bare "Command Center" in: ${copy.slice(Math.max(0, (bare?.index ?? 0) - 60), (bare?.index ?? 0) + 40)}`);
});

test("every PmoTabNav call site supplies an authoritative workspace id", () => {
  // MIGRATED: the call sites moved to the canonical family, and the source of the
  // workspace id changed with them. It used to be `resolvePreferredWorkspace` —
  // a cookie — which is exactly what this slice removed from PMO identity. It is
  // now the workspace `resolveRoutedPmo` returns, i.e. `pmos.workspace_id`.
  for (const file of [
    "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/page.tsx",
    "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/chat/page.tsx",
    "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/reports/page.tsx",
    "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/settings/page.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /<PmoTabNav workspaceId=\{workspaceId\}/, `${file} must pass a workspace id`);
    assert.match(
      source,
      /const \{ workspaceId, pmoId \} = access;/,
      `${file} must take both ids from the resolver's verdict, not from the URL`,
    );
    assert.match(source, /getPmoById\(workspaceId, pmoId\)/, `${file} must scope its PMO lookup`);
  }
});
