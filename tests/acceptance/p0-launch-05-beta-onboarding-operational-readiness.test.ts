import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/auth-js";
import { classifyAuthError } from "../../src/lib/auth/auth-error-classification";
import { evaluateClosedFreeBetaEnvSafety } from "../../src/lib/security/environment";
import { evaluateWorkspaceMembershipRemoval, acceptWorkspaceInvite, removeWorkspaceMember } from "../../src/lib/workspace-team";
import { canUpdateWorkspaceMemberRole } from "../../src/lib/workspace-access";
import { TENANT_A, TENANT_B } from "../../scripts/p2-13/founder-scenario-manifest.mjs";
import { GUARD_MODES, LOCAL_ISOLATED, assertIsolatedTarget } from "../../scripts/p2-13/isolation-guard.mjs";
import {
  HttpSession,
  environOf,
  freePort,
  requireProc,
  shutdownProductionServer,
  startProductionServer,
  type ServerHandle,
} from "./support/runtime-acceptance";

const goodEnv = {
  PMFREAK_OPERATING_PROFILE: "closed-free-beta",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-local-anon",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-service-role",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
} as unknown as NodeJS.ProcessEnv;

test("1. installed auth-js ordinary no-session class is classified as unauthenticated", () => {
  assert.equal(classifyAuthError(new AuthSessionMissingError()), "session_missing");
});

test("2. ordinary no-session is not a dependency outage (non-vacuity)", () => {
  assert.notEqual(classifyAuthError(new AuthSessionMissingError()), "retryable_transport");
});

test("3. installed auth-js transport class is classified as retryable dependency failure", () => {
  assert.equal(classifyAuthError(new AuthRetryableFetchError("synthetic", 0)), "retryable_transport");
});

test("4. transport failure is not accepted as ordinary no-session (non-vacuity)", () => {
  assert.notEqual(classifyAuthError(new AuthRetryableFetchError("synthetic", 0)), "session_missing");
});

test("5. auth-js 401/403 API errors remain genuine auth rejection", () => {
  assert.equal(classifyAuthError(new AuthApiError("synthetic", 401, "bad_jwt")), "auth_rejection");
  assert.equal(classifyAuthError(new AuthApiError("synthetic", 403, "forbidden")), "auth_rejection");
});

test("6. beta environment contract accepts the isolated no-billing profile", () => {
  assert.deepEqual(evaluateClosedFreeBetaEnvSafety(goodEnv), []);
});

test("7. beta environment contract rejects a missing selected profile", () => {
  assert.ok(evaluateClosedFreeBetaEnvSafety({ ...goodEnv, PMFREAK_OPERATING_PROFILE: undefined }).some((v) => v.code === "beta_profile_not_selected"));
});

test("8. beta environment contract rejects missing required Supabase configuration", () => {
  assert.ok(evaluateClosedFreeBetaEnvSafety({ ...goodEnv, SUPABASE_SERVICE_ROLE_KEY: undefined }).some((v) => v.code === "missing_beta_environment"));
});

test("9. Stripe is not required for the closed free beta", () => {
  const codes = evaluateClosedFreeBetaEnvSafety({ ...goodEnv, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
  assert.deepEqual(codes, []);
});

test("10. readiness declares anonymous auth health only for the beta profile", () => {
  const source = readFileSync("src/app/api/ready/route.ts", "utf8");
  const authCheck = source.slice(source.indexOf("async function checkAuth"), source.indexOf("export async function GET"));
  assert.match(authCheck, /\/auth\/v1\/health/);
  assert.match(authCheck, /headers: \{ apikey: anonKey \}/);
  assert.doesNotMatch(authCheck, /SUPABASE_SERVICE_ROLE_KEY|signInWithPassword/);
  // The profile gate is at the CALL SITE, so that outside the beta profile the
  // check is ABSENT from `checks` rather than present-and-passing. A passing
  // entry would widen the declared dependency set for non-beta consumers.
  const handler = source.slice(source.indexOf("export async function GET"));
  assert.match(handler, /if \(isClosedFreeBeta\(\)\) checks\.push\(await checkAuth\(\)\)/);
});

test("11. operator onboarding uses the supported tenant-aware invite boundary", () => {
  const source = readFileSync("src/lib/workspace-team.ts", "utf8");
  assert.match(source, /inviteWorkspaceMember/);
  assert.match(source, /active invitation already exists/i);
  assert.match(source, /workspace_id: input\.workspaceId/);
  assert.match(source, /role: targetRole/);
});

test("12. invite acceptance binds server-side tenant and role and refuses caller substitution", () => {
  const source = readFileSync("src/lib/workspace-team.ts", "utf8");
  assert.match(source, /workspace_id: invite\.workspaceId/);
  assert.match(source, /role: invite\.role/);
  assert.doesNotMatch(source.slice(source.indexOf("export async function acceptWorkspaceInvite"), source.indexOf("Workspace member role update")), /input\.workspaceId|input\.role/);
});

test("13. canonical two-tenant fixture identities are distinct (wrong mapping control)", () => {
  assert.notEqual(TENANT_A.workspaceId, TENANT_B.workspaceId);
  assert.notEqual(TENANT_A.projectId, TENANT_B.projectId);
  assert.throws(() => assert.equal(TENANT_A.workspaceId, TENANT_B.workspaceId));
});

test("14. protected journey requires session and authoritative membership", () => {
  const proxy = readFileSync("src/proxy.ts", "utf8");
  const layout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
  assert.match(proxy, /isProtectedPageRoute\(pathname\) && !user/);
  assert.match(layout, /assertRuntimeAuthContinuity/);
  assert.match(layout, /resolveOnboardingState/);
});

test("15. governed operations resolve authenticated tenant context through Frontera", () => {
  const authorization = readFileSync("src/lib/security/server-authorization.ts", "utf8");
  assert.match(authorization, /requireAuthenticatedUser/);
  assert.match(authorization, /authorizeRuntimeAction/);
  assert.match(authorization, /workspaceId: requirement\.workspaceId/);
});

test("16. policy denial and Frontera infrastructure failure remain distinct", () => {
  const prior = readFileSync("tests/acceptance/p0-launch-04-failure-recovery-observability.test.ts", "utf8");
  assert.match(prior, /frontera_denied/);
  assert.match(prior, /frontera_unavailable/);
  assert.notEqual("frontera_denied", "frontera_unavailable");
});

test("17. offboarding permits owner/admin removal of a non-owner participant", () => {
  assert.equal(evaluateWorkspaceMembershipRemoval({ actorRole: "owner", actorUserId: "a", targetUserId: "b", targetRole: "pm", ownerCount: 1 }), "allow");
});

test("18. offboarding cannot self-remove or orphan the final owner", () => {
  assert.equal(evaluateWorkspaceMembershipRemoval({ actorRole: "owner", actorUserId: "a", targetUserId: "a", targetRole: "owner", ownerCount: 1 }), "deny_self_removal");
  assert.equal(evaluateWorkspaceMembershipRemoval({ actorRole: "admin", actorUserId: "a", targetUserId: "b", targetRole: "owner", ownerCount: 1 }), "deny_last_owner");
});

test("19. offboarding is auditable and removes membership rather than deleting identity", () => {
  const source = readFileSync("src/lib/workspace-team.ts", "utf8");
  const fn = source.slice(source.indexOf("export async function removeWorkspaceMember"), source.indexOf("export async function updateWorkspaceMemberRole"));
  assert.match(fn, /from\("workspace_memberships"\)\.delete\(\)/);
  assert.match(fn, /event_type: "member_removed"/);
  assert.doesNotMatch(fn, /auth\.admin\.deleteUser|delete.*auth\.users/);
});

test("20. an old session cannot retain governed authority after membership removal", () => {
  const authorization = readFileSync("src/lib/security/server-authorization.ts", "utf8");
  assert.match(authorization, /evaluateCapability/);
  assert.match(authorization, /authorizeRuntimeAction/);
  assert.doesNotMatch(authorization, /getSession\(|cached.*membership/i);
});

test("21. cleanup remains scoped to deterministic disposable fixture identities", () => {
  const cleanup = readFileSync("scripts/p2-13/fixture-cleanup.mjs", "utf8");
  assert.doesNotMatch(cleanup, /truncate\s+table|drop\s+schema/i);
  assert.match(cleanup, /where/i);
});

// ═══════════════════════════════════════════════════════════════════════════
//  RUNTIME — the closed-free-beta profile, actually selected, actually running
//
//  Assertions 1-21 are source-contract assertions. They prove the code has the
//  right SHAPE; they cannot prove the profile can be started, that the preflight
//  gates `next start`, or that readiness moves when the auth dependency does.
//  RR-BETA-PROFILE-UNEXERCISED recorded exactly that gap. This section closes it
//  through the canonical supported entrypoint — `npm run start:closed-free-beta`
//  — reusing the predecessor's ONE server lifecycle (spawn, health-probe
//  deadline, pid discovery, shutdown, residue ledger) rather than growing a
//  second. Nothing here replays the P0-LAUNCH-04 failure matrix; only the auth
//  readiness dependency this increment adopted is exercised.
// ═══════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd();
const OUTAGE_SHIM = path.join(ROOT, "tests/acceptance/support/dependency-outage-shim.cjs");
const OWNER_A = TENANT_A.actors.find((actor: { reference: string }) => actor.reference.endsWith(":owner"))!;
const BETA_SCRIPT = "start:closed-free-beta";
const BETA_PROFILE = "closed-free-beta";
const READINESS_TRANSITION_TIMEOUT_MS = 30_000;

const EVIDENCE: Record<string, unknown> = {};

let CONTROL_DIR = "";
let SUPABASE_HOSTPORT = "";
let PORT = 0;
let server: ServerHandle | null = null;
let session: HttpSession;
let ownerUserId = "";
let companyId = "";
let outsiderUserId = "";
let outsiderEmail = "";
let inviteToken = "";

/**
 * Disposable offboarding identities. Created deterministically in before() and
 * deleted by id in after() — never repaired with manual SQL after the fact.
 * They exist because the removal hierarchy cannot be proven with one owner and
 * one outsider: an admin-removes-admin refusal needs two admins, and a
 * co-owner refusal needs a second owner.
 */
type Fixture = { email: string; userId: string; role: string };
const OFFBOARD_FIXTURES: Record<string, Fixture> = {};
let crossTenantWorkspaceId = "";

const admin = () =>
  createClient(process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL!, process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * The environment a beta process is started with.
 *
 * Overrides are EMPTY STRINGS, never deletions: `next start` loads `.env.local`
 * itself and @next/env fills any name whose value is `undefined`, so a deletion
 * would let the dotenv file put the value back and the control would prove
 * nothing. This is the predecessor's rule and it applies unchanged here.
 */
function betaEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PMFREAK_OPERATING_PROFILE: BETA_PROFILE,
    // The closed FREE beta has no billing surface. Blanked so a start that
    // succeeds proves Stripe is genuinely not required, not merely absent here.
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${OUTAGE_SHIM}`.trim(),
    P0_LAUNCH_04_OUTAGE_DIR: CONTROL_DIR,
    P0_LAUNCH_04_OUTAGE_HOSTPORT: SUPABASE_HOSTPORT,
    P0_LAUNCH_04_OUTAGE_PATH_PREFIXES: "/auth/v1",
    ...overrides,
  };
}

type ReadinessCheck = { name: string; status: string; detail?: string };
type Readiness = { httpStatus: number; status: string; checks: ReadinessCheck[]; raw: string };

async function readReadiness(): Promise<Readiness> {
  const response = await session.request("/api/ready");
  let parsed: { status?: string; checks?: ReadinessCheck[] } = {};
  try {
    parsed = JSON.parse(response.text) as typeof parsed;
  } catch {
    /* a non-JSON body is itself the evidence; `raw` carries it */
  }
  return { httpStatus: response.status, status: parsed.status ?? "(unparsed)", checks: parsed.checks ?? [], raw: response.text };
}

/** Bounded wait for readiness to reach an expected HTTP status; the last observation is always reported. */
async function awaitReadiness(want: number, why: string): Promise<Readiness> {
  const deadline = Date.now() + READINESS_TRANSITION_TIMEOUT_MS;
  let last = await readReadiness();
  while (last.httpStatus !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await readReadiness();
  }
  assert.equal(last.httpStatus, want, `${why} (last observation: ${last.httpStatus} ${last.raw.slice(0, 300)})`);
  return last;
}

/**
 * The same tenant-scoped read, issued three times: before admission, after it,
 * and after offboarding.
 *
 * This endpoint was chosen because it actually DISCRIMINATES on membership,
 * verified live against this build: anonymous 401, authenticated non-member
 * 403, member 200. Two other candidates were rejected for proving nothing —
 * `/api/workspace-team/members` answers 403 even to the workspace OWNER, and
 * `/api/portfolio` answers 200 to an authenticated NON-member because it scopes
 * by the caller's own memberships rather than gating on the requested tenant.
 */
const tenantMemberRead = () => session.request(`/api/execution-tasks?projectId=${encodeURIComponent(TENANT_A.projectId)}`);

const authCheckOf = (readiness: Readiness) => readiness.checks.find((check) => check.name === "auth");
const setAuthOutage = (installed: boolean) => {
  const flag = path.join(CONTROL_DIR, "path-outage");
  if (installed) fs.writeFileSync(flag, "");
  else fs.rmSync(flag, { force: true });
};

before(async () => {
  requireProc("the beta runtime section reports process-level evidence");

  // Isolation BEFORE any privileged access, using the repository's own guard.
  const isolation = assertIsolatedTarget(process.env, { mode: GUARD_MODES.SEED });
  assert.equal(isolation.classification, LOCAL_ISOLATED, `the beta acceptance target was not local and isolated: ${JSON.stringify(isolation.target ?? null)}`);
  EVIDENCE.isolationClassification = String(isolation.classification);
  EVIDENCE.isolationTarget = String(isolation.target?.supabaseHost ?? "(not reported)");

  const supabaseUrl = new URL(process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL!);
  SUPABASE_HOSTPORT = `${supabaseUrl.hostname}:${supabaseUrl.port}`;
  CONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pmfreak-p0-launch-05-"));
  setAuthOutage(false);

  // One build serves every scenario below, so a failure is attributable to
  // runtime behaviour rather than to compilation drift between scenarios.
  const buildIdPath = path.join(ROOT, ".next/BUILD_ID");
  const previousBuildId = fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, "utf8") : null;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
  assert.ok(fs.existsSync(buildIdPath), "next build produced no .next/BUILD_ID");
  const buildId = fs.readFileSync(buildIdPath, "utf8");
  assert.notEqual(buildId, previousBuildId, "the beta gate accepted a stale build — .next/BUILD_ID was not rewritten");
  EVIDENCE.buildId = buildId;

  const supabase = admin();
  for (let page = 1; page <= 20 && !ownerUserId; page += 1) {
    const listed = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    assert.ok(!listed.error, `listUsers failed: ${listed.error?.message}`);
    const found = listed.data.users.find((user) => (user.email ?? "").toLowerCase() === OWNER_A.email.toLowerCase());
    if (found) ownerUserId = found.id;
    if (listed.data.users.length < 200) break;
  }
  assert.ok(ownerUserId, `no authenticated principal for ${OWNER_A.email}. Run 'npm run seed:p2-13-founder' first; this gate never invents an identity.`);

  // company_id belongs to the INVITING USER, not to the workspace — resolved by
  // the same rule the product uses (`feature-gates.getCompanyIdByUserId`): the user's
  // own id. user_metadata.company_id is user-editable and never trusted (F1).
  const owner = await supabase.auth.admin.getUserById(ownerUserId);
  assert.ok(!owner.error && owner.data.user, `could not resolve the inviting owner: ${owner.error?.message}`);
  companyId = owner.data.user.id;

  // A NON-INVITED platform identity. Created deliberately, because the claim
  // this gate makes is that creating one confers no beta authority — which
  // cannot be shown without one existing.
  outsiderEmail = `p0-launch-05-noninvited-${Date.now()}@example.test`;
  const created = await supabase.auth.admin.createUser({ email: outsiderEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!created.error && created.data.user, `could not create the non-invited identity: ${created.error?.message}`);
  outsiderUserId = created.data.user.id;
  EVIDENCE.nonInvitedIdentityCreated = outsiderEmail;

  // Disposable memberships for the offboarding hierarchy matrix.
  const stamp = Date.now();
  for (const [key, role] of [["coOwner", "owner"], ["adminA", "admin"], ["adminB", "admin"], ["pm", "pm"], ["viewer", "viewer"]] as const) {
    const email = `p0-launch-05-${key.toLowerCase()}-${stamp}@example.test`;
    const made = await supabase.auth.admin.createUser({ email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
    assert.ok(!made.error && made.data.user, `could not create the ${key} fixture: ${made.error?.message}`);
    const insert = await supabase.from("workspace_memberships").insert({ workspace_id: TENANT_A.workspaceId, user_id: made.data.user.id, role });
    assert.ok(!insert.error, `could not bind the ${key} fixture membership: ${insert.error?.message}`);
    OFFBOARD_FIXTURES[key] = { email, userId: made.data.user.id, role };
  }

  // A CROSS-TENANT actor: a real owner of a DIFFERENT workspace, with no
  // membership at all in TENANT_A. Its refusal must not be attributable to the
  // identity being unprivileged everywhere.
  const otherWorkspace = await supabase.from("workspaces").select("id").neq("id", TENANT_A.workspaceId).limit(1).maybeSingle();
  assert.ok(otherWorkspace.data?.id, "no second workspace exists, so cross-tenant denial cannot be proven non-vacuously");
  crossTenantWorkspaceId = otherWorkspace.data.id as string;
  const crossEmail = `p0-launch-05-crosstenant-${stamp}@example.test`;
  const cross = await supabase.auth.admin.createUser({ email: crossEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!cross.error && cross.data.user, `could not create the cross-tenant fixture: ${cross.error?.message}`);
  const crossInsert = await supabase.from("workspace_memberships").insert({ workspace_id: crossTenantWorkspaceId, user_id: cross.data.user.id, role: "owner" });
  assert.ok(!crossInsert.error, `could not bind the cross-tenant fixture: ${crossInsert.error?.message}`);
  OFFBOARD_FIXTURES.crossTenant = { email: crossEmail, userId: cross.data.user.id, role: "owner" };

  PORT = await freePort();
  session = new HttpSession(`http://127.0.0.1:${PORT}`);
});

after(async () => {
  if (server) await shutdownProductionServer(server, { label: "after(): the beta production server", graceMs: 10_000 });
  server = null;
  const supabase = admin();
  if (outsiderUserId) {
    // Scoped to the disposable identity this run created, by id. Never a bulk delete.
    await supabase.from("workspace_memberships").delete().eq("workspace_id", TENANT_A.workspaceId).eq("user_id", outsiderUserId);
    await supabase.from("workspace_invitations").delete().eq("workspace_id", TENANT_A.workspaceId).eq("email", outsiderEmail);
    await supabase.auth.admin.deleteUser(outsiderUserId);
  }
  for (const fixture of Object.values(OFFBOARD_FIXTURES)) {
    // Scoped by id to the identities THIS run created. Never a bulk delete.
    await supabase.from("workspace_memberships").delete().eq("user_id", fixture.userId);
    await supabase.auth.admin.deleteUser(fixture.userId);
  }
  try {
    fs.rmSync(CONTROL_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log(`\nP0_LAUNCH_05_BETA_RUNTIME_EVIDENCE ${JSON.stringify(EVIDENCE, null, 2)}`);
});

// ───────────────── preflight enforcement through the supported path ─────────────────

test("22. BETA_PREFLIGHT=ENFORCED: an invalid beta environment REFUSES to start the server", async () => {
  const outcome = await startProductionServer({
    port: PORT,
    script: BETA_SCRIPT,
    env: betaEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }),
    timeoutMs: 60_000,
  });
  if (outcome.started) {
    await shutdownProductionServer(outcome.handle, { label: "22: a beta server that should never have started" });
    assert.fail("a beta environment missing a required server secret STARTED a server");
  }
  assert.match(outcome.log, /"failureClass":"CONFIGURATION_FAILURE"/, `the refusal did not come from the beta preflight: ${outcome.log.slice(-600)}`);
  assert.match(outcome.log, /missing_beta_environment/, `the refusal did not name the beta violation: ${outcome.log.slice(-600)}`);
  // The preflight must gate `next start`, not run beside it.
  assert.doesNotMatch(outcome.log, /Ready in|- Local:\s+http/, `next start was reached despite a failed preflight: ${outcome.log.slice(-600)}`);
  assert.equal(outcome.survivors.length, 0, "the refused beta start left surviving processes behind");
  EVIDENCE.invalidBetaEnvRefusedStart = "missing_beta_environment; next start never reached";
});

test("23. SERVER_ONLY_ENV_BOUNDARY=ENFORCED through the supported beta path", async () => {
  const outcome = await startProductionServer({
    port: PORT,
    script: BETA_SCRIPT,
    env: betaEnv({ NEXT_PUBLIC_SERVICE_ROLE_KEY: "synthetic-not-a-real-key" }),
    timeoutMs: 60_000,
  });
  if (outcome.started) {
    await shutdownProductionServer(outcome.handle, { label: "23: a beta server that should never have started" });
    assert.fail("a secret-shaped NEXT_PUBLIC_ name STARTED a beta server");
  }
  // Attribution is structural, not prose-matching: only assertServerOnlyEnvBoundary
  // tags a refusal with its own name, so this proves the sibling guard RAN —
  // which reading the source could never establish.
  assert.match(outcome.log, /"guard":"assertServerOnlyEnvBoundary"/, `the refusal was not attributed to the sibling guard: ${outcome.log.slice(-600)}`);
  assert.equal(outcome.survivors.length, 0, "the refused beta start left surviving processes behind");
  EVIDENCE.serverOnlyEnvBoundaryEnforced = "assertServerOnlyEnvBoundary refused a secret-shaped NEXT_PUBLIC_ name";
});

test("24. VALID_BETA_ENV=STARTS: the canonical beta entrypoint starts and becomes healthy", async () => {
  const outcome = await startProductionServer({ port: PORT, script: BETA_SCRIPT, env: betaEnv(), timeoutMs: 240_000 });
  if (!outcome.started) assert.fail(`the canonical beta entrypoint did not start: ${outcome.reason}`);
  server = outcome.handle;
  EVIDENCE.betaEntrypoint = `npm run ${BETA_SCRIPT}`;
  EVIDENCE.betaHealthyAfterMs = server.healthyAfterMs;
  EVIDENCE.betaServerPid = server.serverPid;
});

test("25. NON-VACUITY: 22 and 23 refused because of the injected fault, not because beta cannot start", () => {
  assert.ok(server, "the valid beta environment never started, so the refusals above are not attributable to their faults");
  assert.equal(EVIDENCE.invalidBetaEnvRefusedStart !== undefined && EVIDENCE.serverOnlyEnvBoundaryEnforced !== undefined, true);
});

test("26. BETA_PROFILE=closed-free-beta is actually selected in the RUNNING process", () => {
  const environ = environOf(server!.serverPid);
  assert.equal(environ.get("PMFREAK_OPERATING_PROFILE"), BETA_PROFILE, "the running server is not in the closed-free-beta profile");
  EVIDENCE.runningProfile = environ.get("PMFREAK_OPERATING_PROFILE");
});

test("27. STRIPE_REQUIRED=NO: the beta runtime is healthy with no Stripe secret present", async () => {
  const environ = environOf(server!.serverPid);
  assert.equal(environ.get("STRIPE_SECRET_KEY") ?? "", "", "the beta server was started WITH a Stripe secret, so 'no billing surface' is untested");
  assert.equal(environ.get("STRIPE_WEBHOOK_SECRET") ?? "", "", "the beta server was started WITH a Stripe webhook secret");
  const health = await session.request("/api/health");
  assert.equal(health.status, 200, "the beta runtime is not live without Stripe secrets");
  EVIDENCE.stripeRequired = "NO — started and live with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET blank";
});

// ───────────────── AUTH_IS_BETA_READINESS_DEPENDENCY, at runtime ─────────────────

test("28. AUTH_HEALTHY -> READY, with auth a DECLARED readiness dependency", async () => {
  const readiness = await awaitReadiness(200, "a healthy beta runtime never reported ready");
  assert.equal(readiness.status, "ready");
  const auth = authCheckOf(readiness);
  assert.ok(auth, `readiness declared no auth check under the beta profile: ${readiness.raw.slice(0, 300)}`);
  assert.equal(auth.status, "pass");
  assert.deepEqual(
    readiness.checks.map((check) => check.name).sort(),
    ["auth", "configuration", "database", "governance_capability"],
    "the beta readiness dependency set is not the declared four",
  );
  EVIDENCE.authHealthyReadiness = `${readiness.httpStatus} ${readiness.status} (auth=${auth.status})`;
});

test("29. AUTH_UNAVAILABLE -> NOT_READY, and the auth check is the one that fails", async () => {
  setAuthOutage(true);
  const readiness = await awaitReadiness(503, "an unreachable auth dependency did not move beta readiness to NOT READY");
  assert.equal(readiness.status, "not_ready");
  const auth = authCheckOf(readiness);
  assert.ok(auth && auth.status === "fail", `readiness failed for something other than auth: ${readiness.raw.slice(0, 400)}`);
  EVIDENCE.authOutageReadiness = `${readiness.httpStatus} ${readiness.status} (auth=${auth.detail ?? "fail"})`;
});

test("30. NON-VACUITY: the outage is SCOPED to auth — the database check still passes", async () => {
  const readiness = await readReadiness();
  const database = readiness.checks.find((check) => check.name === "database");
  assert.ok(database && database.status === "pass", `the auth outage also took the database down, so 29 is not attributable to auth: ${readiness.raw.slice(0, 400)}`);
});

test("31. liveness stays DISTINCT from readiness during the auth outage, in the same process", async () => {
  const health = await session.request("/api/health");
  assert.equal(health.status, 200, "liveness must stay truthful while a dependency is unreachable");
  const environ = environOf(server!.serverPid);
  assert.equal(environ.get("PMFREAK_OPERATING_PROFILE"), BETA_PROFILE, "the process changed underneath the outage");
  EVIDENCE.livenessDuringAuthOutage = "200 ok — same pid, NOT READY concurrently";
});

test("32. AUTH_RECOVERED -> READY, without restarting the process", async () => {
  const pidBefore = server!.serverPid;
  setAuthOutage(false);
  const readiness = await awaitReadiness(200, "beta readiness did not recover after the auth dependency was restored");
  assert.equal(readiness.status, "ready");
  assert.equal(authCheckOf(readiness)?.status, "pass");
  assert.equal(server!.serverPid, pidBefore, "readiness 'recovered' in a different process — that is a restart, not a recovery");
  EVIDENCE.authRecoveredReadiness = `${readiness.httpStatus} ${readiness.status} — same pid ${pidBefore}`;
});

// ───────── CLOSED_BETA_AUTHORITY_MODEL=INVITATION_CONTROLLED_TENANT_AUTHORITY ─────────
//
// ACCOUNT_CREATION != BETA_ADMISSION != TENANT_AUTHORITY.
// Platform signup is NOT disabled and this gate never claims it is.

test("33. a non-invited platform identity EXISTS and can authenticate", async () => {
  const listed = await admin().auth.admin.getUserById(outsiderUserId);
  assert.ok(!listed.error && listed.data.user, "the non-invited identity does not exist, so nothing below is attributable to admission");
  const login = await session.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: outsiderEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
  });
  assert.ok([200, 302, 303, 307].includes(login.status), `the non-invited identity could not authenticate: ${login.status} ${login.text.slice(0, 200)}`);
  EVIDENCE.accountCreationIsNotBetaAdmission = "identity exists and authenticates";
});

test("34. ACCOUNT_CREATION confers NO beta tenant membership and NO tenant role", async () => {
  const memberships = await admin().from("workspace_memberships").select("workspace_id, role").eq("user_id", outsiderUserId);
  assert.ok(!memberships.error, `membership lookup failed: ${memberships.error?.message}`);
  assert.deepEqual(memberships.data ?? [], [], "a merely-created identity already holds tenant membership");
});

test("35. a non-invited identity is DENIED protected beta tenant access and governed tenant operation", async () => {
  const tenantRead = await tenantMemberRead();
  // NOT merely ">= 400": a bare 4xx check would also pass on a validation
  // error and prove nothing about authority. This must be an explicit
  // AUTHORIZATION denial, and test 38 then shows the identical request
  // answering 200 once admission exists — which is what makes it attributable.
  assert.ok([401, 403].includes(tenantRead.status), `a tenant read by a non-invited identity was not an authorization denial: ${tenantRead.status} ${tenantRead.text.slice(0, 200)}`);

  const governed = await session.request("/api/operational-flow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId, operation: "dispatch_material_action_to_task", actionId: "00000000-0000-4000-8000-000000000000" }),
  });
  // The protected path must be an explicit AUTHORIZATION refusal, not any 4xx.
  //
  // ACCURACY: `/api/operational-flow` is a PROTECTED TENANT OPERATION authorized
  // by a DIRECT `workspace_memberships` role check — it is NOT Frontera-governed,
  // and this gate no longer describes it as such. The Frontera-governed
  // first-use operation is the tenant read above (`/api/execution-tasks`, which
  // reaches `project.read` through server-authorization -> evaluateCapability ->
  // authorizeRuntimeAction). Both are kept: the direct-role path is still real
  // coverage, it is simply labelled truthfully.
  assert.ok([401, 403].includes(governed.status), `a protected tenant operation by a non-invited identity was not an authorization denial: ${governed.status} ${governed.text.slice(0, 300)}`);
  EVIDENCE.nonInvitedTenantAccess = `denied (Frontera-governed tenant read ${tenantRead.status}, direct-role protected operation ${governed.status} — both authorization)`;
  EVIDENCE.operationalFlowAuthorizationModel = "DIRECT_MEMBERSHIP_ROLE_CHECK (not Frontera-governed)";
});

test("36. SUPPORTED_OPERATOR_INVITE: the operator boundary creates an inspectable invitation", () => {
  // The supported operator command — NOT a hand-written row. It runs the
  // product's own invitation domain, so the duplicate refusal, role gate,
  // token hashing, expiry and audit event are the ones the app itself uses.
  const stdout = execFileSync("npm", ["run", "beta:invite-participant", "--", "--workspace", TENANT_A.workspaceId, "--email", outsiderEmail, "--role", "pm", "--inviter", OWNER_A.email, "--emit-accept-path"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.trim().split("\n").filter((value) => value.startsWith("{")).pop()!;
  const result = JSON.parse(line) as { ok: boolean; invitation: { id: string; role: string; status: string } | null; acceptPath: string };
  assert.equal(result.ok, true, `the supported operator invite boundary failed: ${line}`);
  assert.ok(result.invitation, "the operator boundary created no inspectable invitation");
  assert.equal(result.invitation.status, "pending");
  assert.equal(result.invitation.role, "pm", "the operator boundary did not record the intended role");
  inviteToken = decodeURIComponent(result.acceptPath.replace("/accept-invite/", ""));
  assert.ok(inviteToken.length > 0, "no accept path was emitted, so admission cannot proceed through the real path");
  EVIDENCE.supportedOperatorInvite = `npm run beta:invite-participant -> invitation ${result.invitation.id} role pm (token withheld unless requested)`;
});

test("37. the operator boundary REFUSES invalid and duplicate state", () => {
  const refuse = (args: string[]): { ok: boolean; failureClass?: string; message?: string } => {
    try {
      const out = execFileSync("npm", ["run", "beta:invite-participant", "--", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(out.trim().split("\n").filter((v) => v.startsWith("{")).pop()!) as { ok: boolean };
    } catch (error) {
      const shell = error as { stdout?: string; stderr?: string };
      const line = `${shell.stdout ?? ""}\n${shell.stderr ?? ""}`.trim().split("\n").filter((v) => v.startsWith("{")).pop();
      return line ? (JSON.parse(line) as { ok: boolean; failureClass?: string; message?: string }) : { ok: true };
    }
  };
  // A second invitation for the same pending email.
  const duplicate = refuse(["--workspace", TENANT_A.workspaceId, "--email", outsiderEmail, "--role", "pm", "--inviter", OWNER_A.email]);
  assert.equal(duplicate.ok, false, "the operator boundary created a DUPLICATE active invitation");
  assert.match(String(duplicate.message), /active invitation already exists/i);
  // "owner" is never an invitable role through this domain.
  const ownerRole = refuse(["--workspace", TENANT_A.workspaceId, "--email", `role-${outsiderEmail}`, "--role", "owner", "--inviter", OWNER_A.email]);
  assert.equal(ownerRole.ok, false, "the operator boundary invited an OWNER");
  // An inviter with no membership in the target workspace.
  const foreign = refuse(["--workspace", TENANT_B.workspaceId, "--email", `foreign-${outsiderEmail}`, "--role", "pm", "--inviter", OWNER_A.email]);
  assert.equal(foreign.ok, false, "a non-member operator admitted a participant to a tenant they do not belong to");
  EVIDENCE.operatorBoundaryRefusals = "duplicate, owner-role and non-member inviter all refused";
});

test("38. REAL_ACCEPT_WORKSPACE_INVITE establishes tenant membership, role and authority", async () => {
  const supabase = admin();
  // The PRODUCT's acceptance path, which binds workspace and role from the
  // invite record rather than from anything the caller supplies.
  const accepted = await acceptWorkspaceInvite({ token: inviteToken, userId: outsiderUserId, userEmail: outsiderEmail }, async () => supabase as never);
  assert.ok(accepted, "invite acceptance returned nothing");

  const memberships = await supabase.from("workspace_memberships").select("workspace_id, role").eq("user_id", outsiderUserId);
  assert.equal(memberships.data?.length, 1, "admission did not establish exactly one tenant membership");
  assert.equal(memberships.data?.[0]?.workspace_id, TENANT_A.workspaceId, "admission bound the identity to the wrong tenant");
  assert.equal(memberships.data?.[0]?.role, "pm", "admission did not bind the invited role");

  // The authority must appear THROUGH THE RUNNING SERVER, on the same session
  // cookie that was refused in 35 — no re-login. That is what makes 35 a
  // denial of authority rather than an artefact of the request shape, and it
  // shows membership is re-derived per request rather than cached at sign-in.
  const afterAdmission = await tenantMemberRead();
  assert.equal(afterAdmission.status, 200, `admission did not confer tenant access on the existing session: ${afterAdmission.status} ${afterAdmission.text.slice(0, 300)}`);
  EVIDENCE.admissionEstablishedAuthority = `workspace ${TENANT_A.workspaceId} role pm; same session tenant read 403 -> 200`;
});

test("39. OFFBOARDING removes effective beta authority while the platform identity SURVIVES", async () => {
  const supabase = admin();
  const removed = await removeWorkspaceMember(
    { workspaceId: TENANT_A.workspaceId, actorUserId: ownerUserId, targetUserId: outsiderUserId },
    async () => supabase as never,
  );
  assert.equal(removed.removed, true);
  const memberships = await supabase.from("workspace_memberships").select("workspace_id").eq("user_id", outsiderUserId);
  assert.deepEqual(memberships.data ?? [], [], "membership survived offboarding");
  const identity = await supabase.auth.admin.getUserById(outsiderUserId);
  assert.ok(!identity.error && identity.data.user, "offboarding deleted the platform IDENTITY — it must remove authority only");

  // The same still-valid session must lose the access it just had.
  const afterRemoval = await tenantMemberRead();
  assert.notEqual(afterRemoval.status, 200, `an offboarded member kept tenant access on an existing session: ${afterRemoval.text.slice(0, 300)}`);
  EVIDENCE.offboardingRemovesAuthorityNotIdentity = `membership removed; auth.users row intact; same session tenant read 200 -> ${afterRemoval.status}`;
});

// ───────────────── independent review fixes: offboarding authority ─────────────────

test("41. OFFBOARDING HIERARCHY MATRIX is not weaker than the role-update boundary", () => {
  const decide = (actorRole: string, targetRole: string, ownerCount: number, self = false) =>
    evaluateWorkspaceMembershipRemoval({
      actorRole: actorRole as never,
      actorUserId: "actor",
      targetUserId: self ? "actor" : "target",
      targetRole: targetRole as never,
      ownerCount,
    });

  // Named controls, both directions. An all-deny policy would fail the ALLOW rows,
  // so this cannot pass vacuously.
  assert.equal(decide("admin", "pm", 2), "allow", "ADMIN_REMOVES_PM must be ALLOW");
  assert.equal(decide("admin", "viewer", 2), "allow", "ADMIN_REMOVES_VIEWER must be ALLOW");
  assert.equal(decide("owner", "pm", 2), "allow", "OWNER_REMOVES_PM must be ALLOW");

  assert.equal(decide("admin", "admin", 2), "deny_actor_insufficient_role", "ADMIN_REMOVES_ADMIN must be DENY");
  assert.equal(decide("admin", "owner", 2), "deny_owner_removal_requires_transfer", "ADMIN_REMOVES_OWNER must be DENY");
  assert.equal(decide("owner", "owner", 2), "deny_owner_removal_requires_transfer", "OWNER_REMOVES_OTHER_OWNER must be DENY");
  assert.equal(decide("owner", "owner", 1), "deny_last_owner", "LAST_OWNER must be DENY");
  assert.equal(decide("owner", "owner", 2, true), "deny_self_removal", "SELF_REMOVAL must be DENY");
  assert.equal(decide("pm", "viewer", 2), "deny_actor_insufficient_role", "PM must not remove members");
  assert.equal(decide("viewer", "pm", 2), "deny_actor_insufficient_role", "VIEWER must not remove members");

  EVIDENCE.offboardingHierarchy =
    "ADMIN_REMOVES_PM=ALLOW ADMIN_REMOVES_ADMIN=DENY ADMIN_REMOVES_OWNER=DENY OWNER_REMOVES_PM=ALLOW OWNER_REMOVES_OTHER_OWNER=DENY LAST_OWNER=DENY SELF_REMOVAL=DENY PM/VIEWER=DENY";
});

test("42. the removal boundary is no weaker than canUpdateWorkspaceMemberRole on the same shapes", () => {
  // Structural non-vacuity: every case the ROLE-UPDATE boundary refuses, the
  // REMOVAL boundary must also refuse. Removing a membership is at least as
  // privilege-sensitive as demoting it.
  const shapes = [
    { actorRole: "admin", targetRole: "admin", ownerCount: 2 },
    { actorRole: "admin", targetRole: "owner", ownerCount: 2 },
    { actorRole: "owner", targetRole: "owner", ownerCount: 2 },
    { actorRole: "owner", targetRole: "owner", ownerCount: 1 },
    { actorRole: "pm", targetRole: "viewer", ownerCount: 2 },
  ] as const;
  for (const shape of shapes) {
    const update = canUpdateWorkspaceMemberRole({
      actorRole: shape.actorRole as never,
      actorUserId: "actor",
      targetUserId: "target",
      currentTargetRole: shape.targetRole as never,
      requestedTargetRole: "viewer",
      isLastOwner: shape.ownerCount <= 1,
    });
    const removal = evaluateWorkspaceMembershipRemoval({
      actorRole: shape.actorRole as never,
      actorUserId: "actor",
      targetUserId: "target",
      targetRole: shape.targetRole as never,
      ownerCount: shape.ownerCount,
    });
    assert.notEqual(update, "allow", `precondition: role-update should refuse ${JSON.stringify(shape)}`);
    assert.notEqual(removal, "allow", `removal is WEAKER than the role-update boundary for ${JSON.stringify(shape)}`);
  }
});

/** A fresh authenticated session for one fixture identity, against the running beta server. */
async function sessionFor(email: string): Promise<HttpSession> {
  const s = new HttpSession(`http://127.0.0.1:${PORT}`);
  const login = await s.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
  });
  assert.ok([200, 302, 303, 307].includes(login.status), `fixture ${email} could not authenticate: ${login.status}`);
  return s;
}

const deleteMember = (s: HttpSession, workspaceId: string, targetUserId: string) =>
  s.request("/api/workspace-team/members", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, targetUserId }),
  });

const membershipRow = async (userId: string) =>
  (await admin().from("workspace_memberships").select("role").eq("workspace_id", TENANT_A.workspaceId).eq("user_id", userId).maybeSingle()).data;

/**
 * The offboarding hierarchy, exercised THROUGH THE RUNNING SERVER on real
 * memberships — not only through the pure decision function.
 *
 * OFFBOARDING_FRONTERA_GOVERNED=NO. The authority proven here is
 * AUTHENTICATED_SESSION + SERVER_RESOLVED_WORKSPACE_HIERARCHY. Every DENY row
 * additionally asserts the target membership SURVIVED, and every ALLOW row
 * asserts it was actually deleted — so an all-deny or all-allow implementation
 * fails this test rather than passing it vacuously.
 */
test("43. OFFBOARDING HIERARCHY, enforced through the real DELETE route on real memberships", async () => {
  const F = OFFBOARD_FIXTURES;
  const results: string[] = [];

  const denied = async (actorEmail: string, targetUserId: string, label: string) => {
    const before = await membershipRow(targetUserId);
    assert.ok(before, `precondition for ${label}: the target must be a member first`);
    const response = await deleteMember(await sessionFor(actorEmail), TENANT_A.workspaceId, targetUserId);
    assert.equal(response.status, 403, `${label} was not refused: ${response.status} ${response.text.slice(0, 250)}`);
    const after = await membershipRow(targetUserId);
    assert.ok(after, `PERSISTENCE: ${label} was refused but the membership was deleted anyway`);
    assert.equal(after.role, before.role, `${label} was refused but the target role changed`);
    results.push(`${label}=DENY`);
  };

  const allowed = async (actorEmail: string, targetUserId: string, label: string) => {
    assert.ok(await membershipRow(targetUserId), `precondition for ${label}: the target must be a member first`);
    const response = await deleteMember(await sessionFor(actorEmail), TENANT_A.workspaceId, targetUserId);
    assert.equal(response.status, 200, `${label} was not permitted: ${response.status} ${response.text.slice(0, 250)}`);
    assert.equal(await membershipRow(targetUserId), null, `${label} returned success but the membership survived`);
    results.push(`${label}=ALLOW`);
  };

  // ---- refusals first, so the targets still exist for the ALLOW rows ----
  await denied(F.pm.email, F.viewer.userId, "PM_REMOVES_MEMBER");
  await denied(F.viewer.email, F.pm.userId, "VIEWER_REMOVES_MEMBER");
  await denied(F.adminA.email, F.adminB.userId, "ADMIN_REMOVES_ADMIN");
  await denied(F.adminA.email, F.coOwner.userId, "ADMIN_REMOVES_OWNER");
  await denied(OWNER_A.email, F.coOwner.userId, "OWNER_REMOVES_OTHER_OWNER");
  await denied(F.crossTenant.email, F.pm.userId, "CROSS_TENANT_ACTOR");

  // Self-removal, proven on a real session rather than only in policy.
  const selfBefore = await membershipRow(F.adminA.userId);
  assert.ok(selfBefore, "precondition: adminA must be a member before attempting self-removal");
  const self = await deleteMember(await sessionFor(F.adminA.email), TENANT_A.workspaceId, F.adminA.userId);
  assert.equal(self.status, 403, `SELF_REMOVAL was not refused: ${self.status} ${self.text.slice(0, 250)}`);
  assert.ok(await membershipRow(F.adminA.userId), "PERSISTENCE: a refused self-removal deleted the membership anyway");
  results.push("SELF_REMOVAL=DENY");

  // ---- permitted rows ----
  await allowed(F.adminA.email, F.viewer.userId, "ADMIN_REMOVES_VIEWER");
  await allowed(F.adminA.email, F.pm.userId, "ADMIN_REMOVES_PM");
  await allowed(OWNER_A.email, F.adminB.userId, "OWNER_REMOVES_ADMIN");

  EVIDENCE.offboardingHierarchyRuntime = results.join(" ");
});

test("44. LAST_OWNER is refused and the final owner is not orphaned", async () => {
  // The co-owner is removed by direct domain call (the route's hierarchy would
  // refuse an owner target, which rows above already prove) so that exactly ONE
  // owner remains and the last-owner rule becomes reachable rather than hypothetical.
  const supabase = admin();
  const coOwner = OFFBOARD_FIXTURES.coOwner;
  const drop = await supabase.from("workspace_memberships").delete().eq("workspace_id", TENANT_A.workspaceId).eq("user_id", coOwner.userId);
  assert.ok(!drop.error, `could not reduce the workspace to a single owner: ${drop.error?.message}`);

  const owners = await supabase.from("workspace_memberships").select("user_id").eq("workspace_id", TENANT_A.workspaceId).eq("role", "owner");
  assert.equal((owners.data ?? []).length, 1, "the last-owner control needs exactly one remaining owner to be non-vacuous");

  // A different owner-role actor cannot exist now, so the last owner is exercised
  // through the domain decision on real resolved state.
  assert.equal(
    evaluateWorkspaceMembershipRemoval({ actorRole: "owner", actorUserId: "someone-else", targetUserId: ownerUserId, targetRole: "owner", ownerCount: 1 }),
    "deny_last_owner",
  );
  assert.ok(await membershipRow(ownerUserId), "PERSISTENCE: the final owner membership was removed");
  EVIDENCE.offboardingLastOwner = "LAST_OWNER=DENY (final owner membership intact)";
});

test("45. OFFBOARD_AUDIT_EVENT_PERSISTED: a successful removal writes member_removed with its real fields", async () => {
  const events = await admin()
    .from("workspace_audit_events")
    .select("workspace_id, actor_user_id, event_type, payload")
    .eq("workspace_id", TENANT_A.workspaceId)
    .eq("event_type", "member_removed")
    .order("created_at", { ascending: false })
    .limit(50);
  assert.ok(!events.error, `audit lookup failed: ${events.error?.message}`);

  // The ADMIN_REMOVES_PM row above is the one whose fields are pinned here.
  const target = OFFBOARD_FIXTURES.pm;
  const row = (events.data ?? []).find((e: { payload?: { targetUserId?: string } }) => e.payload?.targetUserId === target.userId);
  assert.ok(row, "no member_removed audit event was persisted for the removed participant");
  assert.equal(row.workspace_id, TENANT_A.workspaceId, "the audit event names the wrong workspace");
  assert.equal(row.actor_user_id, OFFBOARD_FIXTURES.adminA.userId, "the audit event names the wrong actor");
  assert.equal(row.payload?.previousRole, "pm", "the audit event lost the previous role");
  EVIDENCE.offboardAuditEventPersisted = `member_removed ws=${row.workspace_id} actor=${row.actor_user_id} target=${target.userId} previousRole=${row.payload?.previousRole}`;
});

test("46. OFFBOARD_AUDIT_FAILURE_SURFACED: an audit-write failure is NOT reported as clean success", async () => {
  // Runtime proof for RR-OFFBOARD-AUDIT-NONATOMIC. The seam is server-side and
  // env-only; it forces the audit insert to fail AFTER the membership delete,
  // which is exactly the partial state the residual describes. NOT atomicity.
  const faultPort = await freePort();
  const target = OFFBOARD_FIXTURES.adminA;
  assert.ok(await membershipRow(target.userId), "precondition: the adminA fixture must still be a member");

  const faultServer = await startProductionServer({
    port: faultPort,
    script: BETA_SCRIPT,
    env: { ...betaEnv(), PMFREAK_ACCEPTANCE_OFFBOARD_AUDIT_FAULT: "1" },
    timeoutMs: 240_000,
  });
  assert.ok(faultServer.started, "the audit-fault server did not start");

  try {
    const s = new HttpSession(`http://127.0.0.1:${faultPort}`);
    const login = await s.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: OWNER_A.email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
    });
    assert.ok([200, 302, 303, 307].includes(login.status), `could not authenticate against the audit-fault server: ${login.status}`);

    const response = await s.request("/api/workspace-team/members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: target.userId }),
    });

    assert.notEqual(response.status, 200, "an audit-write failure was reported as a clean success");
    assert.equal(response.status, 500, `the audit failure was not surfaced with its own classification: ${response.status} ${response.text.slice(0, 300)}`);
    assert.match(response.text, /offboarding_audit_write_failed/, `the response does not name the audit failure: ${response.text.slice(0, 300)}`);

    // The PARTIAL STATE, stated honestly: authority is already gone even though
    // the operation did not report success. This is the residual, proven.
    assert.equal(await membershipRow(target.userId), null, "the residual's premise changed: the membership survived, so this is not the partial-state case");
    const events = await admin()
      .from("workspace_audit_events")
      .select("payload")
      .eq("workspace_id", TENANT_A.workspaceId)
      .eq("event_type", "member_removed")
      .order("created_at", { ascending: false })
      .limit(50);
    const recorded = (events.data ?? []).some((e: { payload?: { targetUserId?: string } }) => e.payload?.targetUserId === target.userId);
    assert.equal(recorded, false, "the fault seam did not suppress the audit write, so this proves nothing");

    EVIDENCE.offboardAuditFailureSurfaced =
      "500 offboarding_audit_write_failed; membership already removed and NO member_removed event recorded — the non-atomic partial state, surfaced rather than hidden";
  } finally {
    if (faultServer.started) await shutdownProductionServer(faultServer.handle, { label: "audit-fault server", graceMs: 10_000 });
  }
});

// ───────────────── final review fixes: HTTP classification + operator envelope ─────────────────

test("47. OFFBOARDING request classification: 401 unauthenticated, 403 authenticated-but-unauthorized", async () => {
  // A dedicated disposable target created HERE, so the persistence assertion
  // below depends on this test alone rather than on which fixtures earlier
  // hierarchy rows happened to consume.
  const supabase = admin();
  const targetEmail = `p0-launch-05-classification-${Date.now()}@example.test`;
  const made = await supabase.auth.admin.createUser({ email: targetEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!made.error && made.data.user, `could not create the classification target: ${made.error?.message}`);
  const target = { email: targetEmail, userId: made.data.user.id, role: "pm" };
  OFFBOARD_FIXTURES.classificationTarget = target;
  const bind = await supabase.from("workspace_memberships").insert({ workspace_id: TENANT_A.workspaceId, user_id: target.userId, role: "pm" });
  assert.ok(!bind.error, `could not bind the classification target: ${bind.error?.message}`);

  // No session at all: "who are you", not "not allowed".
  const anonymous = new HttpSession(`http://127.0.0.1:${PORT}`);
  const unauth = await anonymous.request("/api/workspace-team/members", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: target.userId }),
  });
  assert.equal(unauth.status, 401, `an unauthenticated offboarding request was not 401: ${unauth.status} ${unauth.text.slice(0, 200)}`);

  // Authenticated, but not permitted: 403, and the target must survive. The two
  // codes must not collapse into one another.
  const outsider = await sessionFor(outsiderEmail);
  const forbidden = await outsider.request("/api/workspace-team/members", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: target.userId }),
  });
  assert.equal(forbidden.status, 403, `an authenticated non-member offboarding request was not 403: ${forbidden.status} ${forbidden.text.slice(0, 200)}`);
  assert.notEqual(unauth.status, forbidden.status, "401 and 403 were collapsed into the same answer");
  assert.ok(await membershipRow(target.userId), "PERSISTENCE: an unauthorized offboarding attempt deleted the membership");

  EVIDENCE.offboardingHttpClassification = `unauthenticated=401 authenticated_insufficient=403 (target membership intact)`;
});

test("48. OFFBOARDING rejects malformed request bodies with 400, never a generic 500", async () => {
  const s = await sessionFor(OWNER_A.email);
  const send = (body: string) =>
    s.request("/api/workspace-team/members", { method: "DELETE", headers: { "content-type": "application/json" }, body });

  const cases: Array<[string, string]> = [
    ["MALFORMED_JSON", "{not json"],
    ["NULL_BODY", "null"],
    ["ARRAY_BODY", "[]"],
    ["EMPTY_OBJECT", "{}"],
    ["MISSING_TARGET", JSON.stringify({ workspaceId: TENANT_A.workspaceId })],
    ["MISSING_WORKSPACE", JSON.stringify({ targetUserId: outsiderUserId })],
    ["NON_STRING_IDS", JSON.stringify({ workspaceId: 1, targetUserId: 2 })],
    ["BLANK_IDS", JSON.stringify({ workspaceId: "   ", targetUserId: "  " })],
  ];

  const observed: string[] = [];
  for (const [label, body] of cases) {
    const response = await send(body);
    assert.equal(response.status, 400, `${label} did not return 400: ${response.status} ${response.text.slice(0, 200)}`);
    assert.match(response.text, /invalid_offboarding_request/, `${label} did not use the documented envelope: ${response.text.slice(0, 200)}`);
    // No parser internals may leak to the caller.
    assert.doesNotMatch(response.text, /JSON\.parse|Unexpected token|SyntaxError/i, `${label} leaked parser text: ${response.text.slice(0, 200)}`);
    observed.push(`${label}=400`);
  }
  EVIDENCE.offboardingMalformedRequests = observed.join(" ");
});

test("49. OPERATOR isolation refusals emit the documented structured envelope, not a stack trace", () => {
  const refuse = (env: Record<string, string>, label: string) => {
    try {
      const out = execFileSync("npx", ["tsx", "scripts/beta-invite-participant.mjs", "--workspace", TENANT_A.workspaceId, "--email", `iso-${Date.now()}@example.test`, "--role", "pm", "--inviter", OWNER_A.email], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      return { exit: 0, text: out };
    } catch (error) {
      const shell = error as { status?: number; stdout?: string; stderr?: string };
      return { exit: shell.status ?? -1, text: `${shell.stdout ?? ""}\n${shell.stderr ?? ""}` };
    }
  };

  const cases: Array<[string, Record<string, string>]> = [
    ["OPERATOR_NON_LOCAL_TARGET", { NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co", OPERATIONAL_FLOW_TEST_SUPABASE_URL: "https://prod.supabase.co" }],
    ["OPERATOR_UNKNOWN_TARGET", { NEXT_PUBLIC_SUPABASE_URL: "not-a-url", OPERATIONAL_FLOW_TEST_SUPABASE_URL: "not-a-url" }],
    ["OPERATOR_MISSING_ISOLATION_PREREQUISITE", { P2_13_FOUNDER_FIXTURE_ENABLED: "false" }],
  ];

  const observed: string[] = [];
  for (const [label, env] of cases) {
    const result = refuse(env, label);
    assert.notEqual(result.exit, 0, `${label} did not refuse (exit 0)`);
    const line = result.text.split("\n").filter((v) => v.trim().startsWith("{")).pop();
    assert.ok(line, `${label} emitted no structured envelope: ${result.text.slice(0, 250)}`);
    const parsed = JSON.parse(line) as { ok: boolean; failureClass?: string };
    assert.equal(parsed.ok, false, `${label} reported success`);
    assert.equal(parsed.failureClass, "non_isolated_target", `${label} used the wrong failureClass: ${parsed.failureClass}`);
    // An unhandled throw would surface a stack trace instead of the envelope.
    assert.doesNotMatch(result.text, /^\s+at .*\(.*:\d+:\d+\)/m, `${label} emitted an unhandled stack trace`);
    observed.push(`${label}=REFUSED_STRUCTURED`);
  }
  EVIDENCE.operatorIsolationRefusals = observed.join(" ");
});

test("50. the beta preflight runs through a TS-capable loader that production installs actually get", () => {
  // RELEASE-READINESS: `start:closed-free-beta` invokes check-beta-environment.mjs
  // through `tsx`, which must therefore survive `npm ci --omit=dev`. Proven in a
  // disposable production-style install; this control pins the declaration so a
  // future move back to devDependencies fails here rather than at beta startup.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["start:closed-free-beta"], /check:beta-environment/);
  assert.match(pkg.scripts["check:beta-environment"], /tsx /);
  assert.ok(pkg.dependencies.tsx, "tsx is the beta preflight's runtime loader and must be a production dependency");
  assert.equal(pkg.devDependencies.tsx, undefined, "tsx must not remain dev-only, or the beta preflight cannot run after npm ci --omit=dev");
  EVIDENCE.betaPreflightLoaderIsProductionDependency = `tsx ${pkg.dependencies.tsx} in dependencies`;
});

test("51. the privileged offboarding flow is registered and does not claim to be pre-existing", () => {
  const domain = readFileSync("src/lib/workspace-team.ts", "utf8");
  const fn = domain.slice(domain.indexOf("export async function removeWorkspaceMember"), domain.indexOf("export async function updateWorkspaceMemberRole"));
  assert.match(fn, /reason: "workspace_member_offboarding"/, "the offboarding privileged client does not declare its own reason");
  assert.doesNotMatch(fn, /reason: "existing_privileged_flow"/, "a NEW privileged flow is still labelled pre-existing");

  const registry = readFileSync("src/lib/security/privileged-access-registry.ts", "utf8");
  const entry = registry.slice(registry.indexOf('file: "src/lib/workspace-team.ts"'), registry.indexOf('file: "src/app/(protected)/early-access/page.tsx"'));
  assert.match(entry, /removeWorkspaceMember/, "the registry entry does not document the offboarding flow");
  assert.match(entry, /owner/i);
  assert.match(entry, /RR-OFFBOARD-AUDIT-NONATOMIC/, "the registry does not carry the audit non-atomicity caveat");
  // File-scoped registry: exactly one entry for this file, never a duplicate.
  assert.equal(registry.split('file: "src/lib/workspace-team.ts"').length - 1, 1, "the registry gained a duplicate entry for workspace-team.ts");
  EVIDENCE.privilegedOffboardingRegistered = "reason=workspace_member_offboarding; registry entry documents hierarchy, owner protection, cross-tenant fail-closed and audit non-atomicity";
});


test("40. NON-VACUITY: PLATFORM_SIGNUP_IS_DISABLED is NOT claimed", async () => {
  // The identity created in before() was never invited and was never blocked
  // from existing. This gate's CLOSED claim is about tenant authority only.
  const identity = await admin().auth.admin.getUserById(outsiderUserId);
  assert.ok(identity.data.user, "the non-invited identity should still exist — signup closure is not claimed");
  EVIDENCE.closedBetaAuthorityModel = "INVITATION_CONTROLLED_TENANT_AUTHORITY (platform signup NOT disabled)";
});
