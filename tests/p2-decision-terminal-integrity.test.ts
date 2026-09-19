/**
 * P2 Recommendation -> Decision terminal-integrity repair.
 *
 * Defect A: a second terminal Decision died on `operational_decision_terminal_recommendation_uidx`
 * and the API answered a generic 500. Defect B: a non-terminal Decision recorded after a terminal
 * one returned the Recommendation to `proposed`.
 *
 * Executed here: the conflict vocabulary, and the attention / Needs You read model over the
 * persisted shapes before and after the repair. Structural: the forward migration. The route is
 * executed end-to-end in tests/module-mocks/p2-decision-terminal-integrity-route.test.mjs, and the
 * database behaviour (sequential and concurrent) by scripts/check-p2-decision-integrity-db.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import type { OperationalSummary } from "../src/lib/operational-flow/types";
import { OPERATIONAL_FLOW_CONFLICTS, resolveOperationalFlowConflict } from "../src/lib/operational-flow/conflict-contract";
import {
  buildCanonicalAttention,
  selectPendingAttention,
  TERMINAL_DECISION_STATUSES,
  NON_TERMINAL_DECISION_STATUSES,
} from "../src/modules/workspace/presentation/command-center/attention-read-model";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MIGRATION_FILE = "20260911000000_p2_decision_terminal_integrity.sql";
const migration = read(`supabase/migrations/${MIGRATION_FILE}`);
const originalLoop = read("supabase/migrations/20260611000000_operational_evidence_decision_loop.sql");
/** SQL with comments removed, so structural assertions test code rather than prose. */
const code = migration.replace(/--.*$/gm, "");
const functionBody = code.slice(code.indexOf("create or replace function public.record_operational_decision"), code.indexOf("end $$;"));

// ───────────────────────────── conflict vocabulary (executed) ─────────────────────────────

const RAW_PRE_REPAIR_ERROR =
  'record_operational_decision: duplicate key value violates unique constraint "operational_decision_terminal_recommendation_uidx"';

for (const [label, raw] of [
  ["the repaired RPC's domain signal", "record_operational_decision: operational_decision_already_terminal"],
  ["the raw pre-repair unique-index violation (Defect A)", RAW_PRE_REPAIR_ERROR],
] as const) {
  test(`terminal integrity: ${label} resolves to the stable 409 contract`, () => {
    const resolved = resolveOperationalFlowConflict(raw);
    assert.ok(resolved, "must be recognised as a domain conflict, not fall through to 500");
    assert.equal(resolved.code, "recommendation_already_decided");
    assert.equal(resolved.recovery, "reload_recorded_decision");
    for (const leak of [
      /record_operational_decision/,
      /operational_decision/,
      /uidx|duplicate key|constraint|unique|postgres|sql|relation/i,
      /recommended_actions|operational_decision_records/,
    ]) {
      assert.ok(!leak.test(resolved.message), `client message must not contain ${leak}`);
    }
    assert.match(resolved.message, /already has a final Decision/);
    assert.match(resolved.message, /not been changed/);
    assert.match(resolved.message, /Reload/);
  });
}

test("terminal integrity: the signal is anchored, so a longer token does not match", () => {
  assert.equal(resolveOperationalFlowConflict("xoperational_decision_already_terminal"), null);
  assert.equal(resolveOperationalFlowConflict("operational_decision_already_terminals"), null);
  // Unrelated decision errors keep their existing status ladder.
  assert.equal(resolveOperationalFlowConflict("record_operational_decision: operational_decision_authority_denied:read_only_role"), null);
  assert.equal(resolveOperationalFlowConflict("record_operational_decision: governed_recommendation_not_found"), null);
});

test("terminal integrity: the signal the migration raises is the one the contract maps", () => {
  const raised = [...functionBody.matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(raised.includes("operational_decision_already_terminal"));
  assert.ok(OPERATIONAL_FLOW_CONFLICTS.operational_decision_already_terminal);
});

// ───────────────────────────── forward migration (structural) ─────────────────────────────

test("terminal integrity: the repair is the latest definition of record_operational_decision", () => {
  const definers = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => /create or replace function public\.record_operational_decision\s*\(/.test(read(`supabase/migrations/${file}`)));
  assert.equal(definers.at(-1), MIGRATION_FILE);
});

test("terminal integrity: signature, security model and grants are unchanged", () => {
  assert.match(functionBody, /p_recommendation_id uuid,\s*p_manual_evidence_item_id uuid,\s*p_decision text,\s*p_decision_status text,\s*p_rationale text\s*\) returns jsonb language plpgsql security definer set search_path = public as \$\$/);
  assert.match(code, /revoke execute on function public\.record_operational_decision\(uuid,uuid,text,text,text\) from public, anon;/);
  assert.match(code, /grant execute on function public\.record_operational_decision\(uuid,uuid,text,text,text\) to authenticated, service_role;/);
});

test("terminal integrity: the Recommendation row is locked BEFORE terminal state is checked and before any write", () => {
  const lock = functionBody.indexOf("from public.recommended_actions where id=a.id for update");
  const check = functionBody.indexOf("raise exception 'operational_decision_already_terminal'");
  const insert = functionBody.indexOf("insert into public.operational_decision_records");
  const update = functionBody.indexOf("update public.recommended_actions");
  assert.ok(lock > 0, "a row lock serialises concurrent Decisions on one Recommendation");
  assert.ok(lock < check && check < insert && insert < update);
  // Authority is still evaluated first; the lock is not taken on behalf of a denied caller.
  assert.ok(functionBody.indexOf("operational_authority_evaluation") < lock);
});

test("terminal integrity: both terminal signals close the Recommendation, for every Decision status", () => {
  const guard = functionBody.slice(functionBody.indexOf("for update"), functionBody.indexOf("raise exception 'operational_decision_already_terminal'"));
  assert.match(guard, /a\.status is distinct from 'proposed'/);
  assert.match(guard, /decision_status in \('accepted','rejected','modified'\)/);
  // The guard is not conditioned on the incoming status: an escalation is refused too.
  assert.doesNotMatch(guard, /p_decision_status/);
  assert.deepEqual([...TERMINAL_DECISION_STATUSES], ["accepted", "rejected", "modified"]);
  assert.deepEqual([...NON_TERMINAL_DECISION_STATUSES], ["escalated", "needs_more_evidence"]);
});

test("terminal integrity: the unique index is kept and translated, never weakened", () => {
  assert.match(originalLoop, /create unique index if not exists operational_decision_terminal_recommendation_uidx\s+on public\.operational_decision_records\(recommendation_id\)\s+where recommendation_id is not null and decision_status in \('accepted','rejected','modified'\);/);
  assert.doesNotMatch(code, /drop\s+(index|table|constraint|policy|trigger)|alter\s+table|delete\s+from|truncate/i);
  assert.match(functionBody, /exception when unique_violation then\s+get stacked diagnostics violated_constraint = constraint_name;\s+if violated_constraint = 'operational_decision_terminal_recommendation_uidx' then\s+raise exception 'operational_decision_already_terminal';\s+end if;\s+raise;/);
});

test("terminal integrity: Decision history is stamped after the lock so it orders by commit", () => {
  assert.match(functionBody, /authority_evaluation,created_at\)\s+values\([^;]*,clock_timestamp\(\)\)/);
  assert.match(functionBody, /decided_at=d\.created_at/);
});

// ───────────────────────────── Needs You / read model (executed) ─────────────────────────────

const decisionRow = (id: string, status: string, createdAt: string) => ({
  id, recommendation_id: "rec-1", governance_event_id: "gov-1", decision_status: status,
  decision: `Recommendation ${status}`, rationale: "P2 terminal-integrity regression", decided_by: "user-1",
  authority_basis: "owner workspace authority (PMFreak role mapping v1)", created_at: createdAt,
});

function summary(recommendationStatus: string, decisions: Array<Record<string, unknown>>): OperationalSummary {
  return {
    sources: [], rawInputs: [], normalizedEvents: [],
    evidence: [{ id: "ev-1", title: "DEMO / FIXTURE evidence", fixture_state: "DEMO_FIXTURE" }],
    signals: [{ id: "sig-1", evidence_item_id: "ev-1", signal_type: "scope_creep", severity: "high" }],
    risksIssues: [{ id: "risk-1", signal_id: "sig-1", type: "change", status: "open" }],
    governanceEvents: [{ id: "gov-1", related_entity_id: "risk-1", authority_required: "baseline review", governance_status: "decision_required" }],
    recommendations: [{ id: "rec-1", governance_event_id: "gov-1", risk_issue_id: "risk-1", recommendation: "Confirm scope", status: recommendationStatus, actor_authority: {} }],
    decisions, evidenceLinks: [], materialActions: [], materialActionEvaluations: [], outcomes: [], observations: [], lineages: [],
    assurance: {
      scope: "project", workspaceId: "ws-1", projectId: "pr-1", asOf: "2026-09-18T10:00:00.000Z",
      totalGovernanceEvents: 1, decisionRequiredCount: 1, violationsCount: 0, openRecommendations: recommendationStatus === "proposed" ? 1 : 0,
      unresolvedRisksIssues: 1, evidenceLinkedDecisionsCount: decisions.length, evidenceWithoutSignalCount: 0, incompleteChainCount: 0,
    },
    actor: { role: "owner", canCreateEvidence: true },
  } as OperationalSummary;
}

test("Needs You: escalation before a terminal Decision keeps the item open (Case 7, first half)", () => {
  const items = buildCanonicalAttention(summary("proposed", [decisionRow("d-esc", "escalated", "2026-09-18T09:00:00.000Z")]));
  assert.equal(items[0].state, "awaiting_decision");
  assert.equal(selectPendingAttention(items).length, 1);
});

test("Needs You: persisted post-repair state after escalation then acceptance is decided and coherent", () => {
  const items = buildCanonicalAttention(summary("accepted", [
    decisionRow("d-esc", "escalated", "2026-09-18T09:00:00.000Z"),
    decisionRow("d-acc", "accepted", "2026-09-18T09:05:00.000Z"),
  ]));
  assert.equal(items[0].state, "decided");
  assert.equal(items[0].recommendationStatus, "accepted");
  assert.equal(items[0].terminalDecision?.decisionId, "d-acc");
  // Lineage stays visible, newest first, and the terminal Decision is the latest word.
  assert.deepEqual(items[0].decisions.map((d) => d.decisionStatus), ["accepted", "escalated"]);
  assert.equal(selectPendingAttention(items).length, 0);
});

test("Needs You: a refused later escalation leaves the persisted state — and the queue — unchanged", () => {
  // The repaired RPC writes nothing on refusal, so the persisted shape is exactly the
  // pre-attempt one: one terminal Decision and a terminal Recommendation.
  for (const status of ["accepted", "rejected", "modified"]) {
    const items = buildCanonicalAttention(summary(status, [decisionRow("d-1", status, "2026-09-18T09:00:00.000Z")]));
    assert.equal(items[0].state, "decided");
    assert.equal(items[0].decisions.length, 1);
    assert.equal(selectPendingAttention(items).length, 0, `${status} must not re-enter Needs You`);
  }
});

test("Needs You: a row reopened by the pre-repair defect still does not re-enter the queue", () => {
  // Historical Defect B shape, which the repair does not rewrite: terminal Decision first, a later
  // escalation, and the Recommendation back at `proposed`. The read model keys on the canonical
  // terminal Decision, so the contradictory status alone cannot put it back in front of the PM.
  const items = buildCanonicalAttention(summary("proposed", [
    decisionRow("d-acc", "accepted", "2026-09-18T09:00:00.000Z"),
    decisionRow("d-esc", "escalated", "2026-09-18T09:05:00.000Z"),
  ]));
  assert.equal(items[0].state, "decided");
  assert.equal(items[0].terminalDecision?.decisionStatus, "accepted");
  assert.equal(selectPendingAttention(items).length, 0);
});
