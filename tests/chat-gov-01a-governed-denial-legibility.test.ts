/**
 * CHAT-GOV-01a — governed denial legibility and safe Frontera readiness.
 *
 * Behaviour, not source scanning, wherever this runner allows it:
 *   - the pure denial contract is exercised directly;
 *   - Frontera readiness runs against real files in a temp directory;
 *   - `/api/ready` runs its real handler;
 *   - the shared client parser runs the real `runExecutionOperation` against a stubbed fetch;
 *   - the failure notice is rendered by the real component through react-dom/server.
 *
 * The runner has no DOM, so focus-on-mount is the one behaviour asserted from source; the
 * rendered markup proves `role="alert"` and the focus target (`tabIndex=-1`).
 * Route-level mappings live in tests/module-mocks/chat-gov-01a-governed-denial-routes.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GENERIC_GOVERNED_REFUSAL,
  GOVERNED_DENIALS,
  governedDenialBody,
  resolveGovernedDenial,
} from "../src/lib/operational-flow/governed-denial-contract";
import { checkFronteraReadiness } from "../src/lib/integrations/frontera/readiness";
import {
  describeOperationFailure,
  OperationalFlowRequestError,
  runExecutionOperation,
} from "../src/modules/workspace/presentation/command-center/operational-data";
import { OperationFailureAlert, StageRow } from "../src/modules/workspace/presentation/command-center/execution-chain-panel";

const read = (relPath: string) => readFileSync(path.join(process.cwd(), relPath), "utf8");

// ─────────────── Contract (A–E at the pure layer) ───────────────

test("the three Frontera classes resolve to their own ratified copy", () => {
  assert.deepEqual(resolveGovernedDenial({ failureClass: "frontera_unavailable" }), {
    code: "frontera_unavailable",
    error: "The governance enforcement service is not available for this action.",
    recovery: "Try again after the workspace governance service is available. Nothing was created.",
  });
  assert.equal(resolveGovernedDenial({ failureClass: "frontera_actor_unbound" }).error, "Your account is not provisioned to dispatch this governed action.");
  assert.equal(resolveGovernedDenial({ failureClass: "frontera_actor_unbound" }).recovery, "Ask a workspace administrator to review your execution authority.");
  assert.equal(resolveGovernedDenial({ failureClass: "frontera_denied" }).error, "The governance enforcement boundary refused this action.");
  assert.equal(resolveGovernedDenial({ failureClass: "frontera_denied" }).recovery, "Review the action's authority and policy requirements.");
});

test("refusals are not collapsed onto one copy", () => {
  const cases = [
    { failureClass: "frontera_unavailable" },
    { failureClass: "frontera_actor_unbound" },
    { failureClass: "frontera_denied" },
    { failureClass: "expired" },
    { failureClass: "stale" },
    { failureClass: "governance_not_dispatchable", governanceState: "revoked" },
    { failureClass: "governance_not_dispatchable", governanceState: "denied" },
    { failureClass: "idempotency_conflict" },
    { failureClass: "actor_mismatch", reason: "governed_action_actor_mismatch" },
    { failureClass: "actor_mismatch", reason: "internal_execution_actor_mismatch" },
  ];
  const codes = cases.map((refusal) => resolveGovernedDenial(refusal).code);
  assert.equal(new Set(codes).size, codes.length, `codes must be distinct: ${codes.join(", ")}`);
});

test("revocation is recognised by governance state on both the dispatch and the execution gate", () => {
  for (const failureClass of ["governance_not_dispatchable", "governance_not_executable"]) {
    assert.equal(resolveGovernedDenial({ failureClass, governanceState: "revoked" }).code, "authorization_revoked");
  }
});

test("every failure class the P2-07 / P2-08 contracts and the Frontera adapter return has an explicit entry", () => {
  const returned = new Set<string>();
  for (const file of [
    "supabase/migrations/20260905000000_p2_08_internal_dispatch_execution.sql",
    "supabase/migrations/20260912000000_material_action_terminal_revocation.sql",
  ]) {
    for (const match of read(file).matchAll(/'failureClass',\s*'([a-z_]+)'/g)) returned.add(match[1]);
  }
  for (const match of read("src/lib/integrations/frontera/enforcement-adapter.ts").matchAll(/failureClass: "([a-z_]+)"/g)) returned.add(match[1]);
  const special = new Set(["actor_mismatch", "idempotency_conflict"]);
  const unmapped = [...returned].filter((failureClass) => !special.has(failureClass) && !(failureClass in GOVERNED_DENIALS));
  assert.deepEqual(unmapped, [], "a returned failure class would fall through to the generic refusal");
});

test("an unknown failure class is still a refusal with its own safe copy — never the old generic failure", () => {
  const contract = resolveGovernedDenial({ failureClass: "something_new_upstream" });
  assert.deepEqual(contract, GENERIC_GOVERNED_REFUSAL);
  assert.doesNotMatch(contract.error, /Operational flow action failed/);
  assert.equal(resolveGovernedDenial({}).code, "governed_operation_refused");
  assert.equal(resolveGovernedDenial({ failureClass: "__proto__" }).code, "governed_operation_refused");
});

test("F: the body carries only the allowlisted contract fields — diagnostics, reason codes and decision ids are dropped", () => {
  const body = governedDenialBody({
    disposition: "denied",
    failureClass: "frontera_unavailable",
    reason: "frontera_enforcement_denied",
    diagnostic: "unable to open database file /srv/authority.sqlite",
    reasonCodes: ["FRONTERA_EVALUATION_UNAVAILABLE"],
    decisionId: "frontera-decision-1",
    fronteraDecisionId: "frontera-decision-1",
  }, "3f0e2a8c-0000-4000-8000-000000000000");
  assert.deepEqual(Object.keys(body).sort(), ["code", "disposition", "error", "failureClass", "reason", "recovery", "referenceId"]);
  assert.doesNotMatch(JSON.stringify(body), /srv|sqlite|FRONTERA_|frontera-decision/);
});

test("the contract names no table, function, path or configuration variable in any copy", () => {
  const all = [...Object.values(GOVERNED_DENIALS), GENERIC_GOVERNED_REFUSAL];
  for (const contract of all) {
    for (const text of [contract.error, contract.recovery]) {
      assert.doesNotMatch(text, /_[a-z]|AOC_|sqlite|\/|\\|rpc|execution_tasks/i, `unsafe copy: ${text}`);
    }
    assert.match(contract.code, /^[a-z][a-z_]*$/);
  }
});

// ─────────────── K / L: readiness ───────────────

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chat-gov-01a-ready-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test("K: unset or blank configuration is not_configured", async () => {
  assert.deepEqual(await checkFronteraReadiness({}), { configured: false, available: false, status: "not_configured" });
  assert.deepEqual(
    await checkFronteraReadiness({ AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: "   " }),
    { configured: false, available: false, status: "not_configured" },
  );
});

test("K: a configured path with no file is unavailable, and the probe creates nothing", withTempDir(async (dir) => {
  const storePath = path.join(dir, "missing-dir", "authority.sqlite");
  const result = await checkFronteraReadiness({ AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: storePath });
  assert.deepEqual(result, { configured: true, available: false, status: "unavailable" });
  assert.equal(existsSync(storePath), false, "no store file minted");
  assert.equal(existsSync(path.dirname(storePath)), false, "no directory minted");
}));

test("K: a non-SQLite file is unavailable", withTempDir(async (dir) => {
  const storePath = path.join(dir, "authority.sqlite");
  writeFileSync(storePath, "this is a text file, not a database");
  assert.equal((await checkFronteraReadiness({ AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: storePath })).status, "unavailable");
}));

test("K: a readable SQLite file is ready, and the probe leaves it byte-identical with no WAL side files", withTempDir(async (dir) => {
  const storePath = path.join(dir, "authority.sqlite");
  const bytes = Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.alloc(4080, 7)]);
  writeFileSync(storePath, bytes);
  const before = createHash("sha256").update(readFileSync(storePath)).digest("hex");
  const result = await checkFronteraReadiness({ AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: storePath });
  assert.deepEqual(result, { configured: true, available: true, status: "ready" });
  assert.equal(createHash("sha256").update(readFileSync(storePath)).digest("hex"), before);
  assert.deepEqual(readdirSync(dir), ["authority.sqlite"]);
}));

test("L: readiness never reports the path, and its shape is exactly three fixed fields", withTempDir(async (dir) => {
  const storePath = path.join(dir, "SENTINEL-authority.sqlite");
  for (const env of [{}, { AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: storePath }]) {
    const result = await checkFronteraReadiness(env);
    assert.deepEqual(Object.keys(result).sort(), ["available", "configured", "status"]);
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|sqlite|chat-gov-01a-ready/i);
  }
}));

test("L: the readiness probe never opens the authority store through the packaged runtime", () => {
  const source = read("src/lib/integrations/frontera/readiness.ts");
  assert.doesNotMatch(source, /from\s+["']@aoc-enterprise\/runtime/);
  assert.doesNotMatch(source, /better-sqlite3|createSqliteKernelAuthorityStore\(/);
  assert.doesNotMatch(source, /writeFile|mkdir|appendFile|open\([^)]*["'](?:w|a|r\+)/);
});

test("K/L: /api/ready reports the safe Frontera status beside its checks, with no value or path", withTempDir(async (dir) => {
  const storePath = path.join(dir, "SENTINEL-authority.sqlite");
  const previous = process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH;
  process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH = storePath;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  try {
    const { GET } = await import("../src/app/api/ready/route");
    const response = await GET(new Request("http://localhost/api/ready"));
    const body = await response.json();
    assert.deepEqual(body.frontera, { configured: true, available: false, status: "unavailable" });
    assert.ok(!body.checks.some((check: { name: string }) => check.name === "frontera"), "Frontera is reported, not a readiness gate");
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /SENTINEL|chat-gov-01a-ready|AOC_ENTERPRISE|sqlite/i);
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH;
    else process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH = previous;
  }
}));

// ─────────────── Client parser, I (no retry), J (success unchanged) ───────────────

type FetchCall = { url: string; body: Record<string, unknown> };

async function withFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
  fn: (calls: FetchCall[]) => Promise<void>,
) {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a governed dispatch refusal surfaces error, recovery, code and referenceId — and I: is sent exactly once", async () => {
  await withFetch(() => json(409, {
    disposition: "denied", failureClass: "frontera_unavailable", reason: "frontera_enforcement_denied",
    error: "The governance enforcement service is not available for this action.",
    code: "frontera_unavailable",
    recovery: "Try again after the workspace governance service is available. Nothing was created.",
    referenceId: "3f0e2a8c-1111-4000-8000-000000000000",
  }), async (calls) => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" }), (caught: unknown) => {
      assert.ok(caught instanceof OperationalFlowRequestError);
      assert.equal(caught.status, 409);
      assert.equal(caught.code, "frontera_unavailable");
      assert.deepEqual(describeOperationFailure(caught), {
        message: "The governance enforcement service is not available for this action.",
        recovery: "Try again after the workspace governance service is available. Nothing was created.",
        referenceId: "3f0e2a8c-1111-4000-8000-000000000000",
        code: "frontera_unavailable",
      });
      return true;
    });
    assert.equal(calls.length, 1, "a refusal is never retried automatically");
    assert.deepEqual(calls[0], {
      url: "/api/operational-flow",
      body: { workspaceId: "ws-1", projectId: "pr-1", operation: "dispatch_material_action_to_task", actionId: "act-1" },
    });
  });
});

test("an execution refusal is parsed by the same shared parser", async () => {
  await withFetch(() => json(409, {
    ok: false, disposition: "denied", failureClass: "actor_mismatch", reason: "internal_execution_actor_mismatch",
    error: "Only the person who queued this internal execution can change its state.",
    code: "dispatcher_required", recovery: "Ask the person who queued it to continue.",
    referenceId: "3f0e2a8c-2222-4000-8000-000000000000",
  }), async (calls) => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "execution", taskId: "task-1", command: "start" }), (caught: unknown) => {
      const failure = describeOperationFailure(caught);
      assert.equal(failure.message, "Only the person who queued this internal execution can change its state.");
      assert.equal(failure.referenceId, "3f0e2a8c-2222-4000-8000-000000000000");
      assert.equal(failure.code, "dispatcher_required");
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/execution-tasks/internal-execution");
  });
});

test("a machine recovery token from the older conflict contract is not rendered as prose", async () => {
  await withFetch(() => json(409, {
    disposition: "conflict", code: "operational_flow_conflict", error: "This attempt was already recorded with different content.",
    recovery: "reload_recorded_state", referenceId: "3f0e2a8c-3333-4000-8000-000000000000",
  }), async () => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" }), (caught: unknown) => {
      const failure = describeOperationFailure(caught);
      assert.equal(failure.recovery, undefined);
      assert.equal(failure.referenceId, "3f0e2a8c-3333-4000-8000-000000000000");
      return true;
    });
  });
});

test("a non-JSON failure body is reported with its status, not as a parser exception", async () => {
  await withFetch(() => new Response("<html>504 Gateway Timeout</html>", { status: 504 }), async () => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" }), (caught: unknown) => {
      const failure = describeOperationFailure(caught);
      assert.match(failure.message, /HTTP 504/);
      assert.doesNotMatch(failure.message, /Unexpected token|JSON/);
      return true;
    });
  });
});

test("a network failure says the outcome is unknown instead of claiming either result", async () => {
  await withFetch(() => { throw new TypeError("Failed to fetch"); }, async (calls) => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" }), (caught: unknown) => {
      const failure = describeOperationFailure(caught);
      assert.match(failure.message, /could not reach the server/i);
      assert.match(failure.recovery ?? "", /reload/i);
      return true;
    });
    assert.equal(calls.length, 1, "no automatic retry after a network failure either");
  });
});

test("an unknown server error without a body message falls back to a generic message", async () => {
  await withFetch(() => json(500, {}), async () => {
    await assert.rejects(runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" }), (caught: unknown) => {
      assert.equal(describeOperationFailure(caught).message, "Operational flow action failed.");
      return true;
    });
  });
});

test("J: a successful dispatch resolves exactly as before", async () => {
  await withFetch(() => json(201, { disposition: "created", task: { id: "task-1" }, fronteraDecisionId: "fd-1" }), async (calls) => {
    await runExecutionOperation("ws-1", "pr-1", { kind: "task", actionId: "act-1" });
    assert.equal(calls.length, 1);
  });
  await withFetch(() => json(200, { ok: true, disposition: "transitioned" }), async (calls) => {
    await runExecutionOperation("ws-1", "pr-1", { kind: "execution", taskId: "task-1", command: "start" });
    assert.equal(calls.length, 1);
  });
});

// ─────────────── G / H: the failure renders beside the failed control ───────────────

const taskStage = {
  key: "task" as const,
  label: "Canonical internal task",
  state: "not_started" as const,
  actionable: true,
  blockedReason: null,
  effect: "Turns the authorized Action into one canonical internal Task.",
};

test("G/H: the failure notice renders inside the Task stage, directly after its control, as a focusable role=alert", () => {
  const failure = {
    stage: "task" as const,
    attempt: 1,
    message: "The governance enforcement service is not available for this action.",
    recovery: "Try again after the workspace governance service is available. Nothing was created.",
    referenceId: "3f0e2a8c-4444-4000-8000-000000000000",
  };
  const html = renderToStaticMarkup(
    createElement(StageRow, { stage: taskStage, failure }, createElement("button", { type: "button" }, "Create canonical internal task")),
  );
  const button = html.indexOf("Create canonical internal task</button>");
  const alert = html.indexOf('role="alert"');
  assert.ok(button > -1 && alert > button, "the alert follows the Task control");
  assert.equal(html.lastIndexOf("</li>"), html.length - "</li>".length, "and stays inside the same stage row");
  assert.match(html, /role="alert"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="alert"/i);
  assert.match(html, /The governance enforcement service is not available for this action\./);
  assert.match(html, /Try again after the workspace governance service is available/);
  assert.match(html, /Failure reference/);
  assert.match(html, /3f0e2a8c-4444-4000-8000-000000000000/);
});

test("G: a stage without a failure renders no alert", () => {
  const html = renderToStaticMarkup(
    createElement(StageRow, { stage: taskStage }, createElement("button", { type: "button" }, "Create canonical internal task")),
  );
  assert.doesNotMatch(html, /role="alert"/);
});

test("G: the notice omits recovery and reference lines it was not given", () => {
  const html = renderToStaticMarkup(createElement(OperationFailureAlert, { failure: { stage: "task", attempt: 1, message: "Refused." } }));
  assert.match(html, /Refused\./);
  assert.doesNotMatch(html, /Failure reference/);
});

test("H/I: focus moves to the notice on every new failure, and the panel never retries on its own", () => {
  const source = read("src/modules/workspace/presentation/command-center/execution-chain-panel.tsx");
  assert.match(source, /useEffect\(\(\) => \{\s*document\.getElementById\(alertId\)\?\.focus\(\);\s*\}, \[alertId, failure\.attempt\]\);/);
  assert.match(source, /id=\{alertId\}\s*role="alert"\s*tabIndex=\{-1\}/);
  // Each stage passes only ITS failure, and no global branch-level alert remains.
  for (const key of ["task", "execution", "outcome", "observation"]) {
    assert.match(source, new RegExp(`failure=\\{failureFor\\("${key}"\\)\\}`), `${key} stage renders its own failure`);
  }
  assert.doesNotMatch(source, /\{error && \(/, "the far-away branch-level alert is gone");
  // No timer, loop or second onRun call inside the failure path.
  assert.doesNotMatch(source, /setTimeout|setInterval/);
  const runBody = source.slice(source.indexOf("async function run("), source.indexOf("const busy ="));
  assert.equal((runBody.match(/onRun\(/g) ?? []).length, 1);
});

// ─────────────── Governance unchanged ───────────────

test("Frontera stays fail-closed and in front of the canonical RPC; no fallback dispatch path exists", () => {
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  const dispatch = service.slice(service.indexOf("export async function dispatchGovernedMaterialActionToTask"), service.indexOf("export async function revokeGovernedMaterialAction"));
  const fronteraAt = dispatch.indexOf("await authorize(");
  const refusedAt = dispatch.indexOf("if (!frontera.allowed)");
  const rpcAt = dispatch.indexOf('client.rpc("dispatch_governed_action_to_internal_task"');
  assert.ok(fronteraAt > -1 && refusedAt > fronteraAt && rpcAt > refusedAt, "Frontera, then refusal, then RPC");
  assert.equal((dispatch.match(/client\.rpc\(/g) ?? []).length, 1, "exactly one RPC call site");
  assert.match(dispatch, /p_expected_proposal_digest: expectedProposalDigest,/);
  const adapter = read("src/lib/integrations/frontera/enforcement-adapter.ts");
  assert.match(adapter, /if \(decision\.status !== "allowed"\)/);
  assert.match(adapter, /failureClass: "frontera_unavailable"/);
});

test("referenceIds are server-minted, logged with the refusal, and never derived from request content", () => {
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  const route = read("src/app/api/execution-tasks/internal-execution/route.ts");
  for (const source of [service, route]) {
    assert.match(source, /randomUUID\(\)/);
    assert.match(source, /referenceId/);
  }
  assert.match(service, /governed material action dispatch refused at the Frontera boundary",\s*\{[^}]*referenceId/);
  assert.match(service, /governed material action dispatch refused by the canonical contract",\s*\{[^}]*referenceId/);
});
