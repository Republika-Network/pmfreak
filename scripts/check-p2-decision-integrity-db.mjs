import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// P2 Recommendation -> Decision terminal-integrity live verifier.
//
// Drives the real `/api/operational-flow` route of a running local PMFreak app against the
// disposable local Supabase stack, as real signed-in users, and reads persisted state back with
// the service role. Covers: valid terminal Decisions (Cases 1-2), repeated / conflicting terminal
// Decisions (Defect A, Cases 3-4), non-terminal Decisions after a terminal one (Defect B,
// Cases 5-6), escalation before a terminal Decision (Case 7), competing concurrent Decisions
// (Case 8), and the Needs You read model after each refusal.
//
// Requires the migration 20260911000000_p2_decision_terminal_integrity.sql to be applied.

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL;
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY;
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY;
const appBaseUrl = process.env.OPERATIONAL_FLOW_TEST_BASE_URL?.replace(/\/$/, "");

if (!supabaseUrl || !anonKey || !serviceRoleKey || !appBaseUrl || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true") {
  console.error([
    "P2 decision-integrity live verification requires the disposable local PMFreak stack.",
    "Set OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,",
    "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY, OPERATIONAL_FLOW_TEST_BASE_URL",
    "and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true.",
  ].join("\n"));
  process.exit(2);
}
for (const [name, target] of [["Supabase API", supabaseUrl], ["PMFreak", appBaseUrl]]) {
  let host;
  try { host = new URL(target).hostname; } catch { console.error(`SAFETY ABORT: invalid ${name} URL.`); process.exit(2); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    console.error(`SAFETY ABORT: ${name} must use a literal loopback host.`); process.exit(2);
  }
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-DI-${randomUUID()}!`;
const TERMINAL = new Set(["accepted", "rejected", "modified"]);
const LEAKS = [/record_operational_decision/, /operational_decision_/, /uidx/, /duplicate key/i, /constraint/i, /Operational flow failed/];
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };

const email = `p2-decision-integrity-owner-${suffix}@example.test`;
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.ifError(created.error);
const ownerId = created.data.user.id;
const workspaceId = randomUUID(); const projectId = randomUUID();
assert.ifError((await admin.from("workspaces").insert({ id: workspaceId, name: `P2 DI DEMO ${suffix}`, created_by_user_id: ownerId })).error);
assert.ifError((await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: ownerId, role: "owner" })).error);
assert.ifError((await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: ownerId, name: `P2 DI DEMO Project ${suffix}` })).error);

async function loginCookie() {
  const form = new FormData();
  form.set("email", email); form.set("password", password); form.set("next", "/projects");
  const response = await fetch(`${appBaseUrl}/api/login`, { method: "POST", body: form, redirect: "manual" });
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
  assert.ok(values.length > 0, "authenticated login must return cookies");
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}
const cookie = await loginCookie();

async function api(body) {
  const response = await fetch(`${appBaseUrl}/api/operational-flow`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ workspaceId, projectId, ...body }), signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let parsed = {}; try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
  return { status: response.status, body: parsed, raw };
}

let seq = 0;
async function openRecommendation() {
  seq += 1;
  const captured = await api({ operation: "capture_input", idempotencyKey: `di-capture-${suffix}-${seq}`, title: `DEMO / FIXTURE decision integrity ${seq}`,
    content: `Additional work outside scope without formal approval creates a controlled scope risk (${suffix} ${seq}).`, occurredAt: new Date().toISOString(), correlationId: randomUUID() });
  equal(captured.status, 201, "fixture capture");
  const derived = await api({ operation: "derive_evidence", normalizedEventId: captured.body.normalizedEvent.id, idempotencyKey: `di-evidence-${suffix}-${seq}`,
    assertionType: "FACT", classification: "DECISION_CONTEXT", confidenceScore: 0.95, missingDataState: "COMPLETE", evaluatedAt: new Date().toISOString() });
  equal(derived.status, 201, "fixture evidence");
  equal((await api({ operation: "run_chain", evidenceItemId: derived.body.evidence.id })).status, 200, "fixture chain");
  const signals = await admin.from("operational_signals").select("id").eq("evidence_item_id", derived.body.evidence.id);
  assert.ifError(signals.error);
  const risks = await admin.from("risk_issue_records").select("id").in("signal_id", signals.data.map((row) => row.id));
  assert.ifError(risks.error);
  const recommendation = await admin.from("recommended_actions").select("id,status").in("risk_issue_id", risks.data.map((row) => row.id))
    .not("governance_event_id", "is", null).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1).single();
  assert.ifError(recommendation.error);
  equal(recommendation.data.status, "proposed", "fixture recommendation starts open");
  return recommendation.data.id;
}

const decide = (recommendationId, decisionStatus) => api({ operation: "record_decision", recommendationId, decisionStatus,
  decision: `DEMO / FIXTURE ${decisionStatus}`, rationale: `P2 decision-integrity live verifier: ${decisionStatus}` });

async function persisted(recommendationId) {
  const recommendation = await admin.from("recommended_actions").select("status").eq("id", recommendationId).single();
  assert.ifError(recommendation.error);
  const decisions = await admin.from("operational_decision_records").select("id,decision_status,created_at").eq("recommendation_id", recommendationId)
    .order("created_at", { ascending: true }).order("id", { ascending: true });
  assert.ifError(decisions.error);
  return { status: recommendation.data.status, history: decisions.data.map((row) => row.decision_status) };
}

/** One terminal Decision at most; if present it is the last word and the Recommendation carries it. */
function assertCoherent(state, label) {
  const terminals = state.history.filter((status) => TERMINAL.has(status));
  check(terminals.length <= 1, `${label}: at most one terminal Decision (${state.history})`);
  if (terminals.length === 1) {
    equal(state.history.at(-1), terminals[0], `${label}: nothing recorded after the terminal Decision`);
    equal(state.status, terminals[0], `${label}: Recommendation carries its terminal Decision`);
  } else {
    equal(state.status, "proposed", `${label}: an undecided Recommendation stays proposed`);
  }
}

function assertConflict(result, label) {
  equal(result.status, 409, `${label}: explicit domain conflict, never 500 (got ${result.status} ${result.raw})`);
  equal(result.body.disposition, "conflict", `${label}: conflict disposition`);
  equal(result.body.code, "recommendation_already_decided", `${label}: stable conflict code`);
  equal(result.body.recovery, "reload_recorded_decision", `${label}: recovery instruction`);
  check(typeof result.body.referenceId === "string" && result.body.referenceId.length === 36, `${label}: support reference`);
  for (const leak of LEAKS) check(!leak.test(result.raw), `${label}: body must not contain ${leak}`);
}

async function assertNotInNeedsYou(recommendationId, label) {
  const response = await fetch(`${appBaseUrl}/api/operational-flow?workspaceId=${workspaceId}&projectId=${projectId}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  equal(response.status, 200, `${label}: summary readable`);
  const summary = await response.json();
  const openIds = summary.assurance?.openRecommendationIds ?? [];
  check(!openIds.includes(recommendationId), `${label}: not an open Recommendation in the assurance projection`);
  const row = (summary.recommendations ?? []).find((item) => item.id === recommendationId);
  if (row) check(row.status !== "proposed", `${label}: summary does not show it undecided`);
}

// Cases 1 / 2
for (const [caseId, status] of [["Case 1", "accepted"], ["Case 2", "rejected"]]) {
  const rec = await openRecommendation();
  equal((await decide(rec, status)).status, 201, `${caseId}: proposed -> ${status} succeeds`);
  const state = await persisted(rec);
  equal(state.history.length, 1, `${caseId}: one Decision`);
  assertCoherent(state, caseId);
}

// Cases 3-6 and the remaining terminal -> any pairs
for (const [caseId, first, second] of [
  ["Case 3", "accepted", "accepted"], ["Case 4", "accepted", "rejected"], ["Case 5", "accepted", "escalated"],
  ["Case 6", "rejected", "escalated"], ["Case 6b", "accepted", "needs_more_evidence"], ["Case 6c", "modified", "escalated"], ["Case 6d", "rejected", "accepted"],
]) {
  const rec = await openRecommendation();
  equal((await decide(rec, first)).status, 201, `${caseId}: ${first} succeeds`);
  assertConflict(await decide(rec, second), `${caseId}: ${first} -> ${second}`);
  const state = await persisted(rec);
  equal(state.status, first, `${caseId}: Recommendation stays ${first}`);
  equal(state.history.join(), first, `${caseId}: original terminal Decision preserved, nothing added`);
  assertCoherent(state, caseId);
  await assertNotInNeedsYou(rec, caseId);
}

// Case 7
{
  const rec = await openRecommendation();
  for (const status of ["escalated", "needs_more_evidence", "escalated"]) {
    equal((await decide(rec, status)).status, 201, `Case 7: ${status} before a terminal Decision succeeds`);
    equal((await persisted(rec)).status, "proposed", `Case 7: ${status} keeps the Recommendation open`);
  }
  equal((await decide(rec, "accepted")).status, 201, "Case 7: a later terminal Decision still succeeds");
  assertConflict(await decide(rec, "escalated"), "Case 7: escalation after acceptance");
  const state = await persisted(rec);
  equal(state.history.join(), "escalated,needs_more_evidence,escalated,accepted", "Case 7: lineage intact and ordered");
  assertCoherent(state, "Case 7");
  await assertNotInNeedsYou(rec, "Case 7");
}

// Case 8: competing concurrent Decisions over HTTP
const ROUNDS = [
  ["accepted", "rejected"],
  ["accepted", "accepted"],
  ["accepted", "rejected", "modified", "accepted", "rejected", "modified", "accepted", "rejected"],
  ["escalated", "accepted", "needs_more_evidence", "rejected", "escalated"],
];
let concurrentRuns = 0;
for (const spec of ROUNDS) {
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const rec = await openRecommendation();
    const outcomes = await Promise.all(spec.map((status) => decide(rec, status)));
    const label = `Case 8 [${spec}] #${repeat + 1}`;
    for (const outcome of outcomes) {
      check(outcome.status === 201 || outcome.status === 409, `${label}: every caller gets 201 or a controlled 409 (got ${outcome.status} ${outcome.raw})`);
      if (outcome.status === 409) assertConflict(outcome, label);
    }
    const winners = spec.filter((status, index) => TERMINAL.has(status) && outcomes[index].status === 201);
    equal(winners.length, 1, `${label}: exactly one terminal Decision establishes authority`);
    const state = await persisted(rec);
    equal(state.status, winners[0], `${label}: Recommendation carries the winning Decision`);
    assertCoherent(state, label);
    concurrentRuns += 1;
  }
}

console.log(`P2 decision-integrity live verifier PASS: ${assertions} assertions; ${concurrentRuns} concurrent rounds.`);
console.log("Fixtures are UUID-tagged DEMO / FIXTURE rows in the disposable local database only.");
