#!/usr/bin/env node
// ============================================================================
// PMFreak Beta Release Gate (Perilla 11).
//
// Single entrypoint that runs every release-blocking check in order, collects
// results, prints a summary, and exits 1 if any blocking gate fails. Advisory
// gates (dependency security, recovery readiness) report CONDITIONAL/WARN
// without failing the gate; their state is tracked in
// docs/release/residual-risk-register.md.
//
//   npm run check:beta-release          # full gate (build included)
//
// No flags: a gate whose checks can be bypassed is not a gate.
//
// Ordering notes:
//   * There is no longer a local AOC package build step: P0-PKG-05 removed the
//     local pseudo-packages, and the canonical @aoc/protocol and
//     @aoc-enterprise/runtime artifacts arrive pre-built and checksum-pinned
//     through npm ci.
//   * Output is streamed to per-gate log files under .beta-release-logs/ and
//     the last lines are replayed on failure so nothing relevant is hidden.
// ============================================================================

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOG_DIR = ".beta-release-logs";
mkdirSync(LOG_DIR, { recursive: true });

const MAX_OUTPUT_BUFFER = 64 * 1024 * 1024;

/** @type {Array<{name: string, command: string, severity: "blocking" | "advisory"}>} */
/**
 * RELEASE-ENVIRONMENT PRECONDITION, checked before any gate runs.
 *
 * The blocking P0-LAUNCH-06 rehearsal creates a Supabase client, and
 * @supabase/realtime-js requires a native WebSocket, which arrives in Node 22. Under
 * Node 20 the gate used to fail deep inside a dependency with "WebSocket is not
 * defined", presenting an unsupported RUNTIME as a product NO-GO. CI is pinned to 22;
 * this makes the same requirement explicit for local operators and any other automation.
 * There is no upper bound: 23, 24 and later are accepted, since nothing in this
 * repository establishes a maximum.
 *
 * Pure and exported so the contract is testable without installing another Node.
 */
const MINIMUM_NODE_MAJOR = 22;

export function classifyNodeRuntime(version, minimumMajor = MINIMUM_NODE_MAJOR) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!match) {
    return { supported: false, reason: `NODE_RUNTIME_UNSUPPORTED required=>=${minimumMajor} actual=<unparseable>` };
  }
  const major = Number(match[1]);
  if (major < minimumMajor) {
    return { supported: false, major, reason: `NODE_RUNTIME_UNSUPPORTED required=>=${minimumMajor} actual=${major}.x` };
  }
  return { supported: true, major };
}

const nodeRuntime = classifyNodeRuntime(process.versions.node);
if (!nodeRuntime.supported) {
  console.error(`\n${nodeRuntime.reason}`);
  console.error(
    "The canonical beta release gate runs the blocking P0-LAUNCH-06 rehearsal, which needs a native " +
      "WebSocket (Node 22+). Refusing BEFORE any gate executes so an unsupported runtime is never " +
      "reported as a product NO-GO. CI is pinned to Node 22.\n",
  );
  process.exit(1);
}

const GATES = [
  { name: "Governance Ownership Boundary", command: "npm run check:governance-boundary", severity: "blocking" },
  { name: "Typecheck", command: "npm run typecheck", severity: "blocking" },
  { name: "Lint", command: "npm run lint", severity: "blocking" },
  { name: "Tests", command: "npm test", severity: "blocking" },
  { name: "Build", command: "npm run build", severity: "blocking" },
  { name: "Governance", command: "npm run check:governance", severity: "blocking" },
  { name: "Runtime Hardening", command: "npm run check:runtime-hardening", severity: "blocking" },
  { name: "Production Runtime", command: "npm run check:production-runtime", severity: "blocking" },
  { name: "Runtime Contracts", command: "npm run check:runtime-contracts", severity: "blocking" },
  { name: "Database Contract", command: "npm run check:db-contract", severity: "blocking" },
  { name: "Security Definer Hardening", command: "npm run check:security-definer-hardening", severity: "blocking" },
  { name: "Launch Smoke", command: "npm run test:launch-smoke", severity: "blocking" },
  { name: "Auth Bypass Scan", command: "npm run check:no-local-auth-bypass", severity: "blocking" },
  { name: "Enterprise UX", command: "npm run check:enterprise-ux", severity: "advisory" },
  // P0-LAUNCH-06 is the CURRENT closed-beta end-to-end release rehearsal, and it is
  // BLOCKING: the release decision must be incapable of GO / CONDITIONAL GO if the
  // rehearsal fails. It needs an isolated Supabase fixture, which Release Governance
  // provisions before invoking this orchestrator (see release-governance.yml). A missing
  // fixture therefore FAILS this gate — there is deliberately no skip, no advisory
  // downgrade and no environment-conditional execution, because a gate that can be
  // skipped cannot block anything.
  { name: "P0-LAUNCH-06 Beta Release Rehearsal", command: "npm run check:beta-release-rehearsal", severity: "blocking" },
  { name: "Dependency Security", command: "node scripts/check-dependency-security.mjs", severity: "advisory" },
];

const pad = (label) => `${label}${".".repeat(Math.max(2, 26 - label.length))}`;

const results = [];
let blockingFailure = false;

console.log("\nPMFreak Beta Release Gate\n");

for (const gate of GATES) {
  const startedAt = Date.now();
  const run = spawnSync(gate.command, { shell: true, encoding: "utf8", maxBuffer: MAX_OUTPUT_BUFFER });
  const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const logFile = path.join(LOG_DIR, `${gate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.log`);
  writeFileSync(logFile, output);

  // Advisory gates may exit 2 to mean "conditional" (pass with findings).
  const status =
    run.status === 0 ? "PASS" : gate.severity === "advisory" ? (run.status === 2 ? "CONDITIONAL" : "WARN") : "FAIL";
  results.push({ name: gate.name, command: gate.command, status, exitCode: run.status ?? -1, durationS, logFile });

  console.log(`${pad(gate.name)} ${status}  (${durationS}s, exit ${run.status ?? "signal"})`);

  if (status === "FAIL") {
    blockingFailure = true;
    console.error(`\n--- ${gate.name} failed; last output (full log: ${logFile}) ---`);
    console.error(output.split("\n").slice(-40).join("\n"));
    console.error(`--- end ${gate.name} output ---\n`);
    break; // blocking gates stop the run — later results would be noise
  }
}

const skipped = GATES.slice(results.length);
for (const gate of skipped) {
  console.log(`${pad(gate.name)} SKIPPED (earlier blocking failure)`);
}

const decision = blockingFailure ? "NO-GO" : results.some((r) => r.status !== "PASS") ? "CONDITIONAL GO" : "GO";

console.log(`\nDecision: ${decision}`);
if (!blockingFailure && decision === "CONDITIONAL GO") {
  console.log("Conditional items are tracked in docs/release/residual-risk-register.md.");
}
console.log(`Per-gate logs: ${LOG_DIR}/\n`);

writeFileSync(
  path.join(LOG_DIR, "summary.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), decision, results }, null, 2),
);

process.exit(blockingFailure ? 1 : 0);
