/**
 * P0-LAUNCH-04 — failure, recovery and observability acceptance.
 *
 * P0-LAUNCH-03 proved that PMFreak's supported production runtime can be built,
 * started, operated, stopped and restarted, and that it fails closed when a
 * dependency is absent. Every claim it makes is about a runtime whose
 * dependencies are in a FIXED state for the life of the process: the
 * database-outage control is a process BORN with its database unreachable, the
 * fail-closed controls are processes born with a broken configuration, and the
 * restart is a clean, cooperative SIGTERM.
 *
 * This file answers the question that leaves open:
 *
 *   when something operationally meaningful BREAKS under a running process,
 *   does PMFreak fail in the right way, expose enough truthful evidence to
 *   diagnose WHAT broke, and RECOVER when the dependency returns — without
 *   silently degrading governance or needing the durable state repaired by hand?
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEW HERE, AND WHY EACH PIECE IS NOT A REPLAY
 *
 * 1. TRANSITIONS, NOT STATES. The database claim is
 *      READY -> lost -> NOT READY -> restored -> READY
 *    observed across ONE pid, with both directions timed and bounded. That
 *    needs an outage the harness can switch while the server runs, which
 *    P0-LAUNCH-03's preload-decided shim structurally cannot do; see
 *    support/dependency-outage-shim.cjs for why availability is a control FILE.
 *
 * 2. AN ISOLATED AUTHENTICATION OUTAGE. The local Supabase stack puts PostgREST
 *    and GoTrue behind one gateway on one host:port, so a socket-level outage
 *    cannot tell "the database is gone" from "authentication is gone". The
 *    shim's path scope refuses `/auth/v1` only, so this file can hold the
 *    database UP while authentication is DOWN — the shape a real deployment
 *    fails in, and the only shape in which "no authentication bypass" means
 *    anything.
 *
 * 3. AN AUTHORITY BACKING THAT IS UNAVAILABLE RATHER THAN ABSENT.
 *    P0-LAUNCH-03 proved an UNCONFIGURED store and a MALFORMED store fail closed
 *    as outages. Neither can be recovered from — there is nothing to restore. So
 *    the store here is valid and provisioned, and it is its DIRECTORY that is
 *    made unreadable: contents byte-identical throughout, verified by digest on
 *    both sides, which is what makes "the same durable authority became usable
 *    again" distinguishable from "the authority was quietly re-provisioned".
 *
 * 4. ABNORMAL TERMINATION. SIGKILL, not SIGTERM: no shutdown hook runs, nothing
 *    is flushed, and the durable authority is left exactly as the killed process
 *    left it. A genuinely new process then has to govern with it, with no manual
 *    repair anywhere in between.
 *
 * 5. THE FOUR-WAY GOVERNED MATRIX, on one store, in order:
 *      healthy                     -> ALLOW
 *      backing unavailable         -> frontera_unavailable
 *      backing restored            -> ALLOW
 *      policy revoked              -> frontera_denied
 *    Revocation is last because Frontera's revocation is terminal by design.
 *
 * 6. OBSERVABILITY AS A CONTRACT, not as a hope. Every failure class is required
 *    to produce a signal, and the signals are required to be DISTINGUISHABLE
 *    from one another — an operator who cannot tell a policy problem from a
 *    dependency problem has no more information than a 500.
 *
 * 7. REDACTION WITH MARKER SECRETS. Synthetic values of a shape the product's
 *    redaction layer does NOT recognise, so the claim rests on the product not
 *    echoing secret values at all rather than on shape-based scrubbing catching
 *    them afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not wire `assertProductionEnvSafety()` into startup. That carry-forward
 * was resolved as a governance/configuration-contract decision rather than a
 * runtime defect: the function requires Stripe secrets that the adopted closed
 * free pilot (docs/release/pilot-capability-set.md) has no surface for, so
 * enforcing it at boot would refuse to start the very runtime P0-LAUNCH-03
 * accepted. `/api/ready` remains the intended runtime fail-closed guard for the
 * pilot path, and this file proves it. See
 * docs/release/p0-launch-04-failure-recovery-observability-acceptance.md.
 *
 * It does not redesign auth, Frontera persistence, or observability.
 *
 * EXACTLY ONE product change exists, in `src/lib/auth.ts`: `getAuthUser()`
 * records `auth_dependency_unavailable` when auth-js returns its transport error
 * class, so an unreachable auth dependency is distinguishable from an ordinary
 * unauthenticated caller. Its return value is unchanged, so authentication,
 * authorization, tenancy and every fail-closed path are untouched, and nothing
 * branches on the new value. Observability only.
 *
 * ---------------------------------------------------------------------------
 * SCOPE. LOCAL_PRODUCTION_LIKE_FAILURE_RECOVERY_ACCEPTANCE: `next build` +
 * `next start` on this machine against the disposable local Supabase stack. It
 * is NOT high availability, disaster recovery, zero downtime, full
 * observability, or a public production deployment.
 *
 * PRECONDITIONS (operator, out of band — never performed by this file):
 *   npm run seed:p2-13-founder
 * A local Supabase stack must be reachable at OPERATIONAL_FLOW_TEST_SUPABASE_URL,
 * and the P0-LAUNCH-02/03 Founder journey state must already exist.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createClient } from "@supabase/supabase-js";

import {
  openOperatorStore,
  provisionPmfreakDispatchAuthority,
  revokePmfreakDispatchAuthority,
} from "../../scripts/frontera-authority-provisioning.mjs";
import { buildP2_14HandoffManifest } from "../../scripts/p2-13/founder-scenario-manifest.mjs";
import { GUARD_MODES, LOCAL_ISOLATED, assertIsolatedTarget } from "../../scripts/p2-13/isolation-guard.mjs";

// The production-runtime lifecycle P0-LAUNCH-03 was accepted with, extracted
// verbatim so both gates stop a production process by exactly one code path and
// account for residue by exactly one ledger.
import {
  HARNESS_PROCESS_RESIDUE,
  HttpSession,
  asGovernedAllow,
  asGovernedInfrastructureFailure,
  asGovernedPolicyDenial,
  boundedFetch,
  cmdlineOf,
  environOf,
  freePort,
  pidAlive,
  portAcceptsConnections,
  processState,
  productionProcessesStarted,
  requireProc,
  runningPids,
  shutdownProductionServer,
  sleep,
  startProductionServer,
  waitUntil,
  type GovernedResponse,
  type ServerHandle,
} from "./support/runtime-acceptance";

const ROOT = process.cwd();
const OUTAGE_SHIM = path.join(ROOT, "tests/acceptance/support/dependency-outage-shim.cjs");
const FRONTERA_STORE_ENV = "AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH";

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ───────────────────────── bounded waiting, everywhere ─────────────────────────
//
// EVERY wait in this file has a deadline and every deadline is reported. A gate
// about recovery whose recovery wait could block forever would hang exactly when
// recovery failed, which is the one case it exists to report.

const READINESS_TRANSITION_TIMEOUT_MS = 30_000;
const PORT_RELEASE_TIMEOUT_MS = 20_000;

type ReadinessObservation = {
  readonly reached: boolean;
  readonly ms: number;
  readonly status: number;
  readonly body: { status?: string; checks?: { name: string; status: string; detail?: string }[] };
  readonly raw: string;
  readonly requestId: string | null;
};

/**
 * Polls `/api/ready` until it reports the wanted state, to a deadline.
 *
 * Returns the observation rather than asserting on it: the acceptance requires
 * `reached === true`, and a non-vacuity control at the bottom of this file
 * requires the SAME function to return `reached === false` when the state never
 * arrives. A helper that asserted internally could not serve both.
 */
async function observeReadiness(
  baseUrl: string,
  want: "ready" | "not_ready",
  timeoutMs = READINESS_TRANSITION_TIMEOUT_MS,
  requestId?: string,
): Promise<ReadinessObservation> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last: ReadinessObservation = {
    reached: false,
    ms: 0,
    status: 0,
    body: {},
    raw: "no response was received before the deadline expired",
    requestId: null,
  };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await boundedFetch(
        `${baseUrl}/api/ready`,
        { headers: requestId ? { "x-request-id": requestId } : {}, cache: "no-store" },
        Math.min(10_000, remaining),
      );
      const raw = await response.text();
      let body: ReadinessObservation["body"] = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* a non-JSON body is itself the evidence; `raw` carries it */
      }
      last = {
        reached: body.status === want,
        ms: Date.now() - startedAt,
        status: response.status,
        body,
        raw,
        requestId: response.headers.get("x-request-id"),
      };
      if (last.reached) return last;
    } catch (error) {
      last = { ...last, ms: Date.now() - startedAt, raw: `readiness probe failed: ${String(error)}` };
    }
    await sleep(Math.max(0, Math.min(250, deadline - Date.now())));
  }
  return { ...last, reached: false, ms: Date.now() - startedAt };
}

const readinessCheck = (observation: ReadinessObservation, name: string) =>
  (observation.body.checks ?? []).find((check) => check.name === name);

/**
 * Waits, to a deadline, for a port to stop accepting connections.
 *
 * `waitUntil` takes a SYNCHRONOUS predicate — handing it an async one returns a
 * Promise, which is always truthy, so the wait would succeed instantly and the
 * "the port was released" claim would be worthless. Hence an explicit loop.
 */
async function waitForPortRelease(port: number, timeoutMs = PORT_RELEASE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await portAcceptsConnections(port))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

// ───────────────────────── structured-log evidence ─────────────────────────

/**
 * The structured log lines a running server emitted for one event name.
 *
 * `src/lib/observability/logger.ts` writes one JSON object per line through the
 * redaction layer, so an operator signal is a parseable record rather than a
 * string to grep. Non-JSON lines (Next's own output, the shim's markers) are
 * skipped rather than guessed at.
 */
function structuredLogEvents(log: string, message: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && parsed.message === message) events.push(parsed);
    } catch {
      /* a partial line from an interleaved write is not evidence either way */
    }
  }
  return events;
}

const FRONTERA_REFUSAL_EVENT = "governed material action dispatch refused at the Frontera boundary";
const READINESS_FAILURE_EVENT = "readiness_check_failed";

// ───────────────────────── the redaction assertion ─────────────────────────

/**
 * Requires a marker-shaped synthetic secret to appear NOWHERE in captured
 * output.
 *
 * Parameterised rather than reading the captures directly, because the
 * non-vacuity control at the bottom of this file hands it output that DOES
 * contain the marker and requires it to throw. An assertion that could only
 * ever be handed clean output would prove nothing about its ability to notice a
 * leak.
 */
function assertMarkerAbsent(marker: string, captures: { where: string; text: string }[]): void {
  for (const capture of captures) {
    const at = capture.text.indexOf(marker);
    assert.equal(
      at,
      -1,
      `the synthetic secret VALUE leaked into ${capture.where} at offset ${at}: ` +
        `…${capture.text.slice(Math.max(0, at - 120), at + marker.length + 120)}…`,
    );
  }
}

// ───────────────────────────── run context ─────────────────────────────

const manifest = buildP2_14HandoffManifest();
const TENANT_A = manifest.tenants.find((tenant: { key: string }) => tenant.key === "A")!;
const OWNER_A = TENANT_A.actors.find((actor: { reference: string }) => actor.reference.endsWith(":owner"))!;

let RUN_DIR = "";
let CONTROL_DIR = "";
let STORE_DIR = "";
let STORE_PATH = "";
let CRASH_STORE_DIR = "";
let CRASH_STORE_PATH = "";
let EMPTY_STORE_PATH = "";
let MALFORMED_STORE_PATH = "";
let PRINCIPAL_USER_ID = "";
let SUPABASE_HOSTPORT = "";
let PORT = 0;
let server: ServerHandle | null = null;
let session!: HttpSession;
let actionId = "";

const SOCKET_OUTAGE_FLAG = () => path.join(CONTROL_DIR, "socket-outage");
const PATH_OUTAGE_FLAG = () => path.join(CONTROL_DIR, "path-outage");

const installOutage = (flag: string) => fs.writeFileSync(flag, "on");
const clearOutage = (flag: string) => fs.rmSync(flag, { force: true });

/**
 * Facts this run actually observed, printed once at the end. Every one of them
 * is also the subject of an assertion above — none is assumed.
 */
const EVIDENCE: Record<string, string | number | boolean> = {};

/**
 * The operator signal recorded for each material failure class.
 *
 * `source` is load-bearing and is asserted, not decorative. A shim marker in the
 * server log proves the harness INJECTED a failure; it says nothing about what
 * PMFreak itself would show an operator in production. So every signal declares
 * where it comes from, and the diagnosability test requires each failure class to
 * carry at least one PRODUCT_* source — HARNESS_CONTROL evidence can prove
 * non-vacuity but can never satisfy operator diagnosability on its own.
 */
type SignalSource = "PRODUCT_HTTP" | "PRODUCT_LOG" | "PRODUCT_PROCESS" | "HARNESS_CONTROL";

type OperatorSignal = { readonly sources: readonly SignalSource[]; readonly signal: string };

const OPERATOR_SIGNALS: Record<string, OperatorSignal> = {};

const PRODUCT_SOURCES: readonly SignalSource[] = ["PRODUCT_HTTP", "PRODUCT_LOG", "PRODUCT_PROCESS"];

/** The product log event this increment added for an unreachable auth dependency. */
const AUTH_DEPENDENCY_EVENT = "auth_dependency_unavailable";

const runKey = `p0-launch-04-${Date.now()}`;
const SECRET_MARKER = `P0_LAUNCH_04_SECRET_MARKER_${createHash("sha256").update(runKey).digest("hex").slice(0, 24)}`;

/**
 * The environment a production process is started with.
 *
 * Overrides are passed as EMPTY STRINGS rather than deletions, and that detail
 * is load-bearing: `next start` loads `.env.local` itself, and @next/env only
 * fills a name whose `process.env` value is `undefined`, so deleting a variable
 * here would let `.env.local` quietly put it back and the control would test
 * nothing. An empty string is defined, survives that merge, and is falsy
 * everywhere the product checks it.
 */
function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // P0-LAUNCH-06 tightened the certified runtime contract: a Next.js PRODUCTION SERVER
  // must declare an explicit recognized PMFREAK_OPERATING_PROFILE, and a missing, blank
  // or unknown profile now refuses startup (src/instrumentation.ts). These harnesses
  // start real production servers, so they must declare the profile like any other
  // certified start. This adds ONLY that declaration — no assertion, lifecycle,
  // evidence claim or fixture semantic changes.
  return {
    ...process.env,
    PMFREAK_OPERATING_PROFILE: "closed-free-beta",
    [FRONTERA_STORE_ENV]: STORE_PATH,
    ...overrides,
  };
}

/**
 * Acceptance-only, real, secret-bearing variables that the PRODUCT never reads.
 *
 * `productionEnv()` spreads `process.env`, which is right for every other server
 * — they must run with the operator's real configuration. It is WRONG for the
 * redaction control, and independent review was correct that this made a claim
 * false: the child inherited the real service-role key and the real fixture
 * password, so "no real credential was placed in that environment" did not hold,
 * and a failure path that logged one of those inherited values would have gone
 * unnoticed because the capture is only searched for the synthetic marker.
 *
 * These are the harness's OWN credentials — used by this test process to open an
 * admin client and to construct login requests. `next start` needs none of them,
 * so the redaction control gets them removed. The product's own configuration
 * (`NEXT_PUBLIC_*`, and the marker-valued secrets K deliberately injects) is
 * preserved, because removing it would change what is being certified.
 */
const ACCEPTANCE_ONLY_REAL_SECRETS = [
  "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY",
  "OPERATIONAL_FLOW_TEST_ANON_KEY",
  "OPERATIONAL_FLOW_TEST_DATABASE_URL",
  "P2_13_FIXTURE_ACTOR_PASSWORD",
] as const;

/**
 * A child environment with the harness's own real credentials removed.
 *
 * Emptied rather than deleted, for the same reason every other override in this
 * file is: `next start` loads `.env.local` itself and @next/env fills any name
 * whose `process.env` value is `undefined`, so a deletion would let the dotenv
 * file put the real value straight back and the sanitisation would be imaginary.
 */
function sanitizedProductionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const blanked: Record<string, string> = {};
  for (const name of ACCEPTANCE_ONLY_REAL_SECRETS) blanked[name] = "";
  return productionEnv({ ...blanked, ...overrides });
}

/** The environment for a process whose dependency availability this run controls. */
function outageEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return productionEnv({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${OUTAGE_SHIM}`.trim(),
    P0_LAUNCH_04_OUTAGE_DIR: CONTROL_DIR,
    P0_LAUNCH_04_OUTAGE_HOSTPORT: SUPABASE_HOSTPORT,
    P0_LAUNCH_04_OUTAGE_PATH_PREFIXES: "/auth/v1",
    ...overrides,
  });
}

type OperatorStore = { close(): Promise<void> };

async function withOperatorStore<T>(storePath: string, fn: (store: OperatorStore) => Promise<T>): Promise<T> {
  const store = (await openOperatorStore(storePath)) as OperatorStore;
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

const provisionAuthority = (storePath: string) =>
  withOperatorStore(storePath, (store) =>
    provisionPmfreakDispatchAuthority(store, {
      organizationId: TENANT_A.workspaceId,
      principalUserId: PRINCIPAL_USER_ID,
      projectId: TENANT_A.projectId,
      operatorActorId: "operator-p0-launch-04",
    }),
  );

const revokeAuthority = (storePath: string) =>
  withOperatorStore(storePath, (store) =>
    revokePmfreakDispatchAuthority(store, {
      organizationId: TENANT_A.workspaceId,
      principalUserId: PRINCIPAL_USER_ID,
      projectId: TENANT_A.projectId,
      operatorActorId: "operator-p0-launch-04",
      reason: "P0-LAUNCH-04 failure recovery acceptance",
    }),
  );

async function signIn(target: HttpSession) {
  const body = new URLSearchParams({ email: OWNER_A.email, password: process.env.P2_13_FIXTURE_ACTOR_PASSWORD! });
  return await target.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const hasSessionCookie = (target: HttpSession) => target.cookieNames.some((name) => name.startsWith("sb-"));

async function governedPost(target: HttpSession, payload: Record<string, unknown>): Promise<GovernedResponse> {
  const response = await target.request("/api/operational-flow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: TENANT_A.workspaceId, projectId: TENANT_A.projectId, ...payload }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(response.text) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is itself the evidence; `raw` carries it */
  }
  return { status: response.status, body, raw: response.text };
}

const dispatchGovernedAction = (target: HttpSession = session) =>
  governedPost(target, { operation: "dispatch_material_action_to_task", actionId });

/**
 * A governed dispatch that must NOT have succeeded, whatever the reason.
 *
 * Deliberately weaker than the failure-class assertions: this is the claim for
 * states where the product contract does not name ONE class (a total dependency
 * loss can surface as an authentication refusal or as an authority outage
 * depending on which layer is reached first). What it refuses to accept is any
 * shape of success — a 2xx, or a Frontera decision id, either of which would
 * mean the dispatch went through.
 */
function assertGovernedDidNotSucceed(response: GovernedResponse, why: string): void {
  assert.ok(
    ![200, 201].includes(response.status),
    `${why} — the governed dispatch SUCCEEDED (${response.status}): ${response.raw.slice(0, 300)}`,
  );
  assert.equal(
    response.body.fronteraDecisionId,
    undefined,
    `${why} — the response carries a Frontera decision id, so the dispatch was authorized: ${response.raw.slice(0, 300)}`,
  );
  assert.notEqual(
    response.body.disposition,
    "created",
    `${why} — a Task was created: ${response.raw.slice(0, 300)}`,
  );
}

before(async () => {
  // ── Execution-environment guard. This gate mutates disposable runtime state
  //    and must only ever run against the canonical checkout it was written for.
  assert.ok(fs.existsSync(path.join(ROOT, "vendor/aoc-consumer.lock.json")), `not a PMFreak checkout: ${ROOT}`);

  for (const name of [
    "OPERATIONAL_FLOW_TEST_SUPABASE_URL",
    "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY",
    "P2_13_FIXTURE_ACTOR_PASSWORD",
    "NEXT_PUBLIC_APP_URL",
  ] as const) {
    assert.ok(
      process.env[name],
      `${name} is required. Load the acceptance environment first:  set -a && . ./.env.local && set +a`,
    );
  }

  // ── NON-ROOT, because the authority outage is a PERMISSION denial.
  //
  //    The Frontera outage works by making the store's directory unreadable
  //    (`chmod 000`). Under UID 0 that denies nothing: root traverses the
  //    directory and opens the file regardless, so the "outage" would not exist
  //    and the gate would assert `frontera_unavailable` against a perfectly
  //    readable store. Independent review raised this for root-run containers.
  //
  //    The response is to REFUSE such an environment rather than to build a
  //    second outage mechanism for it: an environment that cannot produce the
  //    evidence must not be reported as having produced it — the same rule this
  //    gate already applies to `/proc`. The production child inherits this uid,
  //    so checking it here covers the child too.
  assert.equal(typeof process.getuid, "function", "this gate requires a POSIX platform exposing process.getuid()");
  assert.notEqual(
    process.getuid!(),
    0,
    "this gate must not run as root: the Frontera authority outage is produced by Unix permission denial (chmod 000), " +
      "which root bypasses, so a root run would assert an outage against a fully readable store. Run it as a non-root user.",
  );
  EVIDENCE.executionUid = process.getuid!();
  EVIDENCE.nonRootLinuxRequired = true;

  // ── ISOLATION, BEFORE THE FIRST PRIVILEGED ACCESS.
  //
  //    The assertions above prove those variables are NONEMPTY, which says
  //    nothing about WHERE they point. This gate opens an admin client with the
  //    service-role key, and then deliberately BREAKS the reachability of the
  //    Supabase host it is pointed at. Doing either against a hosted or
  //    production project would be unacceptable, so the repository's own
  //    canonical guard runs first: literal loopback host, the disposable local
  //    API port, equality with the URL the application is configured with, and
  //    an independent refusal of known hosted host shapes. It is a pure function
  //    over the environment, so "before any network access" is a property of
  //    this call's position rather than a hope about timing.
  const isolation = assertIsolatedTarget(process.env, { mode: GUARD_MODES.SEED });
  assert.equal(
    isolation.classification,
    LOCAL_ISOLATED,
    `the acceptance target was not classified local and isolated: ${JSON.stringify(isolation.target ?? null)}`,
  );
  EVIDENCE.isolationClassification = String(isolation.classification);
  EVIDENCE.isolationTarget = String(isolation.target?.supabaseHost ?? "(not reported)");

  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  SUPABASE_HOSTPORT = `${supabase.hostname}:${supabase.port || (supabase.protocol === "https:" ? "443" : "80")}`;
  EVIDENCE.dependencyUnderTest = SUPABASE_HOSTPORT;

  // ── Disposable run state. Each authority store lives in its OWN directory,
  //    because the Frontera outage below is produced by making a DIRECTORY
  //    unreadable and must not take any other store with it.
  RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pmfreak-p0-launch-04-"));
  CONTROL_DIR = path.join(RUN_DIR, "control");
  STORE_DIR = path.join(RUN_DIR, "authority");
  CRASH_STORE_DIR = path.join(RUN_DIR, "crash-authority");
  const emptyStoreDir = path.join(RUN_DIR, "empty-authority");
  const malformedStoreDir = path.join(RUN_DIR, "malformed-authority");
  for (const dir of [CONTROL_DIR, STORE_DIR, CRASH_STORE_DIR, emptyStoreDir, malformedStoreDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  STORE_PATH = path.join(STORE_DIR, "authority.sqlite");
  CRASH_STORE_PATH = path.join(CRASH_STORE_DIR, "authority.sqlite");
  EMPTY_STORE_PATH = path.join(emptyStoreDir, "authority.sqlite");
  MALFORMED_STORE_PATH = path.join(malformedStoreDir, "authority.sqlite");
  fs.writeFileSync(MALFORMED_STORE_PATH, "this is not a SQLite database\n");

  // ── The REAL authenticated principal id. Never guessed: an unresolvable actor
  //    is a hard failure, exactly as the operator provisioning script says.
  const admin = createClient(process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL!, process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (let page = 1; page <= 20 && !PRINCIPAL_USER_ID; page += 1) {
    const listed = await admin.auth.admin.listUsers({ page, perPage: 200 });
    assert.ok(!listed.error, `listUsers failed: ${listed.error?.message}`);
    const found = listed.data.users.find((user) => (user.email ?? "").toLowerCase() === OWNER_A.email.toLowerCase());
    if (found) PRINCIPAL_USER_ID = found.id;
    if (listed.data.users.length < 200) break;
  }
  assert.ok(
    PRINCIPAL_USER_ID,
    `no authenticated principal for ${OWNER_A.email}. Run 'npm run seed:p2-13-founder' first; this gate never invents an identity.`,
  );

  await provisionAuthority(STORE_PATH);
  await provisionAuthority(CRASH_STORE_PATH);
  // Provisioned with NOTHING, so "durable authority survived" can be shown to
  // fail when the authority is absent.
  await withOperatorStore(EMPTY_STORE_PATH, async () => {});

  PORT = await freePort();
});

after(async () => {
  // Normally already null: the residue test stops the long-lived server itself,
  // so its shutdown is inside the ledger that test asserts. This remains only as
  // a safety net for a run that aborted before reaching it — in which case the
  // residue assertion never ran either, so nothing is being certified.
  if (server) await shutdownProductionServer(server, { label: "after(): the last production server (run aborted early)", graceMs: 10_000 });
  // A store directory left unreadable by a failed test would defeat the cleanup
  // below, and a gate that cannot clean up after itself leaves the next run to
  // inherit its damage.
  for (const dir of [STORE_DIR, CRASH_STORE_DIR]) {
    try {
      if (dir) fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
  console.log(`\nP0_LAUNCH_04_FAILURE_RECOVERY_EVIDENCE ${JSON.stringify(EVIDENCE, null, 2)}`);
  console.log(`\nP0_LAUNCH_04_OPERATOR_SIGNALS ${JSON.stringify(OPERATOR_SIGNALS, null, 2)}`);
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ═══════════════════════ 0 — one build, many processes ═══════════════════════

test("0: the supported production build completes and emits a FRESH build", () => {
  const buildIdPath = path.join(ROOT, ".next/BUILD_ID");
  const startedAt = Date.now();

  // The real command, not a proxy for it. Every process this gate starts runs
  // from THIS build — one build, several isolated processes — so that a failure
  // is attributable to runtime behaviour rather than to compilation drift
  // between scenarios.
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });

  assert.ok(fs.existsSync(buildIdPath), "next build produced no .next/BUILD_ID");
  assert.ok(
    fs.statSync(buildIdPath).mtimeMs >= startedAt - 1_000,
    ".next/BUILD_ID was not rewritten by this build — stale output must never be accepted as a production build",
  );
  EVIDENCE.buildId = fs.readFileSync(buildIdPath, "utf8").trim();
});

// ═══════════════════════ A — the healthy control state ═══════════════════════

test("A: the production process starts healthy, ready, and governing (control state)", async () => {
  requireProc("identifying and attributing the production server process");

  const outcome = await startProductionServer({ port: PORT, env: outageEnv() });
  if (!outcome.started) assert.fail(`the production server did not start: ${outcome.reason}\n${outcome.log.slice(-4000)}`);
  server = outcome.handle;
  session = new HttpSession(server.baseUrl);

  assert.match(cmdlineOf(server.serverPid), /next-server/, `the process serving HTTP is not Next's production server: ${cmdlineOf(server.serverPid)}`);
  assert.doesNotMatch(server.log(), /next dev|Starting.*development/i, "the supported production entrypoint started a development server");

  // The outage machinery is present but IDLE. Proving it loaded here is what
  // makes the transitions below attributable: an outage that was never installed
  // would otherwise be indistinguishable from a dependency that never broke.
  assert.match(
    server.log(),
    /P0_LAUNCH_04_OUTAGE_SHIM_ACTIVE/,
    "the dependency-outage control was never installed in the server process, so no outage below can be attributed to it",
  );
  assert.doesNotMatch(server.log(), /P0_LAUNCH_04_(SOCKET|PATH)_OUTAGE_BLOCKED/, "an outage was already in effect before the control state was established");

  const health = await session.request("/api/health");
  assert.equal(health.status, 200, `/api/health returned ${health.status}: ${health.text.slice(0, 300)}`);
  assert.equal(health.json<{ status: string }>().status, "ok");

  const ready = await observeReadiness(server.baseUrl, "ready");
  assert.ok(ready.reached, `the control state is not READY within ${READINESS_TRANSITION_TIMEOUT_MS}ms: ${ready.raw.slice(0, 400)}`);
  assert.equal(ready.status, 200);
  assert.equal(readinessCheck(ready, "database")?.status, "pass", `the readiness database probe did not reach the database: ${ready.raw.slice(0, 400)}`);

  EVIDENCE.baselineHealth = "200 ok";
  EVIDENCE.baselineReadiness = `200 ready (${(ready.body.checks ?? []).map((c) => `${c.name}=${c.status}`).join(", ")})`;
  EVIDENCE.oldPidMain = server.serverPid;
  EVIDENCE.port = PORT;
});

test("A: a governed Material Action dispatches through Frontera in the control state", async () => {
  const login = await signIn(session);
  assert.ok([200, 302, 303, 307].includes(login.status), `POST /api/login returned ${login.status}: ${login.text.slice(0, 300)}`);
  assert.ok(hasSessionCookie(session), `the login did not establish a Supabase session cookie (cookies: ${session.cookieNames.join(", ")})`);

  const summary = (await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`)).json<{
    decisions: { id: string; decision_status: string }[];
  }>();
  // `persist_governed_material_action` only accepts a source Decision that
  // reached a terminal ACCEPTED or MODIFIED state; an escalated Decision is not
  // dispatchable by design, so taking the most recent one regardless of status
  // would read 500 instead of proving anything.
  const decision = summary.decisions?.find((row) => ["accepted", "modified"].includes(String(row.decision_status)));
  assert.ok(
    decision,
    `tenant A has no accepted or modified Decision to propose against. Run \`npm run seed:p2-13-founder\` and the Founder journey first.`,
  );

  const proposed = await governedPost(session, {
    operation: "propose_material_action",
    decisionId: decision.id,
    idempotencyKey: `${runKey}:material-action`,
    actionClass: "external_write",
    actionType: "failure recovery acceptance probe",
    targetResourceType: "project",
    targetResourceId: TENANT_A.projectId,
    intendedOperation: "confirm the governed dispatch boundary across a dependency failure and recovery",
    intendedEffect: "records a canonical Task through the governed dispatch path",
    risk: "medium",
    reversibility: "reversible",
    sideEffect: "external",
    justification: "P0-LAUNCH-04 failure recovery and observability acceptance",
  });
  assert.ok([200, 201].includes(proposed.status), `propose_material_action failed: ${proposed.status} ${proposed.raw.slice(0, 400)}`);

  const after = (await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`)).json<{
    materialActions: { id: string; idempotency_key?: string }[];
  }>();
  const mine = after.materialActions?.find((row) => row.idempotency_key === `${runKey}:material-action`);
  assert.ok(mine, `the proposed Material Action is not readable back: ${JSON.stringify(after.materialActions).slice(0, 400)}`);
  actionId = mine.id;

  const dispatched = await dispatchGovernedAction();
  const decisionId = asGovernedAllow(dispatched, "a provisioned Founder must be allowed to dispatch in the control state");
  EVIDENCE.baselineGovernedOperation = `ALLOW (fronteraDecisionId ${decisionId})`;
  EVIDENCE.actionId = actionId;
  OPERATOR_SIGNALS.RECOVERY_COMPLETE = {
    sources: ["PRODUCT_HTTP"],
    signal: "readiness 200 status=ready with database=pass, and a governed dispatch returning a fresh fronteraDecisionId",
  };
});

// ═══════════════════════ B / C — database loss and recovery ═══════════════════════

test("B: losing the database moves ONE live process from READY to NOT READY", async () => {
  requireProc("attributing the readiness transition to a single production process");
  const pidBefore = server!.serverPid;
  const correlationId = `${runKey}-db-outage`;

  installOutage(SOCKET_OUTAGE_FLAG());
  const notReady = await observeReadiness(server!.baseUrl, "not_ready", READINESS_TRANSITION_TIMEOUT_MS, correlationId);

  assert.ok(
    notReady.reached,
    `readiness never reported NOT READY within ${READINESS_TRANSITION_TIMEOUT_MS}ms of the database becoming unreachable: ${notReady.raw.slice(0, 400)}`,
  );
  assert.equal(notReady.status, 503, `NOT READY must answer 503, got ${notReady.status}: ${notReady.raw.slice(0, 300)}`);

  // Liveness is not readiness, and the transition must not have taken the
  // process with it: the SAME pid answers both, and it is the pid from the
  // control state.
  assert.ok(pidAlive(pidBefore), "the server process died instead of reporting NOT READY");
  assert.equal(server!.serverPid, pidBefore, "the process under test changed identity mid-transition");
  const health = await session.request("/api/health");
  assert.equal(health.status, 200, `/api/health must stay 200 with the database down, got ${health.status}: ${health.text.slice(0, 300)}`);
  assert.equal(health.json<{ status: string }>().status, "ok");

  // Attribution: the database check failed, it failed as an OUTAGE rather than
  // as a configuration problem, and nothing but reachability changed.
  const database = readinessCheck(notReady, "database");
  assert.equal(database?.status, "fail", `the database check did not fail: ${notReady.raw.slice(0, 400)}`);
  assert.match(String(database?.detail), /unreachable|timeout/, `the database failure is not reported as an outage: ${JSON.stringify(database)}`);
  assert.equal(readinessCheck(notReady, "configuration")?.status, "pass", `the control changed more than the database's reachability: ${notReady.raw.slice(0, 400)}`);
  assert.match(
    server!.log(),
    /P0_LAUNCH_04_SOCKET_OUTAGE_BLOCKED/,
    "no connection to the database was ever attempted, so the readiness failure is not attributable to the outage",
  );
  // AND the outage is COMPLETE, not merely new-connection-refusing. Refusing
  // `connect` alone leaves every pooled keep-alive socket working: the first run
  // of this gate observed readiness correctly reporting the database unreachable
  // while a governed dispatch in the SAME process succeeded over a pooled
  // socket. A stopped service drops what it was holding, so the control does too
  // — and this asserts that enforcement actually ran in the server process
  // rather than trusting it to have.
  assert.match(
    server!.log(),
    /P0_LAUNCH_04_SOCKET_OUTAGE_RESET/,
    "the outage never dropped the connections that were already established, so a pooled socket could still reach the 'unreachable' database",
  );

  // CORRELATION. The caller-supplied request id is echoed back AND appears on
  // the server's own structured record of the failure, so an operator holding a
  // failed request can find the reason for that exact request.
  assert.equal(notReady.requestId, correlationId, `readiness did not echo the caller's x-request-id: got ${String(notReady.requestId)}`);
  const failureEvents = structuredLogEvents(server!.log(), READINESS_FAILURE_EVENT).filter((event) => event.request_id === correlationId);
  assert.ok(
    failureEvents.length > 0,
    `no ${READINESS_FAILURE_EVENT} log record carries request_id=${correlationId}, so the failure cannot be correlated to the request that observed it`,
  );
  assert.match(
    JSON.stringify(failureEvents[0].checks),
    /"database"/,
    `the logged readiness failure does not name the database check: ${JSON.stringify(failureEvents[0])}`,
  );

  EVIDENCE.databaseFailureDetectionMs = notReady.ms;
  EVIDENCE.databaseFailureHealth = "200 ok";
  EVIDENCE.databaseFailureReadiness = `503 not_ready (database=${String(database?.detail)})`;
  EVIDENCE.databaseFailureCorrelation = `x-request-id ${correlationId} echoed and logged`;
  // Anchored to the READINESS database check, which is the only signal that
  // actually classifies the database. The governed 401 observed under this
  // outage proves fail-closed, NOT that the governed path classified
  // DATABASE_UNAVAILABLE — a socket-level outage takes /auth/v1 down with
  // /rest/v1, so authentication refuses first. That distinction is deliberate.
  OPERATOR_SIGNALS.DATABASE_UNAVAILABLE = {
    sources: ["PRODUCT_HTTP", "PRODUCT_LOG"],
    signal: `readiness 503 not_ready with checks.database.status=fail detail="${String(database?.detail)}", logged as ${READINESS_FAILURE_EVENT} with the request id`,
  };
});

test("B: a governed operation fails CLOSED while the process is NOT READY", async () => {
  // The instance is live and NOT READY. Whatever it does with a governed write
  // in that state, it must not perform one.
  //
  // WHAT THIS DOES AND DOES NOT PROVE — the distinction independent review
  // asked to keep explicit. The socket-level outage takes the whole Supabase
  // host down, so `/auth/v1` falls with `/rest/v1` and authentication refuses
  // FIRST. So this establishes FAIL_CLOSED, NO AUTH BYPASS and NO TASK CREATED.
  // It does NOT establish that the governed request itself classified
  // DATABASE_UNAVAILABLE, and no such claim is made from it: the database signal
  // stays anchored to `/api/ready`'s own database check, which is the only place
  // the product classifies the database. Proving a governed-path database
  // classification would need a `/rest/v1`-only outage, which this increment
  // does not introduce.
  const response = await dispatchGovernedAction();
  assertGovernedDidNotSucceed(response, "a governed dispatch must not succeed while the instance is NOT READY");
  EVIDENCE.governedOperationWhileNotReady = `refused with HTTP ${response.status} (fail-closed; NOT a governed-path database classification)`;
});

test("C: restoring the database returns the SAME process to READY", async () => {
  const pidBefore = server!.serverPid;
  clearOutage(SOCKET_OUTAGE_FLAG());

  const recovered = await observeReadiness(server!.baseUrl, "ready");
  assert.ok(
    recovered.reached,
    `readiness never returned to READY within ${READINESS_TRANSITION_TIMEOUT_MS}ms of the database being restored: ${recovered.raw.slice(0, 400)}`,
  );
  assert.equal(recovered.status, 200);
  assert.equal(readinessCheck(recovered, "database")?.status, "pass", `the restored database was not observed as reachable: ${recovered.raw.slice(0, 400)}`);

  // THE claim: no restart, no redeploy, no signal — the process that reported
  // NOT READY is the process that is now READY.
  assert.equal(server!.serverPid, pidBefore, "the recovery was observed on a different process");
  assert.equal(server!.serverPid, Number(EVIDENCE.oldPidMain), "recovery was not observed on the process that started in the control state");
  assert.ok(pidAlive(server!.serverPid), "the recovered process is not running");

  EVIDENCE.databaseRecoveryMs = recovered.ms;
  EVIDENCE.databaseRecoverySamePid = server!.serverPid;

  // And governance works again, through the same process, against the same
  // durable authority — recovery of the probe is not recovery of the product.
  const login = await signIn(session);
  assert.ok([200, 302, 303, 307].includes(login.status), `re-authentication after recovery failed: ${login.status} ${login.text.slice(0, 300)}`);
  const dispatched = await dispatchGovernedAction();
  const decisionId = asGovernedAllow(dispatched, "governance must work again once the database is restored");
  EVIDENCE.databaseRecoveryGovernedOperation = `ALLOW (fronteraDecisionId ${decisionId})`;
});

// ═══════════════════════ D — authentication outage and recovery ═══════════════════════

test("D: an ISOLATED authentication outage grants nothing and is not mistaken for policy", async () => {
  installOutage(PATH_OUTAGE_FLAG());
  try {
    // CONTRACT CHANGE. Under PMFREAK_OPERATING_PROFILE=closed-free-beta the product
    // declares AUTHENTICATION as a readiness dependency (api/ready adds checkAuth() for
    // this profile), so this suite's historical claim that readiness stays 200 during an
    // auth outage is superseded: readiness now correctly reports NOT READY. The
    // separation this case exists to prove is unchanged and in fact sharper — the
    // database stays UP and LIVENESS stays truthful while only the auth dependency fails.
    const notReady = await observeReadiness(server!.baseUrl, "not_ready");
    assert.ok(notReady.reached, `readiness did not report NOT READY during the authentication outage: ${notReady.raw.slice(0, 400)}`);
    assert.equal(readinessCheck(notReady, "database")?.status, "pass", "the database was not held up during the authentication outage");
    assert.equal(readinessCheck(notReady, "auth")?.status, "fail", "the auth dependency did not report fail during its own outage");
    // A stable, non-secret classification of WHY auth is unavailable.
    const authDetail = String(readinessCheck(notReady, "auth")?.detail ?? "");
    assert.ok(authDetail.length > 0, "the auth readiness failure carries no diagnosable detail");
    assert.doesNotMatch(authDetail, /eyJ[A-Za-z0-9_-]{10,}/, "the auth readiness detail leaked a credential-shaped value");
    const health = await session.request("/api/health");
    assert.equal(health.status, 200, "liveness must stay truthful during an authentication outage");

    // 1. NO NEW AUTHENTICATION. A caller with no session cannot get one.
    const fresh = new HttpSession(server!.baseUrl);
    const login = await signIn(fresh);
    assert.equal(
      hasSessionCookie(fresh),
      false,
      `a login SUCCEEDED while the authentication dependency was unreachable (status ${login.status}, cookies: ${fresh.cookieNames.join(", ")})`,
    );

    // 2. NO UNAUTHENTICATED ACCESS. An anonymous caller is still refused, and a
    //    governed write is still refused — an unavailable authority to check
    //    against must never read as "nothing objected".
    const anonymousRead = await fresh.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`);
    assert.equal(anonymousRead.status, 401, `an unauthenticated read must be refused, got ${anonymousRead.status}: ${anonymousRead.text.slice(0, 200)}`);
    assertGovernedDidNotSucceed(
      await dispatchGovernedAction(fresh),
      "an unauthenticated governed dispatch must not succeed during an authentication outage",
    );

    // 3. NO AUTHORITY FOR AN EXISTING SESSION EITHER. The API/governed path
    //    resolves its principal through getUser() ONLY — it has no session
    //    fallback — so an already-authenticated caller loses authority too, and
    //    the refusal is NOT dressed up as a Frontera policy denial.
    const governed = await dispatchGovernedAction(session);
    assertGovernedDidNotSucceed(governed, "an established session must not retain governed authority while authentication is unreachable");
    assert.notEqual(
      governed.body.failureClass,
      "frontera_denied",
      `an authentication outage was reported as a POLICY denial: ${governed.raw.slice(0, 300)}`,
    );

    // 4. THE OUTAGE WAS REAL AND SCOPED. `/auth/v1` was reached for and refused;
    //    the database socket was never blocked.
    assert.match(
      server!.log(),
      /P0_LAUNCH_04_PATH_OUTAGE_BLOCKED \/auth\/v1 \/auth\/v1\//,
      "the authentication dependency was never reached, so nothing above is attributable to an authentication outage",
    );

    // 5. THE DOCUMENTED PAGE-LEVEL FALLBACK, and its boundary. `src/proxy.ts`
    //    and `runtime-auth-continuity.ts` deliberately fall back to an UNEXPIRED
    //    LOCAL session on a non-auth (transport) error, so a momentary Supabase
    //    hiccup does not bounce a genuinely authenticated user to /login. That
    //    is product behaviour, it is announced in the log, and it is bounded to
    //    a session that already exists — it is not a way IN.
    // 6. THE PRODUCT CLASSIFIES THE DEPENDENCY FAILURE.
    //
    //    This is the claim independent review found missing, and it is the one
    //    that makes the auth outage DIAGNOSABLE rather than merely fail-closed.
    //    Fail-closed is proven above: 401 everywhere, no session, no authority.
    //    But a bare 401 is exactly what an ordinary unauthenticated caller gets,
    //    so on its own it tells an operator nothing about WHY nobody can log in.
    //
    //    `getAuthUser()` now records `auth_dependency_unavailable` when auth-js
    //    returns its TRANSPORT error class. The shim's own
    //    P0_LAUNCH_04_PATH_OUTAGE_BLOCKED marker is deliberately NOT accepted as
    //    evidence here: it proves the harness injected a failure, not that
    //    PMFreak would show an operator anything in production.
    const authEvents = structuredLogEvents(server!.log(), AUTH_DEPENDENCY_EVENT);
    assert.ok(
      authEvents.length > 0,
      `the product recorded no ${AUTH_DEPENDENCY_EVENT} event, so an unreachable auth dependency is indistinguishable from an ordinary unauthenticated caller`,
    );
    const authEvent = authEvents[authEvents.length - 1];
    assert.equal(authEvent.error_code, "AuthRetryableFetchError", `the auth failure was not classified as a transport error: ${JSON.stringify(authEvent)}`);
    assert.equal(authEvent.operation, "getAuthUser");
    assert.equal(authEvent.level, "error");
    // The provider's message must not be carried into the signal.
    assert.equal(authEvent.message, AUTH_DEPENDENCY_EVENT, `the event name is not the stable classification: ${JSON.stringify(authEvent)}`);
    assert.doesNotMatch(JSON.stringify(authEvent), /fetch failed|ECONNREFUSED|apikey|eyJ[A-Za-z0-9_-]{10,}/, `the auth dependency signal leaked provider or credential detail: ${JSON.stringify(authEvent)}`);

    // 7. A FORGED SESSION IS STILL NOT A WAY IN. Kept because it proves absence
    //    of a bypass, which is this gate's business.
    //
    //    WHAT IS DELIBERATELY NOT CLAIMED: the page-level non-auth-error session
    //    fallback in `src/proxy.ts` / `runtime-auth-continuity.ts`. Earlier
    //    versions of this gate recorded whether that fallback's warning appeared
    //    — but recorded it either way, so its absence failed nothing while the
    //    evidence document reported it as observed. Rather than start certifying
    //    pre-existing behaviour that already carries
    //    RR-AUTH-ERROR-MISCLASSIFICATION, P0-LAUNCH-04 drops it from its
    //    acceptance claim entirely. AUTH_UNAVAILABLE diagnosability rests on the
    //    product signal asserted in step 6, and nothing else.
    const forged = await new HttpSession(server!.baseUrl).request("/command-center", {
      headers: { cookie: "sb-p0-launch-04-auth-token=not-a-real-session" },
    });
    assert.ok(
      [302, 307].includes(forged.status),
      `a FORGED session cookie was not redirected away from a protected page during the authentication outage (status ${forged.status})`,
    );
    EVIDENCE.authFailureForgedCookieRefused = `redirected (${forged.status}) — a fabricated session is not a way in`;

    EVIDENCE.authFailureNewLogin = "refused — no session cookie established";
    EVIDENCE.authFailureAnonymousRead = "401";
    EVIDENCE.authFailureGovernedOperation = `refused with HTTP ${governed.status}`;
    // Recorded from what this case ACTUALLY observed a few lines above — 503 not_ready
    // with auth=fail and database=pass. The predecessor string here claimed the opposite
    // ("200 ready — authentication is NOT a declared readiness dependency"), which was
    // true before the closed-free-beta profile declared auth as a readiness dependency
    // and false after; the case asserted one thing and published another.
    EVIDENCE.authFailureReadiness =
      `${notReady.status} not_ready — authentication IS a declared readiness dependency under the closed-free-beta profile ` +
      "(auth=fail, database=pass); liveness stays 200 and the process is never restarted";
    // The evidence may not drift from the observation again: this pins the published
    // string to the readiness status this case actually asserted.
    assert.equal(notReady.status, 503, "the auth-outage readiness observation is no longer 503");
    assert.match(
      String(EVIDENCE.authFailureReadiness),
      /^503 not_ready — authentication IS a declared readiness dependency/,
      "the published auth-outage readiness evidence does not match the observed NOT READY state",
    );
    assert.doesNotMatch(
      String(EVIDENCE.authFailureReadiness),
      /NOT a declared readiness dependency/,
      "the superseded pre-profile auth-readiness claim is still being published",
    );
    EVIDENCE.authFailureProductClassification = `PRODUCT_LOG ${AUTH_DEPENDENCY_EVENT} error_code=AuthRetryableFetchError`;
    OPERATOR_SIGNALS.AUTH_UNAVAILABLE = {
      sources: ["PRODUCT_LOG"],
      signal: `the product logs ${AUTH_DEPENDENCY_EVENT} with error_code=AuthRetryableFetchError from getAuthUser, while HTTP stays a bare 401, liveness stays 200, and readiness reports NOT READY with auth=fail and database=pass (auth is a declared readiness dependency under the closed-free-beta profile)`,
    };
  } finally {
    clearOutage(PATH_OUTAGE_FLAG());
  }
});

test("D: an unreachable auth dependency is DISTINGUISHABLE from a verifiable one", async () => {
  // The reproduction independent review asked for, run against ONE process, with
  // the ONLY difference between the two captures being the dependency's
  // availability. Route, method and session are held identical, so any
  // difference in signal is attributable to the outage and nothing else.
  //
  // WHY THE CALLER MUST HOLD A SESSION — this is the correction the first
  // attempt at this test earned. With NO session cookie, auth-js answers
  // `AuthSessionMissingError` LOCALLY and never issues a request, so an auth
  // outage is genuinely invisible on that path: the product cannot classify a
  // dependency it never consulted. Nothing is concealed by that, because no
  // authority is granted either way — but comparing an anonymous request
  // against an anonymous request would be comparing two cases in which the
  // dependency is never reached, and would prove nothing about classifying it.
  //
  // The operationally meaningful case is the one below: a caller whose session
  // must be VERIFIED against the dependency. Auth up, it is verified. Auth down,
  // verification is impossible — and that is what has to be legible.
  const protectedPath = `/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`;
  const verifiable = new HttpSession(server!.baseUrl);
  await signIn(verifiable);
  assert.ok(hasSessionCookie(verifiable), "the reproduction needs a caller whose session is actually verifiable");

  // ── Capture 1: dependency UP. The session verifies.
  const logBeforeHealthy = server!.log().length;
  const healthy = await verifiable.request(protectedPath);
  const healthyLog = server!.log().slice(logBeforeHealthy);

  // ── Capture 2: dependency DOWN. Same session, same request.
  installOutage(PATH_OUTAGE_FLAG());
  let outage: { status: number; text: string };
  let outageLog: string;
  try {
    const logBeforeOutage = server!.log().length;
    outage = await verifiable.request(protectedPath);
    outageLog = server!.log().slice(logBeforeOutage);
  } finally {
    clearOutage(PATH_OUTAGE_FLAG());
  }

  // 1. FAIL CLOSED. The session that verified a moment ago now confers nothing.
  assert.equal(healthy.status, 200, `a verifiable session must be served, got ${healthy.status}: ${healthy.text.slice(0, 200)}`);
  assert.equal(outage.status, 401, `an unverifiable session must be refused, got ${outage.status}: ${outage.text.slice(0, 200)}`);

  // 2. HTTP ALONE CANNOT NAME THE CAUSE. 401 is exactly what an ordinary
  //    unauthenticated caller receives, so the HTTP surface does not
  //    distinguish "not logged in" from "cannot be verified". This gate says so
  //    rather than implying a distinction the product does not make.
  const anonymous = await new HttpSession(server!.baseUrl).request(protectedPath);
  assert.equal(anonymous.status, 401, `an unauthenticated read must be refused, got ${anonymous.status}`);
  assert.equal(
    anonymous.status,
    outage.status,
    "the two now differ over HTTP — if the product ever does distinguish them by status, revisit this test rather than let it pass silently",
  );
  EVIDENCE.authOrdinaryVsOutageHttp = `both ${anonymous.status} — PRODUCT_HTTP does NOT distinguish them`;

  // 3. THE PRODUCT LOG DOES, and only in the outage capture.
  assert.equal(
    structuredLogEvents(healthyLog, AUTH_DEPENDENCY_EVENT).length,
    0,
    `a healthy verification emitted ${AUTH_DEPENDENCY_EVENT}, so the signal is noise rather than a dependency classification: ${healthyLog.slice(-400)}`,
  );
  const outageEvents = structuredLogEvents(outageLog, AUTH_DEPENDENCY_EVENT);
  assert.ok(
    outageEvents.length > 0,
    `an unreachable auth dependency emitted no ${AUTH_DEPENDENCY_EVENT}, so it is indistinguishable from an ordinary unauthenticated caller: ${outageLog.slice(-400)}`,
  );
  assert.equal(outageEvents[0].error_code, "AuthRetryableFetchError");
  assert.equal(outageEvents[0].operation, "getAuthUser");

  // 4. AND THE DISTINCTION IS THE PRODUCT'S, NOT THE HARNESS'S. Strip every
  //    P0_LAUNCH_04_* line and the signal must still be there — otherwise
  //    "diagnosable" would mean "the test framework knows", which is worth
  //    nothing to an operator.
  const productOnly = outageLog
    .split("\n")
    .filter((line) => !line.includes("P0_LAUNCH_04_"))
    .join("\n");
  assert.ok(
    structuredLogEvents(productOnly, AUTH_DEPENDENCY_EVENT).length > 0,
    "the only evidence of the auth outage came from the harness shim, not from PMFreak",
  );

  EVIDENCE.authOutageProductSignalWithoutHarnessMarkers = "present";
  EVIDENCE.authOutageAnonymousCallerLimitation =
    "a caller with NO session is not distinguishable: auth-js answers AuthSessionMissingError locally and the dependency is never consulted. No authority is granted either way.";
});

test("D: restoring authentication restores authentication, tenancy and governance", async () => {
  // A NEW session, not the old one: the product contract does not promise that a
  // session survives its authentication dependency, and asserting that it does
  // would be inventing a guarantee.
  const restored = new HttpSession(server!.baseUrl);
  const deadline = Date.now() + READINESS_TRANSITION_TIMEOUT_MS;
  let login = await signIn(restored);
  while (!hasSessionCookie(restored) && Date.now() < deadline) {
    await sleep(250);
    login = await signIn(restored);
  }
  assert.ok(
    hasSessionCookie(restored),
    `authentication did not recover within ${READINESS_TRANSITION_TIMEOUT_MS}ms of the dependency being restored (last status ${login.status})`,
  );

  // Tenant binding is still correct — recovery must not widen scope.
  const read = await restored.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`);
  assert.equal(read.status, 200, `the authenticated tenant read failed after recovery: ${read.status} ${read.text.slice(0, 300)}`);

  const dispatched = await dispatchGovernedAction(restored);
  const decisionId = asGovernedAllow(dispatched, "governance must work again once authentication is restored");
  session = restored;

  // The SAME process must return to READY — no restart, no redeploy — with both declared
  // dependencies passing. Under the closed-free-beta profile that includes auth.
  const recoveredReadiness = await observeReadiness(server!.baseUrl, "ready");
  assert.ok(recoveredReadiness.reached, `readiness did not recover after authentication was restored: ${recoveredReadiness.raw.slice(0, 400)}`);
  assert.equal(readinessCheck(recoveredReadiness, "auth")?.status, "pass", "the auth dependency did not recover");
  assert.equal(readinessCheck(recoveredReadiness, "database")?.status, "pass", "the database dependency regressed during auth recovery");
  EVIDENCE.authRecovery = `re-authenticated, tenant read 200, governed ALLOW (fronteraDecisionId ${decisionId})`;
});

// ═══════════════════════ E / F — the governed four-way matrix ═══════════════════════

test("E: an UNAVAILABLE authority backing fails closed as an OUTAGE, never as ALLOW or policy", async () => {
  const digestBefore = sha256File(STORE_PATH);

  // Availability is removed without touching the store: the DIRECTORY becomes
  // unreadable, so SQLite cannot open the file (nor create its sidecars), and
  // the bytes are provably untouched on the other side. Deleting or corrupting
  // the store would prove something else — that a MISSING authority fails
  // closed, which P0-LAUNCH-03 already proved and which cannot be recovered
  // from because there is nothing left to restore.
  fs.chmodSync(STORE_DIR, 0o000);
  let response: GovernedResponse;
  try {
    response = await dispatchGovernedAction();
  } finally {
    fs.chmodSync(STORE_DIR, 0o700);
  }

  asGovernedInfrastructureFailure(response, "an unreadable authority backing must fail closed as an outage");
  assert.notEqual(response.body.failureClass, "frontera_denied", "an infrastructure outage was reported as a policy denial");

  // The operator's side of the same event: the class, the reason codes and the
  // request identity, none of which crosses the HTTP boundary.
  const refusals = structuredLogEvents(server!.log(), FRONTERA_REFUSAL_EVENT).filter((event) => event.failureClass === "frontera_unavailable");
  assert.ok(refusals.length > 0, `the server logged no frontera_unavailable refusal, so the outage is not diagnosable from the server side`);
  const refusal = refusals[refusals.length - 1];
  assert.equal(refusal.actionId, actionId, `the logged refusal does not carry the governed action id: ${JSON.stringify(refusal)}`);
  assert.equal(refusal.workspaceId, TENANT_A.workspaceId, `the logged refusal does not carry the tenant context: ${JSON.stringify(refusal)}`);
  assert.match(JSON.stringify(refusal.fronteraReasonCodes), /FRONTERA_EVALUATION_UNAVAILABLE/, `the logged refusal carries no infrastructure reason code: ${JSON.stringify(refusal)}`);

  assert.equal(sha256File(STORE_PATH), digestBefore, "the authority store's contents changed while it was unavailable");
  EVIDENCE.fronteraFailureClass = "frontera_unavailable";
  EVIDENCE.fronteraFailureStoreDigest = digestBefore;
  OPERATOR_SIGNALS.FRONTERA_UNAVAILABLE = {
    sources: ["PRODUCT_HTTP", "PRODUCT_LOG"],
    signal: `governed 409 disposition=denied failureClass=frontera_unavailable, logged as "${FRONTERA_REFUSAL_EVENT}" with reasonCodes FRONTERA_EVALUATION_UNAVAILABLE and the action id`,
  };
});

test("E: restoring the SAME authority backing restores governance, with the state preserved", async () => {
  // Read the digest AFTER the restore and BEFORE the dispatch: a successful
  // evaluation is entitled to write to Frontera's own store, so comparing after
  // a dispatch would confuse "the outage preserved the state" with "evaluation
  // never writes". What is asserted is that losing and restoring availability
  // changed nothing.
  assert.equal(sha256File(STORE_PATH), String(EVIDENCE.fronteraFailureStoreDigest), "the authority store's contents changed across the outage and restore");

  const dispatched = await dispatchGovernedAction();
  const decisionId = asGovernedAllow(dispatched, "the same durable authority must become usable again once its backing is readable");
  EVIDENCE.fronteraRecovery = `ALLOW (fronteraDecisionId ${decisionId})`;
  EVIDENCE.fronteraRecoveryStatePreserved = true;
});

test("F: a real policy revocation stays DISTINCT from an infrastructure outage", async () => {
  // Made OUT OF PROCESS, against the store file, by the operator provisioning
  // script — the running server is not signalled and is told nothing. It is
  // last, because Frontera's revocation is terminal by design: a revoked entity
  // id can never be re-provisioned, so a gate that revoked earlier and then
  // expected the grant back would be asserting against semantics the authority
  // model deliberately forbids.
  await revokeAuthority(STORE_PATH);

  const response = await dispatchGovernedAction();
  asGovernedPolicyDenial(response, "an operator revocation must be reported as a policy denial");
  assert.notEqual(
    response.body.failureClass,
    "frontera_unavailable",
    "a policy denial was reported as an infrastructure outage — the two must never collapse into one class",
  );

  const refusals = structuredLogEvents(server!.log(), FRONTERA_REFUSAL_EVENT).filter((event) => event.failureClass === "frontera_denied");
  assert.ok(refusals.length > 0, "the server logged no frontera_denied refusal, so a policy denial is not diagnosable from the server side");

  EVIDENCE.policyDenyClass = "frontera_denied";
  EVIDENCE.policyVsInfraDistinct = true;
  OPERATOR_SIGNALS.POLICY_DENIED = {
    sources: ["PRODUCT_HTTP", "PRODUCT_LOG"],
    signal: `governed 409 disposition=denied failureClass=frontera_denied, logged as "${FRONTERA_REFUSAL_EVENT}" with Frontera's own evaluation reason codes`,
  };
});

// ═══════════════════════ G — abnormal termination ═══════════════════════

test("G: a HARD-KILLED production process is replaced, and governs with the state it left behind", async () => {
  requireProc("proving the killed process and its replacement are different processes");

  const crashPort = await freePort();
  const first = await startProductionServer({ port: crashPort, env: productionEnv({ [FRONTERA_STORE_ENV]: CRASH_STORE_PATH }) });
  if (!first.started) assert.fail(`the production server did not start: ${first.reason}\n${first.log.slice(-4000)}`);

  const oldPid = first.handle.serverPid;
  const oldLauncher = first.handle.launcherPid;
  let digestBeforeKill = "";
  try {
    const ready = await observeReadiness(first.handle.baseUrl, "ready");
    assert.ok(ready.reached, `the process to be killed was never READY: ${ready.raw.slice(0, 400)}`);

    // Confirm the durable authority is genuinely load-bearing BEFORE the kill,
    // so "it still works afterwards" is a claim about survival rather than about
    // a store that never mattered.
    const before = new HttpSession(first.handle.baseUrl);
    await signIn(before);
    asGovernedAllow(await dispatchGovernedAction(before), "the process about to be killed must be governing from its durable authority");
    digestBeforeKill = sha256File(CRASH_STORE_PATH);
  } finally {
    // SIGKILL, through the shared shutdown path so residue is accounted for by
    // the same ledger as every other process this gate starts. No shutdown hook
    // runs, nothing is flushed, and nothing is repaired by hand afterwards.
    const outcome = await shutdownProductionServer(first.handle, { label: "G: hard-killed production process", signal: "SIGKILL", graceMs: 20_000 });
    EVIDENCE.abnormalTerminationSignal = String(outcome.signal ?? `code ${String(outcome.code)}`);
    assert.deepEqual(outcome.orphans, [], `the hard kill left running processes behind: ${JSON.stringify(outcome.orphans)}`);
    assert.deepEqual(outcome.unreaped, [], `the hard kill left uncollected process-table entries behind: ${JSON.stringify(outcome.unreaped)}`);
  }

  assert.equal(pidAlive(oldPid), false, `the hard-killed server process ${oldPid} is still running`);
  assert.equal(pidAlive(oldLauncher), false, `the hard-killed launcher ${oldLauncher} is still running`);
  assert.ok(await waitForPortRelease(crashPort), `port ${crashPort} was never released by the hard-killed process`);
  assert.equal(sha256File(CRASH_STORE_PATH), digestBeforeKill, "the durable authority store was altered by the hard kill or repaired afterwards");

  // A genuinely NEW process, from the same entrypoint, on the same port, with
  // the same store. Nothing was repaired in between.
  const second = await startProductionServer({ port: crashPort, env: productionEnv({ [FRONTERA_STORE_ENV]: CRASH_STORE_PATH }) });
  if (!second.started) assert.fail(`no new production process could start after the hard kill: ${second.reason}\n${second.log.slice(-4000)}`);
  try {
    assert.notEqual(second.handle.serverPid, oldPid, "the 'new' process is the old one — nothing was actually restarted");

    const health = await new HttpSession(second.handle.baseUrl).request("/api/health");
    assert.equal(health.status, 200, `/api/health after the hard kill: ${health.status} ${health.text.slice(0, 300)}`);
    const ready = await observeReadiness(second.handle.baseUrl, "ready");
    assert.ok(ready.reached, `the replacement process never became READY: ${ready.raw.slice(0, 400)}`);
    assert.equal(readinessCheck(ready, "database")?.status, "pass", "the replacement process cannot reach the database");

    const after = new HttpSession(second.handle.baseUrl);
    const login = await signIn(after);
    assert.ok([200, 302, 303, 307].includes(login.status), `authentication does not work after the hard kill: ${login.status}`);
    assert.ok(hasSessionCookie(after), "no session could be established after the hard kill");
    const dispatched = await dispatchGovernedAction(after);
    const decisionId = asGovernedAllow(dispatched, "the durable authority the killed process left behind must still govern");
    assert.equal(sha256File(CRASH_STORE_PATH), digestBeforeKill, "the replacement process rewrote the durable authority store to make itself work");

    EVIDENCE.abnormalTerminationOldPid = oldPid;
    EVIDENCE.abnormalTerminationNewPid = second.handle.serverPid;
    EVIDENCE.postCrashHealth = "200 ok";
    EVIDENCE.postCrashReadiness = "200 ready";
    EVIDENCE.postCrashGovernedOperation = `ALLOW (fronteraDecisionId ${decisionId})`;
    EVIDENCE.postCrashStateSurvives = true;
    EVIDENCE.postCrashManualRepair = false;
    OPERATOR_SIGNALS.PROCESS_TERMINATION = {
      sources: ["PRODUCT_PROCESS"],
      signal: `the process group exits on signal ${String(EVIDENCE.abnormalTerminationSignal)}, the listening port is released, and the replacement answers on a DIFFERENT pid`,
    };
  } finally {
    await shutdownProductionServer(second.handle, { label: "G: replacement production process", graceMs: 10_000 });
  }
});

// ═══════════════════════ H — configuration failure ═══════════════════════

test("H: a production process given broken production-required configuration fails CLOSED, boundedly and legibly", async () => {
  const port = await freePort();
  const startedAt = Date.now();
  // CONTRACT CHANGE, split into two phases so NO original claim is lost.
  //
  // This case previously bundled two production-critical defects into ONE process — an
  // absent required server secret AND an unconfigured authority backing — and asserted
  // STARTS_BUT_NOT_READY for both. Under the closed-beta runtime contract certified by
  // P0-LAUNCH-06, a missing required secret is now caught by the in-process guard BEFORE
  // the server becomes operational, so those two defects no longer share an observable
  // boundary and must be proven separately:
  //
  //   PHASE 1  missing required secret        -> BOOT REFUSED (stronger than NOT READY)
  //   PHASE 2  unconfigured authority backing -> STARTS AND REACHES READY; the GOVERNED
  //            PATH fails closed (the authority backing is not a readiness dependency)
  //
  // Phase 2 keeps every original running-process claim: liveness truthful, anonymous
  // refused, and the unusable authority reported as an OUTAGE rather than degrading to
  // an in-memory substitute.
  const refusedPort = await freePort();
  const refused = await startProductionServer({
    port: refusedPort,
    env: productionEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }),
    timeoutMs: 90_000,
  });
  if (refused.started) {
    await shutdownProductionServer(refused.handle, { label: "H: missing required secret", graceMs: 10_000 });
    assert.fail("a production server became operational without a required server secret");
  }
  assert.match(refused.log, /missing_beta_environment/, "the boot refusal is not attributable to the missing beta environment requirement");
  assert.match(refused.log, /SUPABASE_SERVICE_ROLE_KEY/, "the boot refusal does not name the missing variable");
  assert.doesNotMatch(refused.log, /eyJ[A-Za-z0-9_-]{10,}/, "the boot refusal leaked a credential-shaped value");
  assert.deepEqual(refused.survivors, [], "the refused start left surviving processes");
  EVIDENCE.missingRequiredSecretBehavior = "BOOT_REFUSED (missing_beta_environment names SUPABASE_SERVICE_ROLE_KEY; no value emitted)";

  // PHASE 2 — the authority backing alone, on a process that is allowed to boot.
  const outcome = await startProductionServer({
    port,
    env: productionEnv({ [FRONTERA_STORE_ENV]: "" }),
  });
  if (!outcome.started) assert.fail(`an unconfigured authority backing must still allow the server to START (the governed path is what fails closed), but it did not: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    // BOUNDED and DETERMINISTIC: it reached a settled state inside the deadline
    // rather than hanging, and liveness is truthful about what it can answer for.
    assert.ok(Date.now() - startedAt < 180_000, "the misconfigured process did not reach a settled state within the startup deadline");
    const isolated = new HttpSession(outcome.handle.baseUrl);
    const health = await isolated.request("/api/health");
    assert.equal(health.status, 200, `liveness must remain independent of configuration readiness, got ${health.status}`);

    // MEASURED, not assumed. The original 503 in this case came from the MISSING SECRET,
    // which is now refused at boot in phase 1 — the authority backing is not a declared
    // readiness dependency, so with a valid secret this process is correctly READY. That
    // separation is the point: an unusable authority backing must fail the governed path
    // closed WITHOUT being laundered into, or hidden by, a readiness failure.
    const readyNow = await observeReadiness(outcome.handle.baseUrl, "ready");
    assert.ok(readyNow.reached, `a process with a valid secret did not become READY: ${readyNow.raw.slice(0, 400)}`);
    assert.equal(readinessCheck(readyNow, "database")?.status, "pass", "the database dependency did not pass");
    assert.doesNotMatch(readyNow.raw, /eyJ[A-Za-z0-9_-]{10,}/, "the readiness payload leaked a credential-shaped value");

    // FAILS CLOSED, with no silent substitution: an unauthenticated caller gets
    // nothing, and the governed path reports the unusable authority as an OUTAGE
    // rather than degrading to an in-memory authority it could satisfy.
    const anonymous = await isolated.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`);
    assert.equal(anonymous.status, 401, `an unauthenticated read must be refused, got ${anonymous.status}: ${anonymous.text.slice(0, 200)}`);
    await signIn(isolated);
    asGovernedInfrastructureFailure(
      await dispatchGovernedAction(isolated),
      "an unconfigured authority backing must fail closed as an outage, never degrade to an in-memory substitute",
    );

    // The strings below must state what the assertions above actually observed. An
    // earlier revision still described this authority-only scenario as
    // STARTS_BUT_NOT_READY / 503, which the reconciled phase 2 disproves: with a valid
    // secret the process reaches READY, because the Frontera authority backing is NOT a
    // declared readiness dependency. Only the governed path fails closed.
    EVIDENCE.startupFailureBehavior =
      "SPLIT BY CONTRACT: missing required secret -> BOOT_REFUSED; " +
      "AUTHORITY_BACKING_UNAVAILABLE -> SERVER_READY_GOVERNED_PATH_FAILS_CLOSED";
    EVIDENCE.startupFailureReadiness =
      "missing required secret -> refused at boot, never reaches readiness; authority backing unavailable -> " +
      "READINESS=200_READY with database=pass, because the Frontera authority backing is deliberately NOT a " +
      "declared readiness dependency — the failure surfaces on the GOVERNED PATH instead of being hidden in, " +
      "or laundered into, a readiness failure";
    EVIDENCE.startupFailureGovernedOperation = "frontera_unavailable — fail closed, no in-memory substitution";
    OPERATOR_SIGNALS.STARTUP_CONFIGURATION_FAILURE = {
      sources: ["PRODUCT_HTTP"],
      signal:
        "a missing required server secret is refused at BOOT: the startup diagnostic carries " +
        "missing_beta_environment and names SUPABASE_SERVICE_ROLE_KEY, never its value. An unconfigured " +
        "authority backing is a DIFFERENT signal: the server reaches readiness 200 READY with database=pass, " +
        "and the governed operation fails closed as frontera_unavailable rather than degrading to an " +
        "in-memory substitute.",
    };
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "H: broken production configuration", graceMs: 10_000 });
  }
});

// ═══════════════════════ K — secret safety of failure output ═══════════════════════

test("K: the sanitized redaction control emits no secret VALUE, only variable NAMES", async () => {
  requireProc("reading the child environment to prove the sanitisation actually took");
  const port = await freePort();
  // Marker-shaped synthetic values, in a shape the product's redaction layer
  // does NOT recognise (not sk_live_/whsec_/JWT/Bearer/service_role). If the
  // marker appears anywhere, the product echoed a secret VALUE — the claim rests
  // on it never doing so, not on shape-based scrubbing catching it afterwards.
  //
  // THE ENVIRONMENT IS SANITISED, and that is a correction rather than a
  // nicety. `productionEnv()` spreads `process.env`, so this child used to
  // inherit the harness's REAL service-role key and REAL fixture password. The
  // capture below is only searched for the synthetic marker, so a failure path
  // that logged one of those inherited real values would have passed unnoticed
  // — while the evidence document claimed no real credential was present. The
  // product needs neither variable, so both are removed here.
  const outcome = await startProductionServer({
    port,
    env: sanitizedProductionEnv({
      SUPABASE_SERVICE_ROLE_KEY: SECRET_MARKER,
      STRIPE_SECRET_KEY: SECRET_MARKER,
      STRIPE_WEBHOOK_SECRET: SECRET_MARKER,
      PMFREAK_TRUST_EVENT_HMAC_SECRET: SECRET_MARKER,
      PMFREAK_AGENT_TOKEN_SECRET: SECRET_MARKER,
      ABUSE_HASH_PEPPER: SECRET_MARKER,
      PMFREAK_GOVERNANCE_CAPABILITY_ENABLED: "true",
      PMFREAK_CAPABILITY_CLAIM_SECRET: SECRET_MARKER,
      // A malformed authority backing, so a real governed FAILURE is produced
      // and its diagnostic actually reaches the log in this process.
      [FRONTERA_STORE_ENV]: MALFORMED_STORE_PATH,
    }),
  });
  if (!outcome.started) assert.fail(`the redaction control process did not start: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    // 1. THE SANITISATION IS REAL, read from the child's OWN environment rather
    //    than trusted from the object handed to spawn. Values are compared, never
    //    printed: an assertion message that echoed the credential it is checking
    //    for would be the leak it exists to prevent.
    const childEnv = environOf(outcome.handle.serverPid);
    for (const name of ACCEPTANCE_ONLY_REAL_SECRETS) {
      const parentValue = process.env[name];
      const childValue = childEnv.get(name) ?? "";
      assert.equal(childValue, "", `${name} reached the redaction-control child; it is an acceptance-only credential the product never reads`);
      if (parentValue) {
        assert.notEqual(childValue, parentValue, `${name} still carries the parent's real value in the child environment`);
      }
    }
    // 2. Which acceptance-only VALUES must be absent — and which legitimately
    //    are not, because the product needs them.
    //
    //    `OPERATIONAL_FLOW_TEST_ANON_KEY` carries the SAME value as
    //    `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which `next start` requires and which
    //    this repository documents as public by design (RLS is the real
    //    boundary). Asserting that value's absence would be asserting that the
    //    product cannot run — the first version of this control did exactly that
    //    and failed. So a value the child legitimately RETAINS under a name that
    //    is not an acceptance-only alias is not an acceptance-only secret at all,
    //    and is excluded from the leak checks rather than the checks being
    //    quietly softened.
    const acceptanceOnly = new Set<string>(ACCEPTANCE_ONLY_REAL_SECRETS);
    const childRetainedValues = new Set(
      [...childEnv.entries()]
        .filter(([name]) => !acceptanceOnly.has(name))
        .map(([, value]) => value)
        .filter((value) => value.length >= 8),
    );
    const leakCandidates = ACCEPTANCE_ONLY_REAL_SECRETS.map((name) => ({ name, value: process.env[name] ?? "" }))
      .filter((entry) => entry.value.length >= 8)
      .filter((entry) => !childRetainedValues.has(entry.value));
    assert.ok(
      leakCandidates.length > 0,
      "no acceptance-only credential value remained to check, so the leak assertions below would be vacuous",
    );

    //    Those values appear nowhere in the child's environment block under ANY
    //    name — a rename would defeat the per-name check above.
    const childEnviron = [...childEnv.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
    for (const { name, value } of leakCandidates) {
      assert.equal(childEnviron.includes(value), false, `the real value of ${name} is present in the child environment under some other name`);
    }

    const isolated = new HttpSession(outcome.handle.baseUrl);
    const health = await isolated.request("/api/health");
    const ready = await isolated.request("/api/ready");
    await signIn(isolated);
    const governed = await dispatchGovernedAction(isolated);
    asGovernedInfrastructureFailure(governed, "the redaction control must be exercised against a REAL governed failure");
    // Give the server a moment to flush the failure it just logged, so the
    // capture below is of output that exists rather than of output still queued.
    await waitUntil(() => structuredLogEvents(outcome.handle.log(), FRONTERA_REFUSAL_EVENT).length > 0, 5_000);

    const captures = [
      { where: "the server's captured stdout+stderr", text: outcome.handle.log() },
      { where: "the /api/health body", text: health.text },
      { where: "the /api/ready body", text: ready.text },
      { where: "the governed failure body", text: governed.raw },
    ];

    // 3. No synthetic marker in any captured surface.
    assertMarkerAbsent(SECRET_MARKER, captures);

    // 4. And no acceptance-only real credential either — the check that was
    //    missing. It can only be made because the environment was sanitised
    //    first: without that, absence here would prove nothing about a value the
    //    child was still holding.
    for (const { name, value } of leakCandidates) {
      for (const capture of captures) {
        assert.equal(capture.text.includes(value), false, `the real value of ${name} appeared in ${capture.where}`);
      }
    }

    // The other half of the same contract — that a MISSING variable is still
    // NAMED, because a fail-closed readiness answer that names nothing is not
    // actionable — is proven by test H above. Names are not secrets; values are.
    EVIDENCE.secretRedaction = `no synthetic marker and no acceptance-only real credential in ${captures.length} captured surfaces (log, health, readiness, governed failure)`;
    EVIDENCE.secretRedactionMarkerShape = "P0_LAUNCH_04_SECRET_MARKER_<digest> — deliberately NOT a shape the redaction layer recognises";
    EVIDENCE.redactionChildSanitized = `${ACCEPTANCE_ONLY_REAL_SECRETS.length} acceptance-only credentials removed, verified from the child's own /proc/environ`;
    EVIDENCE.redactionChildLeakCandidatesChecked = leakCandidates.map((entry) => entry.name).join(", ");
    EVIDENCE.redactionChildProductRetainedByDesign =
      "the local anon key value is retained because next start requires it and the repository documents it as public by design";
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "K: secret-redaction control", graceMs: 10_000 });
  }
});

// ═══════════════════════ I / N — the operator's view ═══════════════════════

test("I/N: every failure class carries a PRODUCT signal, and no two are the same", () => {
  const required = [
    "DATABASE_UNAVAILABLE",
    "AUTH_UNAVAILABLE",
    "FRONTERA_UNAVAILABLE",
    "POLICY_DENIED",
    "STARTUP_CONFIGURATION_FAILURE",
    "PROCESS_TERMINATION",
    "RECOVERY_COMPLETE",
  ] as const;

  for (const failureClass of required) {
    const entry = OPERATOR_SIGNALS[failureClass];
    assert.ok(
      entry && entry.signal.trim().length > 0,
      `no operator-visible signal was recorded for ${failureClass}, so an operator cannot tell that this failure happened`,
    );

    // SOURCE, not just presence. A shim marker proves the harness injected a
    // failure and says nothing about what PMFreak shows in production, so a
    // class whose only evidence is HARNESS_CONTROL is NOT diagnosable.
    assert.ok(entry.sources.length > 0, `${failureClass} declares no signal source`);
    const productSources = entry.sources.filter((source) => PRODUCT_SOURCES.includes(source));
    assert.ok(
      productSources.length > 0,
      `${failureClass} has no PRODUCT_* signal source (declared: ${entry.sources.join(", ")}) — harness evidence cannot satisfy operator diagnosability`,
    );
  }

  // DISTINGUISHABILITY is the actual requirement. Seven classes that all
  // surfaced as "503" would satisfy the loop above and tell an operator nothing:
  // they could not tell a policy problem from a dependency problem from a
  // configuration problem.
  const seen = new Map<string, string>();
  for (const failureClass of required) {
    const { signal } = OPERATOR_SIGNALS[failureClass];
    const collision = seen.get(signal);
    assert.equal(
      collision,
      undefined,
      `${failureClass} and ${String(collision)} are indistinguishable to an operator — both surface as: ${signal}`,
    );
    seen.set(signal, failureClass);
  }

  EVIDENCE.operatorSignalClasses = required.length;
  EVIDENCE.operatorSignalsDistinct = true;
  EVIDENCE.operatorSignalSources = required
    .map((failureClass) => `${failureClass}=${OPERATOR_SIGNALS[failureClass].sources.join("+")}`)
    .join(", ");
});

test("NON-VACUITY: a HARNESS_CONTROL-only signal is rejected as non-diagnosable", () => {
  // The source requirement above is the whole of review's P2 finding, so it must
  // be shown to REJECT the thing it exists to catch: a failure class whose only
  // evidence is the harness's own injection marker.
  const harnessOnly: OperatorSignal = {
    sources: ["HARNESS_CONTROL"],
    signal: "P0_LAUNCH_04_PATH_OUTAGE_BLOCKED appeared in the server log",
  };
  const productSources = harnessOnly.sources.filter((source) => PRODUCT_SOURCES.includes(source));
  assert.equal(productSources.length, 0, "a harness marker was counted as a product signal source");
  assert.throws(
    () =>
      assert.ok(
        productSources.length > 0,
        "FAKE has no PRODUCT_* signal source — harness evidence cannot satisfy operator diagnosability",
      ),
    /cannot satisfy operator diagnosability/,
    "the diagnosability check accepts a class whose only evidence is the harness",
  );
});

// ═══════════════════════ non-vacuity controls ═══════════════════════

test("NON-VACUITY: the readiness observer reports FAILURE when the wanted state never arrives", async () => {
  // Control 1 and 2 together. The database-loss claim rests on
  // `observeReadiness(…, "not_ready")` succeeding, and the recovery claim on
  // `observeReadiness(…, "ready")` succeeding. If the observer returned
  // `reached: true` regardless, both would be vacuous. So: with the database
  // genuinely blocked, asking it to wait for READY must FAIL, boundedly.
  installOutage(SOCKET_OUTAGE_FLAG());
  try {
    const startedAt = Date.now();
    const impossible = await observeReadiness(server!.baseUrl, "ready", 4_000);
    assert.equal(impossible.reached, false, "the readiness observer claimed READY while the database was unreachable");
    assert.equal(impossible.status, 503, `the observer did not even see the 503 it should have: ${impossible.raw.slice(0, 300)}`);
    assert.ok(Date.now() - startedAt < 15_000, "the readiness observer did not respect its deadline");
  } finally {
    clearOutage(SOCKET_OUTAGE_FLAG());
  }
  // ...and the database really does come back, or the control above proved
  // nothing about the outage either.
  const recovered = await observeReadiness(server!.baseUrl, "ready");
  assert.ok(recovered.reached, `the database did not recover after the control cleared the outage: ${recovered.raw.slice(0, 300)}`);
});

test("NON-VACUITY: the outage control is what causes the failure, not the harness", async () => {
  // Control 1's other half: with no outage installed, the same process, the same
  // probe and the same assertions report a REACHABLE database. A gate whose
  // "outage" was really a broken probe would fail here.
  const clean = await observeReadiness(server!.baseUrl, "ready");
  assert.ok(clean.reached, `the database is not reachable with no outage installed: ${clean.raw.slice(0, 300)}`);
  assert.equal(readinessCheck(clean, "database")?.status, "pass");
  assert.equal(fs.existsSync(SOCKET_OUTAGE_FLAG()), false, "the socket outage flag was left installed");
  assert.equal(fs.existsSync(PATH_OUTAGE_FLAG()), false, "the path outage flag was left installed");
});

test("NON-VACUITY: an outage is not accepted as a policy denial, nor a policy denial as an outage", () => {
  // Controls 4 and 5. The two failure-class assertions are the whole of the
  // policy-versus-infrastructure boundary, so each is handed the OTHER class and
  // required to reject it. Synthetic responses: the point is the assertion's
  // discrimination, not the server's.
  const outage: GovernedResponse = {
    status: 409,
    body: { disposition: "denied", failureClass: "frontera_unavailable", reason: "frontera_enforcement_denied" },
    raw: '{"disposition":"denied","failureClass":"frontera_unavailable"}',
  };
  const policy: GovernedResponse = {
    status: 409,
    body: { disposition: "denied", failureClass: "frontera_denied", reason: "frontera_enforcement_denied" },
    raw: '{"disposition":"denied","failureClass":"frontera_denied"}',
  };
  const allow: GovernedResponse = { status: 201, body: { disposition: "created", fronteraDecisionId: "decision-1" }, raw: "{}" };

  assert.throws(() => asGovernedPolicyDenial(outage, "control"), /must come from EVALUATION/, "an infrastructure outage satisfies the policy-denial assertion");
  assert.throws(() => asGovernedInfrastructureFailure(policy, "control"), /must be reported as an outage/, "a policy denial satisfies the infrastructure-outage assertion");
  assert.throws(() => asGovernedInfrastructureFailure(allow, "control"), /expected a fail-closed 409/, "an ALLOW satisfies the infrastructure-outage assertion");
  assert.throws(() => assertGovernedDidNotSucceed(allow, "control"), /SUCCEEDED/, "a successful dispatch satisfies the fail-closed assertion");
});

test("NON-VACUITY: the crash-recovery assertion fails when the process did not actually change", () => {
  // Control 6. `NEW_PID != OLD_PID` is the entire content of "a genuinely new
  // process started", so it must be shown to reject the case where it did not.
  const oldPid = Number(EVIDENCE.abnormalTerminationOldPid);
  const newPid = Number(EVIDENCE.abnormalTerminationNewPid);
  assert.ok(Number.isInteger(oldPid) && oldPid > 0, "no old pid was recorded, so the crash claim has no subject");
  assert.notEqual(newPid, oldPid, "the crash-recovery test recorded the same pid twice");
  assert.throws(
    () => assert.notEqual(oldPid, oldPid, "the 'new' process is the old one — nothing was actually restarted"),
    /nothing was actually restarted/,
    "the same-pid assertion accepts an unchanged process",
  );
});

test("NON-VACUITY: durable-authority survival fails against an EMPTY authority store", async () => {
  // Control 7. "The durable authority survived" is only a claim if the same
  // request, against a store with NOTHING in it, is refused. The store is a real
  // Frontera store — it is simply empty — so this separates surviving state from
  // a governed path that would have said ALLOW regardless.
  const port = await freePort();
  const outcome = await startProductionServer({ port, env: productionEnv({ [FRONTERA_STORE_ENV]: EMPTY_STORE_PATH }) });
  if (!outcome.started) assert.fail(`the empty-store control did not start: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    const isolated = new HttpSession(outcome.handle.baseUrl);
    await signIn(isolated);
    const response = await dispatchGovernedAction(isolated);
    assert.throws(
      () => asGovernedAllow(response, "control"),
      /denied|no fronteraDecisionId/,
      `an EMPTY authority store produced an ALLOW, so every "durable state survived" claim in this file is vacuous: ${response.raw.slice(0, 300)}`,
    );
    assertGovernedDidNotSucceed(response, "an empty authority store must not authorize a dispatch");
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "NON-VACUITY: empty authority store", graceMs: 10_000 });
  }
});

test("NON-VACUITY: the PRODUCT redaction path actually runs, it is not mere non-propagation", async () => {
  // Independent review's redaction requirement. The absence of the marker from
  // captured output (test K) is consistent with two very different worlds: the
  // product REDACTED it, or the product simply never touched it. Non-propagation
  // is not proof of redaction, so this drives the product's OWN redacting logger
  // and requires the marker to come back as a redaction rather than as itself.
  const { logEvent } = await import("../../src/lib/observability/logger");
  const { redactSecretLikeValues } = await import("../../src/lib/security/redaction");

  const lines: string[] = [];
  logEvent(
    "error",
    "p0_launch_04_redaction_probe",
    // A sensitive KEY name, which is the rule the product applies — the marker's
    // own shape is deliberately not one the redactor recognises, which is
    // exactly why test K's absence result needed this companion proof.
    { authorization: SECRET_MARKER, nested: { cookie: SECRET_MARKER }, benign: "not-a-secret" },
    { threshold: "debug", sink: (line) => lines.push(line) },
  );

  assert.equal(lines.length, 1, "the product logger emitted nothing, so nothing about its redaction was proven");
  const emitted = lines[0];
  assert.match(emitted, /\[redacted\]/, `the product redaction path did not run: ${emitted}`);
  assert.equal(emitted.includes(SECRET_MARKER), false, `the product logger emitted the secret VALUE: ${emitted}`);
  assert.match(emitted, /not-a-secret/, "the redactor destroyed non-sensitive fields too, so the evidence is not about secrets");

  // And directly, so the claim does not rest on the logger's wiring alone.
  const redacted = JSON.stringify(redactSecretLikeValues({ authorization: SECRET_MARKER }));
  assert.equal(redacted.includes(SECRET_MARKER), false);
  assert.match(redacted, /\[redacted\]/);

  EVIDENCE.secretRedactionProductPathProven = "logEvent + redactSecretLikeValues replaced a marker-valued sensitive key with [redacted]";
});

test("NON-VACUITY: the redaction assertion fails when the marker IS present", () => {
  // Control 8. The redaction claim is an ABSENCE, and an absence assertion that
  // cannot detect a presence proves nothing.
  assert.throws(
    () => assertMarkerAbsent(SECRET_MARKER, [{ where: "a deliberately poisoned capture", text: `some log line key=${SECRET_MARKER} rest` }]),
    /leaked into a deliberately poisoned capture/,
    "the redaction assertion accepts output that contains the marker",
  );
  // and it must still accept genuinely clean output, or it is merely broken.
  assertMarkerAbsent(SECRET_MARKER, [{ where: "clean output", text: "SUPABASE_SERVICE_ROLE_KEY is missing" }]);
});

test("NON-VACUITY: the bounded request helper fails boundedly against a dependency that never answers", async () => {
  // Control 9. Every wait in this file is bounded by `boundedFetch`. A socket
  // that ACCEPTS and never writes is the case an unbounded probe hangs on
  // forever — not a hypothesis about slow machines, but the observable behaviour
  // of an unbounded request.
  const held: net.Socket[] = [];
  const silent = net.createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
  const address = silent.address();
  assert.ok(address && typeof address !== "string", "the silent control server has no port");
  const startedAt = Date.now();
  try {
    await assert.rejects(
      boundedFetch(`http://127.0.0.1:${address.port}/api/ready`, {}, 1_500),
      "a request to a socket that accepts and never answers did not fail",
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 10_000, `the bounded request took ${elapsed}ms — the deadline was not respected`);
  } finally {
    held.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("NON-VACUITY: the outage shim's host matching normalises IPv6 loopback", async () => {
  // The isolation guard accepts IPv6 loopback, so the shim must not accept that
  // environment and then quietly fail to match its socket: a bracketed `[::1]`
  // configured host against Node's bare `::1` destination would block and reset
  // nothing while this gate believed an outage was installed. Pure, so it needs
  // no server.
  // The shared normaliser, NOT the shim: importing the shim would execute a
  // preload — patching net/fetch in this process and throwing without the outage
  // control environment.
  const { normalizeHost } = (await import("./support/host-matching.cjs")) as unknown as {
    normalizeHost: (host: string) => string;
  };

  assert.equal(normalizeHost("[::1]"), normalizeHost("::1"), "bracketed and bare IPv6 loopback must match");
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeHost("LOCALHOST"), "localhost");
  assert.equal(normalizeHost(" [::1] "), "::1");

  // And matching is not weakened: unrelated hosts stay apart.
  assert.notEqual(normalizeHost("::1"), normalizeHost("127.0.0.1"));
  assert.notEqual(normalizeHost("[::1]"), normalizeHost("[::2]"));
  assert.notEqual(normalizeHost("localhost"), normalizeHost("127.0.0.1"));
  assert.notEqual(normalizeHost("::1"), normalizeHost("::10"));
});

test("NON-VACUITY: the process-residue detector can see a live process, and sees it go", async () => {
  // Control 10. If `pidAlive` could not report a running process, every orphan
  // count in this file would be zero for the wrong reason.
  requireProc("classifying the state of the processes this gate started");
  const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.ok(await waitUntil(() => pidAlive(pid), 5_000), "a running process is not reported as running");
  assert.deepEqual(runningPids([pid]), [pid]);

  process.kill(-pid, "SIGKILL");
  await exited;
  assert.ok(await waitUntil(() => processState(pid) === null, 5_000), `pid ${pid} was never collected after SIGKILL`);
  assert.equal(pidAlive(pid), false, "a collected process is still reported as running");
});

test("NON-VACUITY: this gate left no orphaned or unreaped production process behind", async () => {
  requireProc("accounting for every process this gate started");

  // THE LONG-LIVED SERVER IS STOPPED HERE, NOT IN after().
  //
  // This ordering is the whole point of the test. Every other production process
  // this gate starts is stopped inside the test that started it, so its shutdown
  // is already in the ledger by now. The long-lived one was not: it used to be
  // stopped by `after()`, which runs AFTER this assertion — so if its shutdown
  // orphaned or failed to reap anything, `shutdownProductionServer` appended it
  // to the ledger after this test had already passed, and the gate could report
  // zero residue while leaking a process. The claim covered five of six
  // processes and said six.
  //
  // So it is shut down and accounted for FIRST, through the same shared path as
  // every other one, and `server` is cleared so `after()` cannot double-stop it.
  if (server) {
    const outcome = await shutdownProductionServer(server, { label: "the long-lived production server", graceMs: 20_000 });
    server = null;
    assert.deepEqual(outcome.orphans, [], `stopping the long-lived server left running processes behind: ${JSON.stringify(outcome.orphans)}`);
    assert.deepEqual(outcome.unreaped, [], `stopping the long-lived server left uncollected process-table entries behind: ${JSON.stringify(outcome.unreaped)}`);
  }

  // Now the ledger covers EVERY production process this gate started. Anything
  // `shutdownProductionServer` could not account for was recorded as it
  // happened, and this is where that ledger is read.
  assert.deepEqual(
    HARNESS_PROCESS_RESIDUE,
    [],
    `the gate left process-table residue behind: ${JSON.stringify(HARNESS_PROCESS_RESIDUE)}`,
  );
  EVIDENCE.productionProcessesStarted = productionProcessesStarted();
  EVIDENCE.processResidueAcrossEveryShutdown = 0;
  EVIDENCE.residueLedgerCoversEveryProcess = true;
});
