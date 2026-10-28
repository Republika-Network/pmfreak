/**
 * B6 — the AI cost ledger is atomic, service-role-only and fails closed.
 *
 * Before 20261103000000_b6_ai_cost_reservations.sql the daily cost ceiling summed
 * ai_usage_events after each call, read by a separate query before the next one, failing
 * open. Production recorded six gpt-4.1-mini-2025-04-14 calls at NULL cost, so the ceiling
 * never fired. The router now reserves the worst-case cost of each provider call through
 * reserve_ai_cost() before sending it and settles it through settle_ai_cost() after.
 *
 * Covered against the real database and the real handlers: no client role can reserve,
 * settle or read the ledger; concurrent reservations stop exactly at a ceiling; settlement
 * frees exactly the unused part and is final; a key in flight or answered is not spent twice
 * while a failed one keeps its charge; workspaces are isolated and the user and global
 * ceilings span them; a Project Brain turn through the real route is charged at the real
 * cost of a synthetic gpt-4.1-mini-2025-04-14 response, and an exhausted budget answers in
 * limited mode without calling the model. OpenAI is a stub inside this process; no request
 * leaves the machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

// Synthetic OpenAI. Loopback (the disposable stack) passes through; anything else fails.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const realFetch = globalThis.fetch;
const openAiCalls = [];
let openAiReply = () => ({ model: "gpt-4.1-mini-2025-04-14", usage: { prompt_tokens: 2400, completion_tokens: 180, total_tokens: 2580 } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === OPENAI_URL) {
    openAiCalls.push(JSON.parse(String(init?.body ?? "{}")).model);
    const reply = openAiReply();
    const content = JSON.stringify({ reply: "[b6 stub] The project is active.", statements: [] });
    return new Response(JSON.stringify({ model: reply.model, choices: [{ message: { content }, finish_reason: "stop" }], usage: reply.usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (!LOOPBACK.has(new URL(url).hostname)) throw new Error(`[b6] unexpected non-loopback request: ${url}`);
  return realFetch(input, init);
};
process.env.OPENAI_API_KEY = "sk-b6-harness-not-a-real-key";
process.env.PMFREAK_OPERATING_PROFILE = "closed-free-beta";

const { POST: brainPost } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");

const INSUFFICIENT_PRIVILEGE = "42501";
const AMOUNT = 0.01;
let fx;
const sessions = {};
const keyPrefix = `b6-${randomUUID()}`;
let seq = 0;
const key = (label = "k") => `${keyPrefix}:${label}:${++seq}`;

before(async () => {
  fx = await createTenantFixtures(env, { label: "b6" });
  for (const who of ["aOwner", "bOwner", "bViewer"]) sessions[who] = await fx.signIn(fx.users[who]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!fx) return;
  const userIds = Object.values(fx.users).map((u) => u.id);
  await fx.admin.from("ai_cost_reservations").delete().like("reservation_key", `${keyPrefix}%`);
  await fx.admin.from("ai_cost_reservations").delete().in("workspace_id", [fx.workspaces.A, fx.workspaces.B]);
  await fx.admin.from("ai_cost_reservations").delete().in("user_id", userIds);
  await fx.admin.from("ai_usage_events").delete().in("workspace_id", [fx.workspaces.A, fx.workspaces.B]);
  await fx.teardown();
});

beforeEach(() => {
  delete process.env.AI_DAILY_COST_LIMIT_USD;
  delete process.env.AI_DAILY_USER_COST_LIMIT_USD;
  delete process.env.AI_DAILY_GLOBAL_COST_LIMIT_USD;
});

/** Today's ledger total for everything outside this run, so the global ceiling is testable on a shared stack. */
async function globalSpentUsd() {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await fx.admin.from("ai_cost_reservations").select("status, reserved_usd, settled_usd").eq("usage_day", day);
  assert.equal(error, null);
  return data.reduce((total, r) => total + Number(r.status === "reserved" ? r.reserved_usd : r.status === "settled" ? r.settled_usd : 0), 0);
}

function reserve(overrides = {}) {
  return fx.admin.rpc("reserve_ai_cost", {
    p_reservation_key: key(),
    p_workspace_id: fx.workspaces.B,
    p_user_id: fx.users.bOwner.id,
    p_operation: "b6.harness",
    p_provider: "openai",
    p_model: "gpt-4.1-mini",
    p_price_version: "openai-2026-10-26",
    p_amount_usd: AMOUNT,
    p_workspace_limit_usd: 25,
    p_user_limit_usd: 25,
    p_global_limit_usd: 100_000,
    ...overrides,
  });
}

const settle = (id, outcome, settledUsd, reason) =>
  fx.admin.rpc("settle_ai_cost", { p_reservation_id: id, p_outcome: outcome, p_settled_usd: settledUsd, p_input_tokens: null, p_output_tokens: null, p_response_model: null, p_settle_reason: reason });

/** A scope no other test or tenant touches. The ledger stores ids only (no FK), so random ids isolate each case. */
const freshScope = () => ({ userId: randomUUID(), workspaceId: randomUUID() });

test("B6: no client role can reserve, settle or read the AI cost ledger", async () => {
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const args = { p_reservation_key: key(), p_workspace_id: fx.workspaces.B, p_user_id: fx.users.bOwner.id, p_operation: "x", p_provider: "openai", p_model: "gpt-4.1-mini", p_price_version: "v", p_amount_usd: 0.000001, p_workspace_limit_usd: 1e6, p_user_limit_usd: 1e6, p_global_limit_usd: 1e6 };
  for (const [who, client] of [["owner", sessions.bOwner], ["anon", anon]]) {
    const reserved = await client.rpc("reserve_ai_cost", args);
    assert.equal(reserved.error?.code, INSUFFICIENT_PRIVILEGE, `${who} reserve: ${JSON.stringify(reserved.error)}`);
    const settled = await client.rpc("settle_ai_cost", { p_reservation_id: randomUUID(), p_outcome: "released", p_settled_usd: 0, p_input_tokens: null, p_output_tokens: null, p_response_model: null, p_settle_reason: "provider_refused" });
    assert.equal(settled.error?.code, INSUFFICIENT_PRIVILEGE, `${who} settle: ${JSON.stringify(settled.error)}`);
    const read = await client.from("ai_cost_reservations").select("id").limit(1);
    assert.equal(read.error?.code, INSUFFICIENT_PRIVILEGE, `${who} read: ${JSON.stringify(read.error)}`);
    const write = await client.from("ai_cost_reservations").insert({ reservation_key: key(), workspace_id: fx.workspaces.B, operation: "x", provider: "openai", model: "m", price_version: "v", reserved_usd: 1 });
    assert.equal(write.error?.code, INSUFFICIENT_PRIVILEGE, `${who} insert: ${JSON.stringify(write.error)}`);
  }
});

test("B6: twelve concurrent reservations stop exactly at the workspace ceiling", async () => {
  const scope = freshScope();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => reserve({ p_workspace_id: scope.workspaceId, p_user_id: scope.userId, p_workspace_limit_usd: AMOUNT * 5 })),
  );
  for (const r of results) assert.equal(r.error, null, JSON.stringify(r.error));
  const granted = results.filter((r) => r.data.ok === true);
  const refused = results.filter((r) => r.data.ok === false);
  assert.equal(granted.length, 5);
  assert.equal(refused.length, 7);
  for (const r of refused) assert.deepEqual([r.data.reason, r.data.scope], ["daily_cost_ceiling", "workspace"]);
  const { data } = await fx.admin.from("ai_cost_reservations").select("reserved_usd").eq("workspace_id", scope.workspaceId);
  assert.ok(data.reduce((t, r) => t + Number(r.reserved_usd), 0) <= AMOUNT * 5 + 1e-9);
});

test("B6: settlement frees exactly the unused reservation, is final, and only a definitive non-generation releases", async () => {
  const scope = freshScope();
  const limit = { p_workspace_id: scope.workspaceId, p_user_id: scope.userId, p_workspace_limit_usd: AMOUNT * 2 };
  const a = await reserve(limit);
  const b = await reserve(limit);
  assert.equal((await reserve(limit)).data.reason, "daily_cost_ceiling", "two reservations fill the budget");

  assert.equal((await settle(a.data.reservation_id, "settled", AMOUNT / 4, "success")).data.ok, true);
  assert.equal((await reserve({ ...limit, p_amount_usd: AMOUNT / 2 })).data.ok, true, "3/4 of a reservation was freed");
  assert.equal((await settle(a.data.reservation_id, "released", 0, "provider_refused")).data.reason, "already_final");

  const mismatched = await settle(b.data.reservation_id, "released", 0, "success");
  assert.equal(mismatched.error?.code, "22023", "a successful call can never be released");
  const missingReason = await settle(b.data.reservation_id, "settled", 0, null);
  assert.equal(missingReason.error?.code, "22004");
  const { data: row } = await fx.admin.from("ai_cost_reservations").select("status").eq("id", b.data.reservation_id).single();
  assert.equal(row.status, "reserved", "an unsettled reservation keeps counting in full");

  for (const bad of [{ p_amount_usd: 0 }, { p_amount_usd: -1 }, { p_global_limit_usd: null }, { p_workspace_limit_usd: 0 }, { p_workspace_id: null, p_user_id: null }]) {
    const r = await reserve({ ...limit, ...bad });
    assert.ok(r.error, `refused: ${JSON.stringify(bad)}`);
  }
});

test("B6: a key in flight or answered is never spent twice; a failed key may retry and keeps its charge", async () => {
  const scope = freshScope();
  const shared = key("idem");
  const racing = await Promise.all(Array.from({ length: 6 }, () => reserve({ p_reservation_key: shared, p_workspace_id: scope.workspaceId, p_user_id: scope.userId })));
  assert.equal(racing.filter((r) => r.data?.ok === true).length, 1);
  assert.equal(racing.filter((r) => r.data?.reason === "duplicate_request").length, 5);
  const first = racing.find((r) => r.data.ok === true).data.reservation_id;

  await settle(first, "settled", AMOUNT, "provider_failed");
  const retry = await reserve({ p_reservation_key: shared, p_workspace_id: scope.workspaceId, p_user_id: scope.userId });
  assert.equal(retry.data.ok, true, "a failed attempt may be retried");
  await settle(retry.data.reservation_id, "settled", AMOUNT / 10, "success");
  assert.equal((await reserve({ p_reservation_key: shared, p_workspace_id: scope.workspaceId, p_user_id: scope.userId })).data.reason, "duplicate_request");

  const { data } = await fx.admin.from("ai_cost_reservations").select("settled_usd").eq("reservation_key", shared).order("created_at");
  assert.deepEqual(data.map((r) => Number(r.settled_usd)), [AMOUNT, AMOUNT / 10], "the failed attempt's charge is kept");
});

test("B6: workspaces are isolated; the user and global ceilings span every workspace", async () => {
  const one = freshScope();
  const two = freshScope();
  assert.equal((await reserve({ p_workspace_id: one.workspaceId, p_user_id: one.userId, p_workspace_limit_usd: AMOUNT })).data.ok, true);
  assert.equal((await reserve({ p_workspace_id: one.workspaceId, p_user_id: one.userId, p_workspace_limit_usd: AMOUNT })).data.scope, "workspace");
  assert.equal((await reserve({ p_workspace_id: two.workspaceId, p_user_id: two.userId, p_workspace_limit_usd: AMOUNT })).data.ok, true, "tenant one's spend does not count against tenant two");

  const roaming = freshScope();
  assert.equal((await reserve({ p_workspace_id: one.workspaceId, p_user_id: roaming.userId, p_user_limit_usd: AMOUNT * 1.5 })).data.ok, true);
  assert.equal((await reserve({ p_workspace_id: two.workspaceId, p_user_id: roaming.userId, p_user_limit_usd: AMOUNT * 1.5 })).data.scope, "user");

  const spent = await globalSpentUsd();
  const globalLimit = spent + AMOUNT * 1.5;
  assert.equal((await reserve({ p_workspace_id: roaming.workspaceId, p_user_id: roaming.userId, p_global_limit_usd: globalLimit })).data.ok, true);
  assert.equal((await reserve({ p_workspace_id: two.workspaceId, p_user_id: two.userId, p_global_limit_usd: globalLimit })).data.scope, "global");
});

function brainTurn(projectId = fx.projects.B) {
  return brainPost(
    new Request(`http://localhost/api/projects/${projectId}/brain/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId: randomUUID(), text: "What is the status of this project?" }),
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
}

test("B6: a Brain turn through the real route is reserved, sent once and settled at the real cost of the dated model", async () => {
  actAs(sessions.bViewer); // project readers may converse in the closed beta; the viewer pays from the workspace and their own ceiling
  const before = openAiCalls.length;
  const response = await brainTurn();
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.messages.find((m) => m.role === "assistant").brain.mode, "generative");
  assert.equal(openAiCalls.length, before + 1);
  assert.equal(openAiCalls.at(-1), "gpt-4.1-mini");
  const { data: rows } = await fx.admin
    .from("ai_cost_reservations")
    .select("status, settle_reason, settled_usd, reserved_usd, workspace_id, user_id, response_model, input_tokens, output_tokens, model, price_version")
    .eq("workspace_id", fx.workspaces.B)
    .eq("operation", "project_brain.turn");
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.status, "settled");
  assert.equal(row.settle_reason, "success");
  assert.equal(row.user_id, fx.users.bViewer.id);
  assert.equal(row.response_model, "gpt-4.1-mini-2025-04-14");
  assert.deepEqual([row.input_tokens, row.output_tokens], [2400, 180]);
  assert.equal(Number(row.settled_usd), 0.001248); // 2400 × $0.40/M + 180 × $1.60/M
  assert.ok(Number(row.reserved_usd) > Number(row.settled_usd));
  const { data: usage } = await fx.admin.from("ai_usage_events").select("estimated_cost_usd, model").eq("workspace_id", fx.workspaces.B).eq("operation", "project_brain.turn");
  assert.equal(Number(usage.at(-1).estimated_cost_usd), 0.001248, "the usage report is priced too (it recorded NULL in production)");
});

test("B6: an exhausted workspace budget answers in limited mode without calling the model", async () => {
  process.env.AI_DAILY_COST_LIMIT_USD = "0.01"; // below one Brain turn's worst-case reservation
  actAs(sessions.bOwner);
  const before = openAiCalls.length;
  const response = await brainTurn();
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(openAiCalls.length, before, "the model was not called");
  const reply = body.messages.find((m) => m.role === "assistant");
  assert.equal(reply.brain.mode, "degraded");
  assert.equal(reply.brain.reason, "usage_limit");
});

test("B6: a tenant that is not a project reader cannot spend the workspace's budget", async () => {
  actAs(sessions.aOwner);
  const before = openAiCalls.length;
  const { count: beforeRows } = await fx.admin.from("ai_cost_reservations").select("id", { count: "exact", head: true }).eq("workspace_id", fx.workspaces.B);
  const response = await brainTurn(fx.projects.B);
  assert.equal(response.status, 403);
  assert.equal(openAiCalls.length, before);
  const { count: afterRows } = await fx.admin.from("ai_cost_reservations").select("id", { count: "exact", head: true }).eq("workspace_id", fx.workspaces.B);
  assert.equal(afterRows, beforeRows);
});
