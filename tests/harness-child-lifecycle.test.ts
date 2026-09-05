/**
 * Harness integrity regressions for the P0-LAUNCH-06 child-process lifecycle.
 *
 * These are UNIT-level and deliberately standalone: they need no build, no Supabase,
 * no server and no fixture, so the properties the rehearsal's evidence rests on can be
 * re-proved without consuming an authoritative battery execution.
 *
 * Three exact-head review findings are covered:
 *
 *   F1  X1 accepted `/next build/` against raw output, which npm's own lifecycle banner
 *       already emits before the script executable proves anything.
 *   F2  A synchronous `timeout` bounds only the direct child, so npm's shell and the
 *       `next`/`tsx` process under it could outlive the deadline unrecorded.
 *   F3  `npm_execpath` is also populated by pnpm and yarn, so "present, JavaScript,
 *       exists" did not establish that the CLI is npm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_PROCESS_RESIDUE,
  PROC_AVAILABLE,
  nextBuildHelpProof,
  npmCliPath,
  pidAlive,
  pidExistsBySignal,
  processGroupPids,
  processIdentity,
  identityPresent,
  runBoundedChild,
  stabilizeAndReapProcessTree,
  windowsTreeKill,
} from "./acceptance/support/runtime-acceptance";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "harness-child-lifecycle-"));

// ──────── F1 — npm's lifecycle banner is not proof that Next's binary ran ────────

test("F1. npm's lifecycle BANNER alone does not satisfy the `next build` proof", () => {
  // The exact bytes npm emits before it runs the script. The second line is npm
  // echoing the script's command string, so a wrapper or a no-op produces it too.
  const banner = ["", "> pmfreak@0.1.0 build", "> next build --help", ""].join("\n");
  const verdict = nextBuildHelpProof(banner);
  assert.equal(verdict.ok, false, "npm's lifecycle banner alone was accepted as proof Next ran");
  assert.equal(verdict.body, "", "the banner filter left npm's own output in the body");
  assert.match(verdict.reason, /usage signature/, `unexpected refusal reason: ${verdict.reason}`);

  // A banner plus arbitrary non-Next chatter is still not proof.
  const noisy = [banner, "build complete", "next build finished successfully"].join("\n");
  assert.equal(nextBuildHelpProof(noisy).ok, false, "prose merely mentioning `next build` was accepted as proof");

  // A usage line with NO options listing is not proof that help actually rendered.
  const usageOnly = [banner, "Usage: next build [directory] [options]"].join("\n");
  const usageVerdict = nextBuildHelpProof(usageOnly);
  assert.equal(usageVerdict.ok, false, "a bare usage line without an options listing was accepted");
  assert.match(usageVerdict.reason, /options listing/, `unexpected refusal reason: ${usageVerdict.reason}`);
});

test("F1. the real npm -> build script -> next build chain DOES satisfy the proof", async () => {
  // npm is deliberately NOT bypassed: the claim under test is the chain `before()`
  // uses, so the proof must travel through npm's own CLI exactly as the build does.
  const run = await runBoundedChild({
    label: "F1 regression: build-chain launch proof",
    command: process.execPath,
    args: [npmCliPath(), "run", "build", "--", "--help"],
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });
  assert.equal(run.launchError, null, `the build chain could not be launched: ${run.launchError}`);
  assert.equal(run.timedOut, false, "the build-chain launch proof timed out");
  assert.equal(run.exit, 0, `the build chain exited ${run.exit}: ${run.stderr.slice(0, 300)}`);

  const raw = `${run.stdout}\n${run.stderr}`;
  // The raw output DOES contain npm's banner — which is precisely why the old
  // assertion could pass without Next. The proof must survive removing it.
  assert.match(raw, /^\s*>\s.*next build/m, "npm's lifecycle banner was not present, so this is not the chain under test");
  const verdict = nextBuildHelpProof(raw);
  assert.ok(verdict.ok, `Next's own help output was not observed: ${verdict.reason}; body=${verdict.body.slice(0, 300)}`);
  assert.match(verdict.body, /^Usage: next build \[directory\] \[options\]/m, "the surviving body carries no Next usage signature");
});

// ─────────────────────────── F3 — npm CLI identity ───────────────────────────

/** Runs `body` with npm_execpath forced to `value`, always restoring the real one. */
function withExecpath<T>(value: string | undefined, body: () => T): T {
  const saved = process.env.npm_execpath;
  if (value === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = saved;
  }
}

const refusedBy = (value: string | undefined): string | null =>
  withExecpath(value, () => {
    try {
      npmCliPath();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });

test("F3. npmCliPath ACCEPTS the real npm lifecycle CLI this test is running under", () => {
  const resolved = npmCliPath();
  assert.equal(resolved, process.env.npm_execpath, "the accepted path is not the lifecycle value");
  assert.ok(fs.existsSync(resolved), "the accepted npm CLI does not exist");
  // Ownership, not a path substring: the manifest that ships the file must BE npm.
  let dir = path.dirname(fs.realpathSync(resolved));
  let manifest: { name?: string } | null = null;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      manifest = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
      break;
    }
    dir = path.dirname(dir);
  }
  assert.equal(manifest?.name, "npm", "the accepted CLI is not owned by the npm package");
});

test("F3. npmCliPath REFUSES every non-npm shape, and never falls back to PATH", () => {
  const dir = scratch();
  try {
    // A pnpm-style CLI: a real, existing `.cjs` owned by a package named `pnpm`.
    const pnpmDir = path.join(dir, "pnpm-install", "pnpm");
    fs.mkdirSync(path.join(pnpmDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pnpmDir, "package.json"), JSON.stringify({ name: "pnpm", version: "9.0.0", bin: { pnpm: "bin/pnpm.cjs" } }));
    const pnpmCli = path.join(pnpmDir, "bin", "pnpm.cjs");
    fs.writeFileSync(pnpmCli, "// pnpm\n");

    // An arbitrary JavaScript CLI with no package.json at all.
    const orphanCli = path.join(dir, "orphan-cli.js");
    fs.writeFileSync(orphanCli, "// not a package manager\n");

    // A package that LIES about its name but declares no npm bin entry.
    const spoofDir = path.join(dir, "spoof", "npm");
    fs.mkdirSync(path.join(spoofDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(spoofDir, "package.json"), JSON.stringify({ name: "npm", version: "0.0.0" }));
    const spoofCli = path.join(spoofDir, "bin", "npm-cli.js");
    fs.writeFileSync(spoofCli, "// claims to be npm, declares no bin\n");

    // A package named npm whose declared npm bin is a DIFFERENT file.
    const mismatchDir = path.join(dir, "mismatch", "npm");
    fs.mkdirSync(path.join(mismatchDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(mismatchDir, "package.json"), JSON.stringify({ name: "npm", version: "0.0.0", bin: { npm: "bin/real-cli.js" } }));
    fs.writeFileSync(path.join(mismatchDir, "bin", "real-cli.js"), "// the declared entry\n");
    const mismatchCli = path.join(mismatchDir, "bin", "impostor-cli.js");
    fs.writeFileSync(mismatchCli, "// not the declared entry\n");

    const cases: Array<[string, string | undefined, RegExp]> = [
      ["missing npm_execpath", undefined, /npm_execpath is not set/],
      ["a Windows .cmd launcher", "C:\\Program Files\\nodejs\\npm.cmd", /is not a JavaScript file/],
      ["a nonexistent JavaScript file", path.join(dir, "absent", "npm-cli.js"), /does not exist/],
      ["a pnpm CLI", pnpmCli, /belongs to package "pnpm", not npm/],
      ["an unowned JavaScript CLI", orphanCli, /no owning package\.json|belongs to package/],
      ["a package named npm with no npm bin", spoofCli, /declares no `npm` bin entry/],
      ["a package named npm whose bin is a different file", mismatchCli, /is not the CLI entry its own package declares/],
    ];

    for (const [label, value, expected] of cases) {
      const message = refusedBy(value);
      assert.ok(message, `${label} was ACCEPTED as the npm CLI`);
      assert.match(message, expected, `${label} was refused for the wrong reason: ${message}`);
      assert.match(message, /Refusing to guess at another npm installation\./, `${label} did not fail closed`);
    }

    // The real value still resolves afterwards: the probes restored the environment.
    assert.equal(npmCliPath(), process.env.npm_execpath, "the lifecycle npm_execpath was not restored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── F2 — a timed-out child must not leave descendants alive ─────────────

test("F2 (linux). a timed-out child's DESCENDANT is reaped, and residue is never silently omitted", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("the /proc group model is Linux-only; the Windows path is covered by its own case");
    return;
  }
  const dir = scratch();
  const residueBefore = HARNESS_PROCESS_RESIDUE.length;
  try {
    // A controlled parent that spawns a long-lived DESCENDANT and then outlives the
    // deadline itself. This is the exact shape a synchronous timeout mishandles: the
    // direct child is signalled, the grandchild keeps running.
    const marker = path.join(dir, "descendant.pid");
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        // The descendant sleeps far past any deadline this test uses.
        // `detached` is what makes this regression load-bearing. A plain descendant is
        // killed as a side effect of the root dying on both platforms (libuv places it
        // in the parent's job object on Windows; it stays in the root's process group on
        // Linux), so a plain child would pass even against direct-child-only cleanup.
        // A detached one escapes BOTH of those, and is exactly the shape a shell
        // launcher or a server process takes.
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });',
        "child.unref();",
        `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
        "setTimeout(() => {}, 600000);",
      ].join("\n"),
    );

    const run = await runBoundedChild({
      label: "F2 regression: parent with a long-lived descendant",
      command: process.execPath,
      args: [parent],
      cwd: dir,
      timeoutMs: 2_000,
    });

    assert.equal(run.timedOut, true, "the controlled child did not exceed its deadline");
    assert.equal(run.treeEvidence, "timeout-stabilized-linux-proc", `the stabilized path did not run: ${run.treeEvidence}`);
    assert.equal(run.timeoutTreeStabilized, true, "the tree did not reach a proven fixed point before the kill");
    assert.equal(run.timeoutTreeReaped, true, "the stabilized tree was not verified gone");
    assert.equal(run.wholeTreeVerified, true, "a stabilized Linux timeout must carry the whole-tree claim");
    assert.equal(run.fallbackCleanupAttempted, false, "a successful certification must not have needed fallback cleanup");
    assert.equal(run.cleanupError, null, `cleanup reported a failure: ${run.cleanupError}`);
    assert.ok(run.rootPid, "no root pid was recorded for the bounded child");

    const descendantPid = Number(fs.readFileSync(marker, "utf8").trim());
    assert.ok(Number.isFinite(descendantPid) && descendantPid > 0, "the controlled descendant never started");

    // THE FINDING. A direct-child-only timeout leaves this process running.
    assert.equal(
      pidAlive(descendantPid),
      false,
      `the descendant (${descendantPid}) survived the timeout; a bounded child must reap its whole tree`,
    );
    assert.equal(pidAlive(run.rootPid!), false, `the root (${run.rootPid}) survived the timeout`);
    assert.equal(processGroupPids(run.rootPid!).filter(pidAlive).length, 0, "the child's process group still has running members");

    // Reaped cleanly, so nothing was added to the ledger. The two facts are asserted
    // together: "no residue" is only meaningful alongside "the tree really is gone".
    assert.deepEqual(run.survivors, [], `survivors were reported: ${run.survivors.join(",")}`);
    assert.deepEqual(run.unreaped, [], `uncollected processes were reported: ${run.unreaped.join(",")}`);
    assert.equal(
      HARNESS_PROCESS_RESIDUE.length,
      residueBefore,
      "residue was recorded even though the tree was reaped; the ledger and the reaping disagree",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (linux). a clean exit reports PROCESS-GROUP-ONLY evidence, never a whole-tree claim", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("process-group inspection of a clean exit requires /proc");
    return;
  }
  const residueBefore = HARNESS_PROCESS_RESIDUE.length;
  const run = await runBoundedChild({
    label: "F2 regression: clean exit",
    command: process.execPath,
    args: ["-e", "process.stdout.write('done'); process.exit(3);"],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  assert.equal(run.timedOut, false, "a fast child was reported as timed out");
  assert.equal(run.exit, 3, `the child's real exit code was not preserved: ${run.exit}`);
  assert.equal(run.stdout, "done", `stdout was not captured: ${JSON.stringify(run.stdout)}`);
  assert.equal(run.treeEvidence, "clean-exit-process-group-only", `unexpected clean-exit classification: ${run.treeEvidence}`);
  assert.equal(run.wholeTreeVerified, false, "a clean exit must not claim whole-tree verification");
  assert.equal(run.timeoutTreeStabilized, null, "a clean exit must not report timeout stabilization");
  assert.deepEqual(run.survivors, [], "a clean exit reported KNOWN survivors");
  assert.equal(HARNESS_PROCESS_RESIDUE.length, residueBefore, "a clean exit recorded residue");
});


// ───── F2 (windows) — a timeout must not leave the npm/next/tsx descendant alive ─────
//
// There is no process group to signal and no /proc to enumerate on Windows, so the
// Linux model above cannot run there and its absence must not degrade to killing the
// direct child only — which is the exact tree the original finding was about.
//
// These cases run ONLY under native Windows Node (`process.platform === "win32"`).
// They are not emulated from WSL: WSL reports "linux" and takes the branch above.

const onWindows = process.platform === "win32";

test("F2 (linux). a root that DISAPPEARS before stabilization fails closed, never clean", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  // A pid that is not ours and is not alive: stabilization cannot begin, and the only
  // honest outcome is the named refusal — never an inferred empty tree.
  const gone = await stabilizeAndReapProcessTree(0x7ffffffe);
  assert.equal(gone.stabilized, false, "stabilization claimed success against an absent root");
  assert.equal(gone.reaped, false, "an unstabilized tree was reported as reaped");
  assert.equal(
    gone.reason,
    "timeout_root_disappeared_before_tree_stabilization",
    `unexpected refusal reason: ${gone.reason}`,
  );
});

test("F2 (linux). stabilization that cannot reach a fixed point fails closed AND unfreezes nothing", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  const dir = scratch();
  try {
    // A live, well-behaved child — but zero passes are allowed, so a fixed point cannot
    // be PROVEN. The tree must not be described as known merely because it was killed,
    // and — the point of this case — the helper must not leave it SIGSTOPped either.
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(parent, "setTimeout(() => {}, 600000);\n");
    const child = spawn(process.execPath, [parent], { cwd: dir, stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rootPid = child.pid!;

    const result = await stabilizeAndReapProcessTree(rootPid, { maxPasses: 0 });

    assert.equal(result.stabilized, false, "a fixed point was claimed without a single discovery pass");
    assert.equal(result.reaped, false, "an unstabilized tree was reported as certified-reaped");
    assert.match(result.reason, /stable fixed point/, `unexpected reason: ${result.reason}`);
    // FINDING 2. The helper froze this process, so the helper — not this test — has to
    // deal with it. Nothing below sends SIGCONT or SIGKILL.
    assert.equal(result.fallbackCleanupAttempted, true, "a failure after the freeze did not attempt fallback cleanup");
    assert.equal(result.fallbackKnownProcessesReaped, true, `fallback cleanup left processes behind: ${result.survivors.join(",")}`);
    assert.equal(pidAlive(rootPid), false, `the helper returned leaving the root ${rootPid} alive or frozen`);
    assert.deepEqual(processGroupPids(rootPid).filter(pidAlive), [], "the original process group still has live members");
    // Cleanup succeeding must NOT be readable as certification.
    assert.notEqual(result.reaped, result.fallbackKnownProcessesReaped, "fallback success was conflated with certification");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (linux). a discovered process that VANISHES before its stop is confirmed fails closed", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  const dir = scratch();
  let grandchildPid = 0;
  try {
    // The exact escape Codex described, built deterministically rather than raced for:
    //
    //   root -> detached child -> grandchild
    //
    // The child is already detached (its own process group), so the group signal cannot
    // reach it. It is discovered, then — through the test-only `afterDiscovery` seam,
    // which fires between discovery and stop-confirmation — it forks a grandchild and
    // exits. The grandchild is re-parented away from the root ancestry and is in neither
    // the root's group nor the child's. Nothing the algorithm can walk will find it.
    // Silently dropping the vanished child would let two later passes agree on the
    // reduced set and certify a tree with a live escapee in it.
    const goFile = path.join(dir, "go");
    const gcFile = path.join(dir, "grandchild.pid");
    const childScript = path.join(dir, "child.mjs");
    fs.writeFileSync(
      childScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        // Poll for the release marker, then fork a survivor and exit immediately.
        `const tick = setInterval(() => {`,
        `  if (!fs.existsSync(${JSON.stringify(goFile)})) return;`,
        `  clearInterval(tick);`,
        `  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });`,
        `  gc.unref();`,
        `  fs.writeFileSync(${JSON.stringify(gcFile)}, String(gc.pid));`,
        `  process.exit(0);`,
        "}, 5);",
      ].join("\n"),
    );
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore", detached: true });`,
        "child.unref();",
        "setTimeout(() => {}, 600000);",
      ].join("\n"),
    );

    const root = spawn(process.execPath, [parent], { cwd: dir, stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rootPid = root.pid!;

    // Observed inside the seam so a failure to reach the intended state is reported as a
    // PRECONDITION failure rather than as a confusing assertion about certification.
    let childPid = 0;
    let childTerminated = false;

    const result = await stabilizeAndReapProcessTree(rootPid, {
      // DETERMINISTIC, and this is the correction of an earlier version that was not.
      // Waiting for the grandchild's marker file only proved the child was ABOUT to exit:
      // `process.exit(0)` had not necessarily taken effect, so the stop could still land
      // first. That leaves the child frozen ALIVE, which keeps the grandchild
      // parent-reachable — a legitimate, safe outcome in which stabilization correctly
      // succeeds, and one this case must therefore never observe. It made the test fail
      // roughly 1 run in 15.
      //
      // The hook now returns only once the child has ACTUALLY terminated, so the
      // confirmation pass is guaranteed to meet a discovered identity that is gone.
      afterDiscovery: async (identities) => {
        if (childPid !== 0 || identities.length < 2) return;
        const child = identities.find((id) => id.pid !== rootPid);
        if (!child) return;
        childPid = child.pid;
        fs.writeFileSync(goFile, "");
        for (let i = 0; i < 600 && pidAlive(childPid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        childTerminated = !pidAlive(childPid);
      },
    });

    grandchildPid = fs.existsSync(gcFile) ? Number(fs.readFileSync(gcFile, "utf8").trim()) : 0;
    assert.ok(grandchildPid > 0, "the controlled grandchild never started, so the escape was not reproduced");
    assert.ok(childPid > 0, "the controlled child was never discovered, so the vanish window was never entered");
    assert.equal(
      childTerminated,
      true,
      `precondition: the child (${childPid}) had to terminate inside the discovery window; it was still alive, so this run did not exercise the vanish branch`,
    );

    assert.equal(result.stabilized, false, "a vanished discovered identity still produced a stabilized certification");
    assert.equal(result.reaped, false, "a vanished discovered identity still produced a reaped certification");
    assert.match(
      result.reason,
      /discovered_identity_vanished_before_confirmed_stop:\d+:\d+/,
      `the vanish was not named in the failure reason: ${result.reason}`,
    );
    // Fallback cleanup still runs, and still does not launder the certification.
    assert.equal(result.fallbackCleanupAttempted, true, "no fallback cleanup after a vanish failure");
    // The escapee is, by construction, unreachable — which is exactly why certification
    // had to fail. This asserts the honest position, not that the impossible was done.
    assert.equal(pidAlive(grandchildPid), true, "the escapee did not survive, so this case is not exercising the risk");
  } finally {
    if (grandchildPid > 0) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(pidAlive(grandchildPid), false, "the regression failed to clean up its controlled escapee");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (linux). a descendant that is a ZOMBIE on FIRST discovery also fails closed", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  const dir = scratch();
  let grandchildPid = 0;
  try {
    // The window BEFORE the first discovery pass. The group SIGSTOP cannot reach a
    // descendant that has detached into its own group, so it keeps running while the root
    // is frozen; if it forks and exits there, the frozen root cannot reap it and it is a
    // ZOMBIE the very first time it is seen. Exempting "already dead when first seen" let
    // two passes agree on root-plus-zombie and certify while the grandchild ran.
    //
    // Deterministic via the `afterFreeze` seam — a live root would simply reap its child,
    // so the zombie only exists inside this exact window.
    const goFile = path.join(dir, "go");
    const gcFile = path.join(dir, "grandchild.pid");
    const childScript = path.join(dir, "child.mjs");
    fs.writeFileSync(
      childScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const tick = setInterval(() => {`,
        `  if (!fs.existsSync(${JSON.stringify(goFile)})) return;`,
        `  clearInterval(tick);`,
        `  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });`,
        `  gc.unref();`,
        `  fs.writeFileSync(${JSON.stringify(gcFile)}, String(gc.pid));`,
        `  process.exit(0);`,
        "}, 5);",
      ].join("\n"),
    );
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore", detached: true });`,
        "child.unref();",
        "setTimeout(() => {}, 600000);",
      ].join("\n"),
    );

    const root = spawn(process.execPath, [parent], { cwd: dir, stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rootPid = root.pid!;

    const result = await stabilizeAndReapProcessTree(rootPid, {
      afterFreeze: async () => {
        // Root is now frozen; the detached child is not. Release it and wait until it has
        // forked and died, so it is a zombie before the first discovery pass runs.
        fs.writeFileSync(goFile, "");
        for (let i = 0; i < 200 && !fs.existsSync(gcFile); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    grandchildPid = fs.existsSync(gcFile) ? Number(fs.readFileSync(gcFile, "utf8").trim()) : 0;
    assert.ok(grandchildPid > 0, "the controlled grandchild never started");

    assert.equal(result.stabilized, false, "a zombie discovered on the first pass still produced a stabilized certification");
    assert.equal(result.reaped, false, "a zombie discovered on the first pass still produced a reaped certification");
    assert.match(
      result.reason,
      /discovered_identity_vanished_before_confirmed_stop:\d+:\d+/,
      `the pre-observation zombie was not named as the failure: ${result.reason}`,
    );
    assert.equal(result.fallbackCleanupAttempted, true, "no fallback cleanup after the zombie failure");
    assert.equal(pidAlive(grandchildPid), true, "the escapee did not survive, so this case is not exercising the risk");
  } finally {
    if (grandchildPid > 0) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(pidAlive(grandchildPid), false, "the regression failed to clean up its controlled escapee");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (linux). fallback cleanup signals a remembered target only while its IDENTITY matches", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  const dir = scratch();
  try {
    // The ledger exists to defeat pid reuse; flattening it to bare pids during cleanup
    // would undo that and could SIGKILL an unrelated process that inherited the pid.
    // This proves the helper reaps only what it still recognises: an innocent bystander
    // started AFTER the failure must be untouched.
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(parent, "setTimeout(() => {}, 600000);\n");
    const child = spawn(process.execPath, [parent], { cwd: dir, stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rootPid = child.pid!;

    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });
    bystander.unref();
    const bystanderPid = bystander.pid!;
    const bystanderIdentity = processIdentity(bystanderPid);
    assert.ok(bystanderIdentity, "the bystander could not be identified");

    const result = await stabilizeAndReapProcessTree(rootPid, { maxPasses: 0 });
    assert.equal(result.stabilized, false, "precondition: stabilization must fail so fallback cleanup runs");
    assert.equal(result.fallbackCleanupAttempted, true, "fallback cleanup did not run");
    assert.equal(result.fallbackKnownProcessesReaped, true, `fallback left processes: ${result.survivors.join(",")}`);
    assert.equal(pidAlive(rootPid), false, "the controlled root survived fallback cleanup");
    // The bystander was never in this tree and must be untouched.
    assert.equal(pidAlive(bystanderPid), true, "fallback cleanup killed a process outside the tree");
    assert.equal(identityPresent(bystanderIdentity!), true, "the bystander's identity changed under cleanup");
    assert.ok(!result.survivors.includes(bystanderPid), "an unrelated process was reported as cleanup residue");

    try { process.kill(bystanderPid, "SIGKILL"); } catch { /* gone */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (linux). a CLEAN EXIT that leaks a detached descendant does NOT claim whole-tree evidence", async (t) => {
  if (!PROC_AVAILABLE) {
    t.skip("Linux-only");
    return;
  }
  const dir = scratch();
  let descendantPid = 0;
  try {
    // The documented blind spot, reproduced deliberately: the root exits NORMALLY and
    // leaves behind a descendant that had already detached into its own process group.
    // Nothing this gate has can see it afterwards — which is precisely why the outcome
    // must not describe the tree as clean.
    const marker = path.join(dir, "descendant.pid");
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });',
        "child.unref();",
        `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
        "process.exit(0);",
      ].join("\n"),
    );

    const run = await runBoundedChild({
      label: "F2 linux regression: clean exit leaking a detached descendant",
      command: process.execPath,
      args: [parent],
      cwd: dir,
      timeoutMs: 30_000,
    });

    assert.equal(run.timedOut, false, "the controlled parent did not exit normally");
    assert.equal(run.exit, 0, `the controlled parent exited ${run.exit}`);
    descendantPid = Number(fs.readFileSync(marker, "utf8").trim());
    assert.ok(Number.isFinite(descendantPid) && descendantPid > 0, "the controlled descendant never started");

    // THE POINT OF THIS CASE. The descendant really is still alive, and the outcome
    // must not imply otherwise anywhere.
    assert.equal(pidAlive(descendantPid), true, "the controlled descendant did not outlive its parent, so nothing is being tested");
    assert.equal(run.wholeTreeVerified, false, "a clean exit claimed whole-tree verification while a descendant was still running");
    assert.equal(
      run.treeEvidence,
      "clean-exit-process-group-only",
      `a leaked clean exit was classified as ${run.treeEvidence}`,
    );
    assert.notEqual(run.treeEvidence, "timeout-stabilized-linux-proc", "a clean exit reused the stabilized-timeout classification");
    // The arrays ARE empty here — which is exactly why they may never be read as proof.
    assert.deepEqual(run.survivors, [], "precondition: the undiscovered descendant is not in survivors");
    assert.deepEqual(run.unreaped, [], "precondition: the undiscovered descendant is not in unreaped");
  } finally {
    // This regression deliberately leaks; it must not leave residue behind.
    if (descendantPid > 0) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* gone */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(pidAlive(descendantPid), false, "the regression failed to clean up its deliberately leaked descendant");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (windows). a timed-out child's DESCENDANT is terminated by taskkill /T /F", async (t) => {
  if (!onWindows) {
    t.skip("native Windows only; the Linux /proc path is covered above");
    return;
  }
  const dir = scratch();
  const residueBefore = HARNESS_PROCESS_RESIDUE.length;
  try {
    // The controlled shape under test: a parent that spawns a long-lived DESCENDANT
    // and then outlives the deadline itself. The descendant's pid is persisted so this
    // test can check it directly — never inferred from taskkill's stdout.
    const marker = path.join(dir, "descendant.pid");
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        // `detached` is what makes this regression load-bearing. A plain descendant is
        // killed as a side effect of the root dying on both platforms (libuv places it
        // in the parent's job object on Windows; it stays in the root's process group on
        // Linux), so a plain child would pass even against direct-child-only cleanup.
        // A detached one escapes BOTH of those, and is exactly the shape a shell
        // launcher or a server process takes.
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });',
        "child.unref();",
        `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
        "setTimeout(() => {}, 600000);",
      ].join("\n"),
    );

    const run = await runBoundedChild({
      label: "F2 windows regression: parent with a long-lived descendant",
      command: process.execPath,
      args: [parent],
      cwd: dir,
      timeoutMs: 4_000,
    });

    assert.equal(run.timedOut, true, "the controlled child did not exceed its deadline");
    assert.equal(run.treeEvidence, "timeout-verified-windows-taskkill", `the Windows cleanup path did not run: ${run.treeEvidence}`);
    assert.equal(run.windowsTreeKill, "SUCCESS", `the Windows tree kill failed: ${run.cleanupError}`);
    assert.equal(run.cleanupError, null, `cleanup reported a failure: ${run.cleanupError}`);
    // Honest boundary: terminating a tree is not observing one. /proc remains the only
    // authoritative process-evidence platform, so this must NOT claim verification.
    assert.equal(run.wholeTreeVerified, false, "Windows must not claim /proc-grade whole-tree verification");
    assert.ok(run.rootPid, "no root pid was recorded");

    const descendantPid = Number(fs.readFileSync(marker, "utf8").trim());
    assert.ok(Number.isFinite(descendantPid) && descendantPid > 0, "the controlled descendant never started");

    // THE FINDING, checked directly against the process table on both pids.
    assert.equal(pidExistsBySignal(run.rootPid!), false, `the root (${run.rootPid}) survived the timeout`);
    assert.equal(
      pidExistsBySignal(descendantPid),
      false,
      `the descendant (${descendantPid}) survived the timeout; /T did not reach the tree`,
    );
    assert.equal(HARNESS_PROCESS_RESIDUE.length, residueBefore, "clean Windows cleanup still recorded residue");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (windows). a NORMAL exit does not claim /proc-grade evidence", async (t) => {
  if (!onWindows) {
    t.skip("native Windows only");
    return;
  }
  const run = await runBoundedChild({
    label: "F2 windows regression: clean exit",
    command: process.execPath,
    args: ["-e", "process.stdout.write('done'); process.exit(4);"],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  assert.equal(run.timedOut, false, "a fast child was reported as timed out");
  assert.equal(run.exit, 4, `the child's real exit code was not preserved: ${run.exit}`);
  assert.equal(run.stdout, "done", `stdout was not captured: ${JSON.stringify(run.stdout)}`);
  // Windows has no tree observation on the clean-exit path, and must say so.
  assert.equal(run.treeEvidence, "clean-exit-unsupervised", `unexpected Windows clean-exit classification: ${run.treeEvidence}`);
  assert.equal(run.wholeTreeVerified, false, "Windows claimed whole-tree verification for a normal exit");
  assert.equal(run.timeoutTreeStabilized, null, "a clean exit reported timeout stabilization");
});

test("F2 (windows). taskkill that CANNOT LAUNCH fails closed and is recorded", async (t) => {
  if (!onWindows) {
    t.skip("native Windows only");
    return;
  }
  const dir = scratch();
  const residueBefore = HARNESS_PROCESS_RESIDUE.length;
  try {
    const parent = path.join(dir, "parent.mjs");
    fs.writeFileSync(parent, "setTimeout(() => {}, 600000);\n");
    const run = await runBoundedChild({
      label: "F2 windows regression: taskkill cannot launch",
      command: process.execPath,
      args: [parent],
      cwd: dir,
      timeoutMs: 3_000,
      taskkillExecutable: path.join(dir, "no-such-taskkill.exe"),
    });
    assert.equal(run.timedOut, true, "the controlled child did not exceed its deadline");
    assert.equal(run.windowsTreeKill, "FAILED", "a taskkill that could not launch was reported as successful cleanup");
    assert.ok(run.cleanupError, "a cleanup failure produced no cleanupError");
    assert.equal(
      HARNESS_PROCESS_RESIDUE.length,
      residueBefore + 1,
      "a Windows cleanup failure was not recorded in the residue ledger",
    );
    assert.match(
      HARNESS_PROCESS_RESIDUE[HARNESS_PROCESS_RESIDUE.length - 1]!.control,
      /windows tree cleanup/,
      "the residue entry does not identify the Windows cleanup failure",
    );
    // Do not leave the deliberately-unkilled child behind.
    if (run.rootPid && pidExistsBySignal(run.rootPid)) await windowsTreeKill(run.rootPid);
    HARNESS_PROCESS_RESIDUE.length = residueBefore;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F2 (windows). taskkill that exits NON-ZERO is a cleanup failure, not success", async (t) => {
  if (!onWindows) {
    t.skip("native Windows only");
    return;
  }
  // A pid that cannot exist: real taskkill runs and refuses it, exiting non-zero.
  const result = await windowsTreeKill(0x7ffffffe);
  assert.equal(result.ok, false, "taskkill's non-zero exit was read as successful cleanup");
  assert.notEqual(result.exit, 0, `expected a non-zero exit, got ${result.exit}`);
  assert.match(result.reason, /taskkill exited/, `unexpected reason: ${result.reason}`);
});

test("F2 (windows). the cleanup path never reaches a shell", async (t) => {
  if (!onWindows) {
    t.skip("native Windows only");
    return;
  }
  // taskkill is invoked directly with the pid as its own argv element. If a shell were
  // involved, this obviously-invalid pid string would be re-parsed rather than rejected
  // by taskkill itself, so a taskkill-shaped refusal is evidence there was no shell.
  const result = await windowsTreeKill(Number.NaN);
  assert.equal(result.ok, false, "an invalid pid was reported as successful cleanup");
  assert.match(result.reason, /taskkill (exited|could not be started|did not complete)/, `unexpected reason: ${result.reason}`);
});

test("F2. a child that cannot be launched fails fast rather than burning the deadline", async () => {
  const startedAt = Date.now();
  const run = await runBoundedChild({
    label: "F2 regression: launch failure",
    command: path.join(os.tmpdir(), "no-such-executable-a1b2c3"),
    args: [],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  assert.ok(run.launchError, "a nonexistent executable did not report a launch error");
  assert.equal(run.timedOut, false, "a launch failure was reported as a timeout");
  assert.ok(Date.now() - startedAt < 10_000, "a launch failure consumed the full deadline");
});
