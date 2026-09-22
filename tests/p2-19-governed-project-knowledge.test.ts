/**
 * P2-19 — Governed Ratification, Revocation and Learning Review.
 *
 * Behavioural tests for: the three governance actions in the REAL in-process policy evaluator
 * (evaluateGovernanceAction over GOVERNANCE_POLICY_REGISTRY, with a membership port that applies
 * the real RBAC map); the real runtime-consumer fail-closed path when authority is unavailable;
 * fail-closed classification of every non-ALLOW decision; route sequencing with injected
 * dependencies (nothing is written before ALLOW); the pure read mappers; the review UI states
 * rendered from views produced by the REAL mappers; and source-level invariants of the
 * migration. Database-side behaviour — authority re-derivation, stale review, current support,
 * terminal reviews, races, idempotency, revocation, retrieval exclusions, the direct-DML
 * boundary — is proven against the disposable local stack by scripts/check-p2-19-db.mts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GOVERNANCE_POLICY_REGISTRY, evaluateGovernanceAction } from "@/lib/governance/authority/runtime/governance-core";
import type { RuntimeContext } from "@/lib/governance/authority/runtime/context";
import { GovernanceAccessDeniedError } from "@/lib/governance/authority/ports/access-verification";
import { ROLE_PERMISSION_MAP, type Permission, type WorkspaceRole } from "@/lib/security/rbac";
import { classifyKnowledgeGovernanceDecision, deriveKnowledgeEffectiveState, toProjectKnowledgeView, toProjectKnowledgeReviewView } from "@/lib/project-knowledge/views";
import { parseValidity, ratifyLearningCandidate, retrieveProjectKnowledge, revokeProjectKnowledge } from "@/lib/project-knowledge/project-knowledge-service";
import { KNOWLEDGE_LIMITATION_STATEMENTS, type ProjectKnowledgeRecordRow, type ProjectKnowledgeReviewRow, type ReviewCommandResult } from "@/lib/project-knowledge/types";
import { toLearningCandidateView } from "@/lib/learning-candidates/eligibility";
import type { LearningCandidateRow, LearningCandidateSourceRow, LearningCandidateView } from "@/lib/learning-candidates/types";
import { handlePostLearningReview, type LearningReviewRouteDeps } from "@/app/api/learning-candidates/review/route";
import { handlePostRevokeKnowledge } from "@/app/api/project-knowledge/revoke/route";
import { handleGetProjectKnowledge } from "@/app/api/project-knowledge/route";
import { LearningReviewView, validateRatifyRequest, type LearningReviewLoadState } from "@/components/pmfreak/learning-review/learning-review-panel";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/20260915000000_p2_19_governed_project_knowledge.sql");
const u = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
const WS = u("a1");
const PROJECT = u("b1");
const CANDIDATE = u("c1");
const KNOWLEDGE = u("e1");
const DIGEST = "a".repeat(64);
const EVAL = "2026-10-20T12:00:00.000Z";
const EVAL_MS = Date.parse(EVAL);

// ── The real in-process governance evaluator ─────────────────────────────────────────────

const KNOWLEDGE_ACTIONS = ["knowledge.ratify", "knowledge.reject", "knowledge.revoke"] as const;

function runtimeFor(role: string | null) {
  const audit: Array<{ type: string }> = [];
  const denied = (reason: string) => { throw new GovernanceAccessDeniedError("denied", { reason }); };
  const normalized = role === "pm" ? "PM" : role === "viewer" ? "external_stakeholder" : role;
  const requirePermission = async (_scope: string, permission: string) => {
    if (!normalized) denied("missing_membership");
    if (!ROLE_PERMISSION_MAP[normalized as WorkspaceRole]?.has(permission as Permission)) denied("role_missing_permission");
    return { role: normalized as string };
  };
  const runtime = {
    securityAudit: { logEvent: async (type: string) => { audit.push({ type }); } },
    accessVerification: {
      requireWorkspaceMembership: async () => (normalized ? { role: normalized } : denied("missing_membership")),
      requireProjectPermission: requirePermission,
      requireGovernancePermission: requirePermission,
      requireAgentScope: async () => denied("agent_scope"),
    },
    agentAttestation: { verifyAttestation: async () => denied("attestation") },
  } as unknown as RuntimeContext;
  return { runtime, audit };
}

const evaluate = (role: string | null, action: (typeof KNOWLEDGE_ACTIONS)[number], extra: Record<string, unknown> = {}) =>
  evaluateGovernanceAction(runtimeFor(role).runtime, {
    actorType: "user", actorUserId: u("f1"), workspaceId: WS, projectId: PROJECT, action, routeId: "/test",
    resourceType: "canonical_learning_candidate", resourceId: CANDIDATE, ...extra,
  } as Parameters<typeof evaluateGovernanceAction>[1]);

test("the three knowledge actions are registered with the ratified policy shape", () => {
  for (const action of KNOWLEDGE_ACTIONS) {
    const policy = GOVERNANCE_POLICY_REGISTRY[action];
    assert.equal(policy.requiredPermission, "manage_workspace", action);
    assert.deepEqual(policy.allowedActorTypes, ["user"], action);
    assert.equal(policy.agentCompatible, false, action);
    assert.equal(policy.workspaceScoped, true, action);
    assert.equal(policy.denyEventType, "governance_violation", action);
  }
  assert.deepEqual(KNOWLEDGE_ACTIONS.map((a) => GOVERNANCE_POLICY_REGISTRY[a].riskLevel), ["critical", "high", "critical"]);
  // manage_workspace is held by owner and admin only.
  const holders = (Object.keys(ROLE_PERMISSION_MAP) as WorkspaceRole[]).filter((r) => ROLE_PERMISSION_MAP[r].has("manage_workspace")).sort();
  assert.deepEqual(holders, ["admin", "owner"]);
});

test("in-process runtime: owner and admin ALLOW; PM, viewer and non-members DENY with governance_violation", async () => {
  for (const action of KNOWLEDGE_ACTIONS) {
    for (const role of ["owner", "admin"]) {
      const decision = await evaluate(role, action);
      assert.equal(decision.allowed, true, `${role} ${action}`);
      assert.equal(decision.decision, "allow");
      assert.ok(decision.decisionId);
      assert.equal(classifyKnowledgeGovernanceDecision(action, decision).kind, "allow");
    }
    for (const role of ["pm", "viewer", "contributor", "executive_viewer", null]) {
      const { runtime, audit } = runtimeFor(role);
      const decision = await evaluateGovernanceAction(runtime, { actorType: "user", actorUserId: u("f1"), workspaceId: WS, projectId: PROJECT, action, routeId: "/test" });
      assert.equal(decision.allowed, false, `${role} ${action}`);
      assert.equal(decision.auditEventType, "governance_violation");
      assert.equal(classifyKnowledgeGovernanceDecision(action, decision).kind, "deny");
      assert.deepEqual(audit.map((a) => a.type), ["governance_violation"]);
    }
  }
});

test("in-process runtime: AI agents and system actors can never ratify, reject or revoke", async () => {
  for (const action of KNOWLEDGE_ACTIONS) {
    const agent = await evaluate("owner", action, { actorType: "ai_agent", actorAgentId: u("a9") });
    assert.equal(agent.allowed, false);
    assert.match(agent.reason, /cannot execute/);
    const system = await evaluate("owner", action, { actorType: "system", systemActor: "trusted_webhook" });
    assert.equal(system.allowed, false);
    const noWorkspace = await evaluate("owner", action, { workspaceId: null });
    assert.equal(noWorkspace.allowed, false);
    assert.match(noWorkspace.reason, /workspace scope is missing/);
  }
});

test("knowledge actions are not delegable", () => {
  const source = read("src/lib/governance/authority/runtime/delegated-capabilities.ts");
  assert.match(source, /FORBIDDEN = new Set\(\[[^\]]*"knowledge\.ratify", "knowledge\.reject", "knowledge\.revoke"\]\)/);
});

test("real runtime-consumer: an unavailable authority fails closed as unavailable", async () => {
  const previous = process.env.AOC_RUNTIME_AUTHORITY_PROVIDER;
  process.env.AOC_RUNTIME_AUTHORITY_PROVIDER = "external_sdk";
  try {
    const { authorizeRuntimeAction, buildEnterpriseRuntimeRequest } = await import("@/aoc/runtime-consumer");
    const decision = await authorizeRuntimeAction(buildEnterpriseRuntimeRequest({
      user: { id: u("f1") } as never, action: "knowledge.ratify", routeId: "/test", workspaceId: WS, projectId: PROJECT,
    }));
    assert.equal(decision.allowed, false);
    const outcome = classifyKnowledgeGovernanceDecision("knowledge.ratify", decision as never);
    assert.equal(outcome.kind, "unavailable");
  } finally {
    if (previous === undefined) delete process.env.AOC_RUNTIME_AUTHORITY_PROVIDER;
    else process.env.AOC_RUNTIME_AUTHORITY_PROVIDER = previous;
  }
});

test("classification: only an explicit ALLOW with an id and time authorises; everything else fails closed", () => {
  const ok = classifyKnowledgeGovernanceDecision("knowledge.revoke", { allowed: true, decision: "allow", decisionId: "d1", evaluatedAt: EVAL });
  assert.deepEqual(ok, { kind: "allow", reference: { action: "knowledge.revoke", decision: "allow", decisionId: "d1", evaluatedAt: EVAL, contract: "pmfreak.aoc-e.in-process-governance.v1" } });
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: false, decision: "deny", decisionId: "d2" }).kind, "deny");
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: false, decision: "require_admin_approval", decisionId: "d3" }).kind, "approval_required");
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: true, decision: "require_human_approval", decisionId: "d3" }).kind, "approval_required");
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: false, reason: "runtime_dependency_unavailable", decisionId: "runtime_consumer_fail_closed_x" }).kind, "unavailable");
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", null).kind, "unavailable");
  // A malformed allow (no id / no time) is never treated as ALLOW.
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: true, decision: "allow", decisionId: "", evaluatedAt: EVAL }).kind, "unavailable");
  assert.equal(classifyKnowledgeGovernanceDecision("knowledge.ratify", { allowed: true, decision: "allow", decisionId: "d", evaluatedAt: "nope" }).kind, "unavailable");
});

// ── Fixtures built through the real mappers ──────────────────────────────────────────────

function candidateRow(overrides: Partial<LearningCandidateRow> = {}): LearningCandidateRow {
  return {
    id: CANDIDATE, workspace_id: WS, project_id: PROJECT, candidate_kind: "canonical_outcome_pattern",
    pattern_key: `canonical-outcome-pattern:v1:${"b".repeat(64)}`,
    pattern_signature: { signalType: "decision_required", recommendedActionType: "decide", actionClass: "external_write" },
    status: "proposed", evidence_tier: "single_lineage", lineage_count: 1, independent_lineage_count: 1,
    result_counts: { achieved: 1 }, confidence_score: "0.9000", confidence_method: "weakest_linked_observation:v1",
    causality_claim: "correlation_only", limitations: ["correlation_only", "structural_independence_only", "confidence_is_weakest_observation", "not_ratified"],
    version: 2, evidence_digest: DIGEST, evaluator: "pmfreak/learning-candidate-eligibility:v1", fixture_label: null,
    created_by: u("f1"), created_at: EVAL, updated_at: EVAL, last_evaluated_at: EVAL, last_evaluated_by: u("f1"),
    ...overrides,
  };
}

function sourceRow(overrides: Partial<LearningCandidateSourceRow> = {}): LearningCandidateSourceRow {
  return {
    id: u("5a"), candidate_id: CANDIDATE, workspace_id: WS, project_id: PROJECT, outcome_id: u("6a"), observation_id: u("7a"),
    task_id: u("8a"), internal_execution_id: u("9a"), action_id: u("10a"), governance_evaluation_id: u("11a"), decision_id: u("12a"),
    recommendation_id: u("13a"), finding_id: u("14a"), finding_evidence_item_id: u("15a"), observation_evidence_ids: [u("16a")],
    observed_result: "achieved", observation_confidence: "0.9000", valid_until: null, correlation_id: "corr", causation_id: null,
    evaluated_at: EVAL, linked_by: u("f1"), recorded_at: EVAL, superseded_at: null, superseded_by_source_id: null,
    ...overrides,
  };
}

function candidateView(options: { supported?: boolean; version?: number } = {}): LearningCandidateView {
  const supported = options.supported ?? true;
  return toLearningCandidateView(candidateRow({ version: options.version ?? 2 }), [sourceRow()], {
    evaluatedAtMs: EVAL_MS,
    latestObservationIdByOutcome: new Map([[u("6a"), supported ? u("7a") : u("7b")]]),
    currentEvidenceIds: new Set([u("16a")]),
  });
}

function knowledgeRow(overrides: Partial<ProjectKnowledgeRecordRow> = {}): ProjectKnowledgeRecordRow {
  return {
    id: KNOWLEDGE, workspace_id: WS, project_id: PROJECT, candidate_id: CANDIDATE, candidate_version: 2, candidate_evidence_digest: DIGEST,
    review_id: u("d1"), review_outcome: "ratified", knowledge_kind: "canonical_outcome_pattern",
    pattern_key: `canonical-outcome-pattern:v1:${"b".repeat(64)}`,
    pattern_signature: { signalType: "decision_required", recommendedActionType: "decide", actionClass: "external_write" },
    statement: "In this project, the pattern … Observed correlation only; it does not establish causation.",
    evidence_tier: "single_lineage", lineage_count: 1, independent_lineage_count: 1, result_counts: { achieved: 1 },
    confidence_score: "0.9000", confidence_method: "weakest_linked_observation:v1", causality_claim: "correlation_only",
    limitations: ["correlation_only", "applies_to_source_project_only", "ratification_is_not_causal_evidence"],
    source_ids: [u("5a")], applicability_scope: "source_project", status: "active", validity_mode: "until_revoked",
    effective_from: EVAL, effective_until: null, ratified_at: EVAL, ratified_by: u("f1"), ratification_governance_decision_id: "gov-1",
    version: 1, revoked_at: null, revoked_by: null, revocation_reason: null, revocation_governance_decision_id: null,
    revocation_governance_evaluated_at: null, fixture_label: null, created_at: EVAL, updated_at: EVAL,
    ...overrides,
  };
}

function reviewRow(overrides: Partial<ProjectKnowledgeReviewRow> = {}): ProjectKnowledgeReviewRow {
  return {
    id: u("d1"), workspace_id: WS, project_id: PROJECT, candidate_id: CANDIDATE, candidate_version: 2, candidate_evidence_digest: DIGEST,
    review_outcome: "ratified", reviewed_by: u("f1"), reviewer_role: "owner", reviewed_at: EVAL, candidate_created_by: u("f1"),
    candidate_last_evaluated_by: u("f1"), reviewer_is_candidate_creator: true, reviewed_summary: {}, causality_claim: "correlation_only",
    limitations: ["correlation_only"], rationale: "Holds here.", governance_action: "knowledge.ratify", governance_decision_id: "gov-1",
    governance_decision_state: "allow", governance_contract: "pmfreak.aoc-e.in-process-governance.v1", governance_evaluated_at: EVAL,
    fixture_label: null, recorded_at: EVAL,
    ...overrides,
  };
}

// ── Pure mappers and validity ────────────────────────────────────────────────────────────

test("effective state: revocation is persisted; expiry is derived at the read clock", () => {
  assert.equal(deriveKnowledgeEffectiveState(knowledgeRow(), EVAL_MS), "active");
  assert.equal(deriveKnowledgeEffectiveState(knowledgeRow({ status: "revoked" }), EVAL_MS), "revoked");
  assert.equal(deriveKnowledgeEffectiveState(knowledgeRow({ validity_mode: "until_date", effective_until: "2026-10-20T12:00:01.000Z" }), EVAL_MS), "active");
  assert.equal(deriveKnowledgeEffectiveState(knowledgeRow({ validity_mode: "until_date", effective_until: EVAL }), EVAL_MS), "expired");
});

test("the knowledge view keeps correlation-only, applicability and every limitation statement", () => {
  const view = toProjectKnowledgeView(knowledgeRow({ limitations: ["correlation_only", "applies_to_source_project_only", "unknown_code"] }), EVAL_MS);
  assert.equal(view.causalityClaim, "correlation_only");
  assert.equal(view.applicabilityScope, "source_project");
  assert.equal(view.elevationInferred, false);
  assert.equal(view.limitations[1].statement, KNOWLEDGE_LIMITATION_STATEMENTS.applies_to_source_project_only);
  assert.match(view.limitations[2].statement, /kept verbatim/);
  const review = toProjectKnowledgeReviewView(reviewRow());
  assert.equal(review.reviewerIsCandidateCreator, true);
});

test("validity: an explicit choice is required; no default duration exists", () => {
  assert.deepEqual(parseValidity("until_revoked", null), { validityMode: "until_revoked", effectiveUntil: null });
  assert.deepEqual(parseValidity("until_date", "2027-01-01T00:00:00.000Z"), { validityMode: "until_date", effectiveUntil: "2027-01-01T00:00:00.000Z" });
  for (const [mode, until] of [[undefined, undefined], [null, null], ["forever", null], ["until_revoked", "2027-01-01"], ["until_date", null], ["until_date", "not-a-date"]]) {
    assert.throws(() => parseValidity(mode, until), /project_knowledge_validity_invalid/, `${String(mode)} / ${String(until)}`);
  }
  const now = new Date(EVAL);
  const base = { candidate: candidateView(), rationale: "Keep it.", expiresOn: "" };
  assert.deepEqual(validateRatifyRequest({ ...base, validityMode: "until_revoked" }, now), { ok: true, effectiveUntil: null });
  assert.equal(validateRatifyRequest({ ...base, validityMode: null }, now).ok, false);
  assert.equal(validateRatifyRequest({ ...base, rationale: "  ", validityMode: "until_revoked" }, now).ok, false);
  assert.equal(validateRatifyRequest({ ...base, validityMode: "until_date", expiresOn: "" }, now).ok, false);
  assert.equal(validateRatifyRequest({ ...base, validityMode: "until_date", expiresOn: "2026-10-19" }, now).ok, false);
  assert.equal(validateRatifyRequest({ ...base, validityMode: "until_date", expiresOn: "2026-12-01" }, now).ok, true);
});

// ── Service (recording fake client) ──────────────────────────────────────────────────────

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpcResult = Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) });
  return { calls, client: { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; } } as never };
}

const allowRef = (action: "knowledge.ratify" | "knowledge.reject" | "knowledge.revoke") => ({ action, decision: "allow" as const, decisionId: "gov-1", evaluatedAt: EVAL, contract: "pmfreak.aoc-e.in-process-governance.v1" as const });

test("service: ratification passes the exact reviewed state, the explicit validity and the ALLOW reference", async () => {
  const { calls, client } = fakeClient({ data: { disposition: "ratified", review: reviewRow(), knowledge: knowledgeRow(), eventId: u("ee") }, error: null });
  const result = await ratifyLearningCandidate(client, { workspaceId: WS, projectId: PROJECT },
    { candidateId: CANDIDATE, candidateVersion: 2, candidateEvidenceDigest: DIGEST, rationale: "  Holds here. ", validityMode: "until_revoked", effectiveUntil: null },
    allowRef("knowledge.ratify"), { evaluatedAt: EVAL });
  assert.equal(result.disposition, "ratified");
  assert.deepEqual(calls[0], { fn: "ratify_canonical_learning_candidate", args: {
    p_workspace_id: WS, p_project_id: PROJECT, p_candidate_id: CANDIDATE, p_candidate_version: 2, p_candidate_evidence_digest: DIGEST,
    p_rationale: "Holds here.", p_validity_mode: "until_revoked", p_effective_until: null, p_governance: allowRef("knowledge.ratify"),
  } });
  // Never without an ALLOW for the exact action, and never success without the event.
  await assert.rejects(ratifyLearningCandidate(client, { workspaceId: WS, projectId: PROJECT },
    { candidateId: CANDIDATE, candidateVersion: 2, candidateEvidenceDigest: DIGEST, rationale: "x", validityMode: "until_revoked", effectiveUntil: null },
    allowRef("knowledge.reject") as never, { evaluatedAt: EVAL }), /project_knowledge_governance_required/);
  const noEvent = fakeClient({ data: { disposition: "ratified", review: reviewRow(), knowledge: knowledgeRow() }, error: null });
  await assert.rejects(ratifyLearningCandidate(noEvent.client, { workspaceId: WS, projectId: PROJECT },
    { candidateId: CANDIDATE, candidateVersion: 2, candidateEvidenceDigest: DIGEST, rationale: "x", validityMode: "until_revoked", effectiveUntil: null },
    allowRef("knowledge.ratify"), { evaluatedAt: EVAL }), /project_knowledge_result_malformed/);
});

test("service: revocation and retrieval", async () => {
  const revoked = fakeClient({ data: { disposition: "already_revoked", knowledge: knowledgeRow({ status: "revoked", revoked_at: EVAL, revoked_by: u("f1"), revocation_reason: "r", revocation_governance_decision_id: "g", revocation_governance_evaluated_at: EVAL, version: 2 }) }, error: null });
  const result = await revokeProjectKnowledge(revoked.client, { workspaceId: WS, projectId: PROJECT }, { knowledgeId: KNOWLEDGE, reason: "No longer holds" }, allowRef("knowledge.revoke"), { evaluatedAt: EVAL });
  assert.deepEqual([result.disposition, result.eventId, result.knowledge.effectiveState], ["already_revoked", null, "revoked"]);
  await assert.rejects(revokeProjectKnowledge(revoked.client, { workspaceId: WS, projectId: PROJECT }, { knowledgeId: KNOWLEDGE, reason: " " }, allowRef("knowledge.revoke"), { evaluatedAt: EVAL }), /rationale_required/);
  // Retrieval: defence in depth drops anything the contract excludes, and a full page fails closed.
  const rows = [knowledgeRow(), knowledgeRow({ id: u("e2"), status: "revoked" }), knowledgeRow({ id: u("e3"), fixture_label: "DEMO / FIXTURE" }), knowledgeRow({ id: u("e4"), project_id: u("b2") })];
  const listed = await retrieveProjectKnowledge(fakeClient({ data: rows, error: null }).client, { workspaceId: WS, projectId: PROJECT }, { evaluatedAt: EVAL });
  assert.deepEqual(listed.map((k) => k.id), [KNOWLEDGE]);
  await assert.rejects(retrieveProjectKnowledge(fakeClient({ data: Array.from({ length: 1000 }, () => knowledgeRow()), error: null }).client, { workspaceId: WS, projectId: PROJECT }, { evaluatedAt: EVAL }), /read_truncated/);
});

// ── Route sequencing: nothing is written before governance allows it ──────────────────────

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const reviewBody = (extra: Record<string, unknown> = {}) => ({
  workspaceId: WS, projectId: PROJECT, candidateId: CANDIDATE, candidateVersion: 2, candidateEvidenceDigest: DIGEST,
  decision: "ratify", rationale: "Holds here.", validityMode: "until_revoked", effectiveUntil: null, ...extra,
});

function reviewDeps(options: { candidate?: LearningCandidateView | null; governance?: "allow" | "deny" | "approval_required" | "unavailable"; result?: ReviewCommandResult } = {}) {
  const log: string[] = [];
  const deps: Partial<LearningReviewRouteDeps> = {
    authorize: async () => { log.push("authorize"); return { ok: true, user: { id: u("f1") } as never, role: "owner", client: {} as never }; },
    resolveCandidate: (async () => { log.push("resolve"); return { evaluatedAt: EVAL, truncated: false, candidates: options.candidate === null ? [] : [options.candidate ?? candidateView()] }; }) as never,
    evaluateGovernance: async ({ action }) => {
      log.push(`governance:${action}`);
      const kind = options.governance ?? "allow";
      return kind === "allow" ? { kind, reference: allowRef(action as "knowledge.ratify") } : { kind, decisionId: "gov-x", decision: "require_admin_approval" } as never;
    },
    ratify: (async () => { log.push("ratify"); return options.result ?? { disposition: "ratified", review: toProjectKnowledgeReviewView(reviewRow()), knowledge: toProjectKnowledgeView(knowledgeRow(), EVAL_MS), eventId: u("ee") }; }) as never,
    reject: (async () => { log.push("reject"); return options.result ?? { disposition: "rejected", review: toProjectKnowledgeReviewView(reviewRow({ review_outcome: "rejected" })), knowledge: null, eventId: u("ee") }; }) as never,
    now: () => new Date(EVAL),
  };
  return { deps, log };
}

test("route: authenticate → resolve → support → governance → write, in that order", async () => {
  const { deps, log } = reviewDeps();
  const response = await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), deps);
  assert.equal(response.status, 201);
  assert.deepEqual(log, ["authorize", "resolve", "governance:knowledge.ratify", "ratify"]);
  const reject = reviewDeps();
  assert.equal((await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody({ decision: "reject", validityMode: undefined })), reject.deps)).status, 201);
  assert.deepEqual(reject.log, ["authorize", "resolve", "governance:knowledge.reject", "reject"]);
});

test("route: every non-ALLOW governance result writes nothing", async () => {
  for (const [kind, status, disposition] of [["deny", 403, "governance_denied"], ["approval_required", 403, "governance_approval_required"], ["unavailable", 503, "governance_unavailable"]] as const) {
    const { deps, log } = reviewDeps({ governance: kind });
    const response = await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), deps);
    assert.equal(response.status, status, kind);
    assert.equal((await response.json()).disposition, disposition);
    assert.ok(!log.includes("ratify") && !log.includes("reject"), `${kind}: no write`);
  }
});

test("route: validation, scope, unsupported and stale dispositions", async () => {
  // Validation happens before any authorization or read.
  for (const body of [reviewBody({ validityMode: undefined }), reviewBody({ rationale: " " }), reviewBody({ candidateVersion: "2" }), reviewBody({ candidateEvidenceDigest: "x" }), reviewBody({ decision: "approve" }), reviewBody({ validityMode: "until_date", effectiveUntil: "2026-10-19T00:00:00.000Z" })]) {
    const { deps, log } = reviewDeps();
    assert.equal((await handlePostLearningReview(post("/api/learning-candidates/review", body), deps)).status, 400, JSON.stringify(body));
    assert.deepEqual(log, []);
  }
  const unauth = reviewDeps();
  unauth.deps.authorize = async () => ({ ok: false, status: 401 });
  assert.equal((await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), unauth.deps)).status, 401);
  // A candidate outside the claimed scope is not found — before governance.
  const missing = reviewDeps({ candidate: null });
  assert.equal((await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), missing.deps)).status, 404);
  assert.deepEqual(missing.log, ["authorize", "resolve"]);
  // An unsupported current candidate is refused before governance.
  const unsupported = reviewDeps({ candidate: candidateView({ supported: false }) });
  const refused = await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), unsupported.deps);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).disposition, "not_supported");
  assert.deepEqual(unsupported.log, ["authorize", "resolve"]);
  // A stale reviewed state is decided by the database (replay vs stale), after governance.
  const stale = reviewDeps({ candidate: candidateView({ version: 3 }), result: { disposition: "stale_review", currentVersion: 3, currentEvidenceDigest: DIGEST } });
  const staleResponse = await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), stale.deps);
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).disposition, "stale_review");
  // Database refusals map to stable failure classes without provider text.
  const raced = reviewDeps();
  raced.deps.ratify = (async () => { throw new Error("project_knowledge_rpc_failed: project_knowledge_authority_denied"); }) as never;
  const racedResponse = await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), raced.deps);
  assert.equal(racedResponse.status, 403);
  assert.equal((await racedResponse.json()).failureClass, "project_knowledge_authority_denied");
  const internal = reviewDeps();
  internal.deps.ratify = (async () => { throw new Error("project_knowledge_rpc_failed: deadlock detected at pg internals"); }) as never;
  const internalBody = await (await handlePostLearningReview(post("/api/learning-candidates/review", reviewBody()), internal.deps)).json();
  assert.doesNotMatch(JSON.stringify(internalBody), /deadlock|pg internals/);
});

test("revoke route: governance before the write; unknown records are 404", async () => {
  const log: string[] = [];
  const fakeRecordClient = (found: boolean) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: found ? { id: KNOWLEDGE } : null, error: null }) }) }) }) }) }) }) as never;
  const deps = (found: boolean, governance: "allow" | "deny") => ({
    authorize: async () => ({ ok: true as const, user: { id: u("f1") } as never, role: "admin", client: fakeRecordClient(found) }),
    evaluateGovernance: async () => { log.push("governance"); return governance === "allow" ? { kind: "allow" as const, reference: allowRef("knowledge.revoke") } : { kind: "deny" as const, decisionId: null }; },
    revoke: (async () => { log.push("revoke"); return { disposition: "revoked", knowledge: toProjectKnowledgeView(knowledgeRow({ status: "revoked" }), EVAL_MS), eventId: u("ee") }; }) as never,
    now: () => new Date(EVAL),
  });
  const body = { workspaceId: WS, projectId: PROJECT, knowledgeId: KNOWLEDGE, reason: "No longer holds" };
  assert.equal((await handlePostRevokeKnowledge(post("/api/project-knowledge/revoke", body), deps(true, "deny"))).status, 403);
  assert.deepEqual(log.splice(0), ["governance"]);
  assert.equal((await handlePostRevokeKnowledge(post("/api/project-knowledge/revoke", body), deps(false, "allow"))).status, 404);
  assert.deepEqual(log.splice(0), []);
  assert.equal((await handlePostRevokeKnowledge(post("/api/project-knowledge/revoke", { ...body, reason: "" }), deps(true, "allow"))).status, 400);
  assert.equal((await handlePostRevokeKnowledge(post("/api/project-knowledge/revoke", body), deps(true, "allow"))).status, 200);
  assert.deepEqual(log.splice(0), ["governance", "revoke"]);
});

test("knowledge GET: authoritative list and history are separate; canGovern is owner/admin only", async () => {
  const run = async (role: string) => (await handleGetProjectKnowledge(new NextRequest(`http://localhost/api/project-knowledge?workspaceId=${WS}&projectId=${PROJECT}`), {
    authorize: async () => ({ ok: true, user: { id: u("f1") } as never, role, client: {} as never }),
    retrieve: async () => [toProjectKnowledgeView(knowledgeRow(), EVAL_MS)],
    history: async () => ({ evaluatedAt: EVAL, records: [toProjectKnowledgeView(knowledgeRow(), EVAL_MS), toProjectKnowledgeView(knowledgeRow({ id: u("e2"), status: "revoked" }), EVAL_MS)], reviews: [] }),
    now: () => new Date(EVAL),
  })).json();
  const owner = await run("owner");
  assert.deepEqual([owner.knowledge.length, owner.history.records.length, owner.canGovern], [1, 2, true]);
  assert.equal((await run("admin")).canGovern, true);
  assert.equal((await run("pm")).canGovern, false);
  assert.equal((await run("viewer")).canGovern, false);
});

// ── UI states (react-dom/server over views from the real mappers) ────────────────────────

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (state: LearningReviewLoadState, feedback: Parameters<typeof LearningReviewView>[0]["feedback"] = null) =>
  renderToStaticMarkup(createElement(LearningReviewView, { state, feedback }));
const ready = (overrides: Partial<Extract<LearningReviewLoadState, { kind: "ready" }>> = {}): LearningReviewLoadState => ({
  kind: "ready", candidates: [candidateView()], knowledge: [], records: [], reviews: [], canGovern: true, ...overrides,
});

test("UI: loading, denied and error states", () => {
  assert.match(text(render({ kind: "loading" })), /Loading learning candidates/);
  assert.match(render({ kind: "denied" }), /data-testid="learning-review-denied"/);
  assert.match(text(render({ kind: "error", message: "Project knowledge could not be loaded." })), /could not be loaded/);
});

test("UI: an owner sees the candidate contract and terminal controls with no preselected validity", () => {
  const html = render(ready());
  const t = text(html);
  for (const fragment of ["Candidate — not knowledge", "Version 2", "Evidence tier: Single lineage", "Lineages: 1 (1 structurally independent)", "Observed results: 1 achieved", "Confidence: 90% (weakest_linked_observation:v1)", "Summary reflects current sources: yes", "Source project: this project", "Applicability: this project only", "Correlation only", "Until revoked", "Expires on date"]) {
    assert.ok(t.includes(fragment), `renders ${fragment}`);
  }
  assert.match(html, /data-testid="learning-review-ratify"/);
  assert.match(html, /data-testid="learning-review-reject"/);
  assert.doesNotMatch(html, /checked=""/, "no validity choice is preselected");
  assert.doesNotMatch(t, /apply to (all projects|workspace|enterprise)/i, "no widening controls");
});

test("UI: a PM can inspect but gets no terminal controls", () => {
  const html = render(ready({ canGovern: false, knowledge: [toProjectKnowledgeView(knowledgeRow(), EVAL_MS)] }));
  assert.doesNotMatch(html, /learning-review-ratify|learning-review-reject|learning-review-revoke"/);
  assert.match(html, /data-testid="learning-review-read-only"/);
  assert.match(html, /data-testid="learning-review-knowledge"/);
});

test("UI: candidate, rejected version, ratified knowledge and revoked knowledge are distinct", () => {
  const rejected = render(ready({ reviews: [toProjectKnowledgeReviewView(reviewRow({ review_outcome: "rejected", governance_action: "knowledge.reject", reviewer_is_candidate_creator: true }))] }));
  assert.match(rejected, /data-testid="learning-review-state-rejected"/);
  assert.doesNotMatch(rejected, /learning-review-ratify/, "a finalised version offers no further terminal control");
  assert.match(text(rejected), /the reviewer also created this candidate/);
  assert.doesNotMatch(text(rejected), /independent review/i);
  const revokedRecord = toProjectKnowledgeView(knowledgeRow({ status: "revoked", revoked_at: EVAL, revoked_by: u("f1"), revocation_reason: "Stopped holding", revocation_governance_decision_id: "g", revocation_governance_evaluated_at: EVAL, version: 2 }), EVAL_MS);
  const expiredRecord = toProjectKnowledgeView(knowledgeRow({ id: u("e3"), validity_mode: "until_date", effective_until: "2026-10-01T00:00:00.000Z" }), EVAL_MS);
  const html = render(ready({ knowledge: [toProjectKnowledgeView(knowledgeRow({ id: u("e2") }), EVAL_MS)], records: [revokedRecord, expiredRecord] }));
  assert.match(html, /data-testid="learning-review-knowledge"/);
  assert.match(html, /data-testid="learning-review-knowledge-revoked"/);
  assert.match(html, /data-testid="learning-review-knowledge-expired"/);
  assert.match(text(html), /Revoked or expired knowledge \(history, not in effect\)/);
  // A ratified version whose knowledge was revoked says so on the candidate card too.
  const ratifiedThenRevoked = render(ready({ reviews: [toProjectKnowledgeReviewView(reviewRow())], records: [revokedRecord] }));
  assert.match(ratifiedThenRevoked, /data-testid="learning-review-state-ratified"/);
  assert.match(text(ratifiedThenRevoked), /Knowledge revoked — not in effect/);
});

test("UI: stale, denied, governance-unavailable, validation and success feedback", () => {
  const cases = [
    [{ kind: "stale", currentVersion: 3 }, /changed since you opened it \(now version 3\)\. Nothing was recorded/],
    [{ kind: "denied" }, /Only a workspace owner or admin/],
    [{ kind: "governance_unavailable" }, /Governance is unavailable, so nothing was recorded/],
    [{ kind: "validation", message: "Give a reason for this decision." }, /Give a reason/],
    [{ kind: "ratified" }, /does not establish causation/],
    [{ kind: "not_supported" }, /no longer current/],
  ] as const;
  for (const [feedback, pattern] of cases) assert.match(text(render(ready(), feedback as never)), pattern);
});

// ── Migration invariants ─────────────────────────────────────────────────────────────────

test("migration: direct DML revoked from every client role, including service_role", () => {
  for (const table of ["canonical_learning_candidate_reviews", "canonical_project_knowledge_records"]) {
    assert.match(MIGRATION, new RegExp(`revoke all on public\\.${table} from anon, authenticated, service_role;`));
    assert.match(MIGRATION, new RegExp(`grant select on public\\.${table} to authenticated, service_role;`));
  }
  assert.doesNotMatch(MIGRATION, /grant (insert|update|delete|all)/i);
});

test("migration: one terminal review per exact state; knowledge only from a ratified review; one active per candidate", () => {
  assert.match(MIGRATION, /unique \(candidate_id, candidate_version, candidate_evidence_digest\)/);
  assert.match(MIGRATION, /review_outcome text not null default 'ratified'\s+check \(review_outcome = 'ratified'\)/);
  assert.match(MIGRATION, /on public\.canonical_project_knowledge_records \(candidate_id\)\s+where status = 'active'/);
  assert.match(MIGRATION, /check \(applicability_scope = 'source_project'\)/);
  assert.match(MIGRATION, /check \(status in \('active', 'revoked'\)\)/);
  assert.match(MIGRATION, /check \(validity_mode in \('until_revoked', 'until_date'\)\)/);
});

test("migration: no TTL, no Candidate status change, no cross-workspace path, no generic elevation change", () => {
  assert.doesNotMatch(MIGRATION, /interval\s+'\d+/i, "no duration literal");
  assert.doesNotMatch(MIGRATION, /(30|90|180|365) days/i);
  assert.doesNotMatch(MIGRATION, /alter table public\.canonical_learning_candidates/i, "P2-18 table is not altered");
  assert.doesNotMatch(MIGRATION, /update public\.canonical_learning_candidates/i, "the Candidate is never mutated");
  assert.doesNotMatch(MIGRATION, /material_action_proposals|knowledge_elevation'/, "the generic Material Action path is untouched");
  // The generic class stays hard-denied in the application and the P2-06 RPC.
  assert.match(read("src/lib/operational-flow/operational-flow-service.ts"), /input\.actionClass === "knowledge_elevation" \? "denied"/);
  assert.match(read("supabase/migrations/20260903000000_p2_06_governed_decision_to_action.sql"), /when p_proposal->>'actionClass' = 'knowledge_elevation' then 'denied'/);
});

test("migration: commands take the lock, check staleness and support, and use the database clock", () => {
  const ratify = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.ratify_canonical_learning_candidate"), MIGRATION.indexOf("create or replace function public.reject_canonical_learning_candidate"));
  const order = ["canonical_project_knowledge_assert_authority", "for update", "'duplicate'", "'stale_review'", "canonical_learning_candidate_current_support", "'already_ratified'", "insert into public.canonical_learning_candidate_reviews", "insert into public.canonical_project_knowledge_records", "insert into public.platform_events"];
  let at = -1;
  for (const marker of order) {
    const next = ratify.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} after the previous step`);
    at = next;
  }
  assert.match(ratify, /v_now timestamptz := now\(\)/);
  assert.match(ratify, /p_effective_until <= v_now/);
  assert.match(MIGRATION, /learning_eligible, raw_reference_table[\s\S]*?false,/);
});
