// B6 — AI cost control fails closed: priced models only, worst-case reservation before every
// billable call, settlement against reported usage, atomic ceilings.
//
// Production recorded six project_brain.turn calls whose returned model id was
// "gpt-4.1-mini-2025-04-14": the exact-match price table missed it, every row recorded NULL
// cost, and the daily cost ceiling (which summed those rows, and failed open) never fired.
//
// These tests drive the REAL router (src/lib/ai/providers/router.ts), the REAL OpenAI adapter
// and resilient-fetch, and the REAL Project Brain turn service, with synthetic OpenAI
// responses from a stubbed fetch. No network call can leave the process: any fetch that is
// not the stubbed OpenAI endpoint fails the test. The ledger here is an in-memory model of
// reserve_ai_cost()/settle_ai_cost(); the database functions themselves (atomicity under real
// concurrency, grants) are exercised in tests/security-regression/b6-ai-cost-ledger.test.mjs.

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AI_PRICE_TABLE_VERSION,
  costOfUsageUsd,
  inputTokenUpperBound,
  outputTokenUpperBound,
  resolveModelPrice,
  worstCaseAttemptCostUsd,
} from "../src/lib/ai/model-pricing";
import { estimateCostUsd, type AiCostLedger, type AiCostReserveInput, type AiCostSettleInput } from "../src/lib/ai/usage-accounting";
import { registerProvider, resolveBudgetScope, runInference, type InferenceDeps } from "../src/lib/ai/providers/router";
import { openAIProvider } from "../src/lib/ai/providers/openai-provider";
import { AiGuardrailError, providerCircuitBreaker } from "../src/lib/ai/runtime-guardrails";
import { AI_RUNTIME_LIMIT_DEFAULTS, resolveAiRuntimeLimits, type AiRuntimeLimits } from "../src/lib/ai/runtime-limits";
import { InferenceError, type InferenceRequest } from "../src/lib/ai/inference/types";
import { classifyInferenceFailure, runProjectBrainTurn, type ProjectBrainTurnStore } from "../src/lib/project-brain/conversation/turn-service";
import { assembleProjectBrainContext, type ProjectBrainRawContext } from "../src/lib/project-brain/conversation/context-builder";
import type { ContextConversationRow, ContextMessageRow } from "../src/lib/db/database-contract";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_1 = "99999999-9999-4999-8999-999999999999";
const USER_2 = "88888888-8888-4888-8888-888888888888";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// ─── In-memory model of the ledger SQL (20261103000000_b6_ai_cost_reservations.sql) ──

type Row = {
  id: string;
  key: string;
  workspaceId: string | null;
  userId: string | null;
  model: string;
  priceVersion: string;
  reservedUsd: number;
  settledUsd: number | null;
  status: "reserved" | "settled" | "released";
  reason: string | null;
};

type MemoryLedger = AiCostLedger & { rows: Row[]; settleCalls: AiCostSettleInput[]; reserveCalls: AiCostReserveInput[]; available: boolean };

const charge = (r: Row) => (r.status === "reserved" ? r.reservedUsd : r.status === "settled" ? (r.settledUsd ?? 0) : 0);
const sum = (rows: Row[]) => rows.reduce((total, r) => total + charge(r), 0);
const EPS = 1e-9;

function memoryLedger(): MemoryLedger {
  let ids = 0;
  const ledger: MemoryLedger = {
    rows: [],
    settleCalls: [],
    reserveCalls: [],
    available: true,
    async reserve(input) {
      ledger.reserveCalls.push(input);
      await Promise.resolve(); // concurrent callers interleave here; the check+insert below is one critical section
      if (!ledger.available) return { ok: false, reason: "unavailable", detail: "service_role_not_configured" };
      if (ledger.rows.some((r) => r.key === input.reservationKey && (r.status === "reserved" || (r.status === "settled" && r.reason?.startsWith("success"))))) {
        return { ok: false, reason: "duplicate_request" };
      }
      const checks: Array<["global" | "workspace" | "user", Row[], number]> = [["global", ledger.rows, input.limits.globalUsd]];
      if (input.workspaceId) checks.push(["workspace", ledger.rows.filter((r) => r.workspaceId === input.workspaceId), input.limits.workspaceUsd]);
      if (input.userId) checks.push(["user", ledger.rows.filter((r) => r.userId === input.userId), input.limits.userUsd]);
      for (const [scope, rows, limit] of checks) {
        const spent = sum(rows);
        if (spent + input.amountUsd > limit + EPS) return { ok: false, reason: "daily_cost_ceiling", scope, spentUsd: spent, limitUsd: limit };
      }
      const row: Row = {
        id: `res-${++ids}`,
        key: input.reservationKey,
        workspaceId: input.workspaceId,
        userId: input.userId,
        model: input.model,
        priceVersion: input.priceVersion,
        reservedUsd: input.amountUsd,
        settledUsd: null,
        status: "reserved",
        reason: null,
      };
      ledger.rows.push(row);
      return { ok: true, reservationId: row.id };
    },
    async settle(input) {
      ledger.settleCalls.push(input);
      const row = ledger.rows.find((r) => r.id === input.reservationId);
      if (!row || row.status !== "reserved") return { ok: false };
      row.status = input.outcome;
      row.settledUsd = input.outcome === "released" ? 0 : input.settledUsd;
      row.reason = input.reason;
      return { ok: true };
    },
  };
  return ledger;
}

// ─── Synthetic OpenAI: the ONLY fetch target allowed ────────────────────────

type Reply = { status?: number; body?: unknown; delayMs?: number; networkError?: boolean };
type FetchCall = { model: string; maxTokens?: number };

const realFetch = globalThis.fetch;
let openAiCalls: FetchCall[] = [];
let script: Array<Reply | ((call: FetchCall) => Reply)> = [];
let fallbackReply: Reply = { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300) };

function completion(model: string | undefined, promptTokens?: number, completionTokens?: number, content = "ok") {
  return {
    ...(model === undefined ? {} : { model }),
    choices: [{ message: { content }, finish_reason: "stop" }],
    ...(promptTokens === undefined ? {} : { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0) } }),
  };
}

function installOpenAiStub() {
  openAiCalls = [];
  script = [];
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300) };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== OPENAI_URL) throw new Error(`B6 test: unexpected network call to ${url}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-b6-test-not-a-real-key", "only the synthetic test key may be used");
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; max_tokens?: number };
    const call = { model: body.model, maxTokens: body.max_tokens };
    openAiCalls.push(call);
    const next = script.length ? script.shift()! : fallbackReply;
    const reply = typeof next === "function" ? next(call) : next;
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (reply.networkError) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body ?? { error: { message: "stub error" } }), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const savedEnv = { key: process.env.OPENAI_API_KEY, provider: process.env.DEFAULT_AI_PROVIDER, model: process.env.DEFAULT_AI_MODEL };

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-b6-test-not-a-real-key";
  delete process.env.DEFAULT_AI_PROVIDER;
  providerCircuitBreaker.recordSuccess("openai");
  installOpenAiStub();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  providerCircuitBreaker.recordSuccess("openai");
  if (savedEnv.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedEnv.key;
  if (savedEnv.provider !== undefined) process.env.DEFAULT_AI_PROVIDER = savedEnv.provider;
});

// ─── Router harness ─────────────────────────────────────────────────────────

const LIMITS: AiRuntimeLimits = { ...AI_RUNTIME_LIMIT_DEFAULTS, maxConcurrentPerWorkspace: 100, requestTimeoutMs: 1_000 };

function harness(overrides: { limits?: Partial<AiRuntimeLimits>; requestCeiling?: (scope: string, id: string) => boolean } = {}) {
  const ledger = memoryLedger();
  const limitCalls: Array<{ scope: string; identifier: string }> = [];
  const deps: InferenceDeps = {
    ledger,
    limits: { ...LIMITS, ...overrides.limits },
    enforceLimit: (async (input: { scope: string; identifier: string }) => {
      limitCalls.push({ scope: input.scope, identifier: input.identifier });
      const allowed = overrides.requestCeiling ? overrides.requestCeiling(input.scope, input.identifier) : true;
      return allowed ? { allowed: true } : { allowed: false, reason: "rate_limited", retryAfterSeconds: 60 };
    }) as unknown as InferenceDeps["enforceLimit"],
  };
  return { ledger, deps, limitCalls };
}

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    operationName: "project_brain.turn",
    workspaceId: WS_A,
    actorId: USER_1,
    messages: [
      { role: "system", content: "You are PMFreak." },
      { role: "user", content: "What is the status?" },
    ],
    maxTokens: 3800,
    maxAttempts: 2,
    retryDelayMs: 1,
    ...overrides,
  };
}

const price = (model = "gpt-4.1-mini") => {
  const r = resolveModelPrice("openai", model);
  assert.ok(r.ok);
  return r.price;
};
const perAttemptFor = (req: InferenceRequest, model = "gpt-4.1-mini") =>
  worstCaseAttemptCostUsd(price(model), inputTokenUpperBound({ messages: req.messages, responseFormat: req.responseFormat }), outputTokenUpperBound(price(model), req.maxTokens));

async function refused(promise: Promise<unknown>, guardrail: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AiGuardrailError, `expected AiGuardrailError(${guardrail}), got ${String(error)}`);
    assert.equal(error.guardrail, guardrail);
    return true;
  });
}

// ═══ 1. Pricing: explicit allowlist, normalization of supported snapshots ═══

test("1.1 gpt-4.1-mini and the production snapshot gpt-4.1-mini-2025-04-14 resolve to the same allowlisted price", () => {
  const family = resolveModelPrice("openai", "gpt-4.1-mini");
  const snapshot = resolveModelPrice("openai", "gpt-4.1-mini-2025-04-14");
  assert.ok(family.ok && snapshot.ok);
  assert.equal(snapshot.family, "gpt-4.1-mini");
  assert.equal(snapshot.snapshot, "2025-04-14");
  assert.equal(snapshot.price, family.price);
  assert.equal(snapshot.priceVersion, AI_PRICE_TABLE_VERSION);
});

test("1.2 the six production calls would now be priced (they recorded NULL cost before)", () => {
  const cost = estimateCostUsd("gpt-4.1-mini-2025-04-14", 10_000, 1_000);
  assert.equal(cost, 0.0056); // 10k × $0.40/M + 1k × $1.60/M
  assert.notEqual(cost, null);
});

test("1.3 unsupported model ids are unpriced — never guessed by prefix", () => {
  const unpriced: Array<[string, string, string]> = [
    ["openai", "gpt-4.1-mini-2026-01-01", "unlisted_snapshot"], // a future snapshot of a known family
    ["openai", "gpt-4o-2024-05-13", "unlisted_snapshot"], // a real snapshot priced differently from its family
    ["openai", "gpt-5", "unknown_model"],
    ["openai", "gpt-4.1-mini-preview", "unknown_model"],
    ["openai", "GPT-4.1-MINI", "unknown_model"],
    ["openai", "ft:gpt-4.1-mini-2025-04-14:org::abc", "unknown_model"],
    ["openai", "gpt-4.1-mini-2025-04-14-extra", "unknown_model"],
    ["openai", "", "unknown_model"],
    ["openai", "constructor", "unknown_model"],
    ["anthropic", "gpt-4.1-mini", "unknown_model"],
  ];
  for (const [provider, model, reason] of unpriced) {
    const resolution = resolveModelPrice(provider, model);
    assert.equal(resolution.ok, false, `${provider}/${model} must be unpriced`);
    if (!resolution.ok) assert.equal(resolution.reason, reason, model);
    assert.equal(estimateCostUsd(model, 100, 100, provider), null);
  }
  // "gpt-4.1-mini" is its own family, not "gpt-4.1" plus a suffix.
  const mini = resolveModelPrice("openai", "gpt-4.1-mini");
  assert.ok(mini.ok && mini.family === "gpt-4.1-mini");
});

test("1.4 missing token usage is unknown (null), never zero", () => {
  assert.equal(costOfUsageUsd(price(), undefined, 10), null);
  assert.equal(costOfUsageUsd(price(), 10, undefined), null);
  assert.equal(costOfUsageUsd(price(), Number.NaN, 10), null);
  assert.equal(costOfUsageUsd(price(), -1, 10), null);
  assert.equal(estimateCostUsd("gpt-4.1-mini"), null);
});

test("1.5 the input-token bound covers every byte of the request, multi-byte text included", () => {
  const messages = [{ role: "user", content: "naïve 日本語 🚀 ".repeat(200) }];
  const bound = inputTokenUpperBound({ messages });
  assert.ok(bound >= Buffer.byteLength(messages[0].content, "utf8"));
  const schema = { type: "json_schema", jsonSchema: { name: "x", schema: { type: "object", properties: { a: { type: "string" } } } } };
  assert.ok(inputTokenUpperBound({ messages, responseFormat: schema }) > bound, "the response schema is part of the prompt");
  assert.equal(outputTokenUpperBound(price(), 3800), 3800);
  assert.equal(outputTokenUpperBound(price(), undefined), 32_768, "no max_tokens → the model maximum, never unbounded");
  assert.equal(outputTokenUpperBound(price(), 10_000_000), 32_768);
});

test("1.6 new cost limits are bounded and env-configurable", () => {
  const defaults = resolveAiRuntimeLimits({});
  assert.equal(defaults.dailyUserCostLimitUsd, 10);
  assert.equal(defaults.dailyGlobalCostLimitUsd, 50);
  const set = resolveAiRuntimeLimits({ AI_DAILY_USER_COST_LIMIT_USD: "2.5", AI_DAILY_GLOBAL_COST_LIMIT_USD: "20" });
  assert.equal(set.dailyUserCostLimitUsd, 2.5);
  assert.equal(set.dailyGlobalCostLimitUsd, 20);
  const bad = resolveAiRuntimeLimits({ AI_DAILY_USER_COST_LIMIT_USD: "0", AI_DAILY_GLOBAL_COST_LIMIT_USD: "unlimited" });
  assert.equal(bad.dailyUserCostLimitUsd, 10);
  assert.equal(bad.dailyGlobalCostLimitUsd, 50);
});

// ═══ 2. Reservation before the call, settlement after ═══════════════════════

test("2.1 a dated-model response is reserved before the call and settled at its real cost", async () => {
  const { ledger, deps } = harness();
  const req = request();
  const response = await runInference(req, deps);
  assert.equal(response.model, "gpt-4.1-mini-2025-04-14");
  assert.equal(openAiCalls.length, 1);
  assert.equal(ledger.rows.length, 1);
  const [row] = ledger.rows;
  assert.equal(row.status, "settled");
  assert.equal(row.reason, "success");
  assert.equal(row.settledUsd, costOfUsageUsd(price(), 1200, 300));
  assert.ok(row.reservedUsd >= 2 * perAttemptFor(req) - 1e-8, "the reservation covers every allowed attempt");
  assert.ok((row.settledUsd ?? 0) < row.reservedUsd);
  assert.equal(row.priceVersion, AI_PRICE_TABLE_VERSION);
  assert.equal(row.workspaceId, WS_A);
  assert.equal(row.userId, USER_1);
});

test("2.2 an unpriced requested model is refused before any billable request", async () => {
  const { ledger, deps } = harness();
  await refused(runInference(request({ modelPreference: "gpt-4.1-mini-2026-01-01" }), deps), "model_not_priced");
  await refused(runInference(request({ modelPreference: "gpt-5" }), deps), "model_not_priced");
  assert.equal(openAiCalls.length, 0);
  assert.equal(ledger.reserveCalls.length, 0);
});

test("2.3 missing token usage settles at the full per-attempt worst case", async () => {
  const { ledger, deps } = harness();
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14") };
  const req = request({ maxAttempts: 1 });
  await runInference(req, deps);
  const [row] = ledger.rows;
  assert.equal(row.reason, "success_usage_unknown");
  assert.equal(row.settledUsd, perAttemptFor(req));
});

test("2.4 a response from an unrecognized model settles at the worst case and is reported", async () => {
  const { ledger, deps } = harness();
  fallbackReply = { body: completion("gpt-4.1-mini-2027-02-02", 10, 10) };
  const req = request({ maxAttempts: 1 });
  await runInference(req, deps);
  const [row] = ledger.rows;
  assert.equal(row.reason, "success_model_unrecognized");
  assert.equal(row.settledUsd, perAttemptFor(req));
});

test("2.5 no cost accounting → refused, nothing sent (fail closed, not open)", async () => {
  const { ledger, deps } = harness();
  ledger.available = false;
  await refused(runInference(request(), deps), "cost_accounting_unavailable");
  assert.equal(openAiCalls.length, 0);
});

test("2.6 a request with no budget scope is refused; a forged non-UUID scope is no scope", async () => {
  const { ledger, deps } = harness();
  await refused(runInference(request({ workspaceId: undefined, actorId: undefined }), deps), "budget_scope_missing");
  await refused(runInference(request({ workspaceId: "ws-1", actorId: "anyone" }), deps), "budget_scope_missing");
  assert.equal(openAiCalls.length, 0);
  assert.equal(ledger.reserveCalls.length, 0);
  assert.deepEqual(resolveBudgetScope({ actorId: USER_1 }), { workspaceId: null, userId: USER_1 });
});

test("2.7 a user-scoped request (no workspace: copilot, meta-intelligence, message-nudges) is still charged", async () => {
  const { ledger, deps, limitCalls } = harness();
  await runInference(request({ workspaceId: undefined, operationName: "copilot" }), deps);
  assert.equal(ledger.rows[0].workspaceId, null);
  assert.equal(ledger.rows[0].userId, USER_1);
  assert.deepEqual(limitCalls[0], { scope: "ai.user_daily_requests", identifier: USER_1 });
});

// ═══ 3. Concurrency near the limit ══════════════════════════════════════════

test("3.1 eight concurrent requests near the workspace limit: exactly the ones that fit are sent", async () => {
  const req = request({ maxAttempts: 1 });
  const perCall = perAttemptFor(req);
  const { ledger, deps } = harness({ limits: { dailyWorkspaceCostLimitUsd: perCall * 3 + perCall / 2 } });
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300), delayMs: 20 };
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => runInference(request({ maxAttempts: 1 }), deps)));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(sent, 3, "in-flight reservations count against the ceiling");
  assert.equal(openAiCalls.length, 3);
  for (const r of results) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof AiGuardrailError);
      assert.equal(r.reason.guardrail, "daily_cost_ceiling");
    }
  }
  assert.ok(sum(ledger.rows) <= perCall * 3 + perCall / 2 + EPS);
});

test("3.2 once settled below the worst case, the freed budget is usable again", async () => {
  const req = request({ maxAttempts: 1 });
  const perCall = perAttemptFor(req);
  const { deps } = harness({ limits: { dailyWorkspaceCostLimitUsd: perCall * 1.5 } });
  await runInference(request({ maxAttempts: 1 }), deps); // settles at the real (small) cost
  await runInference(request({ maxAttempts: 1 }), deps); // fits again
  assert.equal(openAiCalls.length, 2);
});

// ═══ 4. Failures after a reservation, retries, idempotency ══════════════════

test("4.1 failures after a reservation: charged when generation may have happened, released when it cannot have", async () => {
  const cases: Array<{ name: string; replies: Reply[]; attempts: number; expect: { status: string; reason: string; attemptsCharged: number } }> = [
    { name: "503 on every attempt", replies: [{ status: 503 }, { status: 503 }], attempts: 2, expect: { status: "settled", reason: "provider_failed", attemptsCharged: 2 } },
    { name: "timeout", replies: [{ delayMs: 5_000 }], attempts: 1, expect: { status: "settled", reason: "provider_failed", attemptsCharged: 1 } },
    { name: "network error", replies: [{ networkError: true }], attempts: 1, expect: { status: "settled", reason: "provider_failed", attemptsCharged: 1 } },
    { name: "200 with an empty completion", replies: [{ body: completion("gpt-4.1-mini-2025-04-14", 10, 10, "") }], attempts: 1, expect: { status: "settled", reason: "provider_failed", attemptsCharged: 1 } },
    { name: "400 on the only attempt", replies: [{ status: 400 }], attempts: 1, expect: { status: "released", reason: "provider_refused", attemptsCharged: 0 } },
    { name: "429 on the only attempt", replies: [{ status: 429 }], attempts: 1, expect: { status: "released", reason: "provider_refused", attemptsCharged: 0 } },
    { name: "503 then 400", replies: [{ status: 503 }, { status: 400 }], attempts: 2, expect: { status: "settled", reason: "provider_failed", attemptsCharged: 1 } },
  ];
  for (const c of cases) {
    providerCircuitBreaker.recordSuccess("openai");
    const { ledger, deps } = harness();
    script = [...c.replies];
    const req = request({ maxAttempts: c.attempts, timeoutMs: 200 });
    await assert.rejects(runInference(req, deps), c.name);
    const [row] = ledger.rows;
    assert.equal(row.status, c.expect.status, c.name);
    assert.equal(row.reason, c.expect.reason, c.name);
    assert.ok(Math.abs((row.settledUsd ?? 0) - perAttemptFor(req) * c.expect.attemptsCharged) < 1e-7, c.name);
  }
});

test("4.2 missing OPENAI_API_KEY: nothing is reserved or sent; a metered provider that fails before sending releases its reservation", async () => {
  delete process.env.OPENAI_API_KEY;
  const unconfigured = harness();
  await assert.rejects(runInference(request(), unconfigured.deps));
  assert.equal(openAiCalls.length, 0);
  assert.equal(unconfigured.ledger.reserveCalls.length, 0, "an unconfigured provider is not a candidate, so nothing is reserved");

  process.env.OPENAI_API_KEY = "sk-b6-test-not-a-real-key";
  const { ledger, deps } = harness();
  registerProvider({
    id: "openai",
    metering: "metered",
    async complete() {
      throw new InferenceError("refused locally before any request", "auth_error", "openai", 0);
    },
  });
  try {
    await assert.rejects(runInference(request(), deps));
  } finally {
    registerProvider(openAIProvider);
  }
  assert.equal(ledger.rows[0]?.status, "released");
  assert.equal(ledger.rows[0]?.reason, "provider_not_contacted");
});

test("4.2b the provider never makes more attempts than the reservation covers", async () => {
  const { ledger, deps } = harness();
  script = Array.from({ length: 10 }, () => ({ status: 503 }));
  const req = request({ maxAttempts: 10 });
  await assert.rejects(runInference(req, deps));
  assert.equal(openAiCalls.length, 6, "attempts are clamped to the reserved maximum");
  assert.ok(Math.abs((ledger.rows[0].settledUsd ?? 0) - ledger.rows[0].reservedUsd) < 1e-7, "every attempt was covered and charged");
});

test("4.3 a retried call is ONE reservation settled once: the failed attempt at worst case plus the real cost", async () => {
  const { ledger, deps } = harness();
  script = [{ status: 503 }, { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300) }];
  const req = request({ maxAttempts: 2 });
  await runInference(req, deps);
  assert.equal(openAiCalls.length, 2);
  assert.equal(ledger.reserveCalls.length, 1);
  assert.equal(ledger.settleCalls.length, 1);
  const expected = perAttemptFor(req) + (costOfUsageUsd(price(), 1200, 300) ?? 0);
  assert.ok(Math.abs((ledger.rows[0].settledUsd ?? 0) - expected) < 1e-7);
  // A late or repeated settle cannot lower a final charge.
  assert.deepEqual(await ledger.settle({ reservationId: ledger.rows[0].id, outcome: "released", settledUsd: 0, reason: "provider_refused" }), { ok: false });
  assert.equal(ledger.rows[0].status, "settled");
});

test("4.4 idempotency: a duplicate in flight or already answered is refused; a failed call may be retried and keeps its charge", async () => {
  const { ledger, deps } = harness();
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300), delayMs: 20 };
  const key = "project-brain:msg-1:first";
  const [first, second] = await Promise.allSettled([runInference(request({ idempotencyKey: key }), deps), runInference(request({ idempotencyKey: key }), deps)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") assert.equal((second.reason as AiGuardrailError).guardrail, "duplicate_request");
  assert.equal(openAiCalls.length, 1, "the duplicate never reached the provider");
  await refused(runInference(request({ idempotencyKey: key }), deps), "duplicate_request");

  const retryKey = "project-brain:msg-2:retry";
  script = [{ status: 503, delayMs: 0 }, { status: 503, delayMs: 0 }];
  await assert.rejects(runInference(request({ idempotencyKey: retryKey }), deps));
  const failed = ledger.rows.find((r) => r.key.startsWith(retryKey));
  assert.equal(failed?.reason, "provider_failed");
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14", 1200, 300) };
  await runInference(request({ idempotencyKey: retryKey }), deps);
  const rows = ledger.rows.filter((r) => r.key.startsWith(retryKey));
  assert.equal(rows.length, 2, "the failed attempt's row and charge remain");
  assert.ok((rows[0].settledUsd ?? 0) > 0);
});

// ═══ 5. Independent ceilings, isolation ═════════════════════════════════════

test("5.1 the request ceiling and the monetary ceiling act independently", async () => {
  const denyRequests = harness({ requestCeiling: () => false });
  await refused(runInference(request(), denyRequests.deps), "daily_request_ceiling");
  assert.equal(denyRequests.ledger.reserveCalls.length, 0, "a request-ceiling refusal reserves nothing");

  const tinyBudget = harness({ limits: { dailyWorkspaceCostLimitUsd: 0.0001 } });
  await refused(runInference(request(), tinyBudget.deps), "daily_cost_ceiling");
  assert.equal(tinyBudget.limitCalls.length, 1, "the request ceiling still ran and allowed it");
  assert.equal(openAiCalls.length, 0);
});

test("5.2 per-workspace isolation: an exhausted workspace does not consume or block another tenant", async () => {
  const req = request({ maxAttempts: 1 });
  const perCall = perAttemptFor(req);
  const { ledger, deps } = harness({ limits: { dailyWorkspaceCostLimitUsd: perCall * 1.5 } });
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14"), delayMs: 0 }; // unknown usage → full charge
  await runInference(request({ maxAttempts: 1 }), deps);
  await refused(runInference(request({ maxAttempts: 1 }), deps), "daily_cost_ceiling");
  await runInference(request({ maxAttempts: 1, workspaceId: WS_B, actorId: USER_2 }), deps);
  assert.equal(sum(ledger.rows.filter((r) => r.workspaceId === WS_B)), perCall);
  assert.equal(sum(ledger.rows.filter((r) => r.workspaceId === WS_A)), perCall, "tenant B's call charged nothing to A");
});

test("5.3 the per-user ceiling spans workspaces; the deployment-wide ceiling spans everyone", async () => {
  const req = request({ maxAttempts: 1 });
  const perCall = perAttemptFor(req);
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14") };
  const perUser = harness({ limits: { dailyUserCostLimitUsd: perCall * 1.5 } });
  await runInference(request({ maxAttempts: 1, workspaceId: WS_A }), perUser.deps);
  await refused(runInference(request({ maxAttempts: 1, workspaceId: WS_B }), perUser.deps), "daily_cost_ceiling");

  const global = harness({ limits: { dailyGlobalCostLimitUsd: perCall * 1.5 } });
  await runInference(request({ maxAttempts: 1, workspaceId: WS_A, actorId: USER_1 }), global.deps);
  await refused(runInference(request({ maxAttempts: 1, workspaceId: WS_B, actorId: USER_2 }), global.deps), "daily_cost_ceiling");
});

// ═══ 6. Through the real Project Brain turn service ═════════════════════════

function brainStore(): ProjectBrainTurnStore & { rows: ContextMessageRow[] } {
  let seq = 0;
  let ids = 0;
  const conversations: ContextConversationRow[] = [];
  const rows: ContextMessageRow[] = [];
  const now = () => new Date().toISOString();
  const store = {
    rows,
    async findConversation() {
      return conversations[0] ?? null;
    },
    async getOrCreateConversation() {
      if (!conversations[0]) {
        conversations.push({ id: "conv-1", workspace_id: WS_A, context_type: "project", pmo_id: null, project_id: PROJECT, title: "t", status: "active", created_by_user_id: USER_1, created_at: now(), updated_at: now() } as ContextConversationRow);
      }
      return conversations[0];
    },
    async listMessages() {
      return [...rows].sort((a, b) => a.message_seq - b.message_seq);
    },
    async findUserMessage(_c: string, clientMessageId: string) {
      return rows.find((r) => r.client_message_id === clientMessageId) ?? null;
    },
    async insertUserMessage(conversationId: string, clientMessageId: string, content: string) {
      const row = { id: `msg-${++ids}`, conversation_id: conversationId, workspace_id: WS_A, role: "user", content, metadata: null, created_by_user_id: USER_1, created_at: now(), message_seq: ++seq, client_message_id: clientMessageId, reply_to_message_id: null, brain_mode: null } as ContextMessageRow;
      rows.push(row);
      return { row };
    },
    async findMessage(_c: string, messageId: string) {
      return rows.find((r) => r.id === messageId) ?? null;
    },
    async listReplies(_c: string, userMessageId: string) {
      return rows.filter((r) => r.reply_to_message_id === userMessageId);
    },
    async insertReply(input: { conversationId: string; replyToMessageId: string; content: string; metadata: Record<string, unknown> | null; mode: string }) {
      const row = { id: `msg-${++ids}`, conversation_id: input.conversationId, workspace_id: WS_A, role: "assistant", content: input.content, metadata: input.metadata, created_by_user_id: null, created_at: now(), message_seq: ++seq, client_message_id: null, reply_to_message_id: input.replyToMessageId, brain_mode: input.mode } as ContextMessageRow;
      rows.push(row);
      return { row };
    },
  };
  return store as unknown as ProjectBrainTurnStore & { rows: ContextMessageRow[] };
}

const brainRaw = (): ProjectBrainRawContext =>
  ({
    scope: { workspaceId: WS_A, projectId: PROJECT },
    project: { id: PROJECT, workspace_id: WS_A, name: "MPP", status: "active", description: "Payments", created_at: "2026-09-01T00:00:00.000Z", onboarding_payload: null },
    summary: null,
    milestones: [],
    tasks: [],
    raidItems: [],
    history: [],
  }) as unknown as ProjectBrainRawContext;

const brainModelOutput = JSON.stringify({ reply: "MPP is active.", statements: [] });

function brainDeps(store: ProjectBrainTurnStore, deps: InferenceDeps, generativeEntitled = true) {
  return {
    scope: { workspaceId: WS_A, projectId: PROJECT },
    userId: USER_1,
    generativeEntitled,
    store,
    now: () => new Date(),
    loadContext: async () => assembleProjectBrainContext(brainRaw()),
    infer: (req: InferenceRequest) => runInference(req, deps),
  };
}

test("6.1 Brain: a turn answered by gpt-4.1-mini-2025-04-14 is charged its real cost to the workspace and user", async () => {
  const { ledger, deps } = harness();
  fallbackReply = { body: completion("gpt-4.1-mini-2025-04-14", 2000, 120, brainModelOutput) };
  const store = brainStore();
  const result = await runProjectBrainTurn(brainDeps(store, deps), { clientMessageId: "0f0e0d0c-0b0a-4908-8706-050403020100", text: "Status?" });
  assert.equal(result.status, "completed");
  assert.equal(openAiCalls.length, 1);
  assert.equal(openAiCalls[0].model, "gpt-4.1-mini");
  const [row] = ledger.rows;
  assert.equal(row.status, "settled");
  assert.equal(row.reason, "success");
  assert.equal(row.settledUsd, costOfUsageUsd(price(), 2000, 120));
  assert.equal(row.workspaceId, WS_A);
  assert.equal(row.userId, USER_1);
  assert.match(row.key, /^project-brain:msg-1:first:openai$/);
});

test("6.2 Brain: an exhausted budget answers in limited mode without calling the model", async () => {
  const { deps } = harness({ limits: { dailyWorkspaceCostLimitUsd: 0.0001 } });
  const store = brainStore();
  const result = await runProjectBrainTurn(brainDeps(store, deps), { clientMessageId: "1f0e0d0c-0b0a-4908-8706-050403020100", text: "Status?" });
  assert.equal(result.status, "completed");
  assert.equal(openAiCalls.length, 0);
  assert.equal(store.rows.find((r) => r.role === "assistant")?.brain_mode, "degraded");
});

test("6.3 Brain: an un-entitled user never reaches the provider or the ledger", async () => {
  const { ledger, deps } = harness();
  const store = brainStore();
  await runProjectBrainTurn(brainDeps(store, deps, false), { clientMessageId: "2f0e0d0c-0b0a-4908-8706-050403020100", text: "Status?" });
  assert.equal(openAiCalls.length, 0);
  assert.equal(ledger.reserveCalls.length, 0);
});

test("6.4 Brain: operational cost faults degrade as 'provider unavailable', ceilings as 'usage limit'", () => {
  assert.equal(classifyInferenceFailure(new AiGuardrailError("x", "model_not_priced")), "provider_unavailable");
  assert.equal(classifyInferenceFailure(new AiGuardrailError("x", "cost_accounting_unavailable")), "provider_unavailable");
  assert.equal(classifyInferenceFailure(new AiGuardrailError("x", "budget_scope_missing")), "provider_unavailable");
  assert.equal(classifyInferenceFailure(new AiGuardrailError("x", "daily_cost_ceiling")), "usage_limit");
  assert.equal(classifyInferenceFailure(new AiGuardrailError("x", "duplicate_request")), "usage_limit");
});

// ═══ 7. Source contracts: every billable route names its budget scope ═══════

const read = (p: string) => readFileSync(p, "utf8");

test("7.1 every runInference call site passes a workspace or an actor", () => {
  const sites: Array<[string, RegExp]> = [
    ["src/app/api/projects/[id]/brain/turns/route.ts", /infer: runInference/],
    ["src/app/api/analyze-ai/route.ts", /workspaceId,[\s\S]{0,200}actorId: user\.id/],
    ["src/app/api/copilot/route.ts", /actorId: user\.id/],
    ["src/app/api/ai/meta-intelligence/route.ts", /actorId: user\.id/],
    ["src/lib/ai/gateway/gateway.ts", /actorId: context\?\.actor\?\.actorUserId/],
    ["src/app/api/ai/message-nudges/route.ts", /actorUserId: user\.id/],
  ];
  for (const [file, pattern] of sites) assert.match(read(file), pattern, file);
  const turn = read("src/lib/project-brain/conversation/turn-service.ts");
  assert.match(turn, /workspaceId: scope\.workspaceId/);
  assert.match(turn, /actorId: deps\.userId/);
});

test("7.2 the router reserves before calling and has no fail-open cost path left", () => {
  const router = read("src/lib/ai/providers/router.ts");
  const reserveAt = router.indexOf("await reserveProviderCall(");
  const callAt = router.indexOf("await provider.complete(resolvedRequest)");
  assert.ok(reserveAt > 0 && callAt > reserveAt, "reservation precedes the provider call");
  assert.match(router, /provider\.metering === "unmetered" \? null : await reserveProviderCall/);
  assert.doesNotMatch(router, /getWorkspaceDailyCostUsd|spentUsd !== null/);
  assert.match(read("src/lib/ai/providers/openai-provider.ts"), /metering: "metered"/);
});

test("7.3 the ledger migration is service-role-only, atomic and idempotent", () => {
  const sql = read("supabase/migrations/20261103000000_b6_ai_cost_reservations.sql").toLowerCase();
  assert.match(sql, /create table if not exists public\.ai_cost_reservations/);
  assert.match(sql, /alter table public\.ai_cost_reservations enable row level security/);
  assert.match(sql, /revoke all on public\.ai_cost_reservations from anon/);
  assert.match(sql, /revoke all on public\.ai_cost_reservations from authenticated/);
  for (const fn of ["reserve_ai_cost", "settle_ai_cost", "ai_cost_reservation_charge"]) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`), fn);
  }
  assert.equal((sql.match(/pg_advisory_xact_lock\(hashtextextended\('pmfreak\.ai_cost_ledger', 0\)\)/g) ?? []).length, 2, "reserve and settle share one lock");
  assert.doesNotMatch(sql, /security definer/);
  assert.match(sql, /create unique index if not exists ai_cost_reservations_live_key/);
});
