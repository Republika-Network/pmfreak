import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LEGACY_PMO_SURFACES,
  PMOS_NAV_HREF,
  PMO_SURFACES,
  isCanonicalPmoRoutePath,
  legacyPmoSurfacePath,
  parseCanonicalPmoRoute,
  pmoChatPath,
  pmoCommandCenterPath,
  pmoHomePath,
  pmoReportsPath,
  pmoSettingsPath,
  pmoSurfacePath,
  type LegacyPmoSurface,
  type PmoSurface,
} from "../src/lib/pmos/pmo-paths";
import {
  isPmoCommandCenterPath,
  parsePmoRouteFromPath,
  pmoCommandCenterBreadcrumb,
} from "../src/lib/pmos/pmo-command-center-paths";
import { decideRoutedPmoAccess, type RoutedPmoAccess } from "../src/lib/pmos/routed-pmo";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  isWorkspaceCommandCenterPath,
  navEntryMatchesPathname,
  parseWorkspaceIdFromPath,
  workspaceCommandCenterPath,
} from "../src/lib/workspace/command-center-paths";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { PM_OPERATIONS_LEGACY_PATH, PM_OPERATIONS_PATH } from "../src/lib/pm-operations/pm-operations-paths";
import type { RoutedWorkspaceAccess } from "../src/lib/workspaces/routed-workspace";

/**
 * The PMO route family cutover.
 *
 * PR #606 shipped ONE canonical PMO surface — the Command Center — and left the
 * other four at `/pmos/[pmoId]`, where the workspace was resolved from the
 * preferred-workspace COOKIE. That is the defect this slice removes, and it is
 * worth stating precisely because it is the thing every test below is really
 * about: under the old routes, the same PMO id resolved to different things for
 * the same user depending on which workspace they were last in, and a PMO they
 * were entitled to see 404'd whenever it lived outside that workspace.
 *
 * PMO identity is now `Workspace → PMO → surface`, decided by
 * `pmos.workspace_id` and nothing else.
 */

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const PMO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PMO = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";

const CANONICAL_ROOT = `/workspaces/${WS}/pmos/${PMO}`;

const CANONICAL: Record<PmoSurface, string> = {
  home: CANONICAL_ROOT,
  chat: `${CANONICAL_ROOT}/chat`,
  reports: `${CANONICAL_ROOT}/reports`,
  settings: `${CANONICAL_ROOT}/settings`,
  "command-center": `${CANONICAL_ROOT}/command-center`,
};

const CANONICAL_PAGE_FILES: Record<PmoSurface, string> = {
  home: "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/page.tsx",
  chat: "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/chat/page.tsx",
  reports: "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/reports/page.tsx",
  settings: "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/settings/page.tsx",
  "command-center": "src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/command-center/page.tsx",
};

const LEGACY_PAGE_FILES: Record<LegacyPmoSurface, string> = {
  home: "src/app/(protected)/pmos/[pmoId]/page.tsx",
  chat: "src/app/(protected)/pmos/[pmoId]/chat/page.tsx",
  reports: "src/app/(protected)/pmos/[pmoId]/reports/page.tsx",
  settings: "src/app/(protected)/pmos/[pmoId]/settings/page.tsx",
};

const read = (file: string) => readFileSync(file, "utf8");

const canonicalSources = Object.fromEntries(
  (Object.keys(CANONICAL_PAGE_FILES) as PmoSurface[]).map((surface) => [surface, read(CANONICAL_PAGE_FILES[surface])]),
) as Record<PmoSurface, string>;

const legacySources = Object.fromEntries(
  (Object.keys(LEGACY_PAGE_FILES) as LegacyPmoSurface[]).map((surface) => [surface, read(LEGACY_PAGE_FILES[surface])]),
) as Record<LegacyPmoSurface, string>;

const paths = read("src/lib/pmos/pmo-paths.ts");
const resolver = read("src/lib/pmos/routed-pmo.ts");
const tabNav = read("src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/pmo-tab-nav.tsx");
const protectedLayout = read("src/app/(protected)/layout.tsx");
const routeStates = read("src/components/pmfreak/pmos/pmo-route-states.tsx");
const pmoCommandCenterLegacyRoute = read("src/app/(protected)/pmo-command-center/page.tsx");
const pmOperationsScreen = read("src/app/(protected)/pm-operations/page.tsx");
const pmoMutationRoute = read("src/app/api/pmos/[id]/route.ts");
const pmoDuplicateRoute = read("src/app/api/pmos/[id]/duplicate/route.ts");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. The five canonical paths ──────────────────────────────────────────

test("each named helper builds its own canonical surface path", () => {
  assert.equal(pmoHomePath(WS, PMO), CANONICAL.home);
  assert.equal(pmoChatPath(WS, PMO), CANONICAL.chat);
  assert.equal(pmoReportsPath(WS, PMO), CANONICAL.reports);
  assert.equal(pmoSettingsPath(WS, PMO), CANONICAL.settings);
  assert.equal(pmoCommandCenterPath(WS, PMO), CANONICAL["command-center"]);
});

test("the PMO Command Center path is byte-identical to the one PR #606 shipped", () => {
  // The Command Center is the one surface that did NOT move. It is now built by
  // the shared helper, so this pins that the refactor changed no URL: an existing
  // bookmark, and PR #606's own regression suite, must both still resolve.
  assert.equal(pmoCommandCenterPath(WS, PMO), `/workspaces/${WS}/pmos/${PMO}/command-center`);
  assert.equal(pmoSurfacePath(WS, PMO, "command-center"), pmoCommandCenterPath(WS, PMO));
});

test("Home is the family root — no trailing segment of its own", () => {
  assert.equal(pmoHomePath(WS, PMO), CANONICAL_ROOT);
  for (const surface of PMO_SURFACES) {
    if (surface === "home") continue;
    assert.equal(pmoSurfacePath(WS, PMO, surface), `${CANONICAL_ROOT}/${surface}`);
  }
});

test("every surface is Workspace-rooted and none is in legacy PMO space", () => {
  for (const surface of PMO_SURFACES) {
    const path = pmoSurfacePath(WS, PMO, surface);
    assert.ok(path.startsWith(`/workspaces/${WS}/pmos/${PMO}`), `${surface} must be workspace-rooted`);
    assert.doesNotMatch(path, /^\/pmos\//, `${surface} must not live at the legacy root`);
  }
});

// ─── 2. Encoding: a segment cannot change the path's structure ────────────

test("both ids are encoded on every surface, so neither can escape its segment", () => {
  // Not expected input. This is the assertion that a malformed id cannot add
  // segments and address a different PMO, a different surface, or a route outside
  // the family altogether.
  for (const surface of PMO_SURFACES) {
    const path = pmoSurfacePath("a/b?c=d", "e/f", surface);
    assert.match(path, /^\/workspaces\/a%2Fb%3Fc%3Dd\/pmos\/e%2Ff/);
    const expectedSegments = surface === "home" ? 5 : 6; // "" / workspaces / ws / pmos / pmo [ / surface ]
    assert.equal(path.split("/").length, expectedSegments, `${surface}: encoded ids must not add path segments`);
    assert.ok(isCanonicalPmoRoutePath(path), `${surface}: an encoded id still addresses this family`);
  }
});

test("an id cannot smuggle in a different surface", () => {
  // A pmoId of "p/settings" must address the PMO literally named "p/settings",
  // not PMO "p"'s Settings screen.
  const smuggled = pmoHomePath(WS, "p/settings");
  assert.equal(smuggled, `/workspaces/${WS}/pmos/p%2Fsettings`);
  assert.deepEqual(parseCanonicalPmoRoute(smuggled), { workspaceId: WS, pmoId: "p/settings", surface: "home" });
});

test("an id cannot smuggle in a different workspace", () => {
  const smuggled = pmoHomePath(`${WS}/pmos/${OTHER_PMO}`, PMO);
  assert.deepEqual(parseCanonicalPmoRoute(smuggled), {
    workspaceId: `${WS}/pmos/${OTHER_PMO}`,
    pmoId: PMO,
    surface: "home",
  });
});

test("the legacy path builder encodes its id too", () => {
  assert.equal(legacyPmoSurfacePath("e/f", "chat"), "/pmos/e%2Ff/chat");
  assert.equal(legacyPmoSurfacePath("e/f", "home"), "/pmos/e%2Ff");
});

// ─── 3. The parser recognizes exactly the family ──────────────────────────

test("the parser recognizes all five canonical PMO surfaces", () => {
  for (const surface of PMO_SURFACES) {
    assert.deepEqual(
      parseCanonicalPmoRoute(CANONICAL[surface]),
      { workspaceId: WS, pmoId: PMO, surface },
      `${surface} must parse`,
    );
    assert.ok(isCanonicalPmoRoutePath(CANONICAL[surface]));
  }
  // Exhaustive: the surface union and the path table cannot drift apart.
  assert.deepEqual([...PMO_SURFACES].sort(), Object.keys(CANONICAL).sort());
});

test("the parser round-trips ids that need encoding", () => {
  const odd = { workspaceId: "ws with space", pmoId: "pmo/slash" };
  for (const surface of PMO_SURFACES) {
    assert.deepEqual(parseCanonicalPmoRoute(pmoSurfacePath(odd.workspaceId, odd.pmoId, surface)), {
      ...odd,
      surface,
    });
  }
});

test("a trailing slash is the same route", () => {
  assert.deepEqual(parseCanonicalPmoRoute(`${CANONICAL_ROOT}/`), { workspaceId: WS, pmoId: PMO, surface: "home" });
  assert.deepEqual(parseCanonicalPmoRoute(`${CANONICAL.chat}/`), { workspaceId: WS, pmoId: PMO, surface: "chat" });
});

test("the parser refuses anything outside the family", () => {
  for (const other of [
    "/",
    "/pmos",
    `/pmos/${PMO}`,
    `/pmos/${PMO}/chat`,
    `/pmos/${PMO}/reports`,
    `/pmos/${PMO}/settings`,
    "/workspaces",
    `/workspaces/${WS}`,
    `/workspaces/${WS}/command-center`,
    "/command-center",
    "/pm-operations",
    "/pmo-command-center",
    `/workspaces/${WS}/pmos`,
    `/workspaces/${WS}/pmos/`,
    // An unknown surface segment is not a surface. Reading it as its own parent
    // is how a nav entry lights up for a page that 404s.
    `${CANONICAL_ROOT}/overview`,
    `${CANONICAL_ROOT}/settings/danger`,
    `${CANONICAL.chat}/extra`,
    `/projects/${PMO}`,
  ]) {
    assert.equal(parseCanonicalPmoRoute(other), null, `${other} must not parse as a canonical PMO route`);
    assert.equal(isCanonicalPmoRoutePath(other), false, `${other} must not match the family`);
  }
});

test("malformed percent-escapes fail closed on every segment", () => {
  for (const malformed of [
    `/workspaces/%E0%A4%A/pmos/${PMO}`,
    `/workspaces/%E0%A4%A/pmos/${PMO}/chat`,
    `/workspaces/${WS}/pmos/%E0%A4%A/settings`,
    "/workspaces/%/pmos/%/reports",
  ]) {
    assert.equal(parseCanonicalPmoRoute(malformed), null, `${malformed} must not be guessed at`);
    assert.equal(isCanonicalPmoRoutePath(malformed), false);
  }
});

test("a blank id is not an id", () => {
  // Structurally absent…
  assert.equal(parseCanonicalPmoRoute("/workspaces//pmos/p"), null);
  assert.equal(parseCanonicalPmoRoute("/workspaces/w/pmos/"), null);
  // …and present-but-blank, which would otherwise be handed to a query as if it
  // named something.
  assert.equal(parseCanonicalPmoRoute("/workspaces/%20/pmos/p"), null);
  assert.equal(parseCanonicalPmoRoute("/workspaces/w/pmos/%20%09"), null);
  // An id that merely CONTAINS a space is a real id and is preserved verbatim.
  assert.deepEqual(parseCanonicalPmoRoute(pmoHomePath("ws 1", "pmo 2")), {
    workspaceId: "ws 1",
    pmoId: "pmo 2",
    surface: "home",
  });
});

// ─── 4. The two Command Centers stay separate predicates ──────────────────

test("the Command Center's own predicate stays narrow to one surface", () => {
  assert.ok(isPmoCommandCenterPath(CANONICAL["command-center"]));
  for (const surface of PMO_SURFACES) {
    if (surface === "command-center") continue;
    assert.equal(
      isPmoCommandCenterPath(CANONICAL[surface]),
      false,
      `${surface} is a PMO surface but it is not the PMO Command Center`,
    );
    assert.equal(parsePmoRouteFromPath(CANONICAL[surface]), null);
  }
  assert.deepEqual(parsePmoRouteFromPath(CANONICAL["command-center"]), { workspaceId: WS, pmoId: PMO });
});

test("the Workspace Command Center's helpers do not claim any PMO surface", () => {
  // isWorkspaceCommandCenterPath must NOT be widened to cover the PMO family:
  // they are different entity scopes (ADR-PMF-014 Rule 1), and that predicate is
  // load-bearing for the Workspace screen's own active state.
  for (const surface of PMO_SURFACES) {
    assert.equal(isWorkspaceCommandCenterPath(CANONICAL[surface]), false, `${surface} is not the Workspace CC`);
    assert.equal(parseWorkspaceIdFromPath(CANONICAL[surface]), null);
  }
});

test("the PMO family predicate does not claim the Workspace Command Center", () => {
  assert.equal(isCanonicalPmoRoutePath(workspaceCommandCenterPath(WS)), false);
  assert.equal(isCanonicalPmoRoutePath(WORKSPACE_COMMAND_CENTER_LEGACY_PATH), false);
});

// ─── 5. Routed PMO authority, per surface ─────────────────────────────────

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
  assert.equal(result.pmoId, null, "a refusal must not carry a PMO id");
  assert.equal(result.workspaceId, null, "a refusal must not carry a workspace id");
  assert.equal(result.readOnly, true);
};

test("the canonical pmoId stays authoritative — the verdict echoes what was asked for", () => {
  for (const requested of [PMO, OTHER_PMO]) {
    const result = decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: requested,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    });
    assert.equal(result.access, "granted");
    assert.equal(result.pmoId, requested, "PMO A must never resolve as PMO B");
    assert.equal(result.workspaceId, WS);
  }
});

test("a routed workspace that disagrees with pmos.workspace_id is DENIED on every surface", () => {
  // The caller here is a legitimate member of the PMO's real workspace; the only
  // thing wrong is the ancestry the URL asserts. Rendering anyway would serve the
  // PMO under a workspace that does not own it, and correcting the URL would leak
  // the PMO's real workspace. Since all five surfaces share one resolver, this
  // holds for all five by construction — which is the point of not re-deciding
  // ancestry per page.
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: OTHER_WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "active" },
      workspaceAccess: grantedWs(WS),
    }),
    "Workspace A must never become Workspace B",
  );
});

test("a mismatched pair is refused rather than silently corrected", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: OTHER_WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "active" },
    workspaceAccess: grantedWs(WS),
  });
  // The refusal must not hand back the real workspace, which is what a
  // "helpful" redirect to the correct URL would have to do.
  assert.equal(result.workspaceId, null);
  assert.notEqual(JSON.stringify(result).includes(WS), true, "a refusal must not disclose the real workspace");
});

test("no membership in the PMO's real workspace is denied", () => {
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

test("an absent PMO is denied with no substitute", () => {
  assertDenied(
    decideRoutedPmoAccess({ routedWorkspaceId: WS, pmoId: PMO, pmo: null, workspaceAccess: grantedWs(WS) }),
    "an absent PMO must not fall back to any other PMO",
  );
});

test("archived PMOs stay routable on every canonical surface", () => {
  const result = decideRoutedPmoAccess({
    routedWorkspaceId: WS,
    pmoId: PMO,
    pmo: { workspaceId: WS, status: "archived" },
    workspaceAccess: grantedWs(WS),
  });
  assert.equal(result.access, "archived", "archived is a read-only STATE, not a 'not found'");
  assert.equal(result.pmoId, PMO, "canonical identity is stable across archival");
  assert.equal(result.workspaceId, WS);
  assert.equal(result.readOnly, true);
});

test("an archived PMO in an unreachable workspace is still denied", () => {
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

test("an archived PMO's ancestry claim is checked just as strictly", () => {
  assertDenied(
    decideRoutedPmoAccess({
      routedWorkspaceId: OTHER_WS,
      pmoId: PMO,
      pmo: { workspaceId: WS, status: "archived" },
      workspaceAccess: archivedWs(WS),
    }),
    "archival does not relax the ancestry rule",
  );
});

// ─── 6. Every canonical surface goes through the routed resolver ──────────

test("every canonical PMO page authorizes the URL's PMO id, passing both segments", () => {
  for (const surface of PMO_SURFACES) {
    assert.match(
      canonicalSources[surface],
      /resolveRoutedPmo\(user\.id, requestedWorkspaceId, requestedPmoId\)/,
      `${surface} must authorize through the routed resolver`,
    );
    assert.match(canonicalSources[surface], /access\.access === "denied"/, `${surface} must handle the refusal`);
  }
});

test("no canonical PMO surface can have its identity decided by a preferred workspace", () => {
  for (const [name, rawSource] of [
    ...(PMO_SURFACES.map((surface) => [surface, canonicalSources[surface]]) as [string, string][]),
    ["resolver", resolver],
    ["paths", paths],
    ["tab nav", tabNav],
  ]) {
    // Comments stripped: these modules explain WHY each fallback resolver is
    // absent, which means naming them. A check that cannot tell an explanation
    // from a call would push the reasoning out of the code.
    const source = withoutComments(rawSource);
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, `${name}: the URL is the scope here, not the cookie`);
    assert.doesNotMatch(source, /resolveCanonicalWorkspace/, `${name}: no falling-back resolver`);
    assert.doesNotMatch(source, /ensureUserWorkspace/, `${name}`);
    assert.doesNotMatch(source, /ensureDefaultPmo/, `${name}: a PMO is never auto-created to satisfy a route`);
  }
});

test("every canonical surface reads its data with the resolver's workspace, not the URL's", () => {
  // `requestedWorkspaceId` is an asserted claim; `access.workspaceId` is
  // `pmos.workspace_id`. Using the claim for a query would work only because the
  // resolver proved them equal — and would break silently the moment someone
  // relaxed that check.
  for (const surface of PMO_SURFACES) {
    const body = canonicalSources[surface].slice(canonicalSources[surface].indexOf("const access ="));
    assert.doesNotMatch(
      body,
      /eq\("workspace_id", requestedWorkspaceId\)/,
      `${surface} must not query by the routed segment`,
    );
    assert.match(
      canonicalSources[surface],
      /const \{ workspaceId, pmoId \} = access;/,
      `${surface} must take both ids from the verdict`,
    );
  }
});

test("all five canonical surfaces preserve PMO identity in what they render", () => {
  // Each screen is scoped by BOTH ids on every read, so no surface can show a
  // sibling PMO's data or another workspace's rows.
  for (const surface of PMO_SURFACES) {
    const source = canonicalSources[surface];
    assert.match(source, /workspaceId, pmo(Id|\.id)/, `${surface} must carry both ids into its reads`);
    assert.match(
      source,
      /<PmoTabNav workspaceId=\{workspaceId\} pmoId=\{pmo\.id\}|pmoCommandCenterBreadcrumb/,
      `${surface} must pass both ids into its navigation`,
    );
  }
});

test("canonical Home, Chat, Reports and Settings each scope their PMO lookup by both ids", () => {
  for (const surface of ["home", "chat", "reports", "settings"] as const) {
    assert.match(canonicalSources[surface], /getPmoById\(workspaceId, pmoId\)/, `${surface} must scope its lookup`);
  }
});

test("canonical Reports keeps the shipped report data sources", () => {
  // Route/scope identity is all that changed. Replacing the data sources, or
  // folding them into the Command Center's rollup, was explicitly out of scope.
  const reports = canonicalSources.reports;
  assert.match(reports, /\.from\("projects"\)/);
  assert.match(reports, /\.from\("raid_items"\)/);
  assert.match(reports, /item\.status === "closed" \|\| item\.status === "resolved"/);
  assert.match(reports, /"\/pmo-executive-reporting"/);
  assert.doesNotMatch(reports, /pmo-command-center-rollup/, "Reports must not become a Command Center panel");
});

test("canonical Chat mounts the same PMO-scoped conversation as before", () => {
  const chat = canonicalSources.chat;
  const panel = chat.slice(chat.indexOf("<ContextChatPanel"), chat.indexOf("/>", chat.indexOf("<ContextChatPanel")));
  assert.match(panel, /contextType="pmo"/);
  assert.match(panel, /pmoId=\{pmo\.id\}/);
  // The scope the panel is mounted with carries the PMO id ONLY. Its mutation
  // (`POST /api/context-chat`) derives the conversation's workspace from
  // `pmos.workspace_id` server-side, so no workspace travels through the client
  // to be substituted, and none is inferred from a cookie.
  assert.doesNotMatch(panel, /workspaceId/, "the chat panel takes no workspace to get wrong");
  const contextChat = read("src/app/api/context-chat/route.ts");
  assert.match(contextChat, /getPmoWorkspaceId\(pmoId\)/, "the pmo scope's workspace comes from the PMO row");
});

test("canonical Settings mutations are authorized against the PMO's own workspace", () => {
  // Both mutation routes behind this screen derive the workspace from the PMO
  // row, then require pm-or-above in THAT workspace. A caller cannot mutate PMO P
  // through workspace W2 by editing the page URL, because the URL is not what the
  // role check reads.
  for (const [name, source] of [
    ["/api/pmos/[id]", pmoMutationRoute],
    ["/api/pmos/[id]/duplicate", pmoDuplicateRoute],
  ] as const) {
    assert.match(source, /getPmoWorkspaceId\(pmoId\)/, `${name} must derive the workspace from the PMO row`);
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, `${name} must not scope a mutation by cookie`);
    assert.match(source, /requireWorkspaceMinimumRole\(/, `${name} must keep its role gate`);
    assert.match(source, /"pm"/, `${name} must keep pm-or-above`);
  }
  // The role vocabulary is unchanged — no "PMO Manager" was invented.
  for (const source of [pmoMutationRoute, pmoDuplicateRoute, canonicalSources.settings]) {
    assert.doesNotMatch(source, /PMO Manager|pmo_manager|pmoManager/);
  }
});

test("no canonical PMO surface mutates through a service-role client of its own", () => {
  for (const surface of PMO_SURFACES) {
    assert.doesNotMatch(
      canonicalSources[surface],
      /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/,
      `${surface} must not open its own privileged boundary`,
    );
  }
});

// ─── 7. Legacy routes are resolvers, not second screens ───────────────────

test("each legacy PMO route redirects to its canonical counterpart", () => {
  const expected: Record<LegacyPmoSurface, string> = {
    home: "pmoHomePath(access.workspaceId, access.pmoId)",
    chat: "pmoChatPath(access.workspaceId, access.pmoId)",
    reports: "pmoReportsPath(access.workspaceId, access.pmoId)",
    settings: "pmoSettingsPath(access.workspaceId, access.pmoId)",
  };
  for (const surface of LEGACY_PMO_SURFACES) {
    assert.match(
      legacySources[surface],
      new RegExp(`redirect\\(${expected[surface].replace(/[()[\]{}.*+?^$|\\]/g, "\\$&")}\\)`),
      `/pmos/[pmoId]${surface === "home" ? "" : `/${surface}`} must redirect to canonical ${surface}`,
    );
  }
});

test("the legacy→canonical mapping preserves the surface and the PMO", () => {
  // Stated as data so the four redirects above are checkable against one table
  // rather than against each other.
  const canonicalFor: Record<LegacyPmoSurface, (w: string, p: string) => string> = {
    home: pmoHomePath,
    chat: pmoChatPath,
    reports: pmoReportsPath,
    settings: pmoSettingsPath,
  };
  for (const surface of LEGACY_PMO_SURFACES) {
    const legacy = legacyPmoSurfacePath(PMO, surface);
    const canonical = canonicalFor[surface](WS, PMO);
    assert.equal(canonical, CANONICAL[surface]);
    assert.equal(parseCanonicalPmoRoute(canonical)!.surface, surface, `${legacy} must land on the same surface`);
    assert.equal(parseCanonicalPmoRoute(canonical)!.pmoId, PMO, `${legacy} must land on the same PMO`);
  }
});

test("the legacy resolver derives W from pmos.workspace_id and from nothing else", () => {
  assert.match(resolver, /export async function resolveLegacyPmoRoute/);
  for (const [name, rawSource] of [
    ["resolver", resolver],
    ...(LEGACY_PMO_SURFACES.map((surface) => [`legacy ${surface}`, legacySources[surface]]) as [string, string][]),
  ]) {
    const source = withoutComments(rawSource);
    assert.doesNotMatch(source, /resolvePreferredWorkspace/, `${name}: a cookie must not choose the destination`);
    assert.doesNotMatch(source, /resolveCanonicalWorkspace/, `${name}`);
    assert.doesNotMatch(source, /ensureUserWorkspace/, `${name}`);
    assert.doesNotMatch(source, /ensureDefaultPmo/, `${name}`);
  }
  // The redirect target can only be the resolver's own verdict.
  for (const surface of LEGACY_PMO_SURFACES) {
    assert.match(legacySources[surface], /redirect\(pmo\w+Path\(access\.workspaceId, access\.pmoId\)\)/);
  }
});

test("a legacy PMO URL cannot resolve the same id to two different workspaces", () => {
  // `resolveLegacyPmoRoute` passes the PMO's own workspace as the routed one, so
  // the ancestry check is satisfied by construction and there is no second input
  // that could vary between callers. Proven on the decision function: whatever
  // the PMO's parent is, that is the verdict's workspace.
  for (const parent of [WS, OTHER_WS]) {
    const result = decideRoutedPmoAccess({
      routedWorkspaceId: parent,
      pmoId: PMO,
      pmo: { workspaceId: parent, status: "active" },
      workspaceAccess: grantedWs(parent),
    });
    assert.equal(result.access, "granted");
    assert.equal(result.workspaceId, parent, "the destination follows the PMO, not the caller");
  }
});

test("legacy routes hold no second copy of any PMO screen", () => {
  // A strangler seam, not eight screens. If one of these files started rendering
  // a portfolio, a chat panel or an admin form again, there would be two
  // implementations of that surface to keep in sync.
  for (const surface of LEGACY_PMO_SURFACES) {
    const source = legacySources[surface];
    assert.match(source, /redirect\(/, `legacy ${surface} must redirect`);
    for (const screenPart of [
      /PmoTabNav/,
      /ContextChatPanel/,
      /PmoAdminClient/,
      /listPmosWithProjects/,
      /getPmoById/,
      /createSupabaseServerClient/,
      /\.from\(/,
      /<section/,
      /<h1/,
    ]) {
      assert.doesNotMatch(source, screenPart, `legacy ${surface} must not re-implement the screen (${screenPart})`);
    }
  }
});

test("missing and unauthorized legacy PMO routes are indistinguishable", () => {
  // One refusal component, shared with the canonical surfaces, reached from the
  // single `denied` verdict that absent / deleted / unauthorized / ancestry-
  // mismatched all collapse into. There is no branch here that could say more
  // about one case than another.
  for (const surface of LEGACY_PMO_SURFACES) {
    const source = legacySources[surface];
    assert.equal(source.match(/access\.access === "denied"/g)?.length, 1, `legacy ${surface}: one refusal branch`);
    assert.match(source, /return <PmoNotAvailable \/>;/);
    assert.doesNotMatch(source, /notFound\(\)/, "a distinct 404 path would be a second, distinguishable reply");
  }
  assert.match(routeStates, /does not exist or is not one you have access to/);
  // The refusal carries no identity: not the name, not the status, not the ids.
  assert.doesNotMatch(routeStates, /\{pmo\.|pmoId|workspaceId/);
});

test("the legacy resolver is not a PMO existence oracle", () => {
  // Absent and unauthorized both reach `denied`, and `denied` carries nothing.
  for (const pmo of [null, { workspaceId: WS, status: "active" as const }]) {
    const result = decideRoutedPmoAccess({
      routedWorkspaceId: WS,
      pmoId: PMO,
      pmo,
      workspaceAccess: pmo ? deniedWs : grantedWs(WS),
    });
    assertDenied(result, "absent and unauthorized must be the same answer");
  }
});

test("legacy routes reuse the registered privileged resolver instead of adding four boundaries", () => {
  for (const surface of LEGACY_PMO_SURFACES) {
    assert.match(legacySources[surface], /resolveLegacyPmoRoute/, `legacy ${surface} must use the shared resolver`);
    assert.doesNotMatch(
      legacySources[surface],
      /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/,
      `legacy ${surface} must not create its own privileged client`,
    );
  }
  // One privileged read site for PMO ancestry, shared by both resolvers.
  assert.equal(resolver.match(/createSupabaseServiceRoleClient\(/g)?.length, 1);
  assert.match(resolver, /async function readPmoAncestry/);
  const registry = read("src/lib/security/privileged-access-registry.ts");
  assert.match(registry, /"src\/lib\/pmos\/routed-pmo\.ts"/);
  assert.match(registry, /resolveLegacyPmoRoute/, "the widened purpose must be registered");
});

test("the legacy resolver reads no more of the PMO row than ancestry", () => {
  assert.match(resolver, /\.select\("workspace_id, status"\)/);
  assert.equal(resolver.match(/\.from\("pmos"\)/g)?.length, 1);
});

test("no legacy route redirects to itself", () => {
  // A redirect from `/pmos/P` to `/pmos/P` would loop forever. The canonical
  // family and the legacy family are disjoint by construction: one is
  // workspace-rooted, the other is not.
  for (const surface of LEGACY_PMO_SURFACES) {
    const legacy = legacyPmoSurfacePath(PMO, surface);
    const canonical = CANONICAL[surface];
    assert.notEqual(legacy, canonical);
    assert.equal(isCanonicalPmoRoutePath(legacy), false, `${legacy} must not be its own destination`);
    assert.ok(isCanonicalPmoRoutePath(canonical));
    assert.doesNotMatch(canonical, /^\/pmos\//, `${canonical} must not re-enter the legacy resolver`);
  }
});

// ─── 8. Tab navigation and breadcrumbs stay inside the family ─────────────

test("PmoTabNav builds every tab from the canonical family helper", () => {
  assert.match(tabNav, /pmoSurfacePath\(workspaceId, pmoId, tab\.surface\)/);
  assert.doesNotMatch(tabNav, /"\/pmos\//, "no tab may point into legacy PMO space");
  assert.doesNotMatch(tabNav, /"\/workspaces\//, "no tab may re-type the path as a literal");
});

test("PmoTabNav covers all five canonical surfaces and nothing else", () => {
  const surfaces = [...tabNav.matchAll(/surface: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(surfaces.sort(), [...PMO_SURFACES].sort());
  // And every one of them resolves back to a real canonical route.
  for (const surface of surfaces) {
    assert.ok(isCanonicalPmoRoutePath(pmoSurfacePath(WS, PMO, surface as PmoSurface)));
  }
});

test("every PMO tab label that says Command Center says which entity's", () => {
  // ADR-PMF-014 Rule 1, checked where the labels live.
  const copy = withoutComments(tabNav);
  const bare = /(?<!PMO |Workspace |Project |Portfolio |Program |Enterprise )Command Center/.exec(copy);
  assert.equal(bare, null, `bare "Command Center" in: ${copy.slice(Math.max(0, (bare?.index ?? 0) - 60), (bare?.index ?? 0) + 40)}`);
  assert.match(copy, /label: "PMO Command Center"/);
});

test("the PMO Command Center breadcrumb's PMO ancestor is canonical Home", () => {
  // The seam PR #606 documented and deliberately left open: its middle node
  // pointed at the legacy `/pmos/[pmoId]`.
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery", pmoId: PMO });
  assert.equal(trail[1].href, pmoHomePath(WS, PMO));
  assert.equal(trail[1].href, CANONICAL.home);
  assert.doesNotMatch(trail[1].href!, /^\/pmos\//, "the ancestor must not re-enter legacy space");
  assert.doesNotMatch(trail[1].href!, /command-center/, "an ancestor is a Home, never a Command Center");
  assert.equal(trail[2].href, null, "the Command Center is still the terminal node");
});

test("the breadcrumb's PMO ancestor carries the workspace it was given", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: OTHER_WS, pmoName: "D", pmoId: OTHER_PMO });
  assert.equal(trail[1].href, pmoHomePath(OTHER_WS, OTHER_PMO));
});

test("the canonical surfaces link to each other, never back into legacy space", () => {
  for (const surface of PMO_SURFACES) {
    const code = withoutComments(canonicalSources[surface]);
    assert.doesNotMatch(code, /href=\{?`?\/pmos\/\$/, `${surface} must not build a legacy PMO link`);
    assert.doesNotMatch(code, /legacyPmoHomePath|legacyPmoSurfacePath/, `${surface} must not use a legacy builder`);
  }
});

test("the PMO list and sidebar send users straight into canonical PMO Home", () => {
  // These are entry points into the family, not part of it. They already hold the
  // authoritative workspace — it is a column on each PMO row — so they can link
  // canonically without a redirect hop and without consulting shell context.
  for (const file of [
    "src/components/pmfreak/pmos/pmo-admin-client.tsx",
    "src/components/pmfreak/navigation/sidebar-pmo-tree.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /pmoHomePath\(pmo\.workspace_id, pmo\.id\)/, `${file} must link canonically`);
    assert.doesNotMatch(source, /`\/pmos\/\$\{pmo\.id\}/, `${file} must not build a legacy PMO link`);
    assert.doesNotMatch(source, /workspaceId\}\/pmos/, `${file} must not re-type the path as a literal`);
  }
});

// ─── 9. Navigation active state ───────────────────────────────────────────

test("the entire canonical PMO family activates PMOs, not Workspaces", () => {
  for (const surface of PMO_SURFACES) {
    assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, CANONICAL[surface]), `${surface} must activate PMOs`);
    assert.equal(
      navEntryMatchesPathname("/workspaces", CANONICAL[surface]),
      false,
      `${surface} must not also activate Workspaces`,
    );
    assert.equal(
      navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL[surface]),
      false,
      `${surface} must not activate the Workspace Command Center`,
    );
  }
});

test("Workspace Command Center active-state is unchanged", () => {
  const workspaceCanonical = workspaceCommandCenterPath(WS);
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, workspaceCanonical));
  assert.equal(navEntryMatchesPathname("/workspaces", workspaceCanonical), false);
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, "/command-center"));
});

test("every other nav entry keeps plain prefix semantics", () => {
  assert.ok(navEntryMatchesPathname("/workspaces", "/workspaces"));
  assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, "/pmos"));
  assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, `/pmos/${PMO}`));
  assert.ok(navEntryMatchesPathname("/projects", "/projects/abc"));
  assert.equal(navEntryMatchesPathname("/projects", "/portfolio"), false);
});

// ─── 10. Shell, route policy and session continuation ─────────────────────

test("the protected layout derives workspace context from every canonical PMO surface", () => {
  // The layout runs BEFORE the page authorizes anything, so without this the
  // shell and the onboarding gate answer from the preferred-workspace cookie: a
  // shared link to a PMO in workspace B renders A's navigation and can be
  // bounced by A's onboarding state. One parser, five surfaces.
  assert.match(protectedLayout, /parseCanonicalPmoRoute\([\s\S]*?\)\?\.workspaceId/);
  assert.match(protectedLayout, /parseWorkspaceIdFromPath\(routedHeaders\.get\("x-pathname"\)/);
  assert.match(protectedLayout, /resolveRoutedWorkspace\(user\.id, routedWorkspaceId\)/);
  // Proven behaviourally: the parser the layout calls answers for all five.
  for (const surface of PMO_SURFACES) {
    assert.equal(parseCanonicalPmoRoute(CANONICAL[surface])?.workspaceId, WS, `${surface} must yield its workspace`);
  }
});

test("the layout's PMO hint cannot widen access", () => {
  // It is authorized by `resolveRoutedWorkspace`, which has no fallback, and the
  // parser fails closed on anything malformed — so an unparseable or unauthorized
  // path leaves the preferred workspace in place and the page renders its own
  // refusal.
  assert.equal(parseCanonicalPmoRoute("/workspaces/%E0%A4%A/pmos/p"), null);
  assert.match(protectedLayout, /routedAccess && routedAccess\.access !== "denied"/);
});

test("every canonical PMO surface is a protected, workspace-contextual page", () => {
  for (const surface of PMO_SURFACES) {
    assert.ok(isProtectedPageRoute(CANONICAL[surface]), `${surface} must be protected`);
    assert.equal(getRouteAccessPolicy(CANONICAL[surface]), "workspace-contextual", `${surface} policy`);
  }
});

test("the legacy PMO routes stay protected too", () => {
  for (const surface of LEGACY_PMO_SURFACES) {
    assert.ok(isProtectedPageRoute(legacyPmoSurfacePath(PMO, surface)));
  }
});

test("a canonical PMO deep link on any surface survives an expired session", () => {
  for (const surface of PMO_SURFACES) {
    assert.ok(isSafeContinuationRoute(CANONICAL[surface]), `${surface} must be a safe continuation route`);
  }
});

test("nothing about this slice widened the continuation allowlist", () => {
  for (const blocked of ["/api/anything", "/login", "/_next/static", "/debug/x"]) {
    assert.equal(isSafeContinuationRoute(blocked), false, `${blocked} must stay blocked`);
  }
  assert.equal(isSafeContinuationRoute("//evil.example.com"), false);
});

// ─── 11. PM Operations stays a separate surface ───────────────────────────

test("/pmo-command-center still redirects ONLY to /pm-operations", () => {
  assert.match(pmoCommandCenterLegacyRoute, /redirect\(PM_OPERATIONS_PATH\)/);
  assert.equal(pmoCommandCenterLegacyRoute.match(/redirect\(/g)?.length, 1, "one redirect, one destination");
  assert.doesNotMatch(
    pmoCommandCenterLegacyRoute,
    /pmo-command-center-paths|pmo-paths/,
    "it must not be repointed at any PMO surface",
  );
  assert.doesNotMatch(pmoCommandCenterLegacyRoute, /pmoId/, "it takes no PMO id and never did");
});

test("/pm-operations remains distinct and takes no pmoId", () => {
  assert.doesNotMatch(pmOperationsScreen, /pmoId/, "that surface is workspace-scoped internal PM ops");
  assert.doesNotMatch(pmOperationsScreen, /pmo-paths/, "it is not a member of the PMO route family");
  for (const path of [PM_OPERATIONS_PATH, PM_OPERATIONS_LEGACY_PATH]) {
    assert.equal(isCanonicalPmoRoutePath(path), false, `${path} is not a canonical PMO route`);
    assert.equal(isPmoCommandCenterPath(path), false, `${path} is not the PMO Command Center`);
    assert.equal(parseCanonicalPmoRoute(path), null);
  }
});

test("no PMO surface reaches into the internal PM-ops surface", () => {
  for (const surface of PMO_SURFACES) {
    const code = withoutComments(canonicalSources[surface]);
    assert.doesNotMatch(code, /pm-operations/, `${surface}: no import of, or link to, the internal dashboard`);
    assert.doesNotMatch(code, /pmo_command_center_snapshots/, `${surface}`);
  }
});

// ─── 12. No schema, no migration ──────────────────────────────────────────

test("this slice introduces no schema and no migration", () => {
  const sources = [paths, resolver, routeStates, tabNav, ...PMO_SURFACES.map((s) => canonicalSources[s]),
    ...LEGACY_PMO_SURFACES.map((s) => legacySources[s])];
  for (const source of sources) {
    assert.doesNotMatch(withoutComments(source), /create\s+table|alter\s+table|drop\s+table|\.sql\b/i);
  }
});

test("the route family reads only the tables the shipped screens already read", () => {
  const tables = new Set(
    PMO_SURFACES.flatMap((surface) => [...canonicalSources[surface].matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])),
  );
  assert.deepEqual([...tables].sort(), ["pmos", "projects", "raid_items"]);
  // And no legacy resolver reads anything at all.
  for (const surface of LEGACY_PMO_SURFACES) {
    assert.doesNotMatch(legacySources[surface], /\.from\("/, `legacy ${surface} must read no table directly`);
  }
});

test("no new PMO membership or role primitive was invented", () => {
  const sources = [paths, resolver, routeStates, tabNav, pmoMutationRoute, pmoDuplicateRoute,
    ...PMO_SURFACES.map((s) => canonicalSources[s]), ...LEGACY_PMO_SURFACES.map((s) => legacySources[s])];
  for (const source of sources) {
    // Comments stripped for the same reason as above: `routed-pmo.ts` records
    // that no `pmo_members` table exists anywhere in the schema, which is the
    // evidence for this rule rather than a violation of it (ADR-PMF-003 ratifies
    // no PMO-level role).
    assert.doesNotMatch(withoutComments(source), /pmo_members|pmo_memberships|pmoRole|pmo_role/);
  }
});
