import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  PM_OPERATIONS_LEGACY_PATH,
  PM_OPERATIONS_PATH,
} from "../src/lib/pm-operations/pm-operations-paths";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { isWorkspaceCommandCenterPath } from "../src/lib/workspace/command-center-paths";

const NEW_ROUTE_FILE = "src/app/(protected)/pm-operations/page.tsx";
const LEGACY_ROUTE_FILE = "src/app/(protected)/pmo-command-center/page.tsx";

const screen = readFileSync(NEW_ROUTE_FILE, "utf8");
const legacyRoute = readFileSync(LEGACY_ROUTE_FILE, "utf8");
const executiveReporting = readFileSync("src/app/(protected)/pmo-executive-reporting/page.tsx", "utf8");
const governanceCompliance = readFileSync("src/app/(protected)/pmo-governance-compliance/page.tsx", "utf8");
const dataLayer = readFileSync("src/lib/pmo-command-center/pmo-command-center.ts", "utf8");
const dataLayerTypes = readFileSync("src/lib/pmo-command-center/types.ts", "utf8");

// ─── The premise: these two surfaces are NOT the same screen ──────────────
//
// ADR-PMF-014 Rule 6 and 03-screen-catalog.md both assert that the internal
// dashboard is distinct in scope from the user-facing PMO Command Center. These
// tests pin that premise to the code, because the whole rename rests on it: if
// this dashboard ever does become a projection over one `pmos` entity, the
// rename's justification is gone and this file should fail loudly rather than
// let the two silently re-converge.

test("premise: the dashboard's view input is workspace-scoped and takes no pmoId", () => {
  const input = /export interface GetPMOCommandCenterViewInput \{([^}]*)\}/.exec(dataLayerTypes);
  assert.ok(input, "GetPMOCommandCenterViewInput not found");
  assert.match(input[1], /workspaceId: string/);
  assert.doesNotMatch(input[1], /pmoId/, "a pmoId here would make this a PMO-entity projection");
});

test("premise: the dashboard aggregates project managers, not PMO entities", () => {
  assert.match(dataLayer, /listProjectManagers\(workspaceId\)/);
  assert.doesNotMatch(dataLayer, /\.from\(\s*["']pmos["']\s*\)/, "this surface must not read the pmos table");
});

test("premise: the internal path is not, and must not become, a canonical Command Center path", () => {
  assert.equal(isWorkspaceCommandCenterPath(PM_OPERATIONS_PATH), false);
  assert.doesNotMatch(PM_OPERATIONS_PATH, /command-center/);
});

// ─── The rename itself ────────────────────────────────────────────────────

test("the internal surface joins the pm-* family", () => {
  assert.equal(PM_OPERATIONS_PATH, "/pm-operations");
  assert.equal(PM_OPERATIONS_LEGACY_PATH, "/pmo-command-center");
});

test("the screen lives at the new route, and the old route holds no screen", () => {
  assert.ok(existsSync(NEW_ROUTE_FILE));
  // The tab state machine is the screen's own; finding it here and not there is
  // what proves the screen moved rather than being copied.
  assert.match(screen, /type ActiveTab =/);
  assert.doesNotMatch(legacyRoute, /type ActiveTab =/, "the legacy path must not hold a second copy");
});

test("the legacy path is a redirect-only resolver", () => {
  assert.match(legacyRoute, /redirect\(PM_OPERATIONS_PATH\)/);
  // No data fetching, no client directive — a redirect and nothing else.
  assert.doesNotMatch(legacyRoute, /"use client"/);
  assert.doesNotMatch(legacyRoute, /fetch\(/);
});

test("both ends of the redirect come from the one paths module", () => {
  assert.match(legacyRoute, /from "@\/lib\/pm-operations\/pm-operations-paths"/);
  assert.doesNotMatch(legacyRoute, /"\/pm-operations"/, "the destination must not be re-typed as a literal");
});

// ─── ADR-PMF-014 copy rules ───────────────────────────────────────────────

test("Rule 6: the renamed screen shows no Command Center copy at all", () => {
  assert.doesNotMatch(screen, /Command Center/);
  assert.match(screen, /<h1[^>]*>PM Operations<\/h1>/);
});

test("Rule 6: neither sibling surface calls the internal dashboard a PMO Command Center", () => {
  assert.doesNotMatch(executiveReporting, /PMO Command Center/);
  assert.doesNotMatch(governanceCompliance, /PMO Command Center/);
});

test("Rule 1: no sibling surface carries a bare Command Center label", () => {
  for (const [name, source] of [
    ["pmo-executive-reporting", executiveReporting],
    ["pmo-governance-compliance", governanceCompliance],
  ] as const) {
    assert.doesNotMatch(source, />Command Center</, `${name} still renders a bare "Command Center" label`);
  }
});

test("both cross-links point at the constant and name the internal surface", () => {
  for (const [name, source] of [
    ["pmo-executive-reporting", executiveReporting],
    ["pmo-governance-compliance", governanceCompliance],
  ] as const) {
    assert.match(source, /href=\{PM_OPERATIONS_PATH\}[^>]*>PM Operations</, `${name} cross-link not updated`);
    assert.doesNotMatch(source, /href="\/pmo-command-center"/, `${name} still links the pre-rename literal`);
  }
});

test("Rule 5: internal identifiers may keep their spelling, and still do", () => {
  // The rename is a COPY rule, not a schema rewrite. The view type and the API
  // route keep their internal names on purpose (Rule 5), and this test exists so
  // that staying put reads as a decision rather than an oversight.
  assert.match(screen, /PMOCommandCenterView/);
  assert.match(screen, /fetch\("\/api\/pmo-command-center"\)/);
});

// ─── Behaviour preservation ───────────────────────────────────────────────

test("the new route is a protected page, classified like its pm-* sibling", () => {
  assert.equal(isProtectedPageRoute(PM_OPERATIONS_PATH), true);
  assert.equal(getRouteAccessPolicy(PM_OPERATIONS_PATH), "workspace-contextual");
  assert.equal(getRouteAccessPolicy("/pm-registry"), "workspace-contextual");
});

test("the legacy path stays protected, so the redirect is never reached anonymously", () => {
  assert.equal(isProtectedPageRoute(PM_OPERATIONS_LEGACY_PATH), true);
});

test("session-continuation behaviour is unchanged by the rename", () => {
  // Neither path was continuation-safe before the rename and neither is after.
  // Making the internal pm-* family continuation-safe would be a real change
  // affecting all four siblings — deliberately not smuggled into a rename.
  assert.equal(isSafeContinuationRoute(PM_OPERATIONS_LEGACY_PATH), false);
  assert.equal(isSafeContinuationRoute(PM_OPERATIONS_PATH), false);
});

test("registering the new route did not disturb its neighbours", () => {
  assert.equal(getRouteAccessPolicy("/pmo-interventions"), "workspace-contextual");
  assert.equal(getRouteAccessPolicy("/command-center"), "workspace-contextual");
  assert.equal(getRouteAccessPolicy("/api/pmo-command-center"), "api");
});
