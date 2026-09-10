import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { firstQueryValue, parseWorkspaceIdFromPath } from "../src/lib/workspace/command-center-paths";

const canonicalRoute = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");
const activateAction = readFileSync("src/app/(protected)/command-center/actions.ts", "utf8");
const ingestionAction = readFileSync("src/app/(protected)/command-center/ingestion-actions.ts", "utf8");
const protectedLayout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
const shell = readFileSync("src/components/pmfreak/operational-shell.tsx", "utf8");
const projectsApi = readFileSync("src/app/api/projects/route.ts", "utf8");
const client = readFileSync("src/modules/workspace/screens/command-center/command-center-client.tsx", "utf8");
const routedWorkspace = readFileSync("src/lib/workspaces/routed-workspace.ts", "utf8");

// ─── P1: activation must create in the workspace from the URL ─────────────

test("P1 activation: the action takes the workspace as its first argument", () => {
  assert.match(activateAction, /export async function activateContextAction\(\s*workspaceId: string,\s*formData: FormData,?\s*\)/);
});

test("P1 activation: the bound workspace is authorized, not trusted", () => {
  // A bound Server Action argument reaches the client and can come back altered,
  // so binding alone is not authorization.
  assert.match(activateAction, /resolveRoutedWorkspace\(user\.id, workspaceId\)/);
  assert.match(activateAction, /access\.access !== "granted"/);
});

test("P1 activation: the preferred-workspace write path is gone", () => {
  // resolveWriteWorkspace falls back to the cookie's workspace, which is exactly
  // how a deep link to B created a project in A. Assert the MODULE is no longer
  // imported — the name still appears in this file's prose explaining the fix,
  // so matching the bare identifier would pass on the comment alone.
  assert.doesNotMatch(activateAction, /from "@\/lib\/workspaces\/resolve-write-workspace"/);
  assert.match(activateAction, /const ensured = \{ workspaceId: access\.workspaceId/);
  assert.match(activateAction, /workspace_id: ensured\.workspaceId/);
});

test("P1 activation: the route binds the authorized workspace into the form action", () => {
  assert.match(canonicalRoute, /activateContextAction\.bind\(null, workspace\.workspaceId\)/);
});

// ─── P1: shell/layout context must come from the canonical route ──────────

test("P1 layout: workspace context is derived from the route before the gate runs", () => {
  assert.match(protectedLayout, /parseWorkspaceIdFromPath\(routedHeaders\.get\("x-pathname"\)/);
  assert.match(protectedLayout, /routedAccess && routedAccess\.access !== "denied"/);
});

test("P1 layout: the routed id is authorized, and an unauthorized one cannot widen access", () => {
  assert.match(protectedLayout, /resolveRoutedWorkspace\(user\.id, routedWorkspaceId\)/);
  // Falling back to the preferred workspace on denial is what keeps the URL from
  // becoming an access-granting input.
  assert.match(protectedLayout, /:\s*await resolveWriteWorkspace\(user\.id\)/);
});

test("P1 layout: the onboarding gate evaluates the SAME workspace the shell renders", () => {
  // The defect: an incomplete workspace A could redirect the user away from a
  // workspace B they were entitled to see.
  assert.match(protectedLayout, /resolveOnboardingState\(user, resolvedWorkspace\.workspaceId/);
});

test("P1 shell: the project switcher is scoped to the rendered workspace", () => {
  assert.match(shell, /\/api\/projects\?workspaceId=\$\{encodeURIComponent\(workspaceId\)\}/);
  assert.match(shell, /\}, \[workspaceId\]\);/, "the fetch must re-run when the workspace changes");
});

test("P1 api: the workspace parameter narrows scope and never widens it", () => {
  assert.match(projectsApi, /searchParams\.get\("workspaceId"\)/);
  assert.match(projectsApi, /requestedWorkspaceId \?\? resolution\?\.workspaceId \?\? null/);
});

test("P1 api: requireWorkspaceMember is defence in depth, not the enforcing boundary", () => {
  // An earlier revision of this test called requireWorkspaceMember "the gate",
  // which over-claimed: it delegates to the enterprise runtime's capability
  // evaluation, and this test does not assert what that evaluation concludes.
  assert.match(projectsApi, /requireWorkspaceMember\(workspaceId\)/, "the application-layer check must still run");
  assert.match(projectsApi, /APPLICATION-LAYER DEFENCE IN DEPTH/, "its role must be documented honestly");
});

test("P1 api: the enforcing data-isolation boundary is the user-scoped client plus RLS", () => {
  assert.match(projectsApi, /ENFORCING DATA-ISOLATION BOUNDARY/);
  // The read must go through the caller's own session, or RLS has nothing to
  // enforce against.
  assert.match(projectsApi, /const supabase = await createSupabaseServerClient\(\)/);
  assert.doesNotMatch(
    projectsApi.split("export async function POST")[0],
    /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/,
    "the GET path must never bypass RLS",
  );
});

test("P1 api: a non-member's query can return no project rows, by policy", () => {
  // The offline half of "non-member workspace queries return no project data":
  // the policy that makes it true is asserted at its source, so a migration that
  // weakened it would fail here rather than silently widening this route.
  const policySource = readFileSync("supabase/migrations/20260512160000_workspace_authorization_rewrite.sql", "utf8");
  const selectPolicy = /create policy "workspace members can select projects" on public\.projects for select to authenticated using \(\s*exists \(select 1 from public\.workspace_memberships wm where wm\.workspace_id = projects\.workspace_id and wm\.user_id = auth\.uid\(\)\)/;
  assert.match(policySource, selectPolicy, "projects SELECT must require a membership row for auth.uid()");
});

// ─── P2: ingestion marker must use and authorize the routed workspace ─────

test("P2 ingestion: the action takes and authorizes the routed workspace", () => {
  assert.match(ingestionAction, /markInitialIngestionAction\(\s*workspaceId: string,\s*projectId: string/);
  assert.match(ingestionAction, /resolveRoutedWorkspace\(user\.id, workspaceId\)/);
  assert.doesNotMatch(ingestionAction, /resolvePreferredWorkspace/);
});

test("P2 ingestion: reads and writes are scoped to the authorized workspace", () => {
  const scoped = ingestionAction.match(/\.eq\("workspace_id", access\.workspaceId\)/g) ?? [];
  assert.equal(scoped.length, 2, "both the read and the write must be scoped");
});

test("P2 ingestion: the client stops closing over a write that did not happen", () => {
  assert.match(client, /if \(result\.ok\) setShowIntelligenceInbox\(false\);/);
  assert.match(client, /setIngestionMarkerFailed\(true\)/);
  assert.match(client, /markInitialIngestionAction\(workspaceId, projectId, "completed"\)/);
});

// ─── P2: repeated query parameters ────────────────────────────────────────

test("P2 query: a repeated key collapses to its first value", () => {
  assert.equal(firstQueryValue(["p1", "p1"]), "p1");
  assert.equal(firstQueryValue("p1"), "p1");
});

test("P2 query: absent, empty and empty-array values are undefined, not blank strings", () => {
  assert.equal(firstQueryValue(undefined), undefined);
  assert.equal(firstQueryValue(""), undefined);
  assert.equal(firstQueryValue([]), undefined);
});

test("P2 query: both entry points normalize through the SAME helper", () => {
  // The helper's own doc comment claimed this before it was true: the legacy
  // resolver carried an inline copy of the same logic. Identical in behaviour,
  // but nothing held the two in step, which is precisely the drift the comment
  // said was prevented.
  const legacyRouteSrc = readFileSync("src/app/(protected)/command-center/page.tsx", "utf8");
  assert.match(legacyRouteSrc, /firstQueryValue,/, "the legacy resolver must import the shared helper");
  assert.match(legacyRouteSrc, /firstQueryValue\(params\[key\]\)/);
  assert.doesNotMatch(legacyRouteSrc, /Array\.isArray/, "the inline duplicate must be gone");
  assert.match(canonicalRoute, /firstQueryValue\(rawParams\./);
});

test("P2 query: a repeated key resolves identically on both routes", () => {
  // Same helper, so this is a property of one function rather than a comparison
  // of two implementations — which is the point of collapsing them.
  for (const value of [["p1", "p2"], "p1", [""], undefined] as const) {
    const once = firstQueryValue(value as string | string[] | undefined);
    const twice = firstQueryValue(value as string | string[] | undefined);
    assert.equal(once, twice);
  }
  assert.equal(firstQueryValue(["p1", "p2"]), "p1", "the FIRST occurrence wins, never a joined string");
  assert.notEqual(firstQueryValue(["p1", "p2"]), "p1,p2");
});

test("P2 query: the canonical route declares what Next actually delivers", () => {
  // Typing a repeated param as a scalar does not make it one; the array reached
  // resolveActiveProject and made a real project look foreign to its workspace.
  assert.match(canonicalRoute, /searchParams: Promise<Record<string, string \| string\[\] \| undefined>>/);
  assert.match(canonicalRoute, /projectId: firstQueryValue\(rawParams\.projectId\)/);
});

// ─── P2: archived workspaces stay readable ────────────────────────────────

test("P2 archived: archived is a distinct outcome from denied", () => {
  assert.match(routedWorkspace, /access: "archived"/);
  assert.match(routedWorkspace, /access: "granted"/);
  assert.match(routedWorkspace, /status === "archived"/);
});

test("P2 archived: deleted and non-membership are one indistinguishable refusal", () => {
  // §7 leakage rule: the route must not become a probe for which ids exist.
  assert.match(routedWorkspace, /status === "deleted"\) return DENIED/);
  assert.match(routedWorkspace, /if \(membershipError \|\| !membership\) return DENIED/);
});

test("P2 archived: the resolver never falls back to a different workspace", () => {
  // The difference from resolveCanonicalWorkspace, whose fallback is what turned
  // an archived-but-authorized workspace into "no access". Asserted on the query
  // shape rather than on the absence of the word "fallback", which appears in
  // this module's prose contrasting the two resolvers.
  assert.match(routedWorkspace, /\.eq\("workspace_id", workspaceId\)/, "membership is looked up for the requested id only");
  assert.match(routedWorkspace, /\.eq\("id", workspaceId\)/, "the workspace row is the requested one only");
  assert.doesNotMatch(routedWorkspace, /\.order\(|\.limit\(/, "no membership list means nothing to fall back to");
  assert.doesNotMatch(routedWorkspace, /import .*canonical-workspace-resolver/);
});

test("P2 archived: the route renders last-known data, not the not-found state", () => {
  assert.match(canonicalRoute, /This workspace is archived/);
  assert.match(canonicalRoute, /last-known state/);
  assert.match(canonicalRoute, /const isArchived = workspaceAccess\.access === "archived"/);
});

test("P2 archived: mutation entry points are withheld in the archived view", () => {
  const archivedBlock = canonicalRoute.slice(
    canonicalRoute.indexOf("if (isArchived)"),
    canonicalRoute.indexOf("if ((projects ?? []).length === 0)"),
  );
  assert.ok(archivedBlock.length > 0, "the archived branch must precede the empty state");
  assert.doesNotMatch(archivedBlock, /CommandCenterClient/);
  assert.doesNotMatch(archivedBlock, /activateContextAction/);
});

test("P2 archived: mutating actions refuse an archived workspace", () => {
  for (const [name, src] of [["activate", activateAction], ["ingestion", ingestionAction]] as const) {
    assert.match(src, /access\.access !== "granted"/, `${name} must require granted, not merely non-denied`);
  }
});

// ─── Path parsing used by the layout ──────────────────────────────────────

test("the layout's path hint parses only the canonical Command Center shape", () => {
  assert.equal(parseWorkspaceIdFromPath("/workspaces/ws-1/command-center"), "ws-1");
  assert.equal(parseWorkspaceIdFromPath("/workspaces/ws-1"), null);
  assert.equal(parseWorkspaceIdFromPath("/command-center"), null);
  assert.equal(parseWorkspaceIdFromPath("/workspaces//command-center"), null);
});

test("the path hint decodes the segment it returns", () => {
  assert.equal(parseWorkspaceIdFromPath("/workspaces/a%2Fb/command-center"), "a/b");
  // A malformed escape must not throw into the layout's render path.
  assert.equal(parseWorkspaceIdFromPath("/workspaces/%E0%A4%A/command-center"), null);
});
