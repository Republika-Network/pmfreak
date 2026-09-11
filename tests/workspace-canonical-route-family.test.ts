import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WORKSPACES_NAV_HREF,
  WORKSPACE_SURFACES,
  isCanonicalWorkspaceRoutePath,
  parseCanonicalWorkspaceRoute,
  workspaceCommandCenterPath,
  workspaceHomePath,
  workspaceSettingsPath,
  workspaceSurfacePath,
  type WorkspaceSurface,
} from "../src/lib/workspaces/workspace-paths";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  isWorkspaceCommandCenterPath,
  navEntryMatchesPathname,
  parseWorkspaceIdFromPath,
  workspaceCommandCenterPath as commandCenterPathReExport,
} from "../src/lib/workspace/command-center-paths";
import { pmoCommandCenterBreadcrumb } from "../src/lib/pmos/pmo-command-center-paths";
import { isCanonicalPmoRoutePath, pmoHomePath, pmoSurfacePath, PMO_SURFACES, PMOS_NAV_HREF } from "../src/lib/pmos/pmo-paths";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const PMO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const CANONICAL: Record<WorkspaceSurface, string> = {
  home: `/workspaces/${WS}`,
  "command-center": `/workspaces/${WS}/command-center`,
  settings: `/workspaces/${WS}/settings`,
};

/**
 * Source is read with its COMMENTS STRIPPED.
 *
 * Every assertion below that reads a route file is a claim about what the code
 * does — "Workspace Home does not mount `CommandCenterClient`", "no canonical
 * route calls `ensureUserWorkspace`". Those files explain themselves at length,
 * and several of them name the very symbols and screens they exist to stay away
 * from. Matching against prose would make a test pass or fail on a sentence,
 * which is both a false negative waiting to happen and a false positive today.
 * User-visible copy lives in JSX and survives the strip, so the tests that pin
 * what a screen SAYS are unaffected.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = (path: string) => stripComments(readFileSync(path, "utf8"));

const ROUTE_FILES: Record<WorkspaceSurface, string> = {
  home: "src/app/(protected)/workspaces/[workspaceId]/page.tsx",
  "command-center": "src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx",
  settings: "src/app/(protected)/workspaces/[workspaceId]/settings/page.tsx",
};

const home = read(ROUTE_FILES.home);
const settings = read(ROUTE_FILES.settings);
const commandCenter = read(ROUTE_FILES["command-center"]);
const index = read("src/app/(protected)/workspaces/page.tsx");
const legacySingular = read("src/app/(protected)/workspace/page.tsx");
const proxy = read("src/proxy.ts");
const protectedLayout = read("src/app/(protected)/layout.tsx");
const tabNav = read("src/app/(protected)/workspaces/[workspaceId]/workspace-tab-nav.tsx");
const banner = read("src/components/pmfreak/workspace/workspace-context-banner.tsx");
const routeStates = read("src/components/pmfreak/workspace/workspace-route-states.tsx");

// ─── 1. The canonical paths ───────────────────────────────────────────────

test("the family is exactly the three routes the canonical route map names", () => {
  assert.deepEqual([...WORKSPACE_SURFACES], ["home", "command-center", "settings"]);
  assert.equal(workspaceHomePath(WS), `/workspaces/${WS}`);
  assert.equal(workspaceCommandCenterPath(WS), `/workspaces/${WS}/command-center`);
  assert.equal(workspaceSettingsPath(WS), `/workspaces/${WS}/settings`);
});

test("the Command Center path is unchanged by the family refactor", () => {
  // PR #604's route must be byte-identical after moving its definition into the
  // family module — a "refactor" that moves a shipped URL is a migration.
  assert.equal(commandCenterPathReExport(WS), `/workspaces/${WS}/command-center`);
  assert.equal(commandCenterPathReExport, workspaceCommandCenterPath, "one definition, re-exported — not a second copy");
  assert.ok(isWorkspaceCommandCenterPath(CANONICAL["command-center"]));
  // And its query hand-off still works: dropping `from=onboarding` or
  // `projectId` silently downgrades the guided first experience.
  assert.equal(
    workspaceCommandCenterPath(WS, { projectId: "p1", from: "onboarding" }),
    `${CANONICAL["command-center"]}?projectId=p1&from=onboarding`,
  );
  assert.equal(workspaceCommandCenterPath(WS, { error: null, briefGeneration: undefined, from: "" }), CANONICAL["command-center"]);
});

test("every surface is rooted at its own workspace", () => {
  for (const surface of WORKSPACE_SURFACES) {
    assert.equal(workspaceSurfacePath(WS, surface), CANONICAL[surface]);
    assert.ok(CANONICAL[surface].startsWith(`/workspaces/${WS}`), `${surface} must name its workspace`);
  }
});

// ─── 2. Ids are encoded, and an encoded id cannot add segments ────────────

test("the workspace id is encoded, never interpolated raw", () => {
  const path = workspaceHomePath("a/b?c=d");
  assert.equal(path, "/workspaces/a%2Fb%3Fc%3Dd");
  assert.equal(path.split("/").length, 3, "an encoded id must not add path segments");
});

test("an id cannot smuggle a second segment onto any surface", () => {
  // Without encoding, `w/settings` on Home would address Workspace Settings, and
  // `w/command-center` would address a Command Center the caller never asked for.
  for (const surface of WORKSPACE_SURFACES) {
    const smuggled = workspaceSurfacePath("w/settings", surface);
    assert.ok(smuggled.startsWith("/workspaces/w%2Fsettings"), `${surface} leaked a segment: ${smuggled}`);
    const parsed = parseCanonicalWorkspaceRoute(smuggled);
    assert.equal(parsed?.workspaceId, "w/settings", "the id round-trips as itself");
    assert.equal(parsed?.surface, surface, "and still names the surface that was asked for");
  }
});

test("an id cannot smuggle its way out of the workspace family entirely", () => {
  const smuggled = workspaceHomePath(`${WS}/pmos/${PMO}`);
  assert.equal(isCanonicalPmoRoutePath(smuggled), false, "an encoded id must not become a PMO route");
  assert.equal(parseCanonicalWorkspaceRoute(smuggled)?.surface, "home");
});

// ─── 3. The parser recognizes the family, and only the family ─────────────

test("the parser recognizes all three canonical surfaces", () => {
  for (const surface of WORKSPACE_SURFACES) {
    assert.deepEqual(parseCanonicalWorkspaceRoute(CANONICAL[surface]), { workspaceId: WS, surface });
    assert.ok(isCanonicalWorkspaceRoutePath(CANONICAL[surface]));
  }
});

test("a trailing slash is the same route", () => {
  assert.deepEqual(parseCanonicalWorkspaceRoute(`/workspaces/${WS}/`), { workspaceId: WS, surface: "home" });
  assert.deepEqual(parseCanonicalWorkspaceRoute(`/workspaces/${WS}/settings/`), { workspaceId: WS, surface: "settings" });
});

test("the parser decodes the id it returns", () => {
  assert.equal(parseCanonicalWorkspaceRoute("/workspaces/a%2Fb")?.workspaceId, "a/b");
  assert.equal(parseCanonicalWorkspaceRoute("/workspaces/a%2Fb/settings")?.workspaceId, "a/b");
});

test("everything adjacent to the family is refused, not truncated to its prefix", () => {
  for (const outside of [
    "/workspaces",
    "/workspaces/",
    "/workspace",
    "/command-center",
    `/workspaces/${WS}/pmos`,
    `/workspaces/${WS}/unknown-surface`,
    `/workspaces/${WS}/command-center/extra`,
    `/workspaces/${WS}/settings/members`,
    "/workspacesomething/x",
  ]) {
    assert.equal(parseCanonicalWorkspaceRoute(outside), null, `${outside} is not a canonical Workspace route`);
    assert.equal(isCanonicalWorkspaceRoutePath(outside), false);
  }
});

test("the PMO family nests under this one and is never read as a Workspace route", () => {
  // The regression this guards: a parser that truncated to its prefix would make
  // every PMO surface look like a Workspace surface one level up, which is how a
  // PMO page lights up Workspace navigation and resolves the wrong layout scope.
  for (const surface of PMO_SURFACES) {
    const path = pmoSurfacePath(WS, PMO, surface);
    assert.equal(parseCanonicalWorkspaceRoute(path), null, `${path} is a PMO route`);
    assert.equal(isCanonicalWorkspaceRoutePath(path), false);
    assert.ok(isCanonicalPmoRoutePath(path), "and it must still be recognized as one");
  }
});

// ─── 4. Malformed encodings fail closed ───────────────────────────────────

test("a malformed percent-escape is refused rather than thrown or guessed", () => {
  for (const malformed of [
    "/workspaces/%E0%A4%A",
    "/workspaces/%E0%A4%A/settings",
    "/workspaces/%/command-center",
    "/workspaces/%zz",
  ]) {
    assert.equal(parseCanonicalWorkspaceRoute(malformed), null, `${malformed} must fail closed`);
    assert.equal(parseWorkspaceIdFromPath(malformed), null);
  }
});

test("an empty or whitespace-only id names no workspace", () => {
  assert.equal(parseCanonicalWorkspaceRoute("/workspaces//settings"), null);
  assert.equal(parseCanonicalWorkspaceRoute("/workspaces/%20"), null);
  assert.equal(parseCanonicalWorkspaceRoute("/workspaces/%20%09/command-center"), null);
});

// ─── 5. The Command Center's narrowing still answers for one surface ──────

test("the Command Center's own parser answers for its surface and no other", () => {
  assert.equal(parseWorkspaceIdFromPath(CANONICAL["command-center"]), WS);
  assert.equal(parseWorkspaceIdFromPath(CANONICAL.home), null, "Home is not the Command Center");
  assert.equal(parseWorkspaceIdFromPath(CANONICAL.settings), null, "Settings is not the Command Center");
  assert.equal(isWorkspaceCommandCenterPath(CANONICAL.home), false);
  assert.equal(isWorkspaceCommandCenterPath(CANONICAL.settings), false);
});

test("the family module owns the only pattern — no competing regex survives", () => {
  const ccPaths = read("src/lib/workspace/command-center-paths.ts");
  assert.doesNotMatch(ccPaths, /\/\^\\\/workspaces/, "the Command Center module must not re-declare the route pattern");
  assert.match(ccPaths, /from "@\/lib\/workspaces\/workspace-paths"/);
  const family = read("src/lib/workspaces/workspace-paths.ts");
  assert.equal(
    (family.match(/\/\^\\\/workspaces/g) ?? []).length,
    1,
    "the family must be recognized by exactly one regex",
  );
});

// ─── 6. Navigation: one coherent Workspace identity, no PMO bleed ─────────

test("Workspace Home and Settings activate the Workspaces nav entry", () => {
  assert.ok(navEntryMatchesPathname(WORKSPACES_NAV_HREF, CANONICAL.home));
  assert.ok(navEntryMatchesPathname(WORKSPACES_NAV_HREF, CANONICAL.settings));
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL.home), false);
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL.settings), false);
});

test("the Workspace Command Center's nav identity is unchanged by this slice", () => {
  // PR #604's rule: the deeper, more specific entry wins, so the canonical
  // Command Center lights up "Command Center" and NOT "Workspaces".
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL["command-center"]));
  assert.equal(navEntryMatchesPathname(WORKSPACES_NAV_HREF, CANONICAL["command-center"]), false);
});

test("PMO routes still activate PMOs, never Workspaces, after the family landed", () => {
  for (const surface of PMO_SURFACES) {
    const path = pmoSurfacePath(WS, PMO, surface);
    assert.ok(navEntryMatchesPathname(PMOS_NAV_HREF, path), `${surface} must activate PMOs`);
    assert.equal(navEntryMatchesPathname(WORKSPACES_NAV_HREF, path), false, `${surface} must not activate Workspaces`);
    assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, path), false);
  }
});

test("the three Workspace surfaces share one section nav built from the family", () => {
  for (const surface of WORKSPACE_SURFACES) {
    assert.match(tabNav, new RegExp(`surface: "${surface}"`), `the tab nav must offer ${surface}`);
  }
  assert.match(tabNav, /workspaceSurfacePath\(workspaceId, tab\.surface\)/);
  assert.doesNotMatch(tabNav, /"\/workspaces\//, "no tab may re-type the path as a literal");
  // ADR-PMF-014 Rule 1/3: the phrase always names its entity.
  assert.match(tabNav, /label: "Workspace Command Center"/);
  for (const src of [home, settings]) {
    assert.match(src, /<WorkspaceTabNav workspaceId=\{workspaceId\}/);
  }
});

// ─── 7. Route registration and deep links ────────────────────────────────

test("every canonical Workspace route is a protected, workspace-contextual page", () => {
  for (const surface of WORKSPACE_SURFACES) {
    assert.ok(isProtectedPageRoute(CANONICAL[surface]), `${surface} must be protected`);
    assert.equal(getRouteAccessPolicy(CANONICAL[surface]), "workspace-contextual");
  }
});

test("a canonical deep link to any Workspace surface survives an expired session", () => {
  for (const surface of WORKSPACE_SURFACES) {
    assert.ok(isSafeContinuationRoute(CANONICAL[surface]), `${surface} must be a safe continuation`);
  }
  assert.ok(isSafeContinuationRoute(WORKSPACE_COMMAND_CENTER_LEGACY_PATH), "legacy links must keep working");
});

test("widening the family did not open a blocked prefix", () => {
  for (const blocked of ["/api/anything", "/login", "/_next/static", "/debug/x", "//evil.example.com"]) {
    assert.equal(isSafeContinuationRoute(blocked), false, `${blocked} must stay blocked`);
  }
});

// ─── 8. Routed workspace authority ───────────────────────────────────────

test("every canonical Workspace route authorizes the routed id against real membership", () => {
  for (const [surface, src] of Object.entries({ home, settings, "command-center": commandCenter })) {
    assert.match(
      src,
      /resolveRoutedWorkspace\(user\.id, requestedWorkspaceId\)/,
      `${surface} must authorize the id from the URL`,
    );
    assert.match(src, /access === "denied"/, `${surface} must have an explicit refusal`);
  }
});

test("no canonical Workspace route consults the preferred-workspace cookie", () => {
  // The whole point of an entity-qualified route: the URL is the scope. A
  // fallback resolver here would let workspace A's cookie decide what
  // workspace B's address renders.
  for (const [surface, src] of Object.entries({ home, settings, "command-center": commandCenter })) {
    assert.doesNotMatch(src, /resolvePreferredWorkspace/, `${surface} must not read the preferred workspace`);
    assert.doesNotMatch(src, /resolveCanonicalWorkspace/, `${surface} must not use the falling-back resolver`);
    assert.doesNotMatch(src, /resolveWriteWorkspace/, `${surface} must not resolve a write workspace`);
    assert.doesNotMatch(src, /ensureUserWorkspace/, `${surface} must never conjure a workspace`);
  }
});

test("the resolver that guards these routes has no fallback at all", () => {
  const resolver = read("src/lib/workspaces/routed-workspace.ts");
  assert.match(resolver, /export async function resolveRoutedWorkspace\(userId: string, workspaceId: string\)/);
  // It reads membership for the EXACT id, and every failure path returns DENIED
  // rather than another workspace.
  assert.match(resolver, /\.eq\("workspace_id", workspaceId\)/);
  assert.doesNotMatch(resolver, /order\(/, "a fallback would need to pick among memberships");
  assert.doesNotMatch(resolver, /limit\(/);
});

test("workspace A cannot become workspace B: every read is scoped to the authorized id", () => {
  for (const [surface, src] of Object.entries({ home, settings })) {
    // The authorized id is destructured from the resolver's answer, and the raw
    // routed segment is used for nothing but the refusal log line.
    assert.match(src, /const \{ workspaceId(?:, role)? \} = access;/, `${surface} must use the authorized id`);
    const reads = src.match(/\.eq\("workspace_id", [^)]+\)|\.eq\("id", [^)]+\)/g) ?? [];
    assert.ok(reads.length > 0, `${surface} must scope its reads`);
    for (const read of reads) {
      assert.match(read, /workspaceId\)/, `${surface} scoped a read by something other than the authorized id: ${read}`);
      assert.doesNotMatch(read, /requestedWorkspaceId/, `${surface} must never query by the untrusted segment`);
    }
  }
});

test("the refusal reveals nothing about whether the workspace exists", () => {
  assert.match(routeStates, /does not exist or is not one you have access to/);
  // Nothing that would confirm a real row: no name, no status, no role, and not
  // the requested id echoed back to the caller.
  assert.doesNotMatch(routeStates, /workspace\.name|requestedWorkspaceId|\{role\}/);
  for (const [surface, src] of Object.entries({ home, settings })) {
    assert.match(src, /return <WorkspaceNotAvailable \/>;/, `${surface} must use the shared refusal`);
  }
});

test("a workspace that vanishes between authorization and read gets the same refusal", () => {
  for (const [surface, src] of Object.entries({ home, settings })) {
    assert.match(src, /if \(!workspace\) return <WorkspaceNotAvailable \/>;/, `${surface} must fail closed on an unreadable row`);
  }
});

// ─── 9. Archived is a state, never a disappearance ───────────────────────

test("archived stays routable and readable on every canonical Workspace surface", () => {
  for (const [surface, src] of Object.entries({ home, settings })) {
    assert.match(src, /access\.access === "archived"/, `${surface} must treat archived as its own state`);
    assert.match(src, /<WorkspaceArchivedNotice \/>/, `${surface} must explain the state rather than imply it`);
    // Archived must not be routed into the refusal — that is the defect PR #604's
    // review found and this family must not re-introduce.
    assert.doesNotMatch(
      src,
      /access !== "granted"[\s\S]{0,80}WorkspaceNotAvailable/,
      `${surface} must not collapse archived into denied`,
    );
  }
  assert.match(routeStates, /This workspace is archived/);
  assert.match(routeStates, /nothing here has been deleted/i);
});

test("Workspace Home withholds creation affordances while archived", () => {
  // §7: the viewer keeps the data and loses the ability to change it. Offering
  // "Create Project" on an archived workspace is an instruction that fails on
  // arrival.
  assert.match(home, /\{!isArchived \? \(/);
  assert.match(home, /Create Project/);
});

test("the archived notice invents no mutation semantics", () => {
  // There is no archive/restore mutation at workspace scope anywhere in src/, so
  // the notice must not promise a way back out of archival.
  assert.doesNotMatch(routeStates, /restor/i);
});

// ─── 10. Workspace Home is not a relabeled Command Center ────────────────

test("Workspace Home hosts none of the Command Center's operational surface", () => {
  for (const forbidden of [
    "CommandCenterClient",
    "CommandCenterEmptyState",
    "summarizePortfolio",
    "activateContextAction",
    "resolveActiveProject",
    "loadLatestOperationalGovernanceBrief",
    "resolveCommandCenterLanding",
  ]) {
    assert.doesNotMatch(home, new RegExp(forbidden), `Workspace Home must not host ${forbidden}`);
  }
});

test("Workspace Home offers the Command Center as a destination, not as its own content", () => {
  assert.match(home, /workspaceCommandCenterPath\(workspaceId\)/);
  assert.match(home, /Open Workspace Command Center/);
  assert.match(home, /workspaceSettingsPath\(workspaceId\)/);
});

test("Workspace Home drills down into the canonical PMO family", () => {
  assert.match(home, /pmoHomePath\(workspaceId, pmo\.id\)/);
  assert.doesNotMatch(home, /"\/pmos\/\$\{/, "the legacy PMO route must not be re-typed here");
});

test("Workspace Home never asserts a count it did not read", () => {
  // A failed read must say so. Rendering "0 PMOs" from an error is a false claim
  // about the tenant's own data, and one they have no way to detect.
  assert.match(home, /Temporarily unavailable/);
  // And "this workspace is empty" is only said when BOTH reads succeeded — a
  // failed PMO read must not produce an invitation to create a first PMO in a
  // workspace that may already have several.
  assert.match(home, /!projectsUnavailable && projects\.length === 0 && pmos !== null && pmos\.length === 0/);
});

test("Workspace Settings never reports an empty list it failed to read", () => {
  assert.match(settings, /const invitesUnavailable = Boolean\(invitesError\)/);
  assert.match(settings, /couldn&apos;t load this workspace&apos;s pending invitations/);
  // Membership is the one list that cannot legitimately be empty here — the
  // caller is a member — so its empty branch says "could not be listed", not
  // "there are none".
  assert.match(settings, /No members could be listed/);
});

// ─── 11. Workspace Settings is honest about what exists ──────────────────

test("Workspace Settings adds no mutation of any kind", () => {
  for (const forbidden of [/"use server"/, /<form/, /action=\{/, /\.update\(/, /\.insert\(/, /\.delete\(/, /createSupabaseServiceRoleClient/]) {
    assert.doesNotMatch(settings, forbidden, `Workspace Settings must not mutate: ${forbidden}`);
  }
});

test("Workspace Settings names no tab the product cannot perform", () => {
  // The screen catalog plans General/Members/Integrations/Billing plus rename and
  // archive modals. Only what exists is shown; a tab that names a missing
  // capability is worse than an absent tab.
  assert.doesNotMatch(settings, /Integrations/);
  assert.doesNotMatch(settings, /Rename workspace|Archive workspace/i);
  assert.match(settings, /aren&apos;t available in the product yet/);
});

test("no workspace rename or archive mutation exists to have been moved", () => {
  // Pins the premise of the test above. If a rename ever lands, this fails and
  // the screen's honesty claim is reconsidered deliberately rather than by
  // accident.
  const workspacesLib = read("src/lib/workspaces.ts");
  assert.doesNotMatch(workspacesLib, /from\("workspaces"\)\s*\n?\s*\.update\(/);
});

test("Workspace Settings gates the invitations panel on the routed workspace's own role", () => {
  // The role comes from the resolver that authorized THIS workspace — not from
  // the preferred-workspace cookie, and not from any other membership the caller
  // happens to hold.
  assert.match(settings, /const \{ workspaceId, role \} = access;/);
  assert.match(settings, /canInviteMembers\(role as WorkspaceRole\)/);
  assert.match(settings, /canInvite\s*\?[\s\S]{0,400}workspace_invitations/);
});

test("Workspace Settings delegates administration to the surfaces that own it", () => {
  assert.match(settings, /href="\/team"/);
  assert.match(settings, /href="\/billing"/);
});

test("the existing invite role gate is untouched", () => {
  const teamActions = read("src/app/(protected)/team/actions.ts");
  assert.match(teamActions, /requireWorkspaceRole\(workspaceId, "admin"\)/);
  assert.match(teamActions, /canAssignWorkspaceRole\(\{ actorRole: access\.role, targetRole: requestedRole \}\)/);
});

// ─── 12. The protected layout derives W from every canonical surface ─────

test("the layout reads the workspace from every canonical Workspace surface", () => {
  assert.match(protectedLayout, /parseCanonicalWorkspaceRoute\(routedHeaders\.get\("x-pathname"\)/);
  assert.match(protectedLayout, /parseCanonicalPmoRoute\(routedHeaders\.get\("x-pathname"\)/);
  // And the hint is AUTHORIZED before it is used, so a URL can never widen access.
  assert.match(protectedLayout, /routedWorkspaceId \? await resolveRoutedWorkspace\(user\.id, routedWorkspaceId\) : null/);
});

test("an explicit canonical route is never answered from the preferred-workspace cookie", () => {
  // The shell and the onboarding gate must both see the workspace the URL names.
  // Falling back to the cookie rendered A's chrome on B's address and let an
  // incomplete A redirect the user away from a B they were entitled to see.
  assert.match(
    protectedLayout,
    /routedAccess && routedAccess\.access !== "denied"\s*\?\s*\{ workspaceId: routedAccess\.workspaceId[\s\S]{0,120}: await resolveWriteWorkspace\(user\.id\)/,
  );
});

test("the layout still treats an archived routed workspace as routable", () => {
  assert.match(protectedLayout, /routedAccess\?\.access === "archived"/);
  assert.match(protectedLayout, /shouldRedirectForOnboarding\(\{ state: onboardingState, routedWorkspaceArchived \}\)/);
});

// ─── 13. Breadcrumbs and ancestor links ──────────────────────────────────

test("the PMO Command Center's Workspace ancestor is that workspace's own Home", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "Delivery", pmoId: PMO });
  assert.equal(trail[0].href, workspaceHomePath(WS));
  assert.equal(trail[1].href, pmoHomePath(WS, PMO));
  assert.equal(trail[trail.length - 1].href, null, "a Command Center is a trail's terminal node");
});

test("the Workspace ancestor carries the workspace it was given, not a remembered one", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Other", workspaceId: OTHER_WS, pmoName: "D", pmoId: PMO });
  assert.equal(trail[0].href, workspaceHomePath(OTHER_WS));
  assert.doesNotMatch(trail[0].href!, new RegExp(WS));
});

test("no ancestor node anywhere in the family points at a Command Center", () => {
  const trail = pmoCommandCenterBreadcrumb({ workspaceLabel: "Acme", workspaceId: WS, pmoName: "D", pmoId: PMO });
  for (const node of trail.slice(0, -1)) {
    assert.ok(node.href, "an ancestor must be clickable (nav-contracts §2.3 rule 1)");
    assert.doesNotMatch(node.href!, /command-center/, `${node.href} must be a Home`);
    // A literal href is not enough: "/workspace" and "/workspaces" both LOOK like
    // homes. The first is quarantined into a Command Center; the second is the
    // chooser, not this workspace's Home.
    assert.notEqual(node.href, "/workspace");
    assert.notEqual(node.href, "/workspaces");
  }
});

test("the Workspace Command Center's own up-link is Workspace Home, not itself", () => {
  // The default `/workspace` is quarantined to `/command-center`, so before this
  // slice the Command Center's ancestor link navigated back to the Command
  // Center — a trail whose ancestor was its own descendant.
  assert.match(banner, /workspaceHomePath\(workspaceId\)/);
  assert.match(commandCenter, /<WorkspaceContextBanner lens="Command Center" workspaceId=\{workspace\.workspaceId\} \/>/);
  assert.doesNotMatch(
    commandCenter,
    /<WorkspaceContextBanner lens="Command Center" \/>/,
    "no Command Center banner may fall back to the quarantined default",
  );
});

test("Workspace Settings' trail returns to Workspace Home and the chooser", () => {
  assert.match(settings, /workspaceHomePath\(workspaceId\)/);
  assert.match(settings, /WORKSPACES_NAV_HREF/);
});

// ─── 14. The chooser stays a chooser; the singular stays quarantined ─────

test("/workspaces entries open the canonical Workspace Home", () => {
  assert.match(index, /workspaceHomePath\(workspace\.id\)/);
  assert.doesNotMatch(index, /href="\/pmos"/, "a workspace entry must open that workspace, not a global list");
});

test("/workspaces is still the chooser, not an entity Home", () => {
  // It renders the LIST and has no [workspaceId] of its own to authorize.
  assert.doesNotMatch(index, /resolveRoutedWorkspace/);
  assert.match(index, /getUserWorkspaces\(user\.id\)/);
  // The sanctioned switcher is untouched (§5 rule 4).
  assert.match(index, /switchWorkspaceAction/);
});

test("the legacy singular /workspace remains quarantined and is not Workspace Home", () => {
  assert.match(legacySingular, /redirect\("\/command-center"\)/);
  assert.doesNotMatch(legacySingular, /resolveRoutedWorkspace|workspaceHomePath/, "quarantine must not become a resolver");
  assert.match(proxy, /pathname === "\/workspace"/);
  assert.match(proxy, /new URL\("\/command-center", request\.url\)/);
});

test("the quarantined singular is not a member of the family", () => {
  assert.equal(parseCanonicalWorkspaceRoute("/workspace"), null);
  assert.equal(parseCanonicalWorkspaceRoute("/workspace/setup"), null);
  for (const surface of WORKSPACE_SURFACES) {
    assert.notEqual(workspaceSurfacePath(WS, surface), "/workspace");
  }
});

test("no canonical Workspace route redirects, so the family cannot loop", () => {
  for (const [surface, src] of Object.entries({ home, settings })) {
    assert.doesNotMatch(src, /\bredirect\(/, `${surface} must render, not bounce`);
  }
});

// ─── 15. Workspace Home and Workspace Command Center stay distinct ───────

test("the two screens are different routes, different files and different content", () => {
  assert.notEqual(ROUTE_FILES.home, ROUTE_FILES["command-center"]);
  assert.notEqual(workspaceHomePath(WS), workspaceCommandCenterPath(WS));
  assert.equal(isWorkspaceCommandCenterPath(workspaceHomePath(WS)), false);
  assert.equal(parseCanonicalWorkspaceRoute(workspaceHomePath(WS))?.surface, "home");
});

test("the Command Center screen still lives in exactly one route", () => {
  assert.match(commandCenter, /CommandCenterClient/);
  for (const src of [home, settings, index]) {
    assert.doesNotMatch(src, /CommandCenterClient/);
  }
});

// ─── 16. No schema work ──────────────────────────────────────────────────

test("this slice introduces no migration", () => {
  // Every table this family reads already exists and is already read elsewhere.
  for (const src of [home, settings]) {
    assert.doesNotMatch(src, /create table|alter table/i);
  }
  const family = read("src/lib/workspaces/workspace-paths.ts");
  assert.doesNotMatch(family, /supabase|from\(/i, "the path family is pure — no I/O, no schema");
});
