/**
 * P0-LAUNCH-06 — Beta Release Rehearsal.
 *
 * This is not a re-run of P0-LAUNCH-05's unit-level contract. It rehearses the
 * ACCEPTED closed-beta operating model as an operator lifecycle, in order, on one
 * real server, so the evidence corresponds to a procedure we could actually follow
 * for a real participant:
 *
 *   startup boundary -> liveness -> readiness -> non-invited identity ->
 *   operator admission -> acceptance -> governed first use -> real tenant
 *   operation -> cross-tenant isolation -> dependency outage/recovery ->
 *   offboarding -> authority removal -> identity survival -> audit incident
 *
 * The load-bearing claim is the GOVERNED ACCESS LIFECYCLE: the same protected
 * Frontera-reached path answers 403 before admission, 200 after it, and 403 again
 * after offboarding, on one identity, through one running server.
 *
 * SCOPE, STATED RATHER THAN IMPLIED. This certifies the Next.js SERVER RUNTIME
 * boundary. It does not certify a hosted data tier, and it is not a deployment-time
 * claim. See the P0-LAUNCH-06 evidence document.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { acceptWorkspaceInvite, WorkspaceInviteError } from "../../src/lib/workspace-team";
import { getOnboardingRedirect } from "../../src/lib/auth/onboarding-route-map";
import { TENANT_A, TENANT_B } from "../../scripts/p2-13/founder-scenario-manifest.mjs";
import {
  HARNESS_PROCESS_RESIDUE,
  HttpSession,
  boundedFetch,
  freePort,
  nextBuildHelpProof,
  npmCliPath,
  runBoundedChild,
  shutdownProductionServer,
  startProductionServer,
  type ServerHandle,
  type StartOutcome,
} from "./support/runtime-acceptance";

const ROOT = process.cwd();
/** Finite ceilings for every synchronous child. Sized per operation, never one global value. */
const BUILD_TIMEOUT_MS = 15 * 60_000;   // the production build; observed ~5 min
const OPERATOR_TIMEOUT_MS = 90_000;     // an operator command against Auth/PostgREST
const LAUNCH_PROOF_TIMEOUT_MS = 60_000; // the X1 launch proof, which reaches the build binary but never builds
const BETA_PROFILE = "closed-free-beta";
const OUTAGE_SHIM = path.join(ROOT, "tests/acceptance/support/dependency-outage-shim.cjs");
const OWNER_A = TENANT_A.actors.find((a: { reference: string }) => a.reference.endsWith(":owner"))!;
/**
 * The npm CLI this gate launches its children with, resolved ONCE at load.
 *
 * Resolved here, at module scope, rather than at each call site, so a harness that
 * cannot launch npm at all fails loudly on load. Resolving it inside `operator()`
 * would put the fail-closed throw inside that helper's own try/catch, where a launch
 * failure is indistinguishable from the refusal its negative controls assert.
 */
const NPM_CLI = npmCliPath();

const EVIDENCE: Record<string, unknown> = {};

let CONTROL_DIR = "";
let SUPABASE_HOSTPORT = "";
let PORT = 0;
let server: ServerHandle | null = null;
let session: HttpSession;
let ownerUserId = "";
let participantEmail = "";
let participantUserId = "";
let inviteToken = "";
let inviteAcceptPath = "";
let foreignUserId = "";
let foreignEmail = "";

const admin = () =>
  createClient(process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL!, process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

function betaEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PMFREAK_OPERATING_PROFILE: BETA_PROFILE,
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${OUTAGE_SHIM}`.trim(),
    P0_LAUNCH_04_OUTAGE_DIR: CONTROL_DIR,
    P0_LAUNCH_04_OUTAGE_HOSTPORT: SUPABASE_HOSTPORT,
    P0_LAUNCH_04_OUTAGE_PATH_PREFIXES: "/auth/v1",
    ...overrides,
  };
}

/** Redirect statuses the participant chain may legitimately emit. */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
/**
 * Destinations that mean the accepted participant LOST authority rather than landed.
 * Deliberately narrow: only the login route and the trial denial already represented in
 * D1's route contract — not an invented URL blacklist.
 */
const AUTHENTICATION_LOSS_DESTINATIONS = new Set(["/login", "/trial-inactive"]);

/**
 * Walks the participant destination chain to a TERMINAL response.
 *
 * A redirect is not a landing. An earlier revision requested the destination invite
 * acceptance returned and then recorded it as final WITHOUT inspecting whether that
 * response was itself a redirect, so `accept -> /projects/new -> 302 /login` could report
 * `/projects/new` as the final destination while the participant had actually been
 * bounced to login.
 *
 * Every hop is validated (Location present, same origin, not an authentication-loss
 * destination), the chain is bounded to ONE continuation after the acceptance
 * destination, and nothing is reported until a non-redirect terminal response is
 * observed. `fetchImpl` is injectable purely so this contract can be proven against
 * synthetic chains; production callers use the bounded fetch.
 */
async function followParticipantDestination(
  input: { base: string; cookie: string; location: string },
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = boundedFetch,
): Promise<{ firstDestination: string; finalDestination: string; finalStatus: number; hops: number }> {
  const origin = new URL(input.base).origin;
  const validate = (raw: string | null, label: string): URL => {
    assert.ok(raw, `${label}: a redirect carried no Location header`);
    const resolved = new URL(raw!, input.base);
    assert.equal(resolved.origin, origin, `${label}: the participant was redirected off-origin to ${resolved.origin}`);
    assert.ok(
      !AUTHENTICATION_LOSS_DESTINATIONS.has(resolved.pathname),
      `${label}: the participant was routed to ${resolved.pathname}, so the newly accepted session was lost or denied`,
    );
    return resolved;
  };

  let current = validate(input.location, "invite acceptance");
  const firstDestination = current.pathname;
  let response = await fetchImpl(current.toString(), { headers: { cookie: input.cookie }, redirect: "manual" });
  let hops = 0;

  while (REDIRECT_STATUSES.includes(response.status)) {
    hops += 1;
    // Validate BEFORE the depth bound so the diagnostic names the real problem: a second
    // hop to /login is an authentication loss, not merely a chain that ran too long.
    current = validate(response.headers.get("location"), `continuation ${hops}`);
    assert.ok(
      hops <= 1,
      `INVITE_DESTINATION_REDIRECT_DEPTH_EXCEEDED: the participant chain did not terminate within one continuation after ${firstDestination} (reached ${current.pathname})`,
    );
    response = await fetchImpl(current.toString(), { headers: { cookie: input.cookie }, redirect: "manual" });
  }

  // TERMINAL ONLY. A non-redirect response that still denies or errors is not a landing.
  assert.ok(![401, 403].includes(response.status), `the accepted participant was DENIED ${current.pathname}: ${response.status}`);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `the participant destination ${current.pathname} did not terminate successfully: ${response.status}`,
  );
  return { firstDestination, finalDestination: current.pathname, finalStatus: response.status, hops };
}

/** The certified governed first-use path: project.read, reached through Frontera. */
const governedFirstUse = (s: HttpSession) =>
  s.request(`/api/execution-tasks?projectId=${encodeURIComponent(TENANT_A.projectId)}`);

// A failed query must never read as "no membership". Absence is only provable once the
// query itself is known to have succeeded, so the error is asserted before the null is
// interpreted — otherwise an outage silently satisfies every negative membership check.
/**
 * A rehearsal may not PASS while leaking a process. Every shutdown outcome is inspected
 * here, and the shared HARNESS_PROCESS_RESIDUE ledger is asserted empty at final
 * teardown — the stronger pattern P0-LAUNCH-03 and P0-LAUNCH-04 already use, which this
 * file was the only acceptance gate not to follow.
 */
function assertShutdownClean(outcome: { orphans?: number[]; unreaped?: number[] }, label: string): void {
  assert.deepEqual(outcome.orphans ?? [], [], `${label} left orphan process(es) behind`);
  assert.deepEqual(outcome.unreaped ?? [], [], `${label} left unreaped process(es) behind`);
}

/**
 * A REQUIRED start that did not start still has cleanup to account for.
 *
 * `startProductionServer` reaps a failed start itself, but it can come back with
 * `reaped: false` or a non-empty `survivors` list — and on the failure path there is no
 * handle, so nothing was ever assigned to `server` and the final teardown has nothing to
 * retry. Asserting `outcome.started` alone therefore throws while a known process is
 * still running and never appears in any ledger.
 *
 * So the failure is RECORDED first, in the same ledger the final control asserts empty,
 * and only then re-raised. `assertStarted` is used at every required start site.
 */
function assertStarted(outcome: StartOutcome, label: string): ServerHandle {
  if (outcome.started) return outcome.handle;
  if (!outcome.reaped || outcome.survivors.length > 0) {
    HARNESS_PROCESS_RESIDUE.push({ control: `${label} (failed start)`, orphans: outcome.survivors, unreaped: [] });
  }
  assert.fail(
    `${label} did not start: ${outcome.reason} ` +
      `[launcherPid=${outcome.launcherPid ?? "none"}, reaped=${outcome.reaped}, survivors=${outcome.survivors.join(",") || "none"}]`,
  );
}

const membershipOf = async (userId: string, workspaceId: string) => {
  const r = await admin().from("workspace_memberships").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  assert.equal(r.error, null, `membership lookup failed for ${userId} in ${workspaceId}: ${r.error?.message}`);
  return r.data;
};

/**
 * Logs in and returns the raw Cookie header. HttpSession deliberately hides response
 * headers, but D1 has to inspect the accept route's `Location` — a redirect to /login or
 * an error page would otherwise be indistinguishable from a successful acceptance — so
 * that one flow uses fetch directly rather than widening the shared helper.
 */
async function rawLoginCookie(email: string): Promise<string> {
  // boundedFetch, never bare fetch: a release gate must not be able to hang. It returns
  // the raw Response, which is exactly what the Location inspection below needs, so no
  // local wrapper is required and the shared helper is left untouched.
  const res = await boundedFetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
    redirect: "manual",
  });
  assert.ok([200, 302, 303, 307].includes(res.status), `${email} could not authenticate: ${res.status}`);
  const cookie = res.headers.getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.slice(c.indexOf("=") + 1) !== "")
    .join("; ");
  assert.ok(cookie.length > 0, `${email} authenticated but received no session cookie`);
  return cookie;
}

async function sessionFor(email: string): Promise<HttpSession> {
  const s = new HttpSession(`http://127.0.0.1:${PORT}`);
  const login = await s.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
  });
  assert.ok([200, 302, 303, 307].includes(login.status), `${email} could not authenticate: ${login.status}`);
  return s;
}

const setAuthOutage = (on: boolean) => {
  const flag = path.join(CONTROL_DIR, "path-outage");
  if (on) fs.writeFileSync(flag, "");
  else fs.rmSync(flag, { force: true });
};

type Readiness = { httpStatus: number; status: string; checks: Array<{ name: string; status: string }> };
async function readReadiness(): Promise<Readiness> {
  const r = await session.request("/api/ready");
  let parsed: { status?: string; checks?: Array<{ name: string; status: string }> } = {};
  try { parsed = JSON.parse(r.text) as typeof parsed; } catch { /* raw status is the evidence */ }
  return { httpStatus: r.status, status: parsed.status ?? "(unparsed)", checks: parsed.checks ?? [] };
}
async function awaitReadiness(want: number, why: string): Promise<Readiness> {
  let last = await readReadiness();
  for (let i = 0; i < 60 && last.httpStatus !== want; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    last = await readReadiness();
  }
  assert.equal(last.httpStatus, want, `${why} (last: ${last.httpStatus} ${last.status})`);
  return last;
}

before(async () => {
  CONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p0-launch-06-"));
  SUPABASE_HOSTPORT = new URL(process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL!).host;

  // Bounded. A synchronous child blocks the event loop, so an unbounded one would stall
  // the whole rehearsal — including its teardown — until the workflow's own kill. The
  // build is the long pole (observed ~5 min locally), so it gets a generous but FINITE
  // ceiling; the workflow timeout is never the subprocess control.
  // Launched through THIS Node runtime (`node <npm-cli> run build`) rather than by the
  // bare name `npm`, which does not exist as an executable on Windows; see `npmCliPath`.
  // cwd, the ceiling and the 64 MiB output cap are the ones this build was accepted with.
  //
  // The child is TRACKED, not merely timed. A synchronous timeout signals only the
  // direct child, so npm's shell and the `next build` under it could outlive the
  // deadline and keep compiling — unrecorded — while the rehearsal proceeded. This
  // form accounts for the whole process group and records anything it cannot reap.
  const build = await runBoundedChild({
    label: "before(): production build",
    command: process.execPath,
    args: [NPM_CLI, "run", "build"],
    cwd: ROOT,
    timeoutMs: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(build.launchError, null, `the production build could not be launched: ${build.launchError}`);
  // A cleanup failure is never absorbed: on Windows a failed `taskkill /T /F` would
  // otherwise leave a compiling descendant behind while this hook carried on.
  assert.equal(build.cleanupError, null, `the production build's process tree could not be cleaned up: ${build.cleanupError}`);
  assert.equal(
    build.timedOut,
    false,
    `the production build exceeded ${BUILD_TIMEOUT_MS}ms (survivors=${build.survivors.length}, unreaped=${build.unreaped.length})`,
  );
  assert.equal(
    build.exit,
    0,
    `the production build failed (exit ${build.exit}, signal ${build.signal}): ${build.stderr.slice(-2000) || build.stdout.slice(-2000)}`,
  );

  const supabase = admin();
  for (let page = 1; page <= 20 && !ownerUserId; page += 1) {
    const listed = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    assert.ok(!listed.error, `listUsers failed: ${listed.error?.message}`);
    const found = listed.data.users.find((u) => (u.email ?? "").toLowerCase() === OWNER_A.email.toLowerCase());
    if (found) ownerUserId = found.id;
    if (listed.data.users.length < 200) break;
  }
  assert.ok(ownerUserId, `no operator identity for ${OWNER_A.email}; this rehearsal never invents one`);

  const stamp = Date.now();
  // The beta PARTICIPANT: a real platform identity that has NOT been admitted.
  participantEmail = `p0-launch-06-participant-${stamp}@example.test`;
  const p = await supabase.auth.admin.createUser({ email: participantEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!p.error && p.data.user, `could not create the participant identity: ${p.error?.message}`);
  participantUserId = p.data.user.id;

  // A FOREIGN identity holding real authority in a DIFFERENT tenant, so a later
  // cross-tenant denial is attributable to the tenant boundary rather than to the
  // identity being unprivileged everywhere.
  foreignEmail = `p0-launch-06-foreign-${stamp}@example.test`;
  const f = await supabase.auth.admin.createUser({ email: foreignEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!f.error && f.data.user, `could not create the foreign identity: ${f.error?.message}`);
  foreignUserId = f.data.user.id;
  const bind = await supabase.from("workspace_memberships").insert({ workspace_id: TENANT_B.workspaceId, user_id: foreignUserId, role: "owner" });
  assert.ok(!bind.error, `could not bind the foreign identity to tenant B: ${bind.error?.message}`);

  PORT = await freePort();
  session = new HttpSession(`http://127.0.0.1:${PORT}`);
});

after(async () => {
  // ONCE TEARDOWN BEGINS, EVERY INDEPENDENT CLEANUP COMPONENT IS ATTEMPTED. Previously
  // only the shutdown was wrapped, so the first failing database cleanup threw straight
  // out of the hook and skipped the foreign identity, invitations, bootstrap workspaces,
  // participant handling, the control directory, the residue check and the evidence
  // emission — a transient database blip became a permanent fixture leak. Each component
  // now records its own failure and the hook raises ONE aggregate at the end. Nothing is
  // swallowed, and no cleanup failure can turn the rehearsal green.
  const teardownFailures: string[] = [];
  const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      teardownFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step("process cleanup", async () => {
    if (!server) return;
    assertShutdownClean(
      await shutdownProductionServer(server, { label: "P0-LAUNCH-06 beta server", graceMs: 10_000 }),
      "P0-LAUNCH-06 beta server",
    );
  });
  server = null;
  const supabase = admin();

  await step("membership cleanup", async () => {
    for (const [label, id] of [["participant", participantUserId], ["foreign", foreignUserId]] as const) {
      if (!id) continue;
      const removed = await supabase.from("workspace_memberships").delete().eq("user_id", id);
      assert.equal(removed.error, null, `${label} membership cleanup failed: ${removed.error?.message}`);
    }
  });

  await step("invitation cleanup", async () => {
    if (!participantEmail) return;
    const inviteCleanup = await supabase.from("workspace_invitations").delete()
      .eq("workspace_id", TENANT_A.workspaceId).eq("email", participantEmail.toLowerCase());
    assert.equal(inviteCleanup.error, null, `invitation cleanup failed: ${inviteCleanup.error?.message}`);
  });

  // The foreign identity performs no tenant write, so nothing may block its deletion.
  await step("foreign identity cleanup", async () => {
    if (!foreignUserId) return;
    const foreignDeleted = await supabase.auth.admin.deleteUser(foreignUserId);
    assert.equal(foreignDeleted.error, null, `foreign identity deletion failed: ${foreignDeleted.error?.message}`);
  });

  // The bootstrap workspace the participant acquired by loading the protected accept
  // route is MUTABLE fixture state and must not accumulate. The accepted retention
  // rationale covers the participant IDENTITY and the immutable operational records in
  // tenant A — it does not cover this empty personal workspace.
  EVIDENCE.bootstrapWorkspaceTeardown = "NOT_DETERMINED (cleanup step did not complete)";
  EVIDENCE.bootstrapCleanupRuntimeBranch = "NOT_DETERMINED";
  await step("bootstrap workspace cleanup", async () => {
    if (!participantUserId) return;
    const owned = await supabase.from("workspaces").select("id").eq("created_by_user_id", participantUserId);
    assert.equal(owned.error, null, `bootstrap-workspace lookup failed: ${owned.error?.message}`);
    const bootstrapped = (owned.data ?? []).map((w) => w.id as string)
      .filter((id) => id !== TENANT_A.workspaceId && id !== TENANT_B.workspaceId);
    for (const id of bootstrapped) {
      // Belt and braces: a seeded tenant must never be reachable by this delete.
      assert.notEqual(id, TENANT_A.workspaceId, "refusing to delete the seeded tenant A");
      assert.notEqual(id, TENANT_B.workspaceId, "refusing to delete the seeded tenant B");
      const mships = await supabase.from("workspace_memberships").delete().eq("workspace_id", id);
      assert.equal(mships.error, null, `bootstrap workspace membership cleanup failed for ${id}: ${mships.error?.message}`);
      const dropped = await supabase.from("workspaces").delete().eq("id", id);
      assert.equal(dropped.error, null, `bootstrap workspace cleanup failed for ${id}: ${dropped.error?.message}`);
    }
    const left = await supabase.from("workspaces").select("id").eq("created_by_user_id", participantUserId);
    assert.equal(left.error, null, `bootstrap-workspace verification failed: ${left.error?.message}`);
    assert.deepEqual(
      (left.data ?? []).map((w) => w.id as string).filter((id) => id !== TENANT_A.workspaceId && id !== TENANT_B.workspaceId),
      [],
      "a rehearsal-created bootstrap workspace leaked into the fixture database",
    );
    EVIDENCE.bootstrapWorkspaceTeardown = bootstrapped.length > 0
      ? `REMOVED ${bootstrapped.length} rehearsal-created bootstrap workspace(s); no immutable operational record was deleted`
      : "NONE CREATED";
    // Bootstrap creation is RACE-DEPENDENT: the (protected) layout and the accept page
    // render concurrently, so whether resolveWriteWorkspace observes the new membership
    // varies per run. Report branch coverage honestly rather than implying it ran.
    EVIDENCE.bootstrapCleanupRuntimeBranch = bootstrapped.length > 0 ? "OBSERVED_AND_EXECUTED" : "NOT_OBSERVED_IN_THIS_RUN";
  });

  // The participant's auth user CANNOT be deleted after F1: operational_raw_inputs and
  // operational_normalized_events reference actor_user_id under ON DELETE RESTRICT
  // (20260901000000_raw_input_normalized_event_foundation). That FK behaves as designed —
  // the operational record is immutable evidence — so the correct teardown RETAINS the
  // identity deliberately, and never deletes immutable history to make cleanup green.
  // Retention is only a non-failure when its predicates are positively proven first.
  EVIDENCE.participantIdentityTeardown = "NOT_DETERMINED (cleanup step did not complete)";
  await step("participant identity cleanup/retention", async () => {
    if (!participantUserId) return;
    const [rawInputs, normalizedEvents] = await Promise.all([
      supabase.from("operational_raw_inputs").select("id").eq("actor_user_id", participantUserId),
      supabase.from("operational_normalized_events").select("id").eq("actor_user_id", participantUserId),
    ]);
    assert.equal(rawInputs.error, null, `raw-input evidence lookup failed: ${rawInputs.error?.message}`);
    assert.equal(normalizedEvents.error, null, `normalized-event evidence lookup failed: ${normalizedEvents.error?.message}`);
    const immutableRefs = (rawInputs.data?.length ?? 0) + (normalizedEvents.data?.length ?? 0);

    const deleted = await supabase.auth.admin.deleteUser(participantUserId);
    if (immutableRefs > 0) {
      assert.notEqual(deleted.error, null, "the participant was deleted despite immutable operational evidence referencing it");
      EVIDENCE.participantIdentityTeardown =
        `RETAINED_BY_DESIGN: ${rawInputs.data?.length ?? 0} operational_raw_inputs + ${normalizedEvents.data?.length ?? 0} operational_normalized_events reference actor_user_id ${participantUserId} under ON DELETE RESTRICT; deletion refused as expected. LOCAL FIXTURE STATE, not a product defect.`;
    } else {
      assert.equal(deleted.error, null, `participant deletion failed with no immutable evidence present: ${deleted.error?.message}`);
      EVIDENCE.participantIdentityTeardown = "DELETED (no immutable operational evidence referenced this participant)";
    }
  });

  await step("control directory cleanup", async () => {
    fs.rmSync(CONTROL_DIR, { recursive: true, force: true });
  });

  // No orphan, survivor or unreaped process may coexist with a PASS. shutdownProductionServer
  // appends to this ledger ONLY when a shutdown leaves orphans or unreaped pids, so any
  // entry at all is residue — the same ledger P0-LAUNCH-03/04 assert.
  await step("process residue verification", async () => {
    assert.deepEqual(
      HARNESS_PROCESS_RESIDUE,
      [],
      `the rehearsal left process-table residue behind: ${JSON.stringify(HARNESS_PROCESS_RESIDUE)}`,
    );
  });
  EVIDENCE.processResidue = HARNESS_PROCESS_RESIDUE.length === 0
    ? "CLEAN — residue ledger empty (it records only shutdowns leaving orphans/unreaped pids), and every shutdown outcome was asserted at its call site"
    : `RESIDUE: ${JSON.stringify(HARNESS_PROCESS_RESIDUE)}`;

  // Evidence is emitted BEFORE the failure is raised, so a teardown failure never costs
  // the run its diagnostic output.
  console.log(`\nP0_LAUNCH_06_REHEARSAL_EVIDENCE ${JSON.stringify(EVIDENCE, null, 2)}`);

  assert.deepEqual(
    teardownFailures,
    [],
    `the rehearsal teardown did not fully succeed (${teardownFailures.length} component(s)): ${teardownFailures.join(" | ")}`,
  );
});

// ───────────────── PHASE X — harness integrity (the child-process launch) ─────────────────

/**
 * TRACKED REGRESSION. Every child this rehearsal starts is an npm script, and each one
 * used to name the package manager by its bare name. Node resolves such a name against
 * PATH and execs it itself, with no shell — and on Windows npm exists only as a `.cmd`
 * launcher, which Node will not exec. The whole battery therefore died in `before()`
 * with `spawnSync npm ENOENT`: 27 of 27 cases failed at the build, and not one scenario
 * ran. Linux and WSL never showed it, because there npm is a shebang script.
 *
 * This control is deliberately cheap and structural. It proves the launch SHAPE is
 * portable and that the build child reaches Next's own build binary, without performing
 * a build and without depending on the authoritative battery having run.
 */
test("X1. CROSS_PLATFORM_CHILD_LAUNCH: package-manager children run through this Node runtime, not a PATH lookup", async () => {
  // 1. The launcher is the Node binary already running this gate, and the program it is
  //    handed is npm's own CLI — established by package ownership, not by a path guess.
  //    Those properties are what make the launch shell-free, and therefore portable to
  //    Windows, where the bare name is a `.cmd`.
  assert.ok(fs.existsSync(process.execPath), `the Node runtime is not at ${process.execPath}`);
  assert.equal(path.isAbsolute(NPM_CLI), true, `the npm CLI path is not absolute: ${NPM_CLI}`);
  assert.match(NPM_CLI, /\.[cm]?js$/, `the npm CLI is not a JavaScript file this runtime can execute: ${NPM_CLI}`);
  assert.ok(fs.existsSync(NPM_CLI), `the npm CLI does not exist at ${NPM_CLI}`);

  // 2. NEGATIVE CONTROL FIRST, so the proof below cannot be satisfied by the thing it is
  //    supposed to exclude. npm's banner alone — the exact bytes npm emits before the
  //    script runs — must NOT count as having reached Next.
  const bannerOnly = ["", "> pmfreak@0.1.0 build", "> next build --help", ""].join("\n");
  const bannerVerdict = nextBuildHelpProof(bannerOnly);
  assert.equal(bannerVerdict.ok, false, "npm's lifecycle banner alone satisfies the Next-help proof");
  assert.equal(bannerVerdict.body, "", "the banner filter left npm's own output in the body");

  // 3. The BUILD child reaches NEXT'S OWN help implementation. `--help` is forwarded
  //    through the `build` script to the build binary, which prints its usage and exits
  //    0 without building, so this exercises the whole chain
  //      node -> npm-cli.js -> the `build` script -> next build
  //    that `before()` depends on, at a cost that does not require a build and cannot be
  //    mistaken for one. npm is NOT bypassed: the point is the chain, not the binary.
  const proofRun = await runBoundedChild({
    label: "X1: build-chain launch proof",
    command: process.execPath,
    args: [NPM_CLI, "run", "build", "--", "--help"],
    cwd: ROOT,
    timeoutMs: LAUNCH_PROOF_TIMEOUT_MS,
  });
  assert.equal(proofRun.launchError, null, `the build chain could not be launched: ${proofRun.launchError}`);
  assert.equal(proofRun.timedOut, false, `the build-chain launch proof exceeded ${LAUNCH_PROOF_TIMEOUT_MS}ms`);
  assert.equal(proofRun.exit, 0, `the build chain exited ${proofRun.exit}: ${proofRun.stderr.slice(0, 300)}`);
  const verdict = nextBuildHelpProof(`${proofRun.stdout}\n${proofRun.stderr}`);
  assert.ok(verdict.ok, `the build child did not reach Next's own help output: ${verdict.reason}; body=${verdict.body.slice(0, 300)}`);
  // CLAIM PRECISION. This command exits NORMALLY, so no whole-tree observation is
  // possible: after the root is gone a descendant that had detached is reachable by no
  // relation this gate has. The narrow, true claim is that the mechanism which DID run
  // reported no failure — never that the tree was observed clean. An earlier revision
  // read these empty arrays as "process tree reaped clean", which is exactly what an
  // undiscovered process also looks like.
  assert.equal(proofRun.cleanupError, null, `the launch proof reported a cleanup failure: ${proofRun.cleanupError}`);
  assert.match(
    proofRun.treeEvidence,
    /^clean-exit-/,
    `a normally exiting launch proof reported ${proofRun.treeEvidence}, which is not a clean-exit classification`,
  );
  assert.equal(
    proofRun.wholeTreeVerified,
    false,
    "X1 must not claim whole-tree verification for a normal exit; that evidence is produced only by the stabilized timeout path",
  );
  assert.equal(proofRun.survivors.length, 0, `the launch proof left ${proofRun.survivors.length} KNOWN process(es) running`);
  assert.equal(proofRun.unreaped.length, 0, `the launch proof left ${proofRun.unreaped.length} KNOWN uncollected process(es)`);

  // 4. No bare package-manager launch remains anywhere on this rehearsal's execution
  //    path. Searched for by SHAPE rather than trusted to have been removed once, so a
  //    later edit that reintroduces the defect in a different helper is caught here.
  const BARE_LAUNCH = /(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*(["'`])(?:npm|npx|pnpm|yarn)(?:\.cmd|\.exe|\.bat)?\1/;
  // Self-check. The pattern is built from a defect assembled at RUNTIME, never written
  // as a literal, because these files scan themselves: a literal example would be found
  // by the scan below and would fail this control for describing the bug it fixed.
  // Both defect fixtures are assembled at RUNTIME from fragments, never written as
  // literals: this file is one of the files scanned, so a literal example would be
  // found by the scan below and would fail this control for describing the bugs it fixed.
  const SYNC = `${"execFileSync"}`;
  const BARE_DEFECT = `${SYNC}(${JSON.stringify("npm")}, [${JSON.stringify("run")}])`;
  assert.match(BARE_DEFECT, BARE_LAUNCH, "the bare-launch pattern can no longer detect the defect it exists for");
  // No synchronous unbounded-tree child either: a `timeout` option bounds the direct
  // child only, which is what let a build or operator descendant outlive its deadline.
  const SYNC_TREE_UNAWARE = /\b(?:execFileSync|execSync|spawnSync)\s*\(/;
  assert.match(`${SYNC}(x)`, SYNC_TREE_UNAWARE, "the tree-unaware pattern can no longer detect the defect it exists for");
  const scanned = [
    "tests/acceptance/p0-launch-06-beta-release-rehearsal.test.ts",
    "tests/acceptance/support/runtime-acceptance.ts",
  ];
  for (const f of scanned) {
    const source = readFileSync(f, "utf8");
    assert.doesNotMatch(source, BARE_LAUNCH, `${f} still launches a package manager by bare name`);
    assert.doesNotMatch(source, SYNC_TREE_UNAWARE, `${f} still starts a synchronous child whose descendants are unaccounted for`);
  }

  // Deliberately narrow. Every clause below was established by this control; the
  // timeout-cleanup semantics are proven by dedicated regressions, not claimed here.
  EVIDENCE.crossPlatformChildLaunch =
    `this Node runtime launched the ownership-verified npm CLI; npm executed the package build script; Next's own \`next build\` help output was ` +
    `observed after npm's lifecycle banner was removed (banner alone proven insufficient); the command exited normally (exit 0) with no KNOWN ` +
    `process-group cleanup failure (treeEvidence=${proofRun.treeEvidence}); WHOLE_TREE_VERIFIED=NO for this normal exit — timeout tree cleanup is ` +
    `proven separately; ${scanned.length} execution-path files carry no bare or tree-unaware launch`;
});

// ───────────────── PHASE A — startup boundary (the certified runtime guard) ─────────────────

test("A1. STARTUP BOUNDARY: an invalid closed-beta environment leaves NO application surface operational", async () => {
  // Started through a BARE `next start` — deliberately bypassing
  // `npm run start:closed-free-beta` — because the whole point of the in-process
  // guard is that enforcement no longer depends on which command launched Next.js.
  const port = await freePort();
  // The negative control must be rejected ONLY by the instrumentation guard, or the
  // case proves nothing about whether src/instrumentation.ts ran. A BLANK
  // NEXT_PUBLIC_APP_URL is not such a control: api/ready's checkConfiguration lists
  // NEXT_PUBLIC_APP_URL in productionRequired and 503s on its own when the variable
  // is missing, so A1 would still pass with the hook deleted. An invalid-but-PRESENT
  // value discriminates: checkConfiguration tests presence only (it would pass), while
  // evaluateClosedFreeBetaEnvSafety rejects it with `invalid_app_url`. If the guard
  // does not run, readiness answers 200 and this case FAILS, which is the point.
  const outcome = await startProductionServer({
    port,
    env: betaEnv({ NEXT_PUBLIC_APP_URL: "not-a-url" }),
    timeoutMs: 90_000,
  });

  try {
    // Two acceptable fail-closed shapes, and the evidence must say WHICH occurred
    // rather than accepting any non-200: either the runtime never became healthy at
    // all (the harness reports it did not start), or it listens but no application
    // surface is operational. Both are fail-closed; they are not the same fact.
    const probe = new HttpSession(`http://127.0.0.1:${port}`);
    const surfaces: Array<[string, number]> = [];
    for (const p of ["/api/ready", `/api/execution-tasks?projectId=${encodeURIComponent(TENANT_A.projectId)}`]) {
      const r = await probe.request(p).catch(() => ({ status: 0, text: "" }) as never);
      surfaces.push([p, r.status]);
      assert.notEqual(r.status, 200, `an invalid beta environment served ${p} with 200`);
    }
    const shape = outcome.started
      ? "server listening, no application surface operational"
      : "runtime never became healthy (health probe never succeeded)";
    // A REFUSED START MUST NOT LEAVE A PROCESS ALIVE. Failed starts never enter the
    // normal shutdown ledger, so HARNESS_PROCESS_RESIDUE cannot speak for them — this
    // uses the same failed-start semantics A1b already proves rather than inventing a
    // parallel definition of "clean".
    if (!outcome.started) {
      assert.deepEqual(outcome.survivors, [], "the refused start left surviving processes");
      assert.equal(outcome.reaped, true, "the refused start was not reaped");
    }
    assert.ok(
      !outcome.started || surfaces.every(([, s]) => s !== 200),
      "an invalid beta environment produced an operational surface",
    );
    EVIDENCE.invalidEnvSurfaces = `${shape}; ${surfaces.map(([p, s]) => `${p}=${s}`).join(" ")}`;
    EVIDENCE.invalidEnvApplicationSurfacesOperational = "NO";
  } finally {
    if (outcome.started) {
      assertShutdownClean(await shutdownProductionServer(outcome.handle, { label: "A1 invalid-env server", graceMs: 8_000 }), "A1 invalid-env server");
    } else {
      // A refused start is the EXPECTED outcome here, but its reaping still has to be
      // accounted for: a failed start that left a survivor is residue like any other.
      assert.equal(outcome.reaped, true, `A1 invalid-env server was not reaped: ${outcome.survivors.join(",")}`);
      assert.deepEqual(outcome.survivors, [], "A1 invalid-env server left surviving process(es)");
    }
  }
});

test("A1b. PROFILE SELECTION fails closed: missing, blank, unknown and spoofed-build-phase refuse startup", async () => {
  // A1 proves an invalid VALUE is refused, but it cannot prove profile SELECTION is
  // enforced, because betaEnv() always supplies a valid profile. The bypass this closes
  // is structural: the hook used to `return` when the profile was absent or misspelled,
  // disabling the only in-process guard precisely when the deployment was least
  // trustworthy. Every environment below is otherwise VALID, so the profile is the sole
  // discriminating defect.
  const outcomes: Array<[string, string]> = [];
  for (const [label, override, extra] of [
    ["MISSING_PROFILE", undefined, undefined],
    ["BLANK_PROFILE", "", undefined],
    ["UNKNOWN_PROFILE", "closed-free-beta-typo", undefined],
    // NEXT_PHASE is externally supplied, so a stale or spoofed build phase on a real
    // `next start` must NOT authorize the runtime out of validation. This is the real
    // production-server negative case, not a simulated build.
    ["SPOOFED_BUILD_PHASE", undefined, { NEXT_PHASE: "phase-production-build" }],
  ] as const) {
    const port = await freePort();
    const env = betaEnv();
    if (override === undefined) delete env.PMFREAK_OPERATING_PROFILE;
    else env.PMFREAK_OPERATING_PROFILE = override;
    if (extra) Object.assign(env, extra);

    const outcome = await startProductionServer({ port, env, timeoutMs: 90_000 });
    if (outcome.started) {
      // Refusal is the required outcome; clean up before failing so nothing leaks.
      await shutdownProductionServer(outcome.handle, { label: `${label} server`, graceMs: 8_000 });
      assert.fail(`${label}: the production server became healthy without a recognized operating profile`);
    }
    // Narrowed to FailedStart. No application surface may be operational either.
    const probe = new HttpSession(`http://127.0.0.1:${port}`);
    const surfaces: number[] = [];
    for (const path of ["/api/ready", `/api/execution-tasks?projectId=${encodeURIComponent(TENANT_A.projectId)}`]) {
      const r = await probe.request(path).catch(() => ({ status: 0, text: "" }) as never);
      surfaces.push(r.status);
      assert.notEqual(r.status, 200, `${label}: an unprofiled production server served ${path} with 200`);
    }
    // The refusal must be attributable to the PROFILE guard, not to some unrelated
    // readiness failure: the startup log must carry the guard's own stable code.
    assert.match(outcome.log, /beta_profile_not_selected/, `${label}: refusal is not attributable to the profile guard`);
    // Sanitised: the offending value itself must never be echoed.
    if (typeof override === "string" && override !== "") {
      assert.ok(!outcome.log.includes(override), `${label}: the guard echoed the offending profile VALUE`);
    }
    assert.deepEqual(outcome.survivors, [], `${label}: the refused start left surviving processes`);
    outcomes.push([label, `started=false surfaces=${surfaces.join(",")}`]);
  }
  EVIDENCE.profileSelectionFailsClosed =
    `SERVER_BECOMES_OPERATIONAL=NO for ${outcomes.map(([l, d]) => `${l} (${d})`).join("; ")}; ` +
    "each refusal carries code beta_profile_not_selected and never echoes the offending value";
  EVIDENCE.bareNextStartProfileBypass = "NO";
  EVIDENCE.spoofedBuildPhaseBypass =
    "NO — a stale/spoofed NEXT_PHASE=phase-production-build on a real production server does not authorize " +
    "startup. The closure is architectural: the production-server STARTUP boundary is next.config.ts, which " +
    "Next.js hands its own `phase` argument, so the environment cannot make a running server look like a build. " +
    "src/instrumentation.ts remains an in-process defense-in-depth guard behind it (Next.js can skip the " +
    "instrumentation hook entirely when NEXT_PHASE is spoofed, which is why it cannot be the sole authority).";
});

test("A2. STARTUP BOUNDARY: the guard names offending VARIABLES and never their values", async () => {
  // BEHAVIOURAL first. Source inspection cannot prove a redaction contract: a regression
  // that interpolated an environment VALUE into the diagnostic would leave a
  // source-only check green. So invoke the real guard with a synthetic environment
  // carrying a unique sentinel and inspect what it actually throws.
  const { assertClosedFreeBetaEnvSafety } = await import("../../src/lib/security/environment");
  const sentinel = `p0l06-sentinel-${randomUUID()}`;
  let thrown: unknown = null;
  try {
    assertClosedFreeBetaEnvSafety({
      PMFREAK_OPERATING_PROFILE: BETA_PROFILE,
      NEXT_PUBLIC_SUPABASE_URL: sentinel,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: sentinel,
      SUPABASE_SERVICE_ROLE_KEY: sentinel,
      // The violation under test: present but not an http(s) URL.
      NEXT_PUBLIC_APP_URL: sentinel,
    } as unknown as NodeJS.ProcessEnv);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "an invalid closed-beta environment did not refuse");
  const diagnostic = `${(thrown as Error).message}\n${(thrown as Error).stack ?? ""}`;
  // The operator must be able to act on it: the offending VARIABLE and code are named...
  assert.match(diagnostic, /NEXT_PUBLIC_APP_URL/, "the diagnostic does not name the offending variable");
  assert.match(diagnostic, /invalid_app_url/, "the diagnostic does not carry the machine-readable violation code");
  // ...and the VALUE never appears. Compared, never printed.
  assert.ok(!diagnostic.includes(sentinel), "the guard leaked an environment VALUE into its diagnostic");
  EVIDENCE.guardDiagnosticRedaction = "BEHAVIOURAL: names NEXT_PUBLIC_APP_URL and code invalid_app_url; synthetic sentinel value absent from message and stack";

  // Supplemental source evidence: the wiring the runtime hook must keep.
  const source = readFileSync("src/instrumentation.ts", "utf8");
  // Comments are stripped first: the docblock deliberately NAMES
  // `assertProductionEnvSafety` to explain why it is not wired, and a naive
  // string search would read that explanation as the defect it warns about.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /assertClosedFreeBetaEnvSafety\(\)/, "the runtime guard does not INVOKE the canonical beta contract");
  assert.doesNotMatch(code, /assertProductionEnvSafety\s*\(/, "the beta runtime must not INVOKE the full-production contract");
  assert.match(code, /NEXT_RUNTIME !== "nodejs"/, "the guard must not run on the edge runtime");
  // SUPERSEDED ASSERTION. This used to require `PMFREAK_OPERATING_PROFILE !== "closed-free-beta"`
  // as an early RETURN — which is exactly the bypass A1b now closes: a missing or misspelled
  // profile disabled the only in-process guard. The runtime selector must be independent of the
  // value under test, and a profile mismatch must THROW rather than skip validation.
  assert.match(code, /NODE_ENV !== "production"/, "the guard must select the runtime independently of the profile");
  assert.match(code, /CLOSED_FREE_BETA_PROFILE/, "the guard must compare against the canonical profile constant, not a literal");
  assert.match(code, /beta_profile_not_selected/, "a mismatched profile must fail closed with the canonical code");
  assert.doesNotMatch(
    code,
    /PMFREAK_OPERATING_PROFILE\s*!==\s*[^)]*\)\s*return/,
    "a profile mismatch must never take an early return; that is the bypass this guard closes",
  );
  // The scope limit must still be stated somewhere in the file, comments included.
  assert.match(source, /RUNTIME boundary, not a deployment-time one/i, "the guard does not state its scope limit");
});

test("A3. STARTUP: a VALID closed-beta environment starts and serves liveness", async () => {
  const outcome = await startProductionServer({ port: PORT, env: betaEnv(), timeoutMs: 240_000 });
  server = assertStarted(outcome, "A3 beta runtime");

  const health = await session.request("/api/health");
  assert.equal(health.status, 200, `liveness did not answer 200: ${health.status}`);
  EVIDENCE.liveness = `200 (/api/health)`;
});

test("A4. READINESS declares the closed-free-beta dependency set, and Stripe is NOT required", async () => {
  const readiness = await awaitReadiness(200, "the beta runtime never reported ready");
  const names = readiness.checks.map((c) => c.name).sort();
  assert.deepEqual(names, ["auth", "configuration", "database", "governance_capability"], `unexpected beta readiness set: ${names.join(",")}`);
  assert.ok(readiness.checks.every((c) => c.status === "pass"), "a declared readiness check is not passing");

  // The server was started with both Stripe secrets BLANK, so reaching ready here
  // is itself the proof that the closed free beta needs no billing surface.
  EVIDENCE.readinessInitial = `200 ready; checks=${names.join(",")}`;
  EVIDENCE.closedFreeBetaStripeRequired = "NO";
});

// ───────────────── PHASE B — a non-invited identity has no authority ─────────────────

test("B1. ACCOUNT_CREATION != BETA_ADMISSION: the participant identity exists and authenticates", async () => {
  const identity = await admin().auth.admin.getUserById(participantUserId);
  assert.ok(!identity.error && identity.data.user, "the participant identity does not exist");
  const s = await sessionFor(participantEmail);
  assert.ok(s, "the participant could not authenticate");
  EVIDENCE.participantIdentity = "exists and authenticates before any admission";
});

test("B2. a merely-created identity holds NO tenant membership and NO role", async () => {
  const memberships = await admin().from("workspace_memberships").select("workspace_id, role").eq("user_id", participantUserId);
  assert.ok(!memberships.error, `membership lookup failed: ${memberships.error?.message}`);
  assert.deepEqual(memberships.data ?? [], [], "a merely-created identity already holds tenant membership");
});

test("B3. PRE_ADMISSION_GOVERNED_ACCESS: the governed first-use path is DENIED", async () => {
  const s = await sessionFor(participantEmail);
  const r = await governedFirstUse(s);
  assert.equal(r.status, 403, `a non-invited identity was not denied the governed path: ${r.status} ${r.text.slice(0, 200)}`);
  EVIDENCE.preAdmissionGovernedAccess = "403";
});

// ───────────────── PHASE C — supported operator admission ─────────────────

const operator = async (args: string[], env: Record<string, string> = {}) => {
  // Bounded AND tracked: this operator command talks to Auth/PostgREST, so a stalled
  // dependency must surface as a failed control rather than hanging the rehearsal —
  // and, because the child is `node <npm-cli> run` and the real work happens in a `tsx`
  // grandchild, killing only the direct child would leave that grandchild free to keep
  // WRITING to the fixture the next case reads. The whole process group is reaped, and
  // anything that survives is recorded in the residue ledger the final control asserts.
  // Same Node-runtime launch as the build; the bare name `npm` is not executable on Windows.
  const run = await runBoundedChild({
    label: `operator: beta:invite-participant ${args.join(" ")}`,
    command: process.execPath,
    args: [NPM_CLI, "run", "beta:invite-participant", "--", ...args],
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeoutMs: OPERATOR_TIMEOUT_MS,
  });
  // A TIMEOUT is not a refusal. It is reported as its own fact, never as a non-zero
  // exit, so a stalled dependency can never satisfy a negative control. By the time it
  // is reported the tree has been reaped, or the survivors are in the residue ledger.
  const timeoutNote = run.timedOut
    ? `\n[operator command timed out after ${OPERATOR_TIMEOUT_MS}ms; treeEvidence=${run.treeEvidence}, ` +
      `stabilized=${run.timeoutTreeStabilized}, reaped=${run.timeoutTreeReaped}, survivors=${run.survivors.length}, ` +
      `unreaped=${run.unreaped.length}, windowsTreeKill=${run.windowsTreeKill ?? "n/a"}]`
    : "";
  return {
    exit: run.exit ?? -1,
    text: `${run.stdout}\n${run.stderr}${timeoutNote}`,
    timedOut: run.timedOut,
    // Surfaced separately so a control can fail closed on it. A tsx grandchild that
    // outlived its deadline is still free to write to the fixture the next case reads.
    cleanupError: run.cleanupError,
  };
};
const envelopeOf = (text: string) => {
  const line = text.split("\n").filter((v) => v.trim().startsWith("{")).pop();
  return line ? (JSON.parse(line) as { ok: boolean; failureClass?: string; message?: string }) : null;
};

test("C1. OPERATOR NEGATIVE CONTROLS: isolation, identity, membership, role and duplication are all refused", async () => {
  const refusals: string[] = [];
  const expectRefused = async (label: string, args: string[], env: Record<string, string> = {}, failureClass?: string) => {
    const r = await operator(args, env);
    assert.equal(r.timedOut, false, `${label} TIMED OUT; a stalled dependency must not be read as a refusal`);
    assert.equal(r.cleanupError, null, `${label} left a process tree uncleaned: ${r.cleanupError}`);
    assert.notEqual(r.exit, 0, `${label} was NOT refused`);
    const envelope = envelopeOf(r.text);
    assert.ok(envelope, `${label} emitted no structured envelope: ${r.text.slice(0, 200)}`);
    assert.equal(envelope.ok, false, `${label} reported success`);
    if (failureClass) assert.equal(envelope.failureClass, failureClass, `${label} used failureClass ${envelope.failureClass}`);
    assert.doesNotMatch(r.text, /^\s+at .*\(.*:\d+:\d+\)/m, `${label} emitted an unhandled stack trace`);
    refusals.push(label);
  };

  const base = ["--workspace", TENANT_A.workspaceId, "--email", `neg-${Date.now()}@example.test`, "--role", "pm", "--inviter", OWNER_A.email];

  // The isolation guard must refuse a non-local target BEFORE any privileged client.
  await expectRefused("NON_LOCAL_TARGET", base, { NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co", OPERATIONAL_FLOW_TEST_SUPABASE_URL: "https://prod.supabase.co" }, "non_isolated_target");
  await expectRefused("MISSING_ISOLATION_PREREQUISITE", base, { P2_13_FOUNDER_FIXTURE_ENABLED: "false" }, "non_isolated_target");
  await expectRefused("INVITER_NOT_FOUND", ["--workspace", TENANT_A.workspaceId, "--email", `x-${Date.now()}@example.test`, "--role", "pm", "--inviter", "nobody-a1b2c3@example.test"]);
  await expectRefused("INVITER_NOT_MEMBER_OF_TARGET", ["--workspace", TENANT_B.workspaceId, "--email", `y-${Date.now()}@example.test`, "--role", "pm", "--inviter", OWNER_A.email]);
  await expectRefused("INVALID_ROLE", ["--workspace", TENANT_A.workspaceId, "--email", `z-${Date.now()}@example.test`, "--role", "superuser", "--inviter", OWNER_A.email]);
  await expectRefused("OWNER_ROLE_NEVER_INVITABLE", ["--workspace", TENANT_A.workspaceId, "--email", `w-${Date.now()}@example.test`, "--role", "owner", "--inviter", OWNER_A.email]);

  EVIDENCE.operatorNegativeControls = refusals.join(" ");
});

test("C2. SUPPORTED_OPERATOR_INVITE: the real command creates an inspectable, correctly bound invitation", async () => {
  const result = await operator(["--workspace", TENANT_A.workspaceId, "--email", participantEmail, "--role", "pm", "--inviter", OWNER_A.email, "--emit-accept-path"]);
  assert.equal(result.timedOut, false, "the supported operator invite TIMED OUT against Auth/PostgREST");
  assert.equal(result.cleanupError, null, `the supported operator invite left a process tree uncleaned: ${result.cleanupError}`);
  assert.equal(result.exit, 0, `the supported operator invite failed: ${result.text.slice(0, 400)}`);
  const envelope = envelopeOf(result.text) as { ok: boolean; acceptPath?: string } | null;
  assert.ok(envelope?.ok, `the operator boundary did not report success: ${result.text.slice(0, 300)}`);

  const row = await admin()
    .from("workspace_invitations")
    .select("workspace_id, email, role, status, expires_at, token_hash")
    .eq("workspace_id", TENANT_A.workspaceId).eq("email", participantEmail.toLowerCase()).maybeSingle();
  assert.ok(row.data, "no invitation row was created by the supported boundary");
  assert.equal(row.data.workspace_id, TENANT_A.workspaceId, "the invitation is bound to the wrong workspace");
  assert.equal(row.data.role, "pm", "the invitation carries the wrong role");
  assert.equal(row.data.status, "pending", "the invitation is not pending");
  assert.ok(row.data.expires_at, "the invitation has no expiry");
  assert.ok(row.data.token_hash, "the invitation persisted no token hash");

  // Only the HASH is persisted; the plaintext exists once, in the operator output.
  const accept = envelope!.acceptPath ?? "";
  const token = accept.split("/").filter(Boolean).pop() ?? "";
  assert.ok(token.length > 0, "the operator emitted no accept path despite --emit-accept-path");
  assert.notEqual(row.data.token_hash, token, "the PLAINTEXT token was persisted");
  inviteToken = token;

  inviteAcceptPath = accept;

  // Bind the audit assertion to THIS run's invitation. Filtering only by workspace and
  // event_type lets an older seeded `invitation_sent` row satisfy the case even if this
  // invitation produced no audit record at all — a reachable state, because
  // createWorkspaceInvitationRecord fires the audit insert without inspecting its error
  // (registered as RR-INVITE-AUDIT-NONATOMIC, ACCEPTED_FOR_CLOSED_BETA; deliberately not
  // fixed in this increment). The participant email is unique per run, so filtering the
  // payload on it makes a stale event incapable of satisfying C2.
  const auditEmail = participantEmail.toLowerCase();
  const audit = await admin().from("workspace_audit_events")
    .select("event_type, actor_user_id, payload")
    .eq("workspace_id", TENANT_A.workspaceId)
    .eq("event_type", "invitation_sent")
    .eq("payload->>email", auditEmail);
  assert.equal(audit.error, null, `the invitation_sent audit query failed: ${audit.error?.message}`);
  const auditRows = audit.data ?? [];
  assert.equal(auditRows.length, 1, `expected exactly one invitation_sent event for ${auditEmail}, found ${auditRows.length}`);
  const auditPayload = auditRows[0]!.payload as { email?: string; role?: string; expiresAt?: string };
  assert.equal(auditPayload.email, auditEmail, "the audit event names a different invitee");
  assert.equal(auditPayload.role, "pm", "the audit event records a different role");
  // Same instant, two serializations: the payload is JSON (Date#toISOString, "…Z") while
  // expires_at comes back as timestamptz ("…+00:00"). Compare instants, not strings.
  assert.ok(auditPayload.expiresAt, "the audit event records no expiry");
  assert.equal(
    new Date(auditPayload.expiresAt!).getTime(),
    new Date(row.data.expires_at as string).getTime(),
    "the audit event's expiry is not the same instant as the invitation row's",
  );
  assert.equal(auditRows[0]!.actor_user_id, ownerUserId, "the audit event attributes a different inviter");

  EVIDENCE.supportedOperatorInvite = `workspace ${TENANT_A.workspaceId} role pm pending, token hashed at rest, invitation_sent audited (bound to this run: ${auditEmail}, role pm, expiry matches the invitation row, inviter ${ownerUserId})`;
  EVIDENCE.inviteAuditAtomicity = "RR-INVITE-AUDIT-NONATOMIC ACCEPTED_FOR_CLOSED_BETA — registered in docs/release/residual-risk-register.md and verified by K2 (createWorkspaceInvitationRecord does not inspect the audit insert error; product code deliberately unchanged)";
  EVIDENCE.operatorInviteFronteraGoverned = "NO";
  EVIDENCE.operatorInviteSubscriptionSeatGated = "NO";
});

test("C3. DUPLICATE_INVITE is refused through the shared invitation domain", async () => {
  const dup = await operator(["--workspace", TENANT_A.workspaceId, "--email", participantEmail, "--role", "pm", "--inviter", OWNER_A.email]);
  assert.equal(dup.timedOut, false, "the duplicate-invite control TIMED OUT; that is not a refusal");
  assert.equal(dup.cleanupError, null, `the duplicate-invite control left a process tree uncleaned: ${dup.cleanupError}`);
  assert.notEqual(dup.exit, 0, "a duplicate active invitation was created");
  assert.match(dup.text, /active invitation already exists/i, `duplicate refusal used an unexpected reason: ${dup.text.slice(0, 200)}`);
});

// ───────────────── PHASE D — real invite acceptance ─────────────────

test("D1. TENANT_BINDING and ROLE_BINDING come from the invitation record, server-side", async () => {
  // Acceptance is rehearsed through the SHIPPED participant-facing surface, not by
  // calling the domain function with a service-role client and a caller-supplied
  // identity. Going through the route is what makes this case's own claim honest: the
  // user id is resolved by requireAuthUser() from the participant's session cookie,
  // so "server-side, from the invitation record" is demonstrated rather than assumed.
  // It also puts session resolution, token routing, the abuse limits and the redirect
  // on the certified path — a regression in any of them would otherwise leave real
  // participants unable to accept while this rehearsal still granted membership.
  const supabase = admin();
  const base = `http://127.0.0.1:${PORT}`;
  const cookie = await rawLoginCookie(participantEmail);
  assert.ok(inviteAcceptPath.startsWith("/accept-invite/"), `the operator emitted no usable accept path: ${inviteAcceptPath}`);

  const accepted = await boundedFetch(`${base}${inviteAcceptPath}`, { headers: { cookie }, redirect: "manual" });
  assert.ok(
    [302, 303, 307, 308].includes(accepted.status),
    `the participant-facing accept route did not redirect on success: ${accepted.status}`,
  );
  // WHERE it redirects is the actual contract. Accepting any 3xx would let a regression
  // that bounces the participant to /login, to an error destination, or to a failed invite
  // route pass as a successful acceptance. The shipped route ends in redirect("/team").
  const location = accepted.headers.get("location");
  assert.ok(location, "the accept route redirected without a Location header");
  const destination = new URL(location!, base).pathname;

  // The real contract has TWO legitimate successful destinations, and which one occurs
  // is race-dependent: the accept page ends in redirect("/team"), while (protected)
  // layout.tsx renders concurrently and redirects a participant without workspace access
  // to getOnboardingRedirect(state). A participant whose workspace was bootstrapped
  // moments ago legitimately lands in onboarding instead of /team.
  //
  // The acceptable set is therefore derived from the product's OWN destination map, not
  // from an observed string, so a route change moves both together. `trial_blocked` is
  // deliberately EXCLUDED: /trial-inactive is a denial, not a successful landing. This
  // is not a widening back to "any 3xx" — /login, /trial-inactive, the invite route
  // itself and every error destination still fail.
  const successfulDestinations = new Set<string>([
    "/team",
    ...(["no_workspace", "needs_project", "needs_task", "execution_started"] as const).map(getOnboardingRedirect),
  ]);
  assert.ok(
    successfulDestinations.has(destination),
    `the accept route redirected to a destination that is not a successful post-acceptance landing: ${destination} ` +
      `(accepted: ${[...successfulDestinations].sort().join(", ")})`,
  );
  assert.notEqual(destination, "/login", "the accept route bounced the participant to login");
  assert.notEqual(destination, "/trial-inactive", "the accept route landed the participant on a denial page");
  assert.doesNotMatch(destination, /^\/accept-invite\//, "the accept route redirected back to itself");

  // Scope the claim to the INVITED tenant. Going through the shipped route surfaces real
  // behaviour the direct-domain call never did: `(protected)/layout.tsx` resolves a write
  // workspace and BOOTSTRAPS a personal one for a user who holds none, so the participant
  // legitimately ends up with their own workspace in addition to the invited tenant. That
  // is product behaviour on the certified path, not over-granting — so the invariant to
  // assert is the binding in TENANT_A, plus the absence of any grant that was never invited.
  const memberships = await supabase.from("workspace_memberships").select("workspace_id, role").eq("user_id", participantUserId);
  assert.equal(memberships.error, null, `membership lookup failed: ${memberships.error?.message}`);
  const rows = memberships.data ?? [];
  const inTenantA = rows.filter((m) => m.workspace_id === TENANT_A.workspaceId);
  assert.equal(inTenantA.length, 1, "admission did not establish exactly one membership in the invited tenant");
  assert.equal(inTenantA[0]!.role, "pm", "admission did not bind the invited role");
  assert.equal(rows.filter((m) => m.workspace_id === TENANT_B.workspaceId).length, 0, "admission leaked a membership into an uninvited tenant");

  // Every membership outside the invited tenant must be a workspace the participant
  // itself bootstrapped — nothing else may have been granted by accepting an invite.
  const others = rows.filter((m) => m.workspace_id !== TENANT_A.workspaceId);
  if (others.length > 0) {
    const owned = await supabase.from("workspaces").select("id").eq("created_by_user_id", participantUserId)
      .in("id", others.map((m) => m.workspace_id));
    assert.equal(owned.error, null, `bootstrapped-workspace lookup failed: ${owned.error?.message}`);
    assert.equal(owned.data?.length, others.length, "the participant holds a membership in a workspace it neither was invited to nor created");
  }
  EVIDENCE.inviteAcceptanceBootstrapsPersonalWorkspace =
    others.length > 0
      ? `YES — ${others.length} self-created workspace membership alongside the invited tenant ((protected) layout resolveWriteWorkspace bootstrap); observed only because D1 now uses the shipped route`
      : "NO";

  // The post-acceptance destination must not DENY the admitted identity. It is not
  // asserted to be 200: the participant's own workspace was bootstrapped moments ago, so
  // `(protected)/layout.tsx` legitimately redirects into onboarding. Asserting 200 would
  // encode an onboarding-state assumption rather than an authority fact, so the assertion
  // is that the admitted identity is neither refused nor met with a server error.
  // Exercise the destination the participant was ACTUALLY sent to, all the way to a
  // TERMINAL response. `destination` is already validated above as same-origin and a
  // member of the approved set; the walk below re-validates every further hop, bounds the
  // chain to one continuation, and refuses to call any redirecting path "final". The same
  // authenticated participant cookie is used for every request — a fresh session would
  // prove someone could reach the page, not that THIS participant can.
  const chain = await followParticipantDestination({ base, cookie, location: location! });
  const finalDestination = chain.finalDestination;
  const finalStatus = chain.finalStatus;

  EVIDENCE.tenantBinding = `workspace ${TENANT_A.workspaceId}`;
  EVIDENCE.roleBinding = "pm (from the invitation record, not the caller)";
  // Emitted only after a TERMINAL response was observed; pathnames only, never query
  // strings, tokens or session material.
  EVIDENCE.inviteAcceptDestination = chain.firstDestination;
  EVIDENCE.inviteDestinationRedirectHops = String(chain.hops);
  EVIDENCE.inviteFinalDestination = finalDestination;
  EVIDENCE.inviteFinalDestinationStatus = String(finalStatus);
  EVIDENCE.inviteAcceptanceSurface = `PARTICIPANT_FACING_ROUTE GET ${inviteAcceptPath.replace(/\/[^/]+$/, "/<token>")} -> ${accepted.status} Location ${chain.firstDestination} (a successful post-acceptance landing; /team and the onboarding destinations are both legitimate and race-dependent). THE RETURNED DESTINATION WAS THEN WALKED TO A TERMINAL RESPONSE with the same participant session: ${chain.firstDestination}${chain.hops > 0 ? ` -> ${finalDestination}` : ""} -> ${finalStatus} (every hop same-origin, bounded to ${chain.hops} continuation(s), never an authentication-loss destination)`;
  EVIDENCE.inviteAcceptanceIdentitySource = "SESSION_DERIVED (requireAuthUser on the shipped route), not caller-supplied";
});

test("D2. INVITE_REPLAY_REFUSED: the same token cannot mint a second authority grant", async () => {
  // Replay stays at the DOMAIN layer on purpose. The shipped route is rate-limited
  // (20/h per IP, 10/h per token), so replaying through it would eventually be refused
  // by the abuse limiter rather than by invitation semantics, making the case
  // nondeterministic and testing the wrong boundary. D1 already certifies the route.
  const supabase = admin();
  // Treating ANY throw as proof of refusal would let a PostgREST outage, a query
  // regression or a programmer error satisfy the replay control without the
  // `already_used` decision ever being reached. Only that specific denial counts;
  // everything else is rethrown and fails the case.
  let replayed = false;
  let refusal: WorkspaceInviteError | null = null;
  try {
    await acceptWorkspaceInvite({ token: inviteToken, userId: participantUserId, userEmail: participantEmail }, async () => supabase as never);
    replayed = true;
  } catch (error) {
    if (!(error instanceof WorkspaceInviteError)) throw error;
    if (error.reason !== "already_used") throw error;
    refusal = error;
  }
  assert.equal(replayed, false, "a used invitation token was accepted a second time");
  assert.ok(refusal, "the replay did not reach the already_used decision");
  assert.equal(refusal!.reason, "already_used", "the replay was refused for an unrelated reason");

  const memberships = await supabase.from("workspace_memberships").select("workspace_id").eq("user_id", participantUserId);
  assert.equal(memberships.error, null, `membership lookup failed: ${memberships.error?.message}`);
  // Scoped to the invited tenant for the same reason as D1: the participant also holds
  // its own bootstrapped workspace once acceptance runs through the shipped route.
  const inTenantA = (memberships.data ?? []).filter((m) => m.workspace_id === TENANT_A.workspaceId);
  assert.equal(inTenantA.length, 1, "token replay created a second authority grant in the invited tenant");
  EVIDENCE.inviteReplayRefused = "PASS (WorkspaceInviteError reason=already_used; still exactly one invited-tenant membership after replay)";
});

// ───────────────── PHASE E — governed first use (the load-bearing claim) ─────────────────

test("E1. POST_ADMISSION_GOVERNED_ACCESS: the governed first-use path is now ALLOWED", async () => {
  const s = await sessionFor(participantEmail);
  const r = await governedFirstUse(s);
  assert.equal(r.status, 200, `admission did not confer governed access: ${r.status} ${r.text.slice(0, 250)}`);
  EVIDENCE.postAdmissionGovernedAccess = "200";
  EVIDENCE.governedFirstUsePath = `GET /api/execution-tasks?projectId=${TENANT_A.projectId}`;
  EVIDENCE.governedFirstUseCapability = "project.read";
});

test("E2. GOVERNED_FIRST_USE_FRONTERA_REACHED: the allow is produced by runtime authorization, not a bypass", () => {
  // Runtime evidence above proves the VERDICT; this pins the PATH that produced it,
  // so a future refactor that quietly stopped consulting the runtime would fail here
  // rather than silently downgrading the strongest claim this beta makes.
  const route = readFileSync("src/app/api/execution-tasks/route.ts", "utf8");
  // SUPPLEMENTARY ONLY — this file-wide match is satisfiable by the import declaration and
  // therefore proves nothing on its own. The load-bearing control is the GET-bounded
  // invocation assertion below.
  assert.match(route, /server-authorization/, "the governed route no longer references server-authorization at all");
  // BOUNDED TO THE GET HANDLER. A file-wide match was satisfiable by the import statement
  // alone, or by a call inside POST — neither proves the GET path this case certifies
  // actually consults the guard. Slice GET's own body and require the INVOCATION there,
  // so removing the call while leaving the import in place fails this control.
  const getStart = route.indexOf("export async function GET(");
  assert.notEqual(getStart, -1, "the GET handler could not be located in the governed route");
  const afterGet = route.slice(getStart + 1);
  const nextRouteExport = afterGet.search(/\nexport (async )?(function|const) /);
  const getBody = nextRouteExport === -1 ? route.slice(getStart) : route.slice(getStart, getStart + 1 + nextRouteExport);
  assert.doesNotMatch(getBody, /^import /m, "the GET slice leaked import declarations, which must not satisfy this control");
  assert.match(getBody, /await requireProjectAccess\(/, "the GET handler does not INVOKE the project access guard");

  const guard = readFileSync("src/lib/security/server-authorization.ts", "utf8");
  // Bounded to evaluateCapability's own body. The previous open-ended slice ran to EOF,
  // so a later function referencing authorizeRuntimeAction would have satisfied these
  // assertions even if evaluateCapability had stopped calling it. Latent, not yet
  // exploitable — fixed here because it is the same class as the teardown slice above.
  const fnStart = guard.indexOf("export async function evaluateCapability");
  assert.ok(fnStart > 0, "evaluateCapability could not be located");
  const afterStart = guard.slice(fnStart + 1);
  const nextExport = afterStart.search(/\nexport (async )?(function|const) /);
  const fn = nextExport === -1 ? guard.slice(fnStart) : guard.slice(fnStart, fnStart + 1 + nextExport);
  assert.match(fn, /authorizeRuntimeAction/, "evaluateCapability no longer reaches runtime authorization");
  assert.match(fn, /buildEnterpriseRuntimeRequest/, "evaluateCapability no longer builds a runtime authorization request");

  const actions = readFileSync("src/lib/aoc/runtime/governance-actions.ts", "utf8");
  assert.match(actions, /read: "project\.read"/, "the read permission no longer maps to project.read");
  EVIDENCE.governedFirstUseFronteraReached = "YES (requireProjectAccess -> evaluateCapability -> authorizeRuntimeAction, project.read)";
});

// ───────────────── PHASE F — a real tenant operation, truthfully labelled ─────────────────

test("F1. REAL_TENANT_OPERATION: the admitted participant COMPLETES a real tenant write with an observable effect", async () => {
  // The payload shape is the product's own, taken from the real client
  // (`text-capture-modal.tsx` / `operational-data.ts`): no sourceKey is sent,
  // because the route pins it server-side. Nothing test-only is introduced — this
  // is the same route, the same auth, the same membership, the same supported
  // operation and the same persistence the product uses.
  const requestId = crypto.randomUUID();
  const capture = (correlationId: string, idem: string) =>
    JSON.stringify({
      workspaceId: TENANT_A.workspaceId,
      projectId: TENANT_A.projectId,
      operation: "capture_input",
      idempotencyKey: `capture:${idem}`,
      title: "P0-LAUNCH-06 rehearsal capture",
      content: "Beta release rehearsal: a real operational input captured by an admitted participant.",
      occurredAt: new Date().toISOString(),
      correlationId,
    });
  const post = (s: HttpSession, body: string) =>
    s.request("/api/operational-flow", { method: "POST", headers: { "content-type": "application/json" }, body });

  // ---- A. the admitted participant COMPLETES the operation ----
  const participant = await post(await sessionFor(participantEmail), capture(requestId, requestId));
  assert.equal(participant.status, 201, `the admitted participant did not COMPLETE the tenant write: ${participant.status} ${participant.text.slice(0, 300)}`);

  const created = JSON.parse(participant.text) as { normalizedEvent?: { id?: string } };
  const eventId = created.normalizedEvent?.id;
  assert.ok(eventId, `the completed operation returned no canonical resource: ${participant.text.slice(0, 250)}`);

  // ---- B. the effect is OBSERVABLE, re-read from persistence ----
  // An HTTP 201 alone is not accepted as proof for a route that persists state.
  const persisted = await admin()
    .from("operational_normalized_events")
    .select("id, workspace_id, project_id, correlation_id")
    .eq("id", eventId)
    .maybeSingle();
  assert.ok(persisted.data, `the operation reported 201 but persisted no normalized event: ${persisted.error?.message ?? "row absent"}`);
  assert.equal(persisted.data.workspace_id, TENANT_A.workspaceId, "the persisted effect landed in the wrong tenant");
  assert.equal(persisted.data.project_id, TENANT_A.projectId, "the persisted effect landed in the wrong project");

  // ---- C. the identical request from a FOREIGN tenant owner is refused ----
  const foreignCorrelation = crypto.randomUUID();
  const foreigner = await post(await sessionFor(foreignEmail), capture(foreignCorrelation, foreignCorrelation));
  assert.equal(foreigner.status, 403, `a foreign-tenant owner completed a write in tenant A: ${foreigner.status} ${foreigner.text.slice(0, 250)}`);

  // ---- D. the refused request left NO effect ----
  const foreignEffect = await admin()
    .from("operational_normalized_events")
    .select("id")
    .eq("correlation_id", foreignCorrelation);
  assert.equal(foreignEffect.error, null, `the side-effect verification query failed, so absence is unproven: ${foreignEffect.error?.message}`);
  assert.deepEqual(foreignEffect.data, [], "a refused cross-tenant write still produced a persisted effect");

  EVIDENCE.realTenantOperationPath = "POST /api/operational-flow";
  EVIDENCE.realTenantOperationKind = "capture_input";
  EVIDENCE.realTenantOperationHttp = "201";
  EVIDENCE.realTenantOperationEffect = `operational_normalized_events row ${eventId} persisted in workspace ${TENANT_A.workspaceId} / project ${TENANT_A.projectId}`;
  EVIDENCE.realTenantOperationCompleted = "YES";
  EVIDENCE.foreignTenantOperation = "DENIED (403 on the identical valid request)";
  EVIDENCE.foreignTenantSideEffect = "NONE (no normalized event for the refused correlation id)";
  EVIDENCE.operationalFlowAuthorizationModel = "DIRECT_MEMBERSHIP_ROLE_CHECK (not Frontera-governed)";
});

// ───────────────── PHASE G — cross-tenant isolation ─────────────────

test("G1. CROSS_TENANT_ISOLATION: authority in tenant A confers nothing in tenant B, and vice versa", async () => {
  // Non-vacuity in BOTH directions: each identity genuinely holds authority
  // somewhere, so each denial is attributable to the tenant boundary.
  assert.equal((await membershipOf(participantUserId, TENANT_A.workspaceId))?.role, "pm", "precondition: participant must hold tenant A authority");
  assert.equal((await membershipOf(foreignUserId, TENANT_B.workspaceId))?.role, "owner", "precondition: foreign identity must own tenant B");
  assert.equal(await membershipOf(participantUserId, TENANT_B.workspaceId), null, "participant leaked membership into tenant B");
  assert.equal(await membershipOf(foreignUserId, TENANT_A.workspaceId), null, "foreign identity leaked membership into tenant A");

  // A tenant-B OWNER must not reach the tenant-A governed path.
  const foreign = await sessionFor(foreignEmail);
  const r = await governedFirstUse(foreign);
  assert.equal(r.status, 403, `a foreign-tenant owner reached tenant A's governed path: ${r.status} ${r.text.slice(0, 200)}`);
  EVIDENCE.crossTenantIsolation = "tenant-B owner -> tenant-A governed path 403; no cross-tenant membership in either direction";
});

// ───────────────── PHASE H — dependency outage and recovery ─────────────────

test("H1. AUTH_OUTAGE: readiness becomes NOT READY while liveness stays truthful", async () => {
  setAuthOutage(true);
  try {
    const notReady = await awaitReadiness(503, "readiness never went NOT READY during an auth outage");
    const auth = notReady.checks.find((c) => c.name === "auth");
    assert.equal(auth?.status, "fail", "the auth check did not fail during the auth outage");

    // Attributability: the database check must still pass, so the transition is
    // caused by the auth dependency alone rather than a general failure.
    const db = notReady.checks.find((c) => c.name === "database");
    assert.equal(db?.status, "pass", "the database check also failed, so the transition is not attributable to auth");

    // Liveness answers process health, not dependency health.
    const health = await session.request("/api/health");
    assert.equal(health.status, 200, "liveness followed readiness down; process health and dependency health were conflated");
    EVIDENCE.authOutageBehavior = `readiness 503 (auth=fail, database=pass), liveness 200 in the same process`;
  } finally {
    setAuthOutage(false);
  }
});

test("H2. AUTH_RECOVERY: readiness returns to READY without a restart or manual repair", async () => {
  const recovered = await awaitReadiness(200, "readiness never recovered after the auth dependency returned");
  assert.ok(recovered.checks.every((c) => c.status === "pass"), "a check is still failing after recovery");
  EVIDENCE.authRecovery = "readiness 200 after dependency restoration; same process, no manual repair";
});

test("H3. DATABASE outage/recovery is EXECUTED here, not inherited from a source grep", async () => {
  // Previously this claimed "INHERITED from P0-LAUNCH-04 (28/28)" on the strength of the
  // predecessor's source containing the word "database" — satisfiable by a comment, and
  // it would keep reporting database recovery evidence after those controls were deleted.
  // P0-LAUNCH-06 now executes its own control instead, using the same dependency-outage
  // shim H1/H2 use, pointed at the readiness DATABASE probe's path (/rest/v1). The whole
  // P0-LAUNCH-04 battery is deliberately NOT re-run.
  const dbPort = await freePort();
  const dbControlDir = fs.mkdtempSync(path.join(os.tmpdir(), "p0-launch-06-db-"));
  const dbOutage = await startProductionServer({
    port: dbPort,
    env: betaEnv({ P0_LAUNCH_04_OUTAGE_DIR: dbControlDir, P0_LAUNCH_04_OUTAGE_PATH_PREFIXES: "/rest/v1" }),
    timeoutMs: 240_000,
  });
  try {
    assertStarted(dbOutage, "H3 database-outage rehearsal server");
    const s = new HttpSession(`http://127.0.0.1:${dbPort}`);
    const readiness = async () => {
      const r = await s.request("/api/ready");
      let parsed: { status?: string; checks?: Array<{ name: string; status: string }> } = {};
      try { parsed = JSON.parse(r.text) as typeof parsed; } catch { /* raw status is the evidence */ }
      return { httpStatus: r.status, checks: parsed.checks ?? [] };
    };
    const settle = async (want: number) => {
      let last = await readiness();
      for (let i = 0; i < 60 && last.httpStatus !== want; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        last = await readiness();
      }
      return last;
    };

    // 1. healthy before the outage
    const before = await settle(200);
    assert.equal(before.httpStatus, 200, `readiness was not healthy before the database outage: ${before.httpStatus}`);
    assert.equal(before.checks.find((c) => c.name === "database")?.status, "pass", "the database dependency was not passing before the outage");

    // 2. the database dependency fails, and liveness stays truthful
    fs.writeFileSync(path.join(dbControlDir, "path-outage"), "");
    const during = await settle(503);
    assert.equal(during.httpStatus, 503, "readiness did not report NOT READY during the database outage");
    assert.equal(during.checks.find((c) => c.name === "database")?.status, "fail", "the database dependency did not report fail during the outage");
    const liveness = await s.request("/api/health");
    assert.equal(liveness.status, 200, "liveness stopped answering during a dependency outage");

    // 3. recovery, same process, no manual repair
    fs.rmSync(path.join(dbControlDir, "path-outage"), { force: true });
    const after = await settle(200);
    assert.equal(after.httpStatus, 200, "readiness did not recover after the database dependency returned");
    assert.equal(after.checks.find((c) => c.name === "database")?.status, "pass", "the database dependency did not recover");

    EVIDENCE.databaseOutageBehavior =
      "EXECUTED in P0-LAUNCH-06: readiness 200/database=pass -> 503/database=fail with liveness 200 in the same process -> 200/database=pass after restoration, no restart and no manual repair (dependency-outage shim on /rest/v1)";
  } finally {
    // Same discipline as J1 and the final hook: the shutdown assertion must not be able
    // to abort the control-directory cleanup that follows it.
    const dbCleanupFailures: string[] = [];
    if (dbOutage.started) {
      try {
        assertShutdownClean(
          await shutdownProductionServer(dbOutage.handle, { label: "database-outage rehearsal server", graceMs: 10_000 }),
          "database-outage rehearsal server",
        );
      } catch (error) {
        dbCleanupFailures.push(`process cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try { fs.rmSync(dbControlDir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.deepEqual(dbCleanupFailures, [], `H3 cleanup did not fully succeed: ${dbCleanupFailures.join(" | ")}`);
  }
});

// ───────────────── PHASE I — offboarding and authority removal ─────────────────

test("I1. OFFBOARDING denies before it permits: an unauthorized actor cannot remove the participant", async () => {
  const foreign = await sessionFor(foreignEmail);
  const r = await foreign.request("/api/workspace-team/members", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: participantUserId }),
  });
  assert.equal(r.status, 403, `a foreign-tenant owner was allowed to offboard in tenant A: ${r.status}`);
  assert.ok(await membershipOf(participantUserId, TENANT_A.workspaceId), "PERSISTENCE: a refused offboarding removed the membership anyway");
  EVIDENCE.offboardingDeniesFirst = "foreign-tenant owner -> 403, participant membership intact";
});

test("I2. OFFBOARDING removes tenant authority and persists a correct member_removed audit event", async () => {
  const s = await sessionFor(OWNER_A.email);
  const r = await s.request("/api/workspace-team/members", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: participantUserId }),
  });
  assert.equal(r.status, 200, `the supported offboarding failed: ${r.status} ${r.text.slice(0, 250)}`);
  assert.equal(await membershipOf(participantUserId, TENANT_A.workspaceId), null, "offboarding did not remove the membership");

  const events = await admin().from("workspace_audit_events")
    .select("workspace_id, actor_user_id, event_type, payload")
    .eq("workspace_id", TENANT_A.workspaceId).eq("event_type", "member_removed")
    .order("created_at", { ascending: false }).limit(30);
  // Fails closed either way, but a query error must not be REPORTED as a missing audit
  // event — that misattributes an infrastructure failure to the product.
  assert.equal(events.error, null, `the member_removed audit lookup failed: ${events.error?.message}`);
  const row = (events.data ?? []).find((e: { payload?: { targetUserId?: string } }) => e.payload?.targetUserId === participantUserId);
  assert.ok(row, "no member_removed audit event was persisted for the offboarded participant");
  assert.equal(row.workspace_id, TENANT_A.workspaceId, "the audit event names the wrong workspace");
  assert.equal(row.actor_user_id, ownerUserId, "the audit event names the wrong actor");
  assert.equal(row.payload?.previousRole, "pm", "the audit event lost the previous role");

  EVIDENCE.offboardAuditEventPersisted = `member_removed ws=${row.workspace_id} actor=${row.actor_user_id} target=${participantUserId} previousRole=pm`;
  EVIDENCE.offboardingAuthorizationModel = "AUTHENTICATED_SESSION_PLUS_SERVER_RESOLVED_WORKSPACE_HIERARCHY";
  EVIDENCE.offboardingFronteraGoverned = "NO";
});

test("I3. PLATFORM_IDENTITY_SURVIVES: offboarding removes authority, not the account", async () => {
  const identity = await admin().auth.admin.getUserById(participantUserId);
  assert.ok(!identity.error && identity.data.user, "offboarding deleted the platform identity");
  EVIDENCE.platformIdentitySurvives = "YES (auth.users row intact after offboarding)";
});

test("I4. GOVERNED_ACCESS_LIFECYCLE: 403 -> 200 -> 403 on the same protected path", async () => {
  const s = await sessionFor(participantEmail);
  const r = await governedFirstUse(s);
  assert.equal(r.status, 403, `an offboarded participant kept governed access: ${r.status} ${r.text.slice(0, 200)}`);
  EVIDENCE.postOffboardGovernedAccess = "403";
  EVIDENCE.governedAccessLifecycle = "403 (pre-admission) -> 200 (post-admission) -> 403 (post-offboarding)";
  EVIDENCE.tenantAuthorityRemoved = "YES";
});

// ───────────────── PHASE J — the audit-failure incident procedure ─────────────────

test("J1. OFFBOARD_AUDIT_FAILURE: the incident is surfaced, and the operator response is rehearsed", async () => {
  // Re-admit a disposable target so the incident can be rehearsed on real state
  // rather than described. The seam is the existing acceptance-only, local-isolated
  // fault seam; it is never used against a hosted target.
  const supabase = admin();
  const incidentEmail = `p0-launch-06-incident-${Date.now()}@example.test`;
  const made = await supabase.auth.admin.createUser({ email: incidentEmail, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD!, email_confirm: true });
  assert.ok(!made.error && made.data.user, `could not create the incident target: ${made.error?.message}`);
  const incidentUserId = made.data.user.id;

  // Cleanup protection begins the INSTANT the identity exists. Binding authority, its
  // assertion, the fault-server startup and its assertion are all inside: a failure at
  // any of those points must not leave an identity — still less one holding tenant
  // authority — behind in the shared fixture database.
  let faultServer: Awaited<ReturnType<typeof startProductionServer>> | null = null;
  try {
    const bound = await supabase.from("workspace_memberships").insert({ workspace_id: TENANT_A.workspaceId, user_id: incidentUserId, role: "pm" });
    assert.ok(!bound.error, `could not bind the incident target: ${bound.error?.message}`);

    const faultPort = await freePort();
    faultServer = await startProductionServer({
      port: faultPort,
      env: betaEnv({ PMFREAK_ACCEPTANCE_OFFBOARD_AUDIT_FAULT: "1" }),
      timeoutMs: 240_000,
    });
    assertStarted(faultServer, "J1 audit-fault rehearsal server");

    const s = new HttpSession(`http://127.0.0.1:${faultPort}`);
    const login = await s.request("/api/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: OWNER_A.email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! }).toString(),
    });
    assert.ok([200, 302, 303, 307].includes(login.status), `operator could not authenticate for the incident rehearsal: ${login.status}`);

    const r = await s.request("/api/workspace-team/members", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, targetUserId: incidentUserId }),
    });

    // STEP 1 — the operation must NOT report clean success.
    assert.notEqual(r.status, 200, "an audit-write failure was reported as a clean success");
    assert.equal(r.status, 500, `the audit failure was not surfaced with its own classification: ${r.status}`);
    assert.match(r.text, /offboarding_audit_write_failed/, "the response does not name the audit failure");

    // STEP 2 — the operator INSPECTS EFFECTIVE MEMBERSHIP FIRST, before any retry.
    const effective = await membershipOf(incidentUserId, TENANT_A.workspaceId);
    assert.equal(effective, null, "the residual's premise changed: membership survived, so this is not the partial state");

    // STEP 3 — determine that authority is already gone and the audit record is missing.
    const events = await supabase.from("workspace_audit_events").select("payload")
      .eq("workspace_id", TENANT_A.workspaceId).eq("event_type", "member_removed")
      .order("created_at", { ascending: false }).limit(30);
    assert.equal(events.error, null, `the audit lookup failed, so a suppressed audit write is unproven: ${events.error?.message}`);
    const recorded = (events.data ?? []).some((e: { payload?: { targetUserId?: string } }) => e.payload?.targetUserId === incidentUserId);
    assert.equal(recorded, false, "the fault seam did not suppress the audit write, so this proves nothing");

    // STEP 4 — a blind retry is the WRONG action, and the system shows why: the
    // membership is already gone, so retrying would answer deny_target_not_member
    // rather than repairing anything. Reconciliation is a records action, not a retry.
    EVIDENCE.offboardAuditFailureRunbookRehearsed =
      "500 offboarding_audit_write_failed -> inspect effective membership FIRST (already removed) -> " +
      "confirm member_removed absent -> reconcile the audit record as an incident -> do NOT blindly retry the deletion";
  } finally {
    // EVERY cleanup component is attempted even when an earlier one fails. Asserting the
    // shutdown outcome inline used to throw straight out of the finally block, so the
    // authority-bearing membership and the identity itself were never cleaned up — a
    // process-cleanup failure silently became a fixture leak. Failures are collected and
    // raised together at the end: nothing is swallowed, and a database cleanup failure
    // still turns the test red.
    const cleanupFailures: string[] = [];
    if (faultServer?.started) {
      try {
        assertShutdownClean(
          await shutdownProductionServer(faultServer.handle, { label: "audit-fault rehearsal server", graceMs: 10_000 }),
          "audit-fault rehearsal server",
        );
      } catch (error) {
        cleanupFailures.push(`process cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const unbound = await supabase.from("workspace_memberships").delete().eq("user_id", incidentUserId);
    if (unbound.error) cleanupFailures.push(`incident membership cleanup: ${unbound.error.message}`);
    const removed = await supabase.auth.admin.deleteUser(incidentUserId);
    if (removed.error) cleanupFailures.push(`incident identity cleanup: ${removed.error.message}`);
    assert.deepEqual(cleanupFailures, [], `J1 cleanup did not fully succeed: ${cleanupFailures.join(" | ")}`);
  }
});

// ───────────────── PHASE K — the release contract this rehearsal certifies ─────────────────

test("K1. CERTIFIED BOUNDARY: the runtime boundary is certified; the hosted data tier is NOT", () => {
  // Scope discipline: this gate must not be readable as a full-topology claim.
  EVIDENCE.certifiedBetaRuntimeBoundary = "NEXTJS_16_SERVER_RUNTIME_WITH_IN_PROCESS_CLOSED_BETA_GUARD";
  EVIDENCE.certifiedBetaServerRuntimePreflightBypass = "NO";
  // This gate performs NO migration, dump, restore or integrity check — `npm run
  // check:beta-release-rehearsal` runs this file alone. The hosted certification is real
  // but EXTERNAL: it was produced by the separate, already-accepted RR-MIGRATE and
  // RR-BACKUP rehearsals. Emitting it as a bare PASS implied this case had verified it,
  // so it is emitted as attributed snapshot metadata instead. The VALUE is unchanged.
  const hostedDataTier = {
    value: "PASS_FOR_FRESH_MIGRATION_AND_LOGICAL_BACKUP_RECOVERABILITY",
    provenance: "EXTERNAL_AUTHORITATIVE_SNAPSHOT_METADATA",
    generatedByThisGate: "NO",
    verifiedByThisGate: "NO",
    source: "RR-MIGRATE (hosted validation project, 161/161 applied, 0 pending, 0 unexpected, no manual repair) and RR-BACKUP (authoritative single-pass isolated local logical restore, exit 0)",
    canonicalRecords: "docs/release/hosted-supabase-migration-proof.md, docs/release/backup-restore-drill.md, docs/release/residual-risk-register.md",
    scope: "FRESH_MIGRATION_AND_LOGICAL_BACKUP_RECOVERABILITY_ONLY",
    hostedPlatformRestoreRehearsal: "NOT_PERFORMED",
    fullBetaDeploymentTopologyCertified: "NO",
  } as const;
  // Lock the attribution: a future edit that re-presents this as gate-generated fails here.
  assert.equal(hostedDataTier.provenance, "EXTERNAL_AUTHORITATIVE_SNAPSHOT_METADATA", "the hosted certification lost its external attribution");
  assert.equal(hostedDataTier.generatedByThisGate, "NO", "the battery claims to have generated the hosted certification");
  assert.equal(hostedDataTier.verifiedByThisGate, "NO", "the battery claims to have verified the hosted certification");
  // The external snapshot must be traceable to repository records that agree with it. The
  // previous head cited RR-MIGRATE/RR-BACKUP while those documents still said NOT EXECUTED
  // and OPEN, so the gate emitted a PASS its own evidence base denied.
  const hostedProof = readFileSync("docs/release/hosted-supabase-migration-proof.md", "utf8");
  assert.match(hostedProof, /HOSTED_MIGRATIONS_APPLIED=161\/161/, "the hosted proof does not record the executed migration count");
  assert.match(hostedProof, /RR_MIGRATE=RESOLVED/, "the hosted proof does not record RR-MIGRATE as resolved");
  assert.doesNotMatch(hostedProof.split("## Historical context")[0]!, /^## Status: NOT EXECUTED/m, "the hosted proof still declares the execution NOT EXECUTED");
  const drill = readFileSync("docs/release/backup-restore-drill.md", "utf8");
  assert.match(drill, /RR_BACKUP=RESOLVED/, "the restore drill does not record RR-BACKUP as resolved");
  assert.match(drill, /HOSTED_PLATFORM_RESTORE_REHEARSAL=NOT_PERFORMED/, "the restore drill does not preserve the hosted-restore scope limit");

  // The canonical register is the current-state record, so bind to ITS rows — by risk
  // ID, one row at a time. A repo-wide substring search would be satisfied by the
  // historical "PRIOR STATE ... remains OPEN" text those same rows deliberately retain.
  const register = readFileSync("docs/release/residual-risk-register.md", "utf8");
  const registerRow = (id: string): string => {
    const at = register.indexOf(`| ${id} |`);
    assert.notEqual(at, -1, `${id} has no canonical row in the residual risk register`);
    const end = register.indexOf("\n", at);
    return register.slice(at, end === -1 ? undefined : end);
  };
  for (const id of ["RR-MIGRATE", "RR-BACKUP"]) {
    const row = registerRow(id);
    assert.match(row, /\*\*DISPOSITION: RESOLVED \(P0-LAUNCH-06/, `${id} is not RESOLVED in the canonical register row`);
    // The disposition must lead the row, ahead of the retained historical narrative.
    const dispositionAt = row.indexOf("DISPOSITION: RESOLVED");
    const priorStateAt = row.indexOf("PRIOR STATE");
    assert.ok(dispositionAt > 0 && (priorStateAt === -1 || dispositionAt < priorStateAt),
      `${id}'s historical text precedes its current disposition, so the row reads as OPEN`);
  }
  // Scope limit must survive in the same canonical row, not only in the drill document.
  assert.match(registerRow("RR-BACKUP"), /HOSTED_PLATFORM_RESTORE_REHEARSAL=NOT_PERFORMED/,
    "the RR-BACKUP register row drops the hosted-restore scope limit");
  EVIDENCE.hostedDataTierCertification = hostedDataTier;
  EVIDENCE.fullBetaDeploymentTopologyCertified = "NO";
  EVIDENCE.invalidEnvProcessExits = "NO (Next.js 16.3.2 may keep listening; surfaces still fail closed)";

  const instrumentation = readFileSync("src/instrumentation.ts", "utf8");
  assert.match(instrumentation, /RUNTIME boundary, not a deployment-time one/i, "the runtime guard does not state its scope limit");
});

test("K2. ACCEPTED RESIDUAL BOUNDARIES still hold and are not silently upgraded", () => {
  const register = readFileSync("docs/release/residual-risk-register.md", "utf8");
  for (const rr of [
    "RR-GOVERNANCE-PERMISSION-GUARD-BROKEN",
    "RR-BETA-OPERATOR-FRONTERA-BOUNDARY",
    "RR-NORMAL-INVITE-SEAT-MODEL",
    "RR-OFFBOARD-AUDIT-NONATOMIC",
    "RR-INVITE-AUDIT-NONATOMIC",
    "RR-INVITE-ACCEPTANCE-NONATOMIC",
    "RR-BETA-PLATFORM-SIGNUP-OPEN",
  ]) {
    // Bounded to the row's OWN line. An open-ended slice plus a fixed 400-character
    // window could spill into the NEXT register row, letting a neighbour's
    // ACCEPTED_FOR_CLOSED_BETA satisfy a residual that had lost its own disposition.
    const at = register.indexOf(`| ${rr} |`);
    assert.notEqual(at, -1, `${rr} is missing from the register`);
    const lineEnd = register.indexOf("\n", at);
    const row = register.slice(at, lineEnd === -1 ? undefined : lineEnd);
    assert.ok(row.startsWith(`| ${rr} |`), `${rr} is missing from the register`);
    assert.match(row, /ACCEPTED_FOR_CLOSED_BETA/, `${rr} no longer carries ACCEPTED_FOR_CLOSED_BETA`);
  }

  // The broken guard must remain absent from every certified beta path.
  for (const f of [
    "scripts/beta-invite-participant.mjs",
    "src/app/api/execution-tasks/route.ts",
    "src/app/api/ready/route.ts",
  ]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /await requireGovernancePermission\(/, `${f} now reaches the broken governance guard`);
  }
  EVIDENCE.acceptedResidualsUnchanged = "RR-GOVERNANCE-PERMISSION-GUARD-BROKEN, RR-BETA-OPERATOR-FRONTERA-BOUNDARY, RR-NORMAL-INVITE-SEAT-MODEL, RR-OFFBOARD-AUDIT-NONATOMIC, RR-INVITE-AUDIT-NONATOMIC, RR-INVITE-ACCEPTANCE-NONATOMIC, RR-BETA-PLATFORM-SIGNUP-OPEN all ACCEPTED_FOR_CLOSED_BETA";

  // Fixture-hygiene boundary, proven STRUCTURALLY. Bootstrap creation is race-dependent
  // (the (protected) layout and the accept page render concurrently), so the cleanup
  // branch cannot be made to run on demand without weakening the real D1 path. These
  // assertions therefore pin the teardown's shape rather than claiming it executed;
  // EVIDENCE.bootstrapCleanupRuntimeBranch reports whether it actually ran.
  const self = readFileSync("tests/acceptance/p0-launch-06-beta-release-rehearsal.test.ts", "utf8");
  // BOUNDED on both ends. An open-ended slice ran to EOF and therefore contained these
  // very assertions and their regex literals, so every positive check could match itself
  // even after the cleanup it describes was deleted. The hook body ends at its own
  // terminator, which is the first line that closes the `after(` call at column 0.
  const hookStart = self.indexOf("after(async () => {");
  const hookEnd = self.indexOf("\n});", hookStart);
  assert.ok(hookStart > 0 && hookEnd > hookStart, "the teardown hook body could not be located");
  const teardown = self.slice(hookStart, hookEnd);
  // Self-check: the bounded body must NOT contain this control's own assertion text.
  assert.ok(!teardown.includes("teardown does not identify participant-created workspaces"),
    "the teardown slice still contains this control's own assertions and can satisfy itself");
  assert.match(teardown, /created_by_user_id", participantUserId/, "teardown does not identify participant-created workspaces");
  assert.match(teardown, /id !== TENANT_A\.workspaceId && id !== TENANT_B\.workspaceId/, "teardown does not exclude the seeded tenants from selection");
  assert.match(teardown, /refusing to delete the seeded tenant A/, "teardown lacks an explicit seeded-tenant guard");
  assert.match(teardown, /bootstrap workspace membership cleanup failed/, "teardown does not handle removable membership state");
  assert.match(teardown, /bootstrap workspace cleanup failed/, "the workspace deletion result is not asserted");
  assert.match(teardown, /RETAINED_BY_DESIGN/, "the participant-retention rationale is no longer separate");
  // Immutable operational evidence must never be deleted for cleanup.
  assert.doesNotMatch(teardown, /from\("operational_(raw_inputs|normalized_events)"\)\s*\.delete\(/,
    "teardown deletes immutable operational evidence");
  EVIDENCE.bootstrapCleanupStructure =
    "participant-created workspaces identified by created_by_user_id; TENANT_A/TENANT_B excluded by filter AND by explicit guard; membership and workspace deletions both asserted; no operational_raw_inputs/operational_normalized_events delete exists in teardown";
});
