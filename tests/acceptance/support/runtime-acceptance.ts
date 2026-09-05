/**
 * Shared production-runtime acceptance helpers.
 *
 * EXTRACTED, VERBATIM, from
 * `tests/acceptance/p0-launch-03-production-runtime-acceptance.test.ts` by
 * P0-LAUNCH-04. Not one line of behaviour was changed: the bodies below are the
 * same bytes P0-LAUNCH-03 was accepted with, and P0-LAUNCH-03 now imports them
 * from here instead of declaring them itself.
 *
 * WHY EXTRACT AT ALL. P0-LAUNCH-04 needs the same process lifecycle
 * (`startProductionServer`, `shutdownProductionServer`, the `/proc` evidence,
 * the residue ledger) and the same decision vocabulary
 * (`asGovernedAllow` / `asGovernedPolicyDenial` /
 * `asGovernedInfrastructureFailure`). Copying ~500 lines into a second
 * acceptance file would give the two gates two subtly diverging definitions of
 * "the production process came down cleanly", which is precisely the kind of
 * drift these gates exist to catch. One definition, two callers.
 *
 * The counters and the residue ledger are per-module-instance, and each gate
 * runs in its own process, so the two gates never share a ledger.
 *
 * Nothing in `src/` imports this file, and nothing here reads test state: every
 * function is either pure or parameterised by its caller.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = process.cwd();

// ───────── package-manager children: launched through THIS Node runtime ─────────

/**
 * The package.json that OWNS a file, found by walking up from it.
 *
 * Ownership is what makes the npm check below an identity check rather than a
 * guess: a path substring can be forged by any directory named `npm`, but the
 * nearest enclosing manifest is the package the file actually ships in.
 */
function owningPackage(file: string): { dir: string; manifest: Record<string, unknown> } | null {
  let dir = path.dirname(file);
  // Bounded by the filesystem root; `path.dirname("/") === "/"` terminates the walk.
  for (let depth = 0; depth < 64; depth += 1) {
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        return { dir, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown> };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The path a manifest declares for one of its bin entries, in either bin form. */
function declaredBin(manifest: Record<string, unknown>, binName: string): string | null {
  const bin = manifest.bin;
  if (typeof bin === "string") return manifest.name === binName ? bin : null;
  if (bin && typeof bin === "object") {
    const entry = (bin as Record<string, unknown>)[binName];
    return typeof entry === "string" ? entry : null;
  }
  return null;
}

/**
 * The npm CLI, as a path THIS Node runtime can execute directly.
 *
 * WHY NOT A BARE `"npm"`. On Windows npm is exposed as `npm.cmd`, a shell
 * launcher. Node's `spawn`/`execFile` family resolves the executable itself and
 * will not run a `.cmd` without a shell, so a bare package-manager name dies as
 * `spawnSync npm ENOENT` before any child exists. That is not a hypothesis: it is
 * how P0-LAUNCH-06 failed 27/27 in its `before()` hook, while Linux and WSL —
 * where `npm` is a shebang script Node can exec directly — never exposed it.
 *
 * The fix is to stop asking the OS to find "npm" at all. npm tells every lifecycle
 * script where its own CLI lives, in `npm_execpath`, and that CLI is a JavaScript
 * file. `node <npm-cli>` is the same program on every platform, needs no shell, and
 * therefore has no quoting surface at all: the path travels as one argv element, so
 * a directory with spaces in it is not a special case.
 *
 * WHY EXISTENCE AND A `.js` SUFFIX ARE NOT ENOUGH. `npm_execpath` is not npm's
 * private variable: pnpm and yarn populate it with THEIR own JavaScript CLI. A
 * pnpm `.cjs` therefore satisfies "present, JavaScript, exists" while this helper
 * — and every piece of evidence that cites it — claims execution is bound to npm.
 * So the identity is established POSITIVELY: resolve the real path, find the
 * package.json that owns it, require that package to be named `npm`, and require
 * the file to be the very entry that package declares as its `npm` bin. A
 * directory merely named `npm`, or an unrelated JavaScript CLI, satisfies none of
 * those.
 *
 * FAIL CLOSED. Every failure below throws with a named diagnostic. There is no
 * PATH fallback, no search for another installation, and no hard-coded install
 * directory: these gates are only ever entered through an npm script, so a value
 * that cannot be proven to be npm means the harness was launched in a way its
 * evidence has never been produced under.
 */
export function npmCliPath(): string {
  const execpath = process.env.npm_execpath;
  const refuse = (why: string) => {
    throw new Error(`${why} Refusing to guess at another npm installation.`);
  };
  if (!execpath) {
    refuse(
      "npm_execpath is not set, so the npm CLI cannot be launched through this Node runtime. " +
        "This gate must be started through an npm lifecycle script (for example `npm run check:beta-release-rehearsal`).",
    );
  }
  if (!/\.[cm]?js$/.test(execpath!)) {
    refuse(`npm_execpath (${execpath}) is not a JavaScript file, so this Node runtime cannot execute it directly.`);
  }
  if (!fs.existsSync(execpath!)) {
    refuse(`npm_execpath (${execpath}) does not exist.`);
  }

  const resolved = fs.realpathSync(execpath!);
  const owner = owningPackage(resolved);
  if (!owner) {
    refuse(`npm_execpath (${execpath}) has no owning package.json, so its identity as the npm CLI cannot be established.`);
  }
  if (owner!.manifest.name !== "npm") {
    refuse(
      `npm_execpath (${execpath}) belongs to package "${String(owner!.manifest.name)}", not npm. ` +
        "npm_execpath is also set by pnpm and yarn, and this harness binds its children to npm specifically.",
    );
  }
  const declared = declaredBin(owner!.manifest, "npm");
  if (!declared) {
    refuse(`the package owning npm_execpath (${execpath}) declares no \`npm\` bin entry, so the CLI entry cannot be identified.`);
  }
  const declaredPath = path.resolve(owner!.dir, declared!);
  if (!fs.existsSync(declaredPath) || fs.realpathSync(declaredPath) !== resolved) {
    refuse(
      `npm_execpath (${execpath}) is not the CLI entry its own package declares (${declaredPath}), ` +
        "so it cannot be attributed to npm.",
    );
  }
  return execpath!;
}

/**
 * npm prints a two-line LIFECYCLE BANNER before it runs a script:
 *
 *   > pmfreak@0.1.0 build
 *   > next build --help
 *
 * The second line is npm echoing the script's command STRING. It is emitted before
 * the script executable has proved anything at all, so any wrapper — or a no-op that
 * exits zero — produces it. An earlier revision of X1 accepted `/next build/` against
 * the raw output and could therefore be satisfied by that banner alone, which is the
 * opposite of what the control claims to prove.
 *
 * So the banner is REMOVED first, and what remains must carry a marker only Next's own
 * help implementation emits: its usage signature and a real options listing.
 */
export const NPM_BANNER_LINE = /^\s*>\s.*$/;
export const NEXT_BUILD_USAGE = /^Usage: next build \[directory\] \[options\]/m;
export const NEXT_HELP_OPTION_LINE = /^\s+-{1,2}[A-Za-z][\w-]*(?:,\s*--[\w-]+)?\s{2,}\S/m;

export function nextBuildHelpProof(raw: string): { ok: boolean; reason: string; body: string } {
  const body = raw
    .split("\n")
    .filter((line) => !NPM_BANNER_LINE.test(line))
    .join("\n")
    .trim();
  if (!NEXT_BUILD_USAGE.test(body)) {
    return { ok: false, reason: "no `next build` usage signature outside npm's lifecycle banner", body };
  }
  if (!NEXT_HELP_OPTION_LINE.test(body)) {
    return { ok: false, reason: "no options listing, so Next's help implementation did not run", body };
  }
  return { ok: true, reason: "Next's own `next build` help output was observed", body };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls a condition to a deadline. Returns whether it came true in time. */
export async function waitUntil(condition: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(intervalMs);
  }
  return condition();
}

/**
 * EVERY HTTP REQUEST THIS GATE MAKES IS BOUNDED.
 *
 * A bare `fetch` against a process that ACCEPTS the connection and then never
 * answers stays pending forever — a socket server that accepts and never writes
 * leaves it unsettled indefinitely, which is not a hypothesis about slow
 * machines but the observable behaviour of an unbounded request. That is
 * precisely the broken-startup shape the startup probe exists to DIAGNOSE, and
 * an unbounded probe there parks the `await` so the surrounding deadline is
 * never re-checked and the server is never killed: the gate hangs instead of
 * returning a failed `StartOutcome`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export function boundedFetch(url: string, init: RequestInit = {}, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

/** A one-line, non-secret description of why a request did not answer. */
export function describeRequestFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code ? `${error.name}: ${code}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * A cookie jar over fetch.
 *
 * The Founder session is a real Supabase SSR cookie pair written by
 * `POST /api/login`, not a bearer token this file could mint. Redirects are
 * manual so the Set-Cookie on the post-login redirect is not swallowed.
 */
export class HttpSession {
  private readonly cookies = new Map<string, string>();
  constructor(private baseUrl: string) {}

  rebind(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  async request(
    pathname: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; text: string; json: <T = unknown>() => T }> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await boundedFetch(`${this.baseUrl}${pathname}`, { ...init, headers, redirect: "manual" }, timeoutMs);
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, text, json: <T,>() => JSON.parse(text) as T };
  }

  get cookieNames(): string[] {
    return [...this.cookies.keys()].sort();
  }
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) return reject(new Error("no ephemeral port"));
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function portAcceptsConnections(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 2_000);
  });
}

// ─────────────────── /proc: which process, running which bytes ───────────────────
//
// Assertions about the running production process must target the process that
// actually serves HTTP, and must be able to say which files it loaded. On Linux
// /proc answers both. Where /proc is unavailable these assertions FAIL rather
// than skip — an environment that cannot produce the evidence must not be
// reported as having produced it.

export const PROC_AVAILABLE = fs.existsSync("/proc/self/stat");

export function requireProc(what: string): void {
  assert.ok(PROC_AVAILABLE, `${what} requires /proc (Linux). This environment cannot produce the evidence, so the claim is not made.`);
}

export function descendantPids(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // `comm` may contain spaces and parentheses; ppid is the field after the LAST ')'.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!Number.isFinite(ppid)) continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    } catch {
      /* the process exited while we were reading */
    }
  }
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Every process currently in process GROUP `pgid`.
 *
 * WHY GROUP MEMBERSHIP AND NOT DESCENT. `descendantPids` walks DOWN the parent
 * links, so the moment a root exits its children are re-parented to init and
 * become invisible to it — which is precisely the window a leaked build or
 * operator descendant lives in. A child started `detached` is a group LEADER
 * (pgid === pid), and everything it spawns inherits that group unless it calls
 * setsid, so the group still names the tree after the root is gone.
 *
 * Field 5 of /proc/<pid>/stat is pgrp; `comm` may contain spaces and
 * parentheses, so the fields are read after the LAST ')' exactly as
 * `descendantPids` does.
 */
export function processGroupPids(pgid: number): number[] {
  const out: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readProc(pid, "stat");
    if (stat === "") continue;
    if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pgid) out.push(pid);
  }
  return out;
}

export const readProc = (pid: number, file: string): string => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return "";
  }
};

export const cmdlineOf = (pid: number) => readProc(pid, "cmdline").replace(/\0/g, " ").trim();

export function environOf(pid: number): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of readProc(pid, "environ").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

/** Files mapped into the process's address space — native modules it actually dlopen'd. */
export function mappedFiles(pid: number): string[] {
  const out = new Set<string>();
  for (const line of readProc(pid, "maps").split("\n")) {
    const idx = line.indexOf("/");
    if (idx > 0) out.add(line.slice(idx).trim());
  }
  return [...out];
}

/**
 * The scheduler state of a process: `R`/`S`/`D` while it is still running, `Z`
 * once it has terminated and is waiting for its parent to collect it, and null
 * when the table entry is gone.
 *
 * The distinction is the whole of the reaping fix. A zombie is NOT a running
 * process — waiting for one to "die" waits for something only its parent can
 * do — but it is also not nothing: on a machine whose PID 1 does not reap
 * adopted children, a gate that signalled a process group and returned
 * immediately would accumulate table entries across runs while reporting zero
 * orphans. So the two are counted separately and both are reported.
 */
export function processState(pid: number): string | null {
  const stat = readProc(pid, "stat");
  if (stat === "") return null;
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
}

export const pidAlive = (pid: number) => {
  const state = processState(pid);
  return state !== null && state !== "Z";
};
export const pidUnreaped = (pid: number) => processState(pid) === "Z";
/**
 * Existence of a pid via signal 0, for platforms with no /proc.
 *
 * DELIBERATELY NOT A SUBSTITUTE FOR THE /proc CHECKS ABOVE. Signal 0 succeeds on a
 * ZOMBIE, so on Linux this cannot tell a terminated-but-uncollected process from a
 * running one — which is the whole distinction the residue ledger exists to make.
 * It is used only on Windows, where that distinction does not exist and where the
 * only question is whether the process is still in the table at all.
 */
export function pidExistsBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it EXISTS but belongs to someone else; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const runningPids = (pids: readonly number[]) => pids.filter(pidAlive);
export const unreapedPids = (pids: readonly number[]) => pids.filter(pidUnreaped);

/**
 * Process-table residue this gate could not account for, recorded as it is
 * observed and asserted empty by a control at the bottom of this file. A count
 * measured only around the graceful-shutdown test would say nothing about the
 * eight other production processes this gate starts.
 */
export const HARNESS_PROCESS_RESIDUE: { control: string; orphans: number[]; unreaped: number[] }[] = [];
export let PRODUCTION_PROCESSES_STARTED = 0;

/**
 * Kills a launcher's process GROUP and WAITS for it.
 *
 * `process.kill` only DELIVERS a signal. Sending SIGKILL and returning leaves
 * the launcher in state `Z` at the moment of return — observably, not in
 * theory — so a caller that checked for stragglers right afterwards would be
 * sampling a tree that had not finished coming down.
 */
export async function reapProcessGroup(
  launcherPid: number | undefined,
  hasExited: () => boolean,
  timeoutMs = 10_000,
): Promise<{ reaped: boolean; survivors: number[]; unreaped: number[] }> {
  if (!launcherPid) return { reaped: true, survivors: [], unreaped: [] };
  // Recorded BEFORE the signal: afterwards the tree is being dismantled, and a
  // descendant already re-parented can no longer be found by walking down.
  const recorded = [launcherPid, ...descendantPids(launcherPid)].filter((pid, index, all) => all.indexOf(pid) === index);

  try {
    process.kill(-launcherPid, "SIGKILL");
  } catch {
    /* already gone */
  }
  // Directly as well as by group: a descendant that left the group cannot be
  // reached by the group signal, and it is exactly the one that would survive.
  for (const pid of recorded) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  await waitUntil(() => hasExited() && runningPids(recorded).length === 0, timeoutMs);
  // Zombies clear only when their parent collects them, so wait briefly and
  // then REPORT rather than block for a budget that cannot help.
  await waitUntil(() => unreapedPids(recorded).length === 0, 2_000);

  const survivors = runningPids(recorded);
  return { reaped: hasExited() && survivors.length === 0, survivors, unreaped: unreapedPids(recorded) };
}

/**
 * The same reaping ladder as `reapProcessGroup`, keyed on the process GROUP id
 * rather than on a launcher this process still owns a handle to.
 *
 * `reapProcessGroup` records the tree by walking DOWN from a live launcher, which
 * is the right model for the server lifecycle, where the handle outlives the
 * shutdown. It cannot serve a bounded child that has already exited and left a
 * descendant behind: the descendant has been re-parented and is no longer
 * reachable by descent. The ladder itself is unchanged — record, signal the
 * group, signal each recorded pid individually because one that left the group
 * cannot be reached by the group signal, await, then REPORT running and
 * terminated-but-uncollected separately.
 */
export async function reapProcessGroupMembers(
  pgid: number,
  timeoutMs = 10_000,
): Promise<{ survivors: number[]; unreaped: number[] }> {
  // The union of BOTH relations, because neither alone is sufficient. Group membership
  // survives the root's death, which descent does not — but a descendant spawned
  // `detached` becomes its own group leader and LEAVES the group, so it is invisible to
  // the group query while it is still very much alive. Descent finds exactly that one,
  // provided the root has not been reaped yet, which on the timeout path it has not.
  const recorded = [...processGroupPids(pgid), ...descendantPids(pgid)]
    .filter((pid) => pid !== process.pid)
    .filter((pid, index, all) => all.indexOf(pid) === index);
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
  for (const pid of recorded) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await waitUntil(() => runningPids(recorded).length === 0, timeoutMs);
  await waitUntil(() => unreapedPids(recorded).length === 0, 2_000);
  return { survivors: runningPids(recorded), unreaped: unreapedPids(recorded) };
}

/**
 * A process IDENTITY, not merely a pid.
 *
 * Stabilization takes several /proc passes, and a pid freed between passes can be
 * handed to an unrelated new process. Field 22 of /proc/<pid>/stat is `starttime`,
 * the boot-relative instant the process began, so the pair (pid, starttime) does not
 * survive pid reuse: the recycled process has a different start time and is therefore
 * a different identity. Every decision below — "is this still the process I recorded",
 * "did the root survive the freeze", "is the tree gone" — is made on identity.
 */
export type ProcIdentity = { readonly pid: number; readonly starttime: string };

export function processIdentity(pid: number): ProcIdentity | null {
  const stat = readProc(pid, "stat");
  if (stat === "") return null;
  // `comm` may contain spaces and parentheses, so fields are read after the LAST ')'.
  // Index 19 there is stat field 22, `starttime`.
  const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return starttime === undefined ? null : { pid, starttime };
}

export const identityKey = (id: ProcIdentity): string => `${id.pid}:${id.starttime}`;

/** Whether the SAME process is still present — not merely something holding that pid. */
export function identityPresent(id: ProcIdentity): boolean {
  const now = processIdentity(id.pid);
  return now !== null && now.starttime === id.starttime;
}

const isStopped = (pid: number): boolean => {
  const state = processState(pid);
  return state === "T" || state === "t";
};

export type TreeStabilization = {
  /** Certification. TRUE only when every rule in the fixed-point contract held. */
  readonly stabilized: boolean;
  /** Certification. Every recorded identity was verified gone AFTER a proven freeze. */
  readonly reaped: boolean;
  readonly reason: string;
  readonly recorded: ProcIdentity[];
  readonly survivors: number[];
  readonly unreaped: number[];
  readonly passes: number;
  /** Whether best-effort cleanup ran because certification failed after a freeze began. */
  readonly fallbackCleanupAttempted: boolean;
  /**
   * Whether that fallback killed everything it KNEW about. Deliberately separate from
   * `reaped`: cleaning up the known processes says nothing about a process that escaped
   * observation, which is exactly why certification stays false either way.
   */
  readonly fallbackKnownProcessesReaped: boolean | null;
};

/**
 * FREEZE -> DISCOVER -> CONFIRM STOP -> FIXED POINT -> KILL -> VERIFY, for a timed-out tree.
 *
 * WHY A SNAPSHOT IS NOT ENOUGH. Reading group membership and descendants and killing what
 * was found loses to two races, both ending in the worst way — a live process with empty
 * `survivors`/`unreaped` and no residue, i.e. a false PASS:
 *
 *   A. the root exits BETWEEN the two walks, so a detached child is missing from one and
 *      already re-parented away from the other;
 *   B. a child detaches AFTER both walks but before the kill.
 *
 * Neither is fixed by scanning harder. SIGSTOP cannot be caught, blocked or ignored, so a
 * stopped process cannot fork, exit or call setsid. Freezing first creates a boundary that
 * discovery can then run against.
 *
 * WHY DISCOVERY ALONE IS STILL NOT ENOUGH. Discovering a process does not stop it. An
 * already-detached descendant can fork and exit in the interval between being SEEN and its
 * SIGSTOP taking effect; its grandchild is then re-parented outside both the root ancestry
 * and the original group, and two later passes happily agree on the reduced set.
 *
 * CONFIRMATION IS THEREFORE ABSOLUTE: every identity discovered in a pass must be observed
 * in state T. Nothing else settles it — not disappearance, and NOT a zombie.
 *
 * Two revisions of this rule were wrong before this one, both caught by measurement rather
 * than reasoning, and both in the same direction:
 *
 *   1. "gone" was treated as safe. It is not: the process may have forked before exiting.
 *   2. "terminated/zombie" was then treated as safe for a process ALREADY dead when first
 *      seen. It is not either. The freeze happens BEFORE the first discovery pass, so a
 *      detached descendant can fork and exit inside that pre-observation window and be a
 *      zombie the very first time it is seen — its parent is the frozen root, which cannot
 *      reap it. Exempting it let two passes agree on root-plus-zombie and certify while the
 *      grandchild ran.
 *
 * A zombie in this tree means something died after we started freezing, which is exactly
 * the case that cannot be cleared. On the timeout path a refusal costs nothing: the control
 * has already failed.
 *
 * FAIL CLOSED, AND NEVER LEAVE THE TREE FROZEN. Any failure after a freeze has begun runs
 * a best-effort cleanup over the root, the original group and every EVER-discovered
 * identity, then verifies it. That cleanup NEVER upgrades certification: `stabilized` and
 * `reaped` stay false and the original failure reason is retained, because the processes it
 * could clean up are by definition the ones it knew about.
 */
export async function stabilizeAndReapProcessTree(
  rootPid: number,
  options: {
    deadlineMs?: number;
    maxPasses?: number;
    verifyMs?: number;
    /** Test-only seam: runs between discovery and stop-confirmation. Unused in production. */
    afterDiscovery?: (identities: readonly ProcIdentity[], pass: number) => void | Promise<void>;
    /**
     * Test-only seam: runs after the initial group/root freeze and BEFORE the first
     * discovery pass. That window is real — the group signal cannot reach a descendant
     * that has detached into its own group, so it keeps running while the root is being
     * stopped — and it is the only way a descendant can be a ZOMBIE the first time it is
     * seen. Unused in production.
     */
    afterFreeze?: (rootIdentity: ProcIdentity) => void | Promise<void>;
  } = {},
): Promise<TreeStabilization> {
  const deadline = Date.now() + (options.deadlineMs ?? 15_000);
  const maxPasses = options.maxPasses ?? 25;
  const verifyMs = options.verifyMs ?? 10_000;

  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone, or not ours */
    }
  };
  const isStoppedOrDead = (pid: number) => isStopped(pid) || pidUnreaped(pid);

  // EVERY identity ever seen, so failure cleanup can reach a process that was discovered
  // once and then left the group or the ancestry.
  const everDiscovered = new Map<string, ProcIdentity>();
  /** Set once the root has been identified, so cleanup can check it by identity too. */
  let rootIdentityForCleanup: ProcIdentity | null = null;
  /** Identities positively observed in state T. Termination after this is not an escape. */
  const confirmedStopped = new Set<string>();
  let originalGroup: number[] = [];
  let freezeBegun = false;

  /** Best-effort termination of everything KNOWN, then verification. Never a certification. */
  const fallbackCleanup = async (): Promise<{ attempted: boolean; reaped: boolean; survivors: number[]; unreaped: number[] }> => {
    if (!freezeBegun) return { attempted: false, reaped: false, survivors: [], unreaped: [] };
    // IDENTITY, NOT PID. Flattening the ledger to bare pids here would undo the very
    // thing it exists for: stabilization can fail BECAUSE an identity disappeared, and
    // under process-table churn that pid may already belong to something unrelated —
    // which this would then SIGKILL, and afterwards count as residue. So a remembered
    // target is signalled only while its recorded starttime still matches.
    const known = [...everDiscovered.values()].filter((id) => id.pid > 1 && id.pid !== process.pid);
    const stillOurs = () => known.filter(identityPresent);
    // Group members are read FRESH, so their pids are current by construction and need
    // no identity check; the group signal covers whatever is still in it.
    const groupNow = () => processGroupPids(rootPid).filter((pid) => pid !== process.pid && pid > 1);

    // SIGKILL reaches a stopped process directly; SIGCONT is not a prerequisite, and
    // resuming first would hand a frozen process a window to fork before it dies.
    for (const id of stillOurs()) if (id.pid !== rootPid) signal(id.pid, "SIGKILL");
    for (const pid of groupNow()) if (pid !== rootPid) signal(pid, "SIGKILL");
    signal(-rootPid, "SIGKILL");
    // `freezeBegun` implies the root was identified, so this is always an identity check.
    if (rootIdentityForCleanup && identityPresent(rootIdentityForCleanup)) signal(rootPid, "SIGKILL");

    await waitUntil(() => stillOurs().every((id) => !pidAlive(id.pid)) && groupNow().length === 0, verifyMs, 25);
    await waitUntil(() => stillOurs().every((id) => !pidUnreaped(id.pid)), 2_000, 25);
    const survivors = [...new Set([...stillOurs().filter((id) => pidAlive(id.pid)).map((id) => id.pid), ...groupNow().filter(pidAlive)])];
    const unreaped = stillOurs().filter((id) => pidUnreaped(id.pid)).map((id) => id.pid);
    return { attempted: true, reaped: survivors.length === 0 && unreaped.length === 0, survivors, unreaped };
  };

  const failed = async (reason: string, recorded: ProcIdentity[], passes: number): Promise<TreeStabilization> => {
    const fallback = await fallbackCleanup();
    return {
      stabilized: false,
      reaped: false,
      // The ORIGINAL failure is retained even when cleanup succeeded: a process that
      // escaped observation cannot be cleaned up by definition.
      reason: fallback.attempted
        ? `${reason} [fallback cleanup ${fallback.reaped ? "reaped every KNOWN process" : `left ${fallback.survivors.length} survivor(s), ${fallback.unreaped.length} uncollected`}]`
        : reason,
      recorded,
      survivors: fallback.attempted ? fallback.survivors : recorded.filter((id) => identityPresent(id) && pidAlive(id.pid)).map((id) => id.pid),
      unreaped: fallback.attempted ? fallback.unreaped : recorded.filter((id) => identityPresent(id) && pidUnreaped(id.pid)).map((id) => id.pid),
      passes,
      fallbackCleanupAttempted: fallback.attempted,
      fallbackKnownProcessesReaped: fallback.attempted ? fallback.reaped : null,
    };
  };

  // Freezing our own process group would freeze this gate. A detached child is its own
  // group leader, so this can only be reached by misuse — refuse it explicitly.
  if (rootPid <= 1 || rootPid === process.pid || processGroupPids(rootPid).includes(process.pid)) {
    return await failed(`refusing to stabilize process group ${rootPid}: it would include this gate`, [], 0);
  }

  // 1/2. The root must be provably present BEFORE anything is frozen. `state.exit`
  //      being null is not proof: Node may simply not have delivered the event yet.
  const rootIdentity = processIdentity(rootPid);
  if (rootIdentity === null || !pidAlive(rootPid)) {
    return await failed("timeout_root_disappeared_before_tree_stabilization", [], 0);
  }
  rootIdentityForCleanup = rootIdentity;

  // 3. Freeze the group, then the root itself.
  originalGroup = processGroupPids(rootPid).filter((pid) => pid !== process.pid && pid > 1);
  freezeBegun = true;
  signal(-rootPid, "SIGSTOP");
  signal(rootPid, "SIGSTOP");
  everDiscovered.set(identityKey(rootIdentity), rootIdentity);
  await sleep(10); // let the root's own stop land before the first discovery pass
  if (isStopped(rootPid)) confirmedStopped.add(identityKey(rootIdentity));
  if (options.afterFreeze) await options.afterFreeze(rootIdentity);

  // 4/5/6. Discover -> stop -> CONFIRM -> repeat, until two consecutive passes agree.
  let previousKeys: string | null = null;
  let recorded: ProcIdentity[] = [];
  let passes = 0;
  let stabilized = false;
  while (passes < maxPasses && Date.now() < deadline) {
    passes += 1;
    const discovered = [rootPid, ...processGroupPids(rootPid), ...descendantPids(rootPid)]
      .filter((pid) => pid > 1 && pid !== process.pid)
      .filter((pid, index, all) => all.indexOf(pid) === index);
    const identities = discovered
      .map((pid) => processIdentity(pid))
      .filter((id): id is ProcIdentity => id !== null);
    for (const id of identities) everDiscovered.set(identityKey(id), id);

    // The seam fires HERE — after the identities have been read from /proc but before
    // any of them is stopped. That is the real window the finding is about: a process
    // that has been SEEN but whose SIGSTOP has not yet taken effect can still fork and
    // exit. A hook placed after the stops could not model it, because a stopped process
    // cannot act at all.
    if (options.afterDiscovery) await options.afterDiscovery(identities, passes);

    // Anything not already non-executable is stopped — including a descendant that has
    // detached into its own process group, which the group signal cannot reach.
    for (const id of identities) if (!isStoppedOrDead(id.pid)) signal(id.pid, "SIGSTOP");
    await sleep(25); // let the stops land before re-reading /proc

    // CONFIRMATION. An identity that was RUNNING when discovered must now be present and
    // STOPPED. Anything else — gone, or terminated — is an unobservable escape risk:
    //
    //   MEASURED, not theorised. A detached child released in this window forked a
    //   grandchild and exited. It did not vanish from /proc: its parent is the frozen
    //   root, which cannot reap it, so it became a ZOMBIE. Treating "zombie" as an
    //   acceptable terminal state therefore let two passes agree on an unchanged
    //   identity set and certify the tree while the grandchild — re-parented outside
    //   both the root ancestry and every group we can walk — was still running.
    //
    // So termination only settles a process that was ALREADY non-executable when first
    // seen. A running process must be caught stopped; if it died first, it may have
    // forked first, and certification fails.
    for (const id of identities) {
      const key = identityKey(id);
      const present = identityPresent(id);
      if (present && isStopped(id.pid)) {
        confirmedStopped.add(key);
        continue;
      }
      if (confirmedStopped.has(key)) continue; // already proven frozen on an earlier pass
      return await failed(
        `discovered_identity_vanished_before_confirmed_stop:${id.pid}:${id.starttime}` +
          ` (state ${present ? (pidUnreaped(id.pid) ? "terminated-unreaped" : String(processState(id.pid))) : "absent"})`,
        identities.filter(identityPresent),
        passes,
      );
    }

    const keys = identities.map(identityKey).sort().join(",");
    const everythingStopped = identities.every((id) => isStoppedOrDead(id.pid));
    const rootHeld = identityPresent(rootIdentity) && isStopped(rootPid);
    recorded = identities;

    if (!rootHeld) {
      return await failed("timeout_root_disappeared_before_tree_stabilization", recorded, passes);
    }
    if (keys === previousKeys && everythingStopped) {
      stabilized = true;
      break;
    }
    previousKeys = everythingStopped ? keys : null;
  }
  if (!stabilized) {
    return await failed(`the process tree did not reach a stable fixed point in ${passes} pass(es)`, recorded, passes);
  }

  // 7/8. Only now destroy it. Descendants first, so the stabilized identity set is
  //      still intact while every target is signalled; the group and root go last.
  for (const id of recorded) if (id.pid !== rootPid) signal(id.pid, "SIGKILL");
  signal(-rootPid, "SIGKILL");
  signal(rootPid, "SIGKILL");

  // 9. Verify by IDENTITY, not by pid.
  await waitUntil(() => recorded.every((id) => !identityPresent(id) || !pidAlive(id.pid)), verifyMs, 25);
  await waitUntil(() => recorded.every((id) => !identityPresent(id) || !pidUnreaped(id.pid)), 2_000, 25);

  const survivors = recorded.filter((id) => identityPresent(id) && pidAlive(id.pid)).map((id) => id.pid);
  const unreaped = recorded.filter((id) => identityPresent(id) && pidUnreaped(id.pid)).map((id) => id.pid);
  const groupRemnant = processGroupPids(rootPid).filter((pid) => pid !== process.pid && pidAlive(pid));
  const rootGone = !identityPresent(rootIdentity) || !pidAlive(rootPid);
  const reaped = survivors.length === 0 && unreaped.length === 0 && groupRemnant.length === 0 && rootGone;

  if (!reaped) {
    return await failed(
      `stabilized in ${passes} pass(es) but ${survivors.length} survivor(s), ${unreaped.length} uncollected, ` +
        `${groupRemnant.length} group remnant(s), root ${rootGone ? "gone" : "still present"}`,
      recorded,
      passes,
    );
  }

  return {
    stabilized: true,
    reaped: true,
    reason: `stabilized in ${passes} pass(es) over ${recorded.length} process(es); every recorded identity is gone`,
    recorded,
    survivors: [],
    unreaped: [],
    passes,
    fallbackCleanupAttempted: false,
    fallbackKnownProcessesReaped: null,
  };
}

/**
 * Terminates a process AND ITS DESCENDANTS on Windows.
 *
 * WHY THIS EXISTS. There is no process group to signal on Windows and no /proc to
 * enumerate, so the POSIX path below cannot run there. Killing only the direct
 * ChildProcess handle would leave exactly the tree the original finding was about:
 *
 *   node <npm-cli>  ->  npm  ->  the script launcher  ->  next / tsx
 *
 * `taskkill /T` is the documented native mechanism: it terminates the named process
 * and the child processes started by it. `/F` forces it.
 *
 * NO SHELL. taskkill is executed directly, with the pid as its own argv element —
 * never through `cmd.exe /c`, never through PowerShell, never string-concatenated.
 * That is the same shell-free invariant the npm launch path was introduced to
 * establish, and it must not be given back on the cleanup path.
 *
 * NOT RECURSIVE. This deliberately does not go through `runBoundedChild`: cleanup
 * for a bounded child cannot itself depend on the bounded-child machinery. It gets
 * its own small deadline instead.
 *
 * `executable` exists so the failure paths can be exercised by a regression; it is
 * not used by production callers.
 */
export async function windowsTreeKill(
  pid: number,
  options: { timeoutMs?: number; executable?: string } = {},
): Promise<{ ok: boolean; reason: string; exit: number | null; output: string }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const fallback = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
  const executable = options.executable ?? (systemRoot && fs.existsSync(fallback) ? fallback : "taskkill.exe");

  return await new Promise((resolve) => {
    let settled = false;
    let output = "";
    const finish = (result: { ok: boolean; reason: string; exit: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output });
    };

    let child: ChildProcess;
    try {
      child = spawn(executable, ["/PID", String(pid), "/T", "/F"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: `taskkill could not be started: ${String(error)}`, exit: null, output: "" });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: `taskkill did not complete within ${timeoutMs}ms`, exit: null });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    // A launch failure is a CLEANUP FAILURE, never a silent success.
    child.on("error", (error) => finish({ ok: false, reason: `taskkill could not be started: ${String(error)}`, exit: null }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, reason: "taskkill /T /F reported success", exit: code }
          : { ok: false, reason: `taskkill exited ${code}: ${output.trim().slice(0, 200)}`, exit: code },
      ),
    );
  });
}

export type BoundedChildOutcome = {
  readonly label: string;
  readonly rootPid: number | null;
  readonly exit: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly launchError: string | null;
  readonly durationMs: number;
  /**
   * WHAT WAS ACTUALLY ESTABLISHED about this child's process tree — named, never
   * inferred from empty arrays.
   *
   * The distinction exists because a TIMEOUT and a CLEAN EXIT can support very
   * different claims, and conflating them is how empty `survivors`/`unreaped`
   * defaults came to be read as "tree reaped clean":
   *
   *   timeout-stabilized-linux-proc  the tree was frozen, discovered to a fixed
   *                                  point, killed and verified gone by identity.
   *                                  This is the only whole-tree claim.
   *   timeout-verified-windows-taskkill
   *                                  the tree was TERMINATED by `taskkill /T /F`
   *                                  and the root verified gone. Termination is
   *                                  not observation: no enumeration happened.
   *   clean-exit-process-group-only  the root exited normally; the remaining
   *                                  members of its original process group were
   *                                  inspected and cleaned. A descendant that had
   *                                  already detached is OUTSIDE this claim.
   *   clean-exit-unsupervised        the root exited normally on a platform with
   *                                  no tree observation at all. Nothing is claimed.
   *   launch-failed                  no child existed.
   *   cleanup-failed                 cleanup was attempted and did not succeed.
   */
  readonly treeEvidence:
    | "timeout-stabilized-linux-proc"
    | "timeout-verified-windows-taskkill"
    | "clean-exit-process-group-only"
    | "clean-exit-unsupervised"
    | "launch-failed"
    | "cleanup-failed";
  /**
   * TRUE ONLY when the whole tree was frozen, enumerated to a fixed point, killed
   * and verified — which today means a Linux timeout and nothing else. A clean exit
   * never sets it, because after the root is gone a detached descendant is not
   * reachable by any relation this gate has.
   */
  readonly wholeTreeVerified: boolean;
  /** Timeout path only: whether the tree reached a proven fixed point before the kill. */
  readonly timeoutTreeStabilized: boolean | null;
  /** Timeout path only: whether every recorded identity was then verified gone. */
  readonly timeoutTreeReaped: boolean | null;
  /** Whether failed certification triggered best-effort cleanup of everything KNOWN. */
  readonly fallbackCleanupAttempted: boolean;
  /** Whether that fallback succeeded. NEVER upgrades certification; reported apart. */
  readonly fallbackKnownProcessesReaped: boolean | null;
  /** Windows only: whether `taskkill /T /F` succeeded AND the root is verifiably gone. */
  readonly windowsTreeKill: "SUCCESS" | "FAILED" | null;
  /** Non-null when cleanup itself failed. A caller must fail closed on this. */
  readonly cleanupError: string | null;
  /** Processes KNOWN to have survived. Emptiness is not proof; read `treeEvidence`. */
  readonly survivors: number[];
  readonly unreaped: number[];
};

/**
 * Runs one child to a deadline and accounts for its whole process TREE.
 *
 * WHY THIS EXISTS. The synchronous form this replaces —
 * a synchronous `execFileSync` call with a `timeout` option — bounds only the direct child.
 * On timeout Node signals THAT process and returns, so npm's `sh -c`, and the
 * `next` or `tsx` process under it, can outlive the call. The caller then sees a
 * tidy non-zero result while a build is still compiling, or while an operator
 * command is still mutating the fixture the very next case reads. Worse, nothing
 * recorded it: those survivors appear in no ledger, so the gate's "zero residue"
 * claim covered a tree it had never looked at.
 *
 * So the child is started `detached`, making it a process-group LEADER, and the
 * GROUP is what gets accounted for — on the timeout path AND on the normal-exit
 * path, because a child can exit zero and still leave a descendant running.
 * Anything still alive after reaping is recorded in `HARNESS_PROCESS_RESIDUE`
 * under this child's label, so it is asserted by the same control that already
 * asserts the server lifecycle left nothing behind.
 *
 * The invocation model is unchanged and stays shell-free: `command` is executed
 * directly, never through a shell, so the Windows `.cmd` dependency this launch
 * path was introduced to remove is not reintroduced here.
 *
 * WHAT IS CLAIMED IS NAMED. `treeEvidence` says which mechanism ran and therefore
 * what was established; `wholeTreeVerified` is true for exactly one of them, the
 * stabilized Linux timeout. Emptiness of `survivors`/`unreaped` is NEVER evidence on
 * its own — an undiscovered process produces exactly the same empty arrays, which is
 * how a clean exit came to be described as "tree reaped clean".
 *
 * WHERE /proc IS UNAVAILABLE the tree cannot be enumerated. On a Windows TIMEOUT it
 * is still TERMINATED, by `taskkill /T /F`, and the root verified gone — but that is
 * `timeout-verified-windows-taskkill`, not whole-tree verification, because nothing
 * was enumerated. Authoritative process evidence remains Linux-only.
 *
 * KNOWN LIMIT, stated rather than implied: a descendant that both detaches into its
 * own process group AND outlives a root that exited CLEANLY is reachable by neither
 * relation — the group no longer contains it and the parent link is gone. That case
 * is reported as `clean-exit-process-group-only`, which does not claim to cover it.
 * The TIMEOUT path has no such gap: the root is frozen alive, so it stays
 * parent-reachable while the tree is discovered. Closing the clean-exit case would
 * need a supervising job object or cgroup, a subsystem this gate does not have.
 */
export async function runBoundedChild(options: {
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer?: number;
  /** Test-only: exercise the Windows cleanup failure paths. Unused in production. */
  taskkillExecutable?: string;
}): Promise<BoundedChildOutcome> {
  const { label, command, args, cwd, timeoutMs } = options;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  const startedAt = Date.now();

  const child = spawn(command, [...args], {
    cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const rootPid = child.pid ?? null;

  const state: {
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    closed: boolean;
    error: Error | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
  } = { exit: null, closed: false, error: null, stdout: "", stderr: "", truncated: false };

  // Bounded accumulation. `execFileSync`'s maxBuffer KILLS the child on overflow;
  // capping and flagging instead keeps the diagnostic that explains the overflow.
  const collect = (stream: "stdout" | "stderr") => (chunk: unknown) => {
    const text = String(chunk);
    const room = maxBuffer - state[stream].length;
    if (text.length > room) {
      state.truncated = true;
      state[stream] += text.slice(0, Math.max(0, room));
      return;
    }
    state[stream] += text;
  };
  child.stdout?.on("data", collect("stdout"));
  child.stderr?.on("data", collect("stderr"));
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  child.on("close", () => {
    state.closed = true;
  });
  // A launch failure (ENOENT, EACCES) must end the wait immediately rather than
  // burn the whole deadline on a child that never existed.
  child.on("error", (error) => {
    state.error = error;
  });

  await waitUntil(() => state.exit !== null || state.error !== null, timeoutMs, 25);
  const timedOut = state.exit === null && state.error === null;
  // Give the pipes a moment to flush AFTER exit. If `close` never arrives, a
  // descendant is still holding the inherited stdio open — which the group check
  // below is exactly what catches.
  if (!timedOut) await waitUntil(() => state.closed, 2_000, 25);

  let treeEvidence: BoundedChildOutcome["treeEvidence"] = "clean-exit-unsupervised";
  let timeoutTreeStabilized: boolean | null = null;
  let timeoutTreeReaped: boolean | null = null;
  let windowsTreeKillResult: BoundedChildOutcome["windowsTreeKill"] = null;
  let fallbackCleanupAttempted = false;
  let fallbackKnownProcessesReaped: boolean | null = null;
  let cleanupError: string | null = null;
  let survivors: number[] = [];
  let unreaped: number[] = [];

  if (rootPid === null || state.error !== null) {
    treeEvidence = "launch-failed";
  } else if (timedOut && PROC_AVAILABLE) {
    // ── Linux TIMEOUT: the authoritative model. Freeze, discover to a fixed point,
    //    kill, verify by identity. Nothing here is inferred from an empty array.
    const stabilization = await stabilizeAndReapProcessTree(rootPid);
    timeoutTreeStabilized = stabilization.stabilized;
    timeoutTreeReaped = stabilization.reaped;
    survivors = stabilization.survivors;
    unreaped = stabilization.unreaped;
    fallbackCleanupAttempted = stabilization.fallbackCleanupAttempted;
    fallbackKnownProcessesReaped = stabilization.fallbackKnownProcessesReaped;
    if (stabilization.stabilized && stabilization.reaped) {
      treeEvidence = "timeout-stabilized-linux-proc";
    } else {
      // Certification failed. Fallback cleanup may well have killed everything KNOWN —
      // that is reported separately and NEVER upgrades this, because a process that
      // escaped observation is precisely the one cleanup could not target.
      treeEvidence = "cleanup-failed";
      cleanupError = stabilization.reason;
      HARNESS_PROCESS_RESIDUE.push({ control: `${label} [timeout tree cleanup: ${cleanupError}]`, orphans: survivors, unreaped });
    }
  } else if (!timedOut && PROC_AVAILABLE) {
    // ── Linux CLEAN EXIT. The root is gone, so descent reaches nothing and this
    //    CANNOT be a whole-tree claim. What remains observable is the original
    //    process GROUP, so leftovers there are cleaned up and reported — and a
    //    descendant that detached before the root exited is outside the claim.
    treeEvidence = "clean-exit-process-group-only";
    const leftovers = processGroupPids(rootPid).filter((pid) => pid !== process.pid);
    if (leftovers.length > 0) {
      const reaping = await reapProcessGroupMembers(rootPid);
      survivors = reaping.survivors;
      unreaped = reaping.unreaped;
      if (survivors.length > 0 || unreaped.length > 0) {
        treeEvidence = "cleanup-failed";
        cleanupError = `a clean exit left ${survivors.length} running and ${unreaped.length} uncollected process-group member(s)`;
        HARNESS_PROCESS_RESIDUE.push({ control: `${label} [${cleanupError}]`, orphans: survivors, unreaped });
      }
    }
  } else if (timedOut && process.platform === "win32") {
    // ── Windows: no group to signal and no /proc to enumerate, so terminate the
    //    tree with the documented native mechanism and then VERIFY the root is gone.
    //    Cleanup is never called clean on taskkill's own say-so.
    treeEvidence = "timeout-verified-windows-taskkill";
    const killed = await windowsTreeKill(rootPid, { executable: options.taskkillExecutable });
    const rootGone = !pidExistsBySignal(rootPid);
    if (killed.ok && rootGone) {
      windowsTreeKillResult = "SUCCESS";
    } else {
      windowsTreeKillResult = "FAILED";
      treeEvidence = "cleanup-failed";
      cleanupError = killed.ok
        ? `taskkill reported success but the root process ${rootPid} is still present`
        : killed.reason;
      survivors = rootGone ? [] : [rootPid];
      // Recorded in the SAME ledger the rehearsal's final control asserts empty, so a
      // Windows cleanup failure cannot coexist with a passing battery.
      HARNESS_PROCESS_RESIDUE.push({ control: `${label} [windows tree cleanup: ${cleanupError}]`, orphans: survivors, unreaped: [] });
    }
  } else if (timedOut) {
    // Neither /proc nor Windows: the child must still not be left running, but the
    // tree cannot be accounted for, and that is reported rather than assumed away.
    treeEvidence = "cleanup-failed";
    cleanupError = `no process-tree cleanup mechanism is available on ${process.platform}; only the direct child was signalled`;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    HARNESS_PROCESS_RESIDUE.push({ control: `${label} [${cleanupError}]`, orphans: [], unreaped: [] });
  }

  return {
    label,
    rootPid,
    exit: state.exit?.code ?? null,
    signal: state.exit?.signal ?? null,
    stdout: state.stdout,
    stderr: state.stderr,
    truncated: state.truncated,
    timedOut,
    launchError: state.error === null ? null : String(state.error),
    durationMs: Date.now() - startedAt,
    treeEvidence,
    // The ONLY whole-tree claim this gate makes. Deliberately not a function of the
    // survivor arrays: empty arrays are what a missed process looks like.
    wholeTreeVerified: treeEvidence === "timeout-stabilized-linux-proc",
    timeoutTreeStabilized,
    timeoutTreeReaped,
    fallbackCleanupAttempted,
    fallbackKnownProcessesReaped,
    windowsTreeKill: windowsTreeKillResult,
    cleanupError,
    survivors,
    unreaped,
  };
}

// ───────────────────────────── server lifecycle ─────────────────────────────

export type ServerHandle = {
  readonly launcherPid: number;
  readonly serverPid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly child: ChildProcess;
  readonly healthyAfterMs: number;
  log(): string;
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null;
};

export type FailedStart = {
  readonly started: false;
  readonly reason: string;
  readonly log: string;
  readonly launcherPid: number | null;
  readonly reaped: boolean;
  readonly survivors: number[];
};

export type StartOutcome = { readonly started: true; readonly handle: ServerHandle } | FailedStart;

/**
 * Starts PMFreak through its SUPPORTED production entrypoint: `npm run start`,
 * which is `next start`. Never `next dev`.
 *
 * `detached: true` puts the launcher and the server it spawns in their own
 * process group, so shutdown can signal the GROUP — which is what a container
 * runtime or a process supervisor does, and the only way to observe whether a
 * child is left orphaned.
 */
export async function startProductionServer(options: {
  port: number;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * The npm script that starts the server. Defaults to `start`, which is what
   * every caller before P0-LAUNCH-05 used and what they all still get.
   *
   * It exists so a gate can exercise a DIFFERENT supported entrypoint —
   * `start:closed-free-beta`, which runs the beta preflight before
   * `next start` — through this one lifecycle rather than growing a second.
   * Process spawning, the health-probe deadline, server-pid discovery,
   * shutdown and the residue ledger are shared, so evidence about a beta
   * process is produced by exactly the same machinery that produced every
   * predecessor's, and a failed beta start is reaped and counted identically.
   */
  script?: string;
}): Promise<StartOutcome> {
  const { port, env } = options;
  const script = options.script ?? "start";
  const timeoutMs = options.timeoutMs ?? 180_000;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Launched as `node <npm-cli> run <script>` rather than by the bare name `npm`,
  // so the child exists on Windows too; see `npmCliPath`. On POSIX this is the same
  // process the bare name already resolved to — npm's own shebang script — so the
  // process tree, the group, the pids and every piece of evidence below are unchanged.
  const child = spawn(process.execPath, [npmCliPath(), "run", script, "--", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let log = "";
  const collect = (chunk: unknown) => {
    log += String(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const state: { exit: { code: number | null; signal: NodeJS.Signals | null } | null } = { exit: null };
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });

  PRODUCTION_PROCESSES_STARTED += 1;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let healthy = false;
  let lastProbe = "no probe was attempted before the deadline expired";
  while (!state.exit) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // Bounded by the SMALLER of the per-probe budget and what is left of the
      // startup deadline, so one request can never outlive the deadline it is
      // supposed to be checked against. A process that accepts the connection
      // and never answers is the case this exists for: it now fails the probe
      // and the loop returns to the deadline, instead of parking here forever.
      const response = await boundedFetch(`${baseUrl}/api/health`, {}, Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining));
      const body = await response.text();
      if (response.ok) {
        healthy = true;
        break;
      }
      lastProbe = `/api/health answered ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      lastProbe = describeRequestFailure(error);
    }
    await sleep(Math.max(0, Math.min(400, deadline - Date.now())));
  }

  if (!healthy) {
    // WHY THE EXIT STATUS IS READ BEFORE THE SHUTDOWN. Whether the process died
    // on its own or was still running when the deadline expired is decided by
    // the state at THIS point. Reading it after the shutdown below — which now
    // awaits the exit rather than signalling and returning — would report the
    // SIGKILL this helper itself just sent, and every failed start would be
    // described as "the process exited (signal SIGKILL)" no matter why it
    // failed. That is not hypothetical: it is what this returned before the
    // zero-deadline control caught it.
    const exitedOnItsOwn = state.exit;
    const reaping = await reapProcessGroup(child.pid, () => state.exit !== null);
    return {
      started: false,
      log,
      launcherPid: child.pid ?? null,
      reaped: reaping.reaped,
      survivors: reaping.survivors,
      reason: exitedOnItsOwn
        ? `the process exited (code ${exitedOnItsOwn.code}, signal ${exitedOnItsOwn.signal}) before it became healthy`
        : `the process never became healthy within ${timeoutMs}ms (last probe: ${lastProbe})`,
    };
  }

  const launcherPid = child.pid!;
  // The supported command is an npm script, so the process tree is
  //   node <npm-cli>  ->  sh -c "[preflight &&] next start --port N"  ->  next-server (vX.Y.Z)
  // For `start:closed-free-beta` the preflight has already exited by the time
  // this runs — it is awaited by the `&&` before `next start` is reached, and
  // this line is only reached once /api/health has answered.
  // Claims about which bytes are executing must name the server, not npm and
  // not the shell in between — both of those load none of the application.
  const descendants = descendantPids(launcherPid);
  const serverPid =
    descendants.filter((pid) => /next/.test(cmdlineOf(pid)) && !/^(\/bin\/)?sh /.test(cmdlineOf(pid))).pop() ?? launcherPid;

  return {
    started: true,
    handle: {
      launcherPid,
      serverPid,
      port,
      baseUrl,
      child,
      healthyAfterMs: Date.now() - startedAt,
      log: () => log,
      exitStatus: () => state.exit,
    },
  };
}

export type ShutdownOutcome = {
  readonly exitedAfterMs: number | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly escalated: boolean;
  readonly orphans: number[];
  readonly unreaped: number[];
};

/**
 * Stops the process GROUP the way a supervisor or `docker stop` would — and
 * then WAITS for the tree to come down.
 *
 * EVERY production process this gate starts is stopped through this one path,
 * the fail-closed controls included. The previous arrangement had two: a
 * graceful stop used by one test, and a fire-and-forget SIGKILL used by the
 * five controls and the final hook, which signalled the group and returned
 * before anything had exited. Only the first reported stragglers, so the
 * gate's "zero orphans" covered a single shutdown out of nine.
 *
 * The ladder is: signal, await the handle this gate owns and the descendants it
 * recorded, escalate ONCE to SIGKILL if that did not take, then await reaping
 * and report whatever is left — running (`orphans`) and terminated-but-uncollected
 * (`unreaped`) counted apart.
 */
export async function shutdownProductionServer(
  handle: ServerHandle,
  options: { label: string; signal?: NodeJS.Signals; graceMs?: number; reapMs?: number },
): Promise<ShutdownOutcome> {
  const signal = options.signal ?? "SIGTERM";
  const graceMs = options.graceMs ?? 30_000;
  const reapMs = options.reapMs ?? 10_000;

  const recorded = [handle.serverPid, handle.launcherPid, ...descendantPids(handle.launcherPid)].filter(
    (pid, index, all) => all.indexOf(pid) === index,
  );

  const startedAt = Date.now();
  try {
    process.kill(-handle.launcherPid, signal);
  } catch {
    /* already dead */
  }

  // 1. Await the handle, and the descendants that are not this process's to await.
  await waitUntil(() => handle.exitStatus() !== null && runningPids(recorded).length === 0, graceMs);
  // Read BEFORE any escalation, so `exitedAfterMs` answers the question the
  // graceful-shutdown test actually asks: did the signal SENT stop it in time?
  const status = handle.exitStatus();
  const exitedAfterMs = status === null ? null : Date.now() - startedAt;

  // 2. Escalate exactly once, and only if graceful termination did not take. A
  //    shutdown that always escalated could not tell a clean stop from a hung one.
  let escalated = false;
  if (status === null || runningPids(recorded).length > 0) {
    escalated = true;
    await reapProcessGroup(handle.launcherPid, () => handle.exitStatus() !== null, reapMs);
  }

  // 3. Await reaping rather than sampling once.
  await waitUntil(() => runningPids(recorded).length === 0, reapMs);
  await waitUntil(() => unreapedPids(recorded).length === 0, 2_000);

  const outcome: ShutdownOutcome = {
    exitedAfterMs,
    code: status?.code ?? null,
    signal: status?.signal ?? null,
    escalated,
    orphans: runningPids(recorded),
    unreaped: unreapedPids(recorded),
  };
  if (outcome.orphans.length > 0 || outcome.unreaped.length > 0) {
    HARNESS_PROCESS_RESIDUE.push({ control: options.label, orphans: outcome.orphans, unreaped: outcome.unreaped });
  }
  return outcome;
}

// ───────────────────────── governed-operation helpers ─────────────────────────

export type GovernedResponse = { status: number; body: Record<string, unknown>; raw: string };

/**
 * The product's own decision vocabulary as it reaches an HTTP caller.
 *
 * The route deliberately withholds Frontera's reason codes from clients — they
 * are what an operator needs and precisely what an arbitrary caller should not
 * learn about another system's authority structure. What DOES cross the
 * boundary is the failure class, and that is the distinction this file needs:
 * `frontera_denied` is a policy answer, `frontera_unavailable` is an outage.
 */
export function asGovernedAllow(response: GovernedResponse, why: string): string {
  assert.ok([200, 201].includes(response.status), `${why} — expected 200/201, got ${response.status}: ${response.raw.slice(0, 300)}`);
  assert.notEqual(response.body.disposition, "denied", `${why} — the dispatch was denied: ${response.raw.slice(0, 300)}`);
  const decisionId = response.body.fronteraDecisionId;
  assert.equal(typeof decisionId, "string", `${why} — no fronteraDecisionId, so the Frontera boundary was not traversed: ${response.raw.slice(0, 300)}`);
  assert.ok(String(decisionId).length > 0, `${why} — the Frontera decision id is empty`);
  return String(decisionId);
}

/**
 * A POLICY denial, and nothing else.
 *
 * `allowed === false` is not enough and never was: an unreachable store, a
 * corrupt store and a kernel crash all produce `allowed === false` too. This
 * asserts the exact class, so an outage cannot be banked as governance working.
 */
export function asGovernedPolicyDenial(response: GovernedResponse, why: string): void {
  // A governed denial is answered 409 by the route's disposition ladder. It is
  // a MEANINGFUL domain answer, not a fault, so a 5xx here would itself be a
  // finding rather than a denial.
  assert.equal(response.status, 409, `${why} — expected a governed 409 denial, got ${response.status}: ${response.raw.slice(0, 300)}`);
  assert.equal(response.body.disposition, "denied", `${why} — the dispatch was not denied: ${response.raw.slice(0, 300)}`);
  assert.equal(
    response.body.failureClass,
    "frontera_denied",
    `${why} — the denial must come from EVALUATION, not from an outage. Got failureClass=${String(response.body.failureClass)}`,
  );
}

export function asGovernedInfrastructureFailure(response: GovernedResponse, why: string): void {
  assert.equal(response.status, 409, `${why} — expected a fail-closed 409, got ${response.status}: ${response.raw.slice(0, 300)}`);
  assert.equal(response.body.disposition, "denied", `${why} — expected a fail-closed denial: ${response.raw.slice(0, 300)}`);
  assert.equal(
    response.body.failureClass,
    "frontera_unavailable",
    `${why} — an unusable authority dependency must be reported as an outage, never as a policy answer and never as ALLOW. Got failureClass=${String(response.body.failureClass)}`,
  );
}

/**
 * How many production processes this module has started in this process.
 *
 * An accessor rather than a bare re-read of the exported binding, so a caller
 * can never accidentally capture the count at import time and report zero.
 */
export const productionProcessesStarted = (): number => PRODUCTION_PROCESSES_STARTED;
