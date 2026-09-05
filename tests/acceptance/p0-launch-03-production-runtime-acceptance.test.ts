/**
 * P0-LAUNCH-03 — production runtime and deployment acceptance.
 *
 * P0-LAUNCH-02 proved that one integrated Founder journey runs truthfully across
 * the converged stack, in ONE TEST PROCESS. This file answers a different
 * question: can that accepted stack be built, started, operated, stopped,
 * restarted and validated through PMFreak's SUPPORTED PRODUCTION RUNTIME PATH?
 *
 * The distinction is the whole increment. Before this file, every gate whose
 * name contains "production", "runtime", "hardening" or "startup" was a
 * `readFileSync` plus a regular expression over SOURCE TEXT:
 *
 *   check:production-runtime   — asserts 20-odd files exist under src/lib/production-runtime
 *   check:runtime-hardening    — asserts 20-odd files exist under src/lib/runtime-hardening
 *   check:runtime-contracts    — counts occurrences of `any` in two files
 *   diag:runtime               — three regexes against bootstrap.ts and health/route.ts
 *   test:launch-smoke          — three more regexes
 *   docs/release/startup-readiness.md — "Startup assertions are enforced by ... checks"
 *
 * Every one of those passes with the application unable to boot. `npm run start`
 * was declared in package.json and executed by NOTHING: a repository-wide search
 * for `next start` / `npm run start` across scripts/, tests/, .github/ and
 * docs/release/ returned zero hits, and the only HTTP evidence in the repository
 * (the P2-14 Playwright journey) points its webServer at `npm run dev`.
 *
 * So this file starts the real thing. `npm run build`, then `npm run start`, then
 * HTTP against the process that results — health, readiness, authentication, a
 * governed dispatch, SIGTERM, a genuinely new process, and the durable state that
 * has to survive it.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THE CLAIMS HERE LOAD-BEARING RATHER THAN DECORATIVE
 *
 * 1. The Frontera authority store is created FRESH under the OS temp directory
 *    on every run. The store configured in the developer's .env.local is a
 *    leftover from a previous session; accepting against it would be accepting
 *    against developer-machine residue, which is exactly what this increment
 *    exists to rule out.
 *
 * 2. The centrepiece is not "a governed call returned ALLOW". It is that an
 *    operator revocation performed OUT OF PROCESS, against the store file, is
 *    observed by the already-running (and by then already RESTARTED) production
 *    server on its very next dispatch, without that server being signalled or
 *    told anything. A server running an in-memory authority world, a cached
 *    provider set, or a store other than the configured one CANNOT produce that
 *    transition. It proves H, I, R and the DENY half of J at once.
 *
 *    It happens ONCE, and last, because Frontera's revocation is TERMINAL by
 *    design: a revoked entity id can never be re-provisioned. A gate that
 *    revoked mid-run and then expected to restore the same grant would be
 *    asserting against semantics the authority model deliberately forbids.
 *
 * 3. Denials assert their exact `failureClass`. An outage
 *    (`frontera_unavailable`) is proven NOT to satisfy a policy-denial
 *    assertion — the same vacuity P0-LAUNCH-02's review found as its finding 6.
 *
 * 4. Liveness and readiness are asserted separately and are not interchangeable.
 *    /api/health answers 200 with the database down; only /api/ready probes it.
 *    Readiness is proven against a REAL Supabase endpoint — the repository's
 *    existing readiness test mocks `globalThis.fetch`, so before this file the
 *    readiness database probe had never actually reached a database.
 *
 * 5. Every assertion that could pass vacuously has a mechanical control at the
 *    bottom of this file proving it fails when the thing it claims is broken.
 *
 * ---------------------------------------------------------------------------
 * SCOPE. This is LOCAL PRODUCTION-LIKE acceptance: `next build` + `next start`
 * on this machine, against the disposable local Supabase stack. It is NOT a
 * real public production deployment, and nothing here should be read as one.
 * See docs/release/p0-launch-03-production-runtime-acceptance.md.
 *
 * PRECONDITIONS (operator, out of band — never performed by this file):
 *   npm run seed:p2-13-founder     # PMFreak database state for tenant A
 * A local Supabase stack must be reachable at OPERATIONAL_FLOW_TEST_SUPABASE_URL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
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
import {
  GUARD_MODES,
  LOCAL_ISOLATED,
  assertIsolatedTarget,
  classifyP2_13Target,
} from "../../scripts/p2-13/isolation-guard.mjs";
// The production-runtime lifecycle, /proc evidence and governed-decision
// vocabulary this gate was accepted with. Extracted verbatim by P0-LAUNCH-04 so
// the failure/recovery gate stops the production process by exactly the same
// path this one does; see that file's header.
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
  mappedFiles,
  pidAlive,
  portAcceptsConnections,
  processState,
  productionProcessesStarted,
  requireProc,
  runningPids,
  shutdownProductionServer,
  startProductionServer,
  waitUntil,
  type FailedStart,
  type GovernedResponse,
  type ServerHandle,
} from "./support/runtime-acceptance";

const ROOT = process.cwd();
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * The installed root of a packaged artifact, by RESOLUTION rather than by
 * assuming a path.
 *
 * `require.resolve(name + "/package.json")` cannot be used here:
 * `@aoc-enterprise/runtime` declares an `exports` map that does not expose
 * `./package.json`, so Node refuses the subpath outright
 * (ERR_PACKAGE_PATH_NOT_EXPORTED). Resolving the package's own entry point and
 * walking up to the manifest that CLAIMS the name works for both artifacts, and
 * still proves the specifier genuinely resolves rather than merely that a
 * directory exists where one is expected.
 */
function resolvePackageRoot(name: string): string {
  let dir = path.dirname(fs.realpathSync(requireFromRoot.resolve(name)));
  const stop = path.parse(dir).root;
  while (dir !== stop) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (readJson(manifest).name === name) return dir;
      } catch {
        /* an unreadable manifest on the way up is not the one we want */
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate the installed root of ${name} by resolution`);
}

const installedManifest = (name: string) => readJson(path.join(resolvePackageRoot(name), "package.json"));

/** Where the harness's per-process database outage lives. See the file itself. */
const DATABASE_OUTAGE_SHIM = path.join(ROOT, "tests/acceptance/support/database-outage-shim.cjs");

/**
 * A deterministic fingerprint of a package tree: every file's path and content
 * hash, ordered, hashed again.
 *
 * The technique is P0-LAUNCH-02's, applied here for the reason that gate found:
 * a matching name and version prove IDENTITY, never PROVENANCE. A package whose
 * manifest still reads `0.2.0-rc.1` while one installed file has been edited
 * satisfies every version, lock and integrity assertion in this file — the lock
 * records the TARBALL's integrity, and npm does not re-verify what is already
 * unpacked under node_modules. The server would then execute bytes this gate
 * had just certified as frozen.
 */
function fingerprintTree(root: string): { digest: string; count: number } {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // npm writes these INTO an installed package; they are not package content.
      if (entry.name === ".package-lock.json" || entry.name === ".bin") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${path.relative(root, full).split(path.sep).join("/")}:${sha256File(full)}`);
    }
  };
  walk(root);
  return { digest: createHash("sha256").update(entries.join("\n")).digest("hex"), count: entries.length };
}

/** Extracts a tarball to a temp directory and hands the caller its `package/` root. */
function withExtractedTarball<T>(tarball: string, fn: (packageRoot: string) => T): T {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "p0-launch-03-extract-"));
  try {
    execFileSync("tar", ["xzf", tarball, "-C", extractDir]);
    return fn(path.join(extractDir, "package"));
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

/**
 * THE IMMUTABLE LAUNCH BASELINE.
 *
 * Deliberately a literal, and deliberately NOT derived from
 * `vendor/aoc-consumer.lock.json`, for the reason P0-LAUNCH-02 gives: the lock
 * is mutable, and a coordinated repin would move the lock and the installed
 * tree together while an acceptance that only compared those two to each other
 * stayed green. Moving the launch baseline must edit this block.
 */
const LAUNCH_BASELINE = {
  "@aoc/protocol": {
    version: "0.2.0-rc.1",
    sha256: "b0d6ee6ff2010c4addab0bd683e2a89b9b2246f430c7e892fdc3d4123f3a3f60",
    integrity: "sha512-iJqgwo9ZLewWhY4HWOX1owfplgOzcjk2CuPOcI7ne8ZhwM8dekDaztaBhkfgos0IQ9mSH6fmefNA2yix8DO2bA==",
    tarball: "vendor/aoc-protocol-0.2.0-rc.1.tgz",
  },
  "@aoc-enterprise/runtime": {
    version: "1.2.1",
    sha256: "6b11e68e71b73e8a599c25c3b1ba26129de201b567664accf9874e06366e0628",
    integrity: "sha512-k3YmQ/GX6cHLLGjNzzYKHSIUT19U342jJF76l+qIbr2TKZTJJhvIQSjLIRuwfbeLZS1EqKOUNDrgPzdu0s5K3A==",
    tarball: "vendor/aoc-enterprise-runtime-1.2.1.tgz",
  },
} as const;

/** Frontera's own internals. A DIRECT PMFreak dependency on any of these would bypass the packaged boundary. */
const PRIVATE_FRONTERA_WORKSPACES = [
  "@aoc-enterprise/governed-authority",
  "@aoc-enterprise/governed-authorization",
  "@aoc-enterprise/identity",
  "@aoc-enterprise/scoped-access",
] as const;

const FRONTERA_STORE_ENV = "AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH";

// ───────────────────────────── small utilities ─────────────────────────────

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ─────────────────── local-fallback guards, as pure functions ───────────────────
//
// These are deliberately parameterised rather than reading their inputs
// directly. The acceptance calls them with the REAL tree; the non-vacuity
// controls at the bottom of this file call the SAME functions with a poisoned
// tree and require them to throw. A guard that could only ever be handed a
// passing input would prove nothing about its ability to detect a redirect.

function assertNoUpstreamAliasRedirect(aliases: readonly string[]): void {
  for (const alias of aliases) {
    assert.ok(
      !/^@aoc\/|^@aoc-enterprise\//.test(alias),
      `the alias ${alias} could redirect an upstream specifier to repository-local source`,
    );
  }
}

function assertNoPrivateFronteraDependency(declared: readonly string[]): void {
  for (const name of declared) {
    assert.ok(
      !PRIVATE_FRONTERA_WORKSPACES.includes(name as (typeof PRIVATE_FRONTERA_WORKSPACES)[number]),
      `${name} is a Frontera internal and must reach PMFreak only as a bundled dependency of the packaged artifact`,
    );
  }
}

function assertResolvedFromPackagedArtifact(name: string, resolvedPath: string, nodeModulesRoot: string): void {
  assert.ok(resolvedPath.startsWith(nodeModulesRoot), `${name} resolves to ${resolvedPath}, outside this checkout's node_modules`);
  assert.ok(!/[/\\]src[/\\]aoc[/\\]/.test(resolvedPath), `${name} resolves through repository-local source: ${resolvedPath}`);
}


// ─────────────────────────────── run context ───────────────────────────────

const manifest = buildP2_14HandoffManifest();
const TENANT_A = manifest.tenants.find((tenant: { key: string }) => tenant.key === "A")!;
const OWNER_A = TENANT_A.actors.find((actor: { reference: string }) => actor.reference.endsWith(":owner"))!;

let RUN_DIR = "";
let STORE_PATH = "";
let EMPTY_STORE_PATH = "";
let MALFORMED_STORE_PATH = "";
let PRINCIPAL_USER_ID = "";
let PORT = 0;
let server: ServerHandle | null = null;
let firstServerPid = 0;
let session!: HttpSession;
/**
 * Facts this run actually observed, printed once at the end.
 *
 * A launch-acceptance gate whose only output is "ok 25" makes a reviewer
 * re-run it to learn anything. These are recorded as they are asserted, never
 * assumed, and every one of them is also the subject of an assertion above.
 */
const EVIDENCE: Record<string, string | number | boolean> = {};
let actionId = "";
let allowDecisionId = "";
let postRestartDecisionId = "";
const runKey = `p0-launch-03-${Date.now()}`;

/**
 * The environment a production process is started with.
 *
 * Overrides are passed as EMPTY STRINGS rather than deletions, and that detail
 * is load-bearing. `next start` loads `.env.local` itself, and @next/env only
 * fills a name whose `process.env` value is `undefined` — so deleting a
 * variable here would let `.env.local` quietly put it back and the negative
 * control would test nothing. An empty string is defined, survives that merge,
 * and is falsy everywhere the product checks it.
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

/** Only the lifecycle this file owns; the provisioning helpers own the rest of the surface. */
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
      operatorActorId: "operator-p0-launch-03",
    }),
  );

const revokeAuthority = (storePath: string) =>
  withOperatorStore(storePath, (store) =>
    revokePmfreakDispatchAuthority(store, {
      organizationId: TENANT_A.workspaceId,
      principalUserId: PRINCIPAL_USER_ID,
      projectId: TENANT_A.projectId,
      operatorActorId: "operator-p0-launch-03",
      reason: "P0-LAUNCH-03 production runtime acceptance",
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

before(async () => {
  // ── Execution-environment guard. This gate mutates disposable runtime state
  //    and must only ever run against the canonical checkout it was written for.
  assert.ok(fs.existsSync(path.join(ROOT, "vendor/aoc-consumer.lock.json")), `not a PMFreak checkout: ${ROOT}`);

  // Environment is the operator's to supply, exactly as every other runtime gate
  // in this repository requires it (`set -a && . ./.env.local && set +a`). This
  // file reads no dotenv file of its own and invents no configuration.
  for (const name of [
    "OPERATIONAL_FLOW_TEST_SUPABASE_URL",
    "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY",
    "P2_13_FIXTURE_ACTOR_PASSWORD",
    // Declared by the product as required in production
    // (deployment-boundary-registry.ts) and checked by /api/ready. A production
    // runtime acceptance must be given it rather than invent one, because
    // inventing it is precisely how a readiness gate stops meaning anything.
    "NEXT_PUBLIC_APP_URL",
  ] as const) {
    assert.ok(
      process.env[name],
      `${name} is required. Load the acceptance environment first:  set -a && . ./.env.local && set +a`,
    );
  }

  // ── ISOLATION, BEFORE THE FIRST PRIVILEGED ACCESS.
  //
  //    The assertions above prove those variables are NONEMPTY, which says
  //    nothing about WHERE they point. An acceptance environment that has
  //    drifted onto a hosted or production Supabase satisfies every one of
  //    them — and this gate then opens an admin client with the SERVICE-ROLE
  //    key, lists users, and goes on to create Material Actions and Tasks
  //    through the running application. That contradicts the disposable-local
  //    boundary this gate is scoped to and would mutate real data.
  //
  //    The guard is the repository's own canonical one, not a weaker local
  //    copy: literal loopback host, the disposable local API port 54321, a
  //    plaintext loopback scheme, equality with the NEXT_PUBLIC_SUPABASE_URL
  //    the running application is configured with, and an independent refusal
  //    of known hosted/staging/production host shapes. It is a pure function
  //    over the environment, so "before any network access" is a property of
  //    this call's position, not a hope about timing.
  const isolation = assertIsolatedTarget(process.env, { mode: GUARD_MODES.SEED });
  assert.equal(
    isolation.classification,
    LOCAL_ISOLATED,
    `the acceptance target was not classified local and isolated: ${JSON.stringify(isolation.target ?? null)}`,
  );
  EVIDENCE.isolationClassification = String(isolation.classification);
  EVIDENCE.isolationTarget = String(isolation.target?.supabaseHost ?? "(not reported)");

  // ── A FRESH authority store, per run, under the OS temp directory.
  //    Never the operator's configured store: that file is developer-machine
  //    residue, and reusing it would make "durable state survived" unfalsifiable.
  RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pmfreak-p0-launch-03-"));
  STORE_PATH = path.join(RUN_DIR, "authority.sqlite");
  EMPTY_STORE_PATH = path.join(RUN_DIR, "empty-authority.sqlite");
  MALFORMED_STORE_PATH = path.join(RUN_DIR, "malformed-authority.sqlite");
  fs.writeFileSync(MALFORMED_STORE_PATH, "this is not a SQLite database\n");

  // ── The REAL authenticated principal id. Never guessed: an unresolvable
  //    actor is a hard failure, exactly as the operator provisioning script says.
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
  // The empty store is provisioned with NOTHING. It exists so that "durable
  // state survived a restart" can be shown to fail when the state is absent.
  await withOperatorStore(EMPTY_STORE_PATH, async () => {});

  PORT = await freePort();
});

after(async () => {
  // Normally already null: the residue test stops the long-lived server itself,
  // so its shutdown is inside the ledger that test asserts. This remains only as
  // a safety net for a run that aborted before reaching it — in which case the
  // residue assertion never ran either, so nothing is being certified.
  if (server) await shutdownProductionServer(server, { label: "after(): the last production server (run aborted early)", graceMs: 10_000 });
  console.log(`\nP0_LAUNCH_03_PRODUCTION_RUNTIME_EVIDENCE ${JSON.stringify(EVIDENCE, null, 2)}`);
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ═══════════════════════════ A / Q / R — the tree ═══════════════════════════

test("A: the installed dependency tree is the frozen launch baseline", () => {
  const lock = readJson(path.join(ROOT, "package-lock.json"));
  const pkg = readJson(path.join(ROOT, "package.json"));

  for (const [name, expected] of Object.entries(LAUNCH_BASELINE)) {
    const tarball = path.join(ROOT, expected.tarball);
    assert.ok(fs.existsSync(tarball), `${name}: the vendored artifact ${expected.tarball} is missing`);
    assert.equal(sha256File(tarball), expected.sha256, `${name}: the vendored tarball is not the frozen artifact`);

    assert.equal(pkg.dependencies[name], `file:${expected.tarball}`, `${name}: the declared specifier moved off the frozen tarball`);

    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name}: absent from package-lock.json`);
    assert.equal(entry.version, expected.version, `${name}: the locked version is not the launch baseline`);
    assert.equal(entry.integrity, expected.integrity, `${name}: the locked integrity is not the launch baseline`);

    assert.equal(installedManifest(name).version, expected.version, `${name}: the INSTALLED version is not the launch baseline`);

    // ── and the installed BYTES, not merely the installed version.
    //
    // Everything above this line is satisfied by a node_modules tree whose
    // contents have been edited while the manifest version stayed put, which is
    // exactly the state in which the server executes different Protocol or
    // Frontera JavaScript than the artifact this gate certifies. The comparison
    // is against the tarball ALREADY hashed to the frozen sha256 four lines up,
    // so it inherits that verification rather than trusting the file anew, and
    // it fingerprints the tree reached by RESOLUTION — the one the running
    // server actually loads — rather than a constructed path.
    const packed = withExtractedTarball(tarball, fingerprintTree);
    const installed = fingerprintTree(resolvePackageRoot(name));
    assert.ok(packed.count > 0, `${name}: the frozen tarball extracted no files`);
    assert.equal(
      installed.digest,
      packed.digest,
      `${name}: the INSTALLED tree (${installed.count} files) is not the frozen tarball's bytes (${packed.count} files). ` +
        `Name and version match, so only a content fingerprint could catch this. Run \`npm ci\`.`,
    );
    EVIDENCE[`installedBytes:${name}`] = `${packed.digest.slice(0, 16)}… (${packed.count} files, identical to ${expected.tarball})`;
  }
});

test("Q: no local-source or TypeScript-alias path to the upstream packages exists", () => {
  for (const dir of ["src/aoc/protocol", "src/aoc/enterprise"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, dir)), `${dir} exists; a repository-local copy could shadow the packaged artifact`);
  }

  assertNoUpstreamAliasRedirect(Object.keys(readJson(path.join(ROOT, "tsconfig.json")).compilerOptions?.paths ?? {}));

  const pkg = readJson(path.join(ROOT, "package.json"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    assertNoPrivateFronteraDependency(Object.keys(pkg[section] ?? {}));
  }

  // The resolved artifacts must live in this checkout's node_modules, not
  // somewhere a link or a workspace redirect could point.
  const nodeModulesRoot = fs.realpathSync(path.join(ROOT, "node_modules"));
  for (const name of Object.keys(LAUNCH_BASELINE)) {
    assertResolvedFromPackagedArtifact(name, resolvePackageRoot(name), nodeModulesRoot);
  }
});

test("R: no product code path can select an in-memory authority store", () => {
  // The packaged runtime DOES export an in-memory store, so this is a real
  // capability rather than a hypothetical. What must not exist is a way for the
  // PRODUCTION path to reach it.
  const runtimeSurface = fs.readFileSync(requireFromRoot.resolve("@aoc-enterprise/runtime/enterprise"), "utf8");
  assert.match(
    runtimeSurface,
    /createInMemoryKernelAuthorityStore/,
    "the packaged runtime no longer exports an in-memory store; this control is asserting against a stale assumption",
  );

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && fs.readFileSync(abs, "utf8").includes("createInMemoryKernelAuthorityStore")) {
        offenders.push(path.relative(ROOT, abs));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(offenders, [], "product code references an in-memory authority store");

  const adapter = fs.readFileSync(path.join(ROOT, "src/lib/integrations/frontera/enforcement-adapter.ts"), "utf8");
  assert.match(adapter, /createSqliteKernelAuthorityStore\(config\.authorityStorePath\)/, "the production path no longer opens the configured durable store");
});

// ═══════════════════════ B / C — build and actually start ═══════════════════════

test("B: the supported production build completes and emits a fresh build", () => {
  const buildIdPath = path.join(ROOT, ".next/BUILD_ID");
  const previousBuildId = fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, "utf8") : null;
  const startedAt = Date.now();

  // The real command, not a proxy for it. `npm run build` is `next build`.
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });

  assert.ok(fs.existsSync(buildIdPath), "next build produced no .next/BUILD_ID");
  assert.ok(
    fs.statSync(buildIdPath).mtimeMs >= startedAt - 1_000,
    `.next/BUILD_ID was not rewritten by this build — stale output must never be accepted as a production build (previous id ${previousBuildId})`,
  );

  EVIDENCE.buildCommand = "npm run build";
  EVIDENCE.buildOutput = ".next";
  EVIDENCE.buildId = fs.readFileSync(buildIdPath, "utf8").trim();

  const routes = fs.readFileSync(path.join(ROOT, ".next/routes-manifest.json"), "utf8");
  for (const route of ["/api/health", "/api/ready", "/api/login", "/api/operational-flow"]) {
    assert.ok(routes.includes(`"${route}"`), `the production build does not carry ${route}`);
  }
});

test("C: the built application starts through `npm run start` and becomes healthy", async () => {
  requireProc("identifying the production server process");
  const outcome = await startProductionServer({ port: PORT, env: productionEnv() });
  if (!outcome.started) assert.fail(`the production server did not start: ${outcome.reason}\n${outcome.log.slice(-4000)}`);

  server = outcome.handle;
  firstServerPid = server.serverPid;
  session = new HttpSession(server.baseUrl);

  EVIDENCE.startCommand = `npm run start -- --port ${PORT}`;
  EVIDENCE.processModel = `npm(${server.launcherPid}) -> sh -> ${cmdlineOf(server.serverPid)}(${server.serverPid})`;
  EVIDENCE.port = PORT;
  EVIDENCE.healthyAfterMs = server.healthyAfterMs;
  EVIDENCE.oldPid = server.serverPid;
  EVIDENCE.authorityStore = STORE_PATH;

  assert.ok(await portAcceptsConnections(PORT), `nothing is listening on ${PORT}`);
  assert.notEqual(server.serverPid, server.launcherPid, "could not distinguish the Next server from the npm launcher");

  // `next start` does not export NODE_ENV into the process environment — the
  // value the application sees is compiled in — so reading /proc/environ for it
  // would prove nothing either way. What IS observable here is that the process
  // serving HTTP is Next's PRODUCTION server, and that it received this run's
  // isolated store path. That the application is in production MODE is proven
  // separately and behaviourally by the fail-closed test below: readiness only
  // demands SUPABASE_SERVICE_ROLE_KEY when NODE_ENV === "production", and it
  // demands it.
  assert.match(cmdlineOf(server.serverPid), /next-server/, `the process serving HTTP is not Next's production server: ${cmdlineOf(server.serverPid)}`);
  assert.doesNotMatch(server.log(), /next dev|Starting.*development/i, "the supported production entrypoint started a development server");
  assert.equal(
    environOf(server.serverPid).get(FRONTERA_STORE_ENV),
    STORE_PATH,
    "the server process did not receive this run's isolated authority store path",
  );
});

// ═══════════════════════ D / E — liveness and readiness ═══════════════════════

test("D: liveness answers over HTTP from the running production process", async () => {
  const response = await session.request("/api/health");
  assert.equal(response.status, 200, `/api/health returned ${response.status}: ${response.text.slice(0, 300)}`);
  const body = response.json<{ status: string; app: string; runtime: { adapters: string[]; adapterCount: number } }>();
  assert.equal(body.status, "ok");
  assert.equal(body.app, "pmfreak");
  assert.ok(body.runtime.adapterCount > 0, "the AOC runtime composed no adapters");
  assert.ok(body.runtime.adapters.includes("policyEvaluator"), `the composed adapter set is missing policyEvaluator: ${body.runtime.adapters.join(", ")}`);
  EVIDENCE.health = `200 ok (${body.runtime.adapterCount} adapters)`;
});

test("E: readiness answers separately, and its database probe reaches a REAL database", async () => {
  const response = await session.request("/api/ready");
  const body = response.json<{ status: string; checks: { name: string; status: string; detail?: string }[] }>();
  assert.equal(response.status, 200, `/api/ready returned ${response.status}: ${response.text.slice(0, 400)}`);
  assert.equal(body.status, "ready");

  const failed = body.checks.filter((check) => check.status !== "pass");
  assert.deepEqual(failed, [], `readiness reported failing checks: ${JSON.stringify(failed)}`);

  // Readiness is not liveness. The database check is the reason this endpoint
  // exists, and until now it had only ever run against a mocked `fetch`.
  const database = body.checks.find((check) => check.name === "database");
  assert.ok(database, `readiness reported no database check: ${JSON.stringify(body.checks)}`);
  assert.equal(database.status, "pass", `the readiness database probe did not reach the database: ${JSON.stringify(database)}`);
  EVIDENCE.readiness = `200 ready (${body.checks.map((check) => `${check.name}=${check.status}`).join(", ")})`;
});

test("D/E: ONE process stays LIVE while its database is unreachable, and reports NOT READY", async () => {
  requireProc("attributing liveness and readiness to a single production process");

  // D and E above prove `/api/health` is 200 and `/api/ready` is 200 while the
  // database is REACHABLE — which is the only condition either of them was ever
  // asserted under. The claim that distinguishes them ("liveness stays 200 with
  // the database down; only readiness fails") had no control at all, so a
  // regression that added a database call to the health route would leave this
  // file entirely green.
  //
  // The outage is genuine and confined to ONE process: see the shim's own
  // comment for why an environment override cannot produce it (Next inlines
  // NEXT_PUBLIC_* into the server bundle at build time, so there is no runtime
  // lookup left to re-point) and why rebuilding would answer for a different
  // build than the one under acceptance.
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  const hostPort = `${supabase.hostname}:${supabase.port || (supabase.protocol === "https:" ? "443" : "80")}`;
  const port = await freePort();
  const outcome = await startProductionServer({
    port,
    env: productionEnv({
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${DATABASE_OUTAGE_SHIM}`.trim(),
      P0_LAUNCH_03_UNREACHABLE_HOSTPORT: hostPort,
    }),
  });
  // Reaching HEALTHY is already half the claim: `startProductionServer` waits on
  // `/api/health`, so a health route that touched the database could not get
  // this far — it would time out and fail here rather than pass quietly.
  if (!outcome.started) {
    assert.fail(`the process must stay live with its database unreachable, but: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  }
  try {
    assert.match(
      outcome.handle.log(),
      /P0_LAUNCH_03_DATABASE_OUTAGE_SHIM_ACTIVE/,
      "the outage was never installed in the server process, so 'the database is unreachable' is not established",
    );

    const isolated = new HttpSession(outcome.handle.baseUrl);
    const health = await isolated.request("/api/health");
    const ready = await isolated.request("/api/ready");
    // Both answers came from the SAME process: one process listens on this
    // port, it is the one started above, and it is still that process now.
    assert.ok(pidAlive(outcome.handle.serverPid), "the server process died between the two requests");

    assert.equal(health.status, 200, `/api/health must stay 200 with the database down, got ${health.status}: ${health.text.slice(0, 300)}`);
    assert.equal(health.json<{ status: string }>().status, "ok");

    assert.equal(ready.status, 503, `/api/ready must be 503 with the database down, got ${ready.status}: ${ready.text.slice(0, 300)}`);
    const body = ready.json<{ status: string; checks: { name: string; status: string; detail?: string }[] }>();
    assert.equal(body.status, "not_ready");
    const database = body.checks.find((check) => check.name === "database");
    assert.equal(database?.status, "fail", `the database check did not fail: ${JSON.stringify(body.checks)}`);
    assert.match(String(database?.detail), /unreachable|timeout/, `the database failure is not an outage: ${JSON.stringify(database)}`);

    // The probe REACHED for the database and was refused, so readiness failed
    // BECAUSE of the outage rather than because some other check happened to
    // fail first — and nothing but reachability was changed, which is why the
    // configuration check must still pass.
    assert.match(
      outcome.handle.log(),
      /P0_LAUNCH_03_DATABASE_OUTAGE_BLOCKED/,
      "no connection to the database was ever attempted, so the readiness failure is not attributable to the outage",
    );
    assert.equal(
      body.checks.find((check) => check.name === "configuration")?.status,
      "pass",
      `the control changed more than the database's reachability: ${JSON.stringify(body.checks)}`,
    );

    EVIDENCE.livenessDuringDatabaseOutage =
      `pid ${outcome.handle.serverPid}: /api/health=200 ok, /api/ready=503 not_ready (database=${String(database?.detail)})`;
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "D/E: database-outage control", graceMs: 10_000 });
  }
});

// ═══════════════════════ G / F — auth and database, in the running process ═══════════════════════

test("G: the running process refuses an unauthenticated caller and honours a real login", async () => {
  const anonymous = new HttpSession(server!.baseUrl);
  const denied = await anonymous.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`);
  assert.equal(denied.status, 401, `an unauthenticated read must be refused, got ${denied.status}: ${denied.text.slice(0, 200)}`);

  const login = await signIn(session);
  assert.ok([200, 302, 303, 307].includes(login.status), `POST /api/login returned ${login.status}: ${login.text.slice(0, 300)}`);
  assert.ok(
    session.cookieNames.some((name) => name.startsWith("sb-")),
    `the login did not establish a Supabase session cookie (cookies: ${session.cookieNames.join(", ")})`,
  );
});

test("F: the running process reads tenant-scoped data from the real database", async () => {
  const response = await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`);
  assert.equal(response.status, 200, `the authenticated tenant read failed: ${response.status} ${response.text.slice(0, 300)}`);
  const summary = response.json<Record<string, unknown>>();
  assert.ok(Array.isArray(summary.decisions), `the summary carries no decisions array: ${response.text.slice(0, 300)}`);
  assert.ok((summary.decisions as unknown[]).length > 0, "tenant A has no persisted Decision; run `npm run seed:p2-13-founder` and the Founder journey first");
});

// ═══════════════════════ J / H / I — the governed operation ═══════════════════════

test("J(ALLOW): a governed Material Action dispatches through Frontera in the production process", async () => {
  const summary = (await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`)).json<{
    decisions: { id: string; decision_status: string }[];
  }>();
  // `persist_governed_material_action` only accepts a source Decision that
  // reached a terminal ACCEPTED or MODIFIED state. Taking the most recent
  // Decision regardless of status is how this reads 500 instead of proving
  // anything — an escalated Decision is not dispatchable by design.
  const decision = summary.decisions.find((row) => ["accepted", "modified"].includes(String(row.decision_status)));
  assert.ok(
    decision,
    `tenant A has no accepted or modified Decision to propose against (statuses: ${summary.decisions.map((row) => row.decision_status).join(", ") || "none"}). Run \`npm run seed:p2-13-founder\` and the Founder journey first.`,
  );
  const decisionId = decision.id;

  // Proposed through the product's own governed surface, with a run-scoped
  // idempotency key, so the ALLOW rests on state this run created rather than
  // on a row a previous session happened to leave behind.
  const proposed = await governedPost(session, {
    operation: "propose_material_action",
    decisionId,
    idempotencyKey: `${runKey}:material-action`,
    actionClass: "external_write",
    actionType: "production runtime acceptance probe",
    targetResourceType: "project",
    targetResourceId: TENANT_A.projectId,
    intendedOperation: "confirm the governed dispatch boundary from a production process",
    intendedEffect: "records a canonical Task through the governed dispatch path",
    risk: "medium",
    reversibility: "reversible",
    sideEffect: "external",
    justification: "P0-LAUNCH-03 production runtime acceptance",
  });
  assert.ok([200, 201].includes(proposed.status), `propose_material_action failed: ${proposed.status} ${proposed.raw.slice(0, 400)}`);

  const after = (await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`)).json<{
    materialActions: { id: string; idempotency_key?: string }[];
    materialActionEvaluations: { action_id: string; governance_state: string }[];
  }>();
  const mine = after.materialActions.find((row) => row.idempotency_key === `${runKey}:material-action`);
  assert.ok(mine, `the proposed Material Action is not readable back: ${JSON.stringify(after.materialActions).slice(0, 400)}`);
  actionId = mine.id;

  const evaluation = after.materialActionEvaluations.find((row) => row.action_id === actionId);
  assert.equal(evaluation?.governance_state, "authorized", `PMFreak's own governance did not authorize the action: ${JSON.stringify(evaluation)}`);

  const dispatched = await dispatchGovernedAction();
  allowDecisionId = asGovernedAllow(dispatched, "a provisioned Founder must be allowed to dispatch through the production process");
  EVIDENCE.governedOperation = "POST /api/operational-flow {operation:dispatch_material_action_to_task}";
  EVIDENCE.actionId = actionId;
  EVIDENCE.allowDecisionId = allowDecisionId;
});

test("H/I: the running server executed the frozen packaged artifacts, not local or alternate bytes", () => {
  requireProc("proving which bytes the production server loaded");

  // The durable store is opened through better-sqlite3, a NATIVE module. A
  // process that only claimed to use Frontera's durable store could not have
  // this mapped into its address space; a process using an in-memory store
  // would not either.
  const mapped = mappedFiles(firstServerPid);
  const sqliteBinding = mapped.find((file) => /better[_-]sqlite3.*\.node$/.test(file));
  assert.ok(
    sqliteBinding,
    `the server process mapped no better-sqlite3 native binding, so it did not open the durable authority store through the packaged runtime`,
  );
  assert.ok(
    fs.realpathSync(sqliteBinding).startsWith(fs.realpathSync(path.join(ROOT, "node_modules"))),
    `the server loaded a SQLite binding from outside this checkout: ${sqliteBinding}`,
  );
  EVIDENCE.nativeBindingMappedIntoServer = path.relative(ROOT, fs.realpathSync(sqliteBinding));
  EVIDENCE.activeProtocol = `@aoc/protocol@${installedManifest("@aoc/protocol").version}`;
  EVIDENCE.activeFrontera = `@aoc-enterprise/runtime@${installedManifest("@aoc-enterprise/runtime").version}`;

  // The store this run configured is a real, populated SQLite database. The
  // proof that the SERVER is the process reading it is not this line — it is
  // the out-of-process revocation in the next test, which the server observes
  // without being restarted or told anything.
  assert.ok(fs.statSync(STORE_PATH).size > 0, "the configured authority store is empty after a governed evaluation");
  assert.equal(
    fs.readFileSync(STORE_PATH).subarray(0, 15).toString("utf8"),
    "SQLite format 3",
    "the configured authority store is not a SQLite database",
  );

  // Identity of the artifacts resolved from the checkout the server runs out of.
  const nodeModulesRoot = fs.realpathSync(path.join(ROOT, "node_modules"));
  for (const [name, expected] of Object.entries(LAUNCH_BASELINE)) {
    assert.equal(installedManifest(name).version, expected.version, `${name}: the running root resolves a version other than the launch baseline`);
    assertResolvedFromPackagedArtifact(name, resolvePackageRoot(name), nodeModulesRoot);
  }

  // The process that produced the governed decision is the same production
  // server this test inspected — not a helper, not the launcher, and not this
  // test process. (`next start` does not export NODE_ENV; production MODE is
  // established behaviourally by the fail-closed readiness control below.)
  assert.equal(server!.serverPid, firstServerPid, "the governed decision was produced by a different process than the one inspected here");
  assert.match(cmdlineOf(firstServerPid), /next-server/, `the inspected process is not Next's production server: ${cmdlineOf(firstServerPid)}`);
  assert.equal(
    environOf(firstServerPid).get(FRONTERA_STORE_ENV),
    STORE_PATH,
    "the process that produced the governed decision was reading a different authority store",
  );
});

test("NEGATIVE CONTROL: an infrastructure outage is not accepted as a policy denial", () => {
  const outage: GovernedResponse = {
    status: 409,
    body: { disposition: "denied", failureClass: "frontera_unavailable", reason: "frontera_enforcement_denied" },
    raw: "{}",
  };
  assert.throws(
    () => asGovernedPolicyDenial(outage, "control"),
    /must come from EVALUATION, not from an outage/,
    "the policy-denial assertion accepts an outage, so every DENY in this file would be satisfiable by breaking the store",
  );
  // and the converse: a real allow must not satisfy the denial assertion either.
  assert.throws(() => asGovernedPolicyDenial({ status: 201, body: { fronteraDecisionId: "x" }, raw: "{}" }, "control"), /expected a governed 409 denial/);
});

// ═══════════════════════ K / L / M / N / O — stop, restart, survive ═══════════════════════

test("K: SIGTERM stops the production process cleanly and releases the port", async () => {
  const storeBefore = sha256File(STORE_PATH);
  const outcome = await shutdownProductionServer(server!, { label: "K: SIGTERM to the process group", signal: "SIGTERM", graceMs: 30_000 });

  assert.notEqual(outcome.exitedAfterMs, null, "the production process did not exit within 30s of SIGTERM");
  // SIGTERM alone was enough. The shutdown path CAN escalate to SIGKILL, so
  // without this the test would pass just as happily on a process that ignored
  // the graceful signal entirely.
  assert.equal(outcome.escalated, false, "SIGTERM did not stop the process group; the shutdown had to escalate to SIGKILL");
  assert.deepEqual(outcome.orphans, [], `SIGTERM left running processes behind: ${outcome.orphans.join(", ")}`);
  assert.deepEqual(outcome.unreaped, [], `SIGTERM left terminated-but-uncollected processes behind: ${outcome.unreaped.join(", ")}`);
  assert.equal(await portAcceptsConnections(PORT), false, `port ${PORT} is still accepting connections after shutdown`);
  assert.equal(sha256File(STORE_PATH), storeBefore, "the durable authority store changed during shutdown");
  EVIDENCE.shutdownMethod = "SIGTERM to the process group";
  EVIDENCE.shutdownExitedAfterMs = outcome.exitedAfterMs ?? -1;
  EVIDENCE.shutdownSignal = String(outcome.signal);
  EVIDENCE.shutdownEscalatedToSigkill = outcome.escalated;
  EVIDENCE.orphanProcesses = outcome.orphans.length;
  server = null;
});

test("L: a genuinely NEW production process starts from the same entrypoint", async () => {
  const outcome = await startProductionServer({ port: PORT, env: productionEnv() });
  if (!outcome.started) assert.fail(`the production server did not restart: ${outcome.reason}\n${outcome.log.slice(-4000)}`);
  server = outcome.handle;
  session.rebind(server.baseUrl);

  assert.notEqual(server.serverPid, firstServerPid, "the restart reused the original process; a same-process reopen is not a restart");
  assert.equal(pidAlive(firstServerPid), false, "the original server process is still alive after the restart");
  EVIDENCE.newPid = server.serverPid;
});

test("M: the new process becomes healthy and ready again", async () => {
  const health = await session.request("/api/health");
  assert.equal(health.status, 200, `/api/health after restart: ${health.status}`);
  assert.equal(health.json<{ status: string }>().status, "ok");

  const ready = await session.request("/api/ready");
  assert.equal(ready.status, 200, `/api/ready after restart: ${ready.status} ${ready.text.slice(0, 300)}`);
  const body = ready.json<{ status: string; checks: { name: string; status: string }[] }>();
  assert.equal(body.status, "ready");
  assert.equal(body.checks.find((check) => check.name === "database")?.status, "pass", "the restarted process cannot reach the database");
});

test("N/O: durable state survived the restart, and the new process governs with it", async () => {
  // The restarted process was told only the store PATH — nothing else about the
  // authority world. If the authority provisioned before the restart had not
  // survived in durable state, this dispatch would be denied as unbound.
  await signIn(session);
  const allowed = await dispatchGovernedAction();
  postRestartDecisionId = asGovernedAllow(allowed, "authority provisioned before the restart must still authorize after it");
  assert.notEqual(
    postRestartDecisionId,
    allowDecisionId,
    "the restarted process replayed the pre-restart decision id rather than evaluating afresh against the store",
  );

  // PMFreak's own durable state must have survived too.
  const summary = (await session.request(`/api/operational-flow?workspaceId=${TENANT_A.workspaceId}&projectId=${TENANT_A.projectId}`)).json<{
    materialActions: { id: string }[];
  }>();
  assert.ok(
    summary.materialActions.some((row) => row.id === actionId),
    "the Material Action created before the restart is no longer readable after it",
  );
  EVIDENCE.postRestartAllowDecisionId = postRestartDecisionId;
});

test("J(DENY): an operator revocation made OUT OF PROCESS is observed by the running server", async () => {
  // This is the centrepiece. The revocation is written by THIS test process,
  // directly to the store file, while the production server keeps running and
  // is never signalled, restarted or told anything. If that server were
  // consulting an in-memory world, a cached provider set, or any store other
  // than the configured one, the very next dispatch would still be allowed.
  //
  // It is done ONCE, and last, because Frontera's revocation is TERMINAL by
  // design: `decideKernelAuthorityAppend` refuses to re-provision a revoked
  // entity id ("provision a new entity id rather than reusing a revoked one").
  // A gate that revoked mid-run and then expected to restore the same grant
  // would be asserting against semantics the authority model deliberately
  // forbids.
  await revokeAuthority(STORE_PATH);

  const denied = await dispatchGovernedAction();
  asGovernedPolicyDenial(denied, "a revoked capability must deny the exact dispatch that was allowed moments ago");
  EVIDENCE.denyDecision = `${denied.status} ${String(denied.body.failureClass)}`;
});

// ═══════════════════════ P / T — fail closed ═══════════════════════

test("P: a production process missing a required server secret REFUSES TO START", async () => {
  // CONTRACT CHANGE, not a weakening. This case previously required the process to start
  // and then answer NOT READY. Under the closed-beta runtime contract that P0-LAUNCH-06
  // certified, required startup configuration is enforced by the in-process guard BEFORE
  // the server can become operational, so the observable boundary moves from
  // RUNNING_NOT_READY to the strictly stronger BOOT_REFUSED. The control's intent —
  // invalid required runtime configuration must fail closed — is unchanged, and the
  // historical NOT-READY evidence remains true for its historical SHA.
  const port = await freePort();
  const outcome = await startProductionServer({ port, env: productionEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }), timeoutMs: 90_000 });
  if (outcome.started) {
    await shutdownProductionServer(outcome.handle, { label: "P: missing server secret", graceMs: 10_000 });
    assert.fail("a production server became operational without a required server secret");
  }
  // Not merely "it failed": the refusal must be attributable to THIS misconfiguration.
  assert.match(outcome.log, /missing_beta_environment/, "the refusal is not attributable to the missing beta environment requirement");
  assert.match(outcome.log, /SUPABASE_SERVICE_ROLE_KEY/, "the refusal does not name the missing variable");
  // Names the variable, never a value.
  assert.doesNotMatch(outcome.log, /eyJ[A-Za-z0-9_-]{10,}/, "the startup refusal leaked a credential-shaped value");
  assert.deepEqual(outcome.survivors, [], "the refused start left surviving processes");
});

test("P: a misconfigured declared dependency REFUSES TO START", async () => {
  // Same contract change as above: enabling governance capability signing without its
  // secret is part of the closed-beta startup contract, so it now fails closed at boot
  // rather than surfacing later as a readiness failure.
  const port = await freePort();
  const outcome = await startProductionServer({
    port,
    env: productionEnv({ PMFREAK_GOVERNANCE_CAPABILITY_ENABLED: "true", PMFREAK_CAPABILITY_CLAIM_SECRET: "" }),
    timeoutMs: 90_000,
  });
  if (outcome.started) {
    await shutdownProductionServer(outcome.handle, { label: "P: misconfigured declared dependency", graceMs: 10_000 });
    assert.fail("a production server became operational with an enabled capability and no claim secret");
  }
  assert.match(outcome.log, /missing_governance_secret/, "the refusal is not attributable to the missing governance secret");
  assert.doesNotMatch(outcome.log, /eyJ[A-Za-z0-9_-]{10,}/, "the startup refusal leaked a credential-shaped value");
  assert.deepEqual(outcome.survivors, [], "the refused start left surviving processes");
});

test("P: an unconfigured Frontera authority store denies as an OUTAGE, never as ALLOW", async () => {
  const port = await freePort();
  const outcome = await startProductionServer({ port, env: productionEnv({ [FRONTERA_STORE_ENV]: "" }) });
  if (!outcome.started) assert.fail(`expected a running process that fails closed, but: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    const isolated = new HttpSession(outcome.handle.baseUrl);
    await signIn(isolated);
    const response = await governedPost(isolated, { operation: "dispatch_material_action_to_task", actionId });
    asGovernedInfrastructureFailure(response, "an unconfigured authority store must fail closed as an outage");
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "P: unconfigured authority store", graceMs: 10_000 });
  }
});

test("P: a MALFORMED Frontera authority store is refused, never silently substituted", async () => {
  const port = await freePort();
  const outcome = await startProductionServer({ port, env: productionEnv({ [FRONTERA_STORE_ENV]: MALFORMED_STORE_PATH }) });
  if (!outcome.started) assert.fail(`expected a running process that fails closed, but: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    const isolated = new HttpSession(outcome.handle.baseUrl);
    await signIn(isolated);
    const response = await governedPost(isolated, { operation: "dispatch_material_action_to_task", actionId });
    asGovernedInfrastructureFailure(response, "a malformed authority store must fail closed rather than degrade to an in-memory substitute");
    // The malformed file must be left as it was — never repaired into a store.
    assert.equal(fs.readFileSync(MALFORMED_STORE_PATH, "utf8"), "this is not a SQLite database\n", "the runtime rewrote the malformed store file");
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "P: malformed authority store", graceMs: 10_000 });
  }
});

// ═══════════════════════ non-vacuity controls ═══════════════════════

test("NON-VACUITY: the health probe fails when nothing is listening", async () => {
  const port = await freePort();
  await assert.rejects(
    boundedFetch(`http://127.0.0.1:${port}/api/health`, {}, 5_000),
    "a probe against a dead port resolved, so 'healthy' proves nothing",
  );
});

test("NON-VACUITY: the start check fails when the process cannot become healthy", async () => {
  const port = await freePort();
  // A ZERO startup deadline is a MECHANICAL impossibility, not a bet on how
  // slow this machine is. The previous form allowed 1.5s, so on a machine where
  // an already-built server became healthy inside that window the control
  // received a successful StartOutcome and failed the whole gate even though
  // `startProductionServer` was behaving correctly: it was reporting the
  // machine's speed rather than the helper's behaviour. No machine can beat a
  // deadline that has already expired.
  const outcome = await startProductionServer({ port, env: productionEnv(), timeoutMs: 0 });
  assert.equal(outcome.started, false, "startProductionServer reported success without a healthy process");
  const failed = outcome as FailedStart;
  assert.match(failed.reason, /never became healthy within 0ms/);

  // A failed start must also not leave the process it spawned behind.
  assert.equal(failed.reaped, true, `the failed start left processes behind: ${failed.survivors.join(", ")}`);
  assert.equal(await portAcceptsConnections(port), false, `port ${port} is still accepting connections after a failed start`);
  EVIDENCE.failedStartControl = "timeoutMs=0 — an expired deadline, not a timing assumption";
});

test("NON-VACUITY: durable-state survival fails against an EMPTY authority store", async () => {
  const port = await freePort();
  // Same code path, same running product, only the durable state is absent. If
  // this still allowed, the survival claim in N/O would be worthless.
  const outcome = await startProductionServer({ port, env: productionEnv({ [FRONTERA_STORE_ENV]: EMPTY_STORE_PATH }) });
  if (!outcome.started) assert.fail(`control server did not start: ${outcome.reason}\n${outcome.log.slice(-2000)}`);
  try {
    const isolated = new HttpSession(outcome.handle.baseUrl);
    await signIn(isolated);
    const response = await governedPost(isolated, { operation: "dispatch_material_action_to_task", actionId });
    assert.equal(response.body.disposition, "denied", `an empty authority store must not authorize: ${response.raw.slice(0, 300)}`);
    assert.equal(
      response.body.failureClass,
      "frontera_actor_unbound",
      `an empty store must leave the principal unbound, not produce a policy answer: ${response.raw.slice(0, 300)}`,
    );
    assert.throws(() => asGovernedAllow(response, "control"), /fronteraDecisionId|denied/);
  } finally {
    await shutdownProductionServer(outcome.handle, { label: "NON-VACUITY: empty authority store", graceMs: 10_000 });
  }
});

test("NON-VACUITY: the isolation guard refuses a non-local Supabase target, before any network access", () => {
  // The guard is a PURE function over an environment object — it opens no
  // socket and reads no file — so these are the states the `before` hook would
  // have refused, evaluated without going anywhere near a database.
  const withTarget = (url: string) => ({ ...process.env, OPERATIONAL_FLOW_TEST_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url });

  const refused: readonly (readonly [string, string, string])[] = [
    ["a hosted Supabase project", "https://abcdefghijklmnop.supabase.co", "supabase_url_loopback"],
    ["a LAN host", "http://192.168.1.50:54321", "supabase_url_loopback"],
    ["an arbitrary public host", "http://db.example.com:54321", "supabase_url_loopback"],
    ["a host that merely CONTAINS localhost", "http://localhost.attacker.example:54321", "supabase_url_loopback"],
    ["loopback on the wrong port", "http://127.0.0.1:5432", "supabase_url_expected_port"],
  ];

  for (const [why, url, expectedRefusal] of refused) {
    assert.throws(
      () => assertIsolatedTarget(withTarget(url), { mode: GUARD_MODES.SEED }),
      /P2-13 SAFETY REFUSAL/,
      `${why} (${url}) was accepted as a disposable local target, so this gate would have used a service-role key against it`,
    );
    const verdict = classifyP2_13Target(withTarget(url), { mode: GUARD_MODES.SEED });
    assert.equal(verdict.ok, false, `${why}: the guard returned ok`);
    assert.ok(
      verdict.refusals.includes(expectedRefusal),
      `${why}: expected the ${expectedRefusal} refusal, got ${verdict.refusals.join(", ")}`,
    );
  }

  // A hosted target is refused even when only ONE of the two variables moved,
  // so a half-updated environment cannot slip a privileged call through.
  assert.throws(
    () => assertIsolatedTarget({ ...process.env, OPERATIONAL_FLOW_TEST_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" }, { mode: GUARD_MODES.SEED }),
    /P2-13 SAFETY REFUSAL/,
    "a harness pointed at a hosted project was accepted because the application's own variable still looked local",
  );

  // and it must still accept the genuine target, or it is merely broken.
  assert.equal(classifyP2_13Target(process.env, { mode: GUARD_MODES.SEED }).classification, LOCAL_ISOLATED);
});

test("NON-VACUITY: the installed-bytes fingerprint catches a mutated file whose version is untouched", () => {
  // Nothing under node_modules is touched. The frozen tarball is extracted, its
  // pristine tree fingerprinted, ONE file edited, and the SAME function asked
  // again — a tree wrong in exactly the way the acceptance must catch, and in
  // the only way the version, lock and integrity assertions cannot see.
  const name = "@aoc/protocol";
  const expected = LAUNCH_BASELINE[name];
  withExtractedTarball(path.join(ROOT, expected.tarball), (tree) => {
    const pristine = fingerprintTree(tree);
    assert.ok(pristine.count > 0, "the frozen tarball extracted no files");

    const firstJavaScriptFile = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = firstJavaScriptFile(full);
          if (found) return found;
        } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) return full;
      }
      return null;
    };
    const victim = firstJavaScriptFile(tree);
    assert.ok(victim, "the packaged artifact carries no JavaScript to mutate");

    fs.appendFileSync(victim, "\n// one line an attacker appended\n");
    const mutated = fingerprintTree(tree);

    // The mutation must leave every signal the other assertions read intact,
    // or it would not be demonstrating their blindness.
    const manifest = readJson(path.join(tree, "package.json"));
    assert.equal(manifest.name, name, "the mutation changed the package name; it must change CONTENT only");
    assert.equal(manifest.version, expected.version, "the mutation changed the version; it must change CONTENT only");
    assert.equal(mutated.count, pristine.count, "the mutation added or removed a file; it must change CONTENT only");

    assert.notEqual(
      mutated.digest,
      pristine.digest,
      "a mutated file did not change the fingerprint, so the installed-bytes assertion in A would pass straight over it",
    );
  });
});

test("NON-VACUITY: the process-residue detector can see a live process, and sees it go", async () => {
  requireProc("classifying the state of the processes this gate started");

  // If `pidAlive` could not report a running process, every orphan count in
  // this file would be zero for the wrong reason.
  const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.ok(await waitUntil(() => pidAlive(pid), 5_000), "a running process is not reported as running");
  assert.deepEqual(runningPids([pid]), [pid]);

  process.kill(-pid, "SIGKILL");
  await exited;
  assert.ok(await waitUntil(() => processState(pid) === null, 5_000), `pid ${pid} was never collected after SIGKILL`);
  assert.equal(pidAlive(pid), false, "a collected process is still reported as running");
  assert.deepEqual(runningPids([pid]), []);
});

test("NON-VACUITY: this gate left no orphaned or unreaped production process behind", async () => {
  requireProc("accounting for every process this gate started");

  // THE LONG-LIVED SERVER IS STOPPED HERE, NOT IN after().
  //
  // P0-LAUNCH-04's review found this ordering defect and it is the same one
  // here, so it is closed in the same place rather than left to be rediscovered.
  // Every other production process this gate starts is stopped inside the test
  // that started it, so its shutdown is already in the ledger. The long-lived
  // one was not: it used to be stopped by `after()`, which runs AFTER this
  // assertion — so if its shutdown orphaned or failed to reap anything,
  // `shutdownProductionServer` appended it to the ledger after this test had
  // already passed, and the gate could report zero residue while leaking a
  // process.
  //
  // It is now stopped and accounted for FIRST, through the same shared path as
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

test("NON-VACUITY: the local-fallback guards reject a redirected tree", () => {
  // The SAME functions the acceptance uses, handed the states they exist to
  // catch. No file is mutated: the guards are pure, so the redirect can be
  // expressed as an argument instead of as damage to the checkout.
  const nodeModulesRoot = fs.realpathSync(path.join(ROOT, "node_modules"));

  assert.throws(
    () => assertNoUpstreamAliasRedirect(["@/*", "@aoc/protocol", "@aoc/protocol/*"]),
    /@aoc\/protocol could redirect/,
    "a tsconfig alias onto @aoc/protocol is accepted, so an alias redirect would pass unnoticed",
  );
  assert.throws(
    () => assertNoUpstreamAliasRedirect(["@aoc-enterprise/runtime"]),
    /@aoc-enterprise\/runtime could redirect/,
    "a tsconfig alias onto @aoc-enterprise/runtime is accepted",
  );
  assert.throws(
    () => assertNoPrivateFronteraDependency(["next", "@aoc-enterprise/governed-authority"]),
    /must reach PMFreak only as a bundled dependency/,
    "a direct dependency on a Frontera internal is accepted, so the packaged boundary could be bypassed",
  );
  assert.throws(
    () => assertResolvedFromPackagedArtifact("@aoc/protocol", path.join(ROOT, "src/aoc/protocol/package.json"), nodeModulesRoot),
    /outside this checkout's node_modules/,
    "a resolution into repository-local source is accepted, so a local fallback would pass unnoticed",
  );
  assert.throws(
    () => assertResolvedFromPackagedArtifact("@aoc/protocol", path.join(nodeModulesRoot, "..", "src", "aoc", "protocol", "package.json"), nodeModulesRoot),
    /outside this checkout's node_modules/,
  );

  // and the guards must still accept the genuine tree, or they are merely broken.
  assertNoUpstreamAliasRedirect(["@/*"]);
  assertNoPrivateFronteraDependency(["next", "react"]);
  assertResolvedFromPackagedArtifact("@aoc/protocol", path.join(nodeModulesRoot, "@aoc/protocol/package.json"), nodeModulesRoot);
});
