import type { SupabaseClient } from "@supabase/supabase-js";
import { canCreateOperationalEvidence, evaluateOperationalDecisionAuthority, type OperationalWorkspaceRole } from "./authority";
import type {
  AuditReconstructionItem,
  CanonicalOutcomeObservationState,
  CanonicalTaskOutcomeState,
  CompleteLineageProjection,
  DecisionStatus,
  DeriveEvidenceInput,
  EnsureExpectedOutcomeInput,
  EvidenceProvenanceResult,
  LineageLinkRelationship,
  LineageStepKind,
  LineageStepNode,
  LineageTransition,
  OperationalSummary,
  RecordOutcomeObservationInput,
} from "./types";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "@/lib/observability/logger";
import { authorizeFronteraDispatch } from "@/lib/integrations/frontera";
import type { FronteraEnforcementDeps } from "@/lib/integrations/frontera";
import {
  createPMFreakMaterialActionProposal,
  evaluatePMFreakMaterialActionGovernance,
  type PMFreakMaterialActionProposalInput,
  type PMFreakMaterialActionClass,
} from "@/features/pmfreak-integrations/aoc-governance-request-client";

export const SIGNAL_DETECTOR_KEY = "system/deterministic:governance_signal_detector_v1";

/**
 * Explicit governance_state -> lineage integrity mapping. The 10 keys are exactly the
 * check constraint on material_action_governance_evaluations.governance_state
 * (supabase/migrations/20260903000000_p2_06_governed_decision_to_action.sql).
 *
 * Fail safe: any state NOT in this table — including a future state added to the
 * constraint before this map is updated — resolves to "degraded", never "intact".
 * can_execute is deliberately not consulted: it is constrained to false and carries
 * no integrity signal.
 */
const GOVERNANCE_STATE_INTEGRITY: Record<string, "intact" | "disputed" | "degraded"> = {
  authorized: "intact",
  not_required: "intact",
  denied: "disputed",
  revoked: "disputed",
  requires_review: "degraded",
  requires_approval: "degraded",
  expired: "degraded",
  stale: "degraded",
  unavailable: "degraded",
  degraded: "degraded",
};

/**
 * platform_events.correlation_id is uuid; canonical_outcome_observations.correlation_id and
 * canonical_task_outcomes.correlation_id are text. A legitimate non-uuid correlation id must
 * not make the platform_events query raise 22P02. Canonical 8-4-4-4-12 form only: a value
 * this pattern rejects is treated as "cannot match a uuid column", never sent as a filter.
 */
const UUID_CANONICAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Client = SupabaseClient;
type Scope = { workspaceId: string; projectId: string; userId: string; role?: OperationalWorkspaceRole | null };
export type CaptureOperationalInput = {
  sourceKey: string;
  idempotencyKey: string;
  title: string;
  content: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string | null;
  externalId?: string | null;
};

function requireValue(value: string | undefined | null, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }, operation: string): T {
  if (result.error || result.data === null) throw new Error(`${operation}: ${result.error?.message ?? "no_data"}`);
  return result.data;
}

export async function deriveEvidence(client: Client, scope: Scope, input: DeriveEvidenceInput): Promise<EvidenceProvenanceResult> {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("evidence_write_role_denied");
  for (const [value, name] of [[input.normalizedEventId, "normalized_event_id"], [input.idempotencyKey, "idempotency_key"], [input.evaluatedAt, "evaluated_at"]] as const) requireValue(value, name);
  if (!Number.isFinite(input.confidenceScore) || input.confidenceScore < 0 || input.confidenceScore > 1) throw new Error("confidence_score_invalid");
  const evaluatedAt = new Date(input.evaluatedAt);
  if (Number.isNaN(evaluatedAt.valueOf())) throw new Error("evaluated_at_invalid");
  const staleAt = input.staleAt ? new Date(input.staleAt) : null;
  if (staleAt && Number.isNaN(staleAt.valueOf())) throw new Error("stale_at_invalid");
  const result = await client.rpc("derive_operational_evidence", {
    p_workspace_id: scope.workspaceId, p_project_id: scope.projectId,
    p_normalized_event_id: input.normalizedEventId, p_idempotency_key: input.idempotencyKey.trim(),
    p_assertion_type: input.assertionType, p_classification: input.classification,
    p_confidence_score: input.confidenceScore, p_missing_data_state: input.missingDataState,
    p_evaluated_at: evaluatedAt.toISOString(), p_stale_at: staleAt?.toISOString() ?? null,
  });
  return unwrap(result, "derive_operational_evidence") as EvidenceProvenanceResult;
}

export async function captureOperationalInput(client: Client, scope: Scope, input: CaptureOperationalInput) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("intake_write_role_denied");
  for (const [value, name] of [[input.sourceKey, "source_key"], [input.idempotencyKey, "idempotency_key"], [input.title, "title"], [input.content, "content"], [input.occurredAt, "occurred_at"], [input.correlationId, "correlation_id"]] as const) requireValue(value, name);
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.valueOf())) throw new Error("occurred_at_invalid");
  const result = await client.rpc("capture_operational_input", {
    p_workspace_id: scope.workspaceId, p_project_id: scope.projectId,
    p_source_key: input.sourceKey.trim(), p_idempotency_key: input.idempotencyKey.trim(),
    p_title: input.title.trim(), p_content: input.content.trim(), p_occurred_at: occurredAt.toISOString(),
    p_correlation_id: input.correlationId, p_causation_id: input.causationId || null, p_external_id: input.externalId?.trim() || null,
  });
  return unwrap(result, "capture_operational_input") as Record<string, unknown>;
}

/**
 * P2-14 — capture a genuinely LIVE operational input.
 *
 * Delegates wholesale to the verified P2-09 `capture_live_operational_input` contract.
 * That RPC owns every canonical semantic and none of it is reimplemented here:
 *
 *   - it resolves or creates a NON-fixture Source (`is_fixture = false`), which is the
 *     only reason the Evidence later derived from this event becomes `fixture_state =
 *     'LIVE'` and therefore Observation-eligible under P2-09;
 *   - it refuses an existing fixture Source with `intake_source_fixture_prohibited`, so
 *     a DEMO / FIXTURE source key can never be laundered into live provenance;
 *   - it enforces `auth.uid()` and `can_write_operational_project` inside the database,
 *     under RLS, independently of this layer;
 *   - it writes Raw Input -> Normalized Event with real sha256 digests under its own
 *     idempotency contract.
 *
 * Evidence is deliberately NOT created here. `evidenceCreated` is false in the contract's
 * own response, and LIVE Evidence is derived from the returned Normalized Event through
 * the existing verified P2-04 `derive_operational_evidence` path — exactly as the
 * DEMO / FIXTURE capture does. Capture and derivation remain separate transitions;
 * collapsing them would erase the Raw Input != Normalized Event != Evidence boundary.
 */
export async function captureLiveOperationalInput(client: Client, scope: Scope, input: CaptureOperationalInput) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("intake_write_role_denied");
  for (const [value, name] of [[input.sourceKey, "source_key"], [input.idempotencyKey, "idempotency_key"], [input.title, "title"], [input.content, "content"], [input.occurredAt, "occurred_at"], [input.correlationId, "correlation_id"]] as const) requireValue(value, name);
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.valueOf())) throw new Error("occurred_at_invalid");
  const result = await client.rpc("capture_live_operational_input", {
    p_workspace_id: scope.workspaceId, p_project_id: scope.projectId,
    p_source_key: input.sourceKey.trim(), p_idempotency_key: input.idempotencyKey.trim(),
    p_title: input.title.trim(), p_content: input.content.trim(), p_occurred_at: occurredAt.toISOString(),
    p_correlation_id: input.correlationId, p_causation_id: input.causationId || null, p_external_id: input.externalId?.trim() || null,
  });
  return unwrap(result, "capture_live_operational_input") as Record<string, unknown>;
}

export async function runEvidenceDecisionChain(client: Client, scope: Scope, evidenceItemId: string) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("operational_chain_role_denied");
  const result = await client.rpc("materialize_operational_chain", { p_evidence_item_id: requireValue(evidenceItemId, "evidence_item_id") });
  if (result.error) {
    await client.rpc("record_operational_chain_failure", { p_evidence_item_id: evidenceItemId, p_error_message: result.error.message });
    throw new Error(`materialize_operational_chain: ${result.error.message}`);
  }
  return result.data as { evidenceItemId: string; detector: string; chain: Array<Record<string, unknown>>; agentRunId: string };
}

export async function recordHumanDecision(client: Client, scope: Scope, input: {
  recommendationId?: string | null;
  manualEvidenceItemId?: string | null;
  decision: string;
  decisionStatus: DecisionStatus;
  rationale: string;
}) {
  const result = await client.rpc("record_operational_decision", {
    p_recommendation_id: input.recommendationId || null,
    p_manual_evidence_item_id: input.manualEvidenceItemId || null,
    p_decision: requireValue(input.decision, "decision"),
    p_decision_status: input.decisionStatus,
    p_rationale: requireValue(input.rationale, "rationale"),
  });
  return unwrap(result, "record_operational_decision") as Record<string, unknown>;
}

export type ProposeMaterialActionInput = {
  decisionId: string;
  idempotencyKey: string;
  actionClass: PMFreakMaterialActionClass;
  actionType: string;
  targetResourceType: string;
  targetResourceId: string;
  intendedOperation: string;
  intendedEffect: string;
  risk: "low" | "medium" | "high" | "critical" | "unknown";
  reversibility: "reversible" | "partially_reversible" | "irreversible" | "unknown";
  sideEffect: "internal" | "external" | "authority" | "knowledge" | "unknown";
  justification: string;
  /**
   * Governance-window timestamps. OPTIONAL, and deliberately not supplied by any browser
   * caller: `expires_at` is enforced against database `now()`, so a client clock two hours
   * behind would persist Actions that are already expired, and one two hours ahead would
   * silently extend the authorization by the skew. When omitted, this function derives
   * them from the server clock — see `resolveMaterialActionWindow`.
   *
   * Server-side callers (tests, fixtures) may still pin them explicitly.
   */
  createdAt?: string;
  evaluationTime?: string;
  expiresAt?: string;
};

/** The authorization window P2-06 grants. Server-owned; no client may widen or narrow it. */
export const MATERIAL_ACTION_WINDOW_MS = 60 * 60 * 1000;

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** P2-06 ends at a persisted, inert authorization record. */
/**
 * The effective governance window for this proposal, on trusted server time.
 *
 * A retry must re-send byte-identical `createdAt`/`expiresAt`, because both are folded
 * into the proposal digest that `persist_governed_material_action` compares for the
 * idempotency key — a fresh reading would turn an idempotent replay into
 * `material_action_idempotency_conflict`. So the already-persisted row is authoritative
 * whenever one exists for this key, and the server clock is consulted only for a genuinely
 * first submission. That is what lets the client stop sending wall time without losing
 * retry stability.
 */
async function resolveMaterialActionWindow(
  client: Client,
  scope: Scope,
  input: ProposeMaterialActionInput
): Promise<{ createdAt: Date; evaluationTime: Date; expiresAt: Date }> {
  const now = new Date();
  // An explicit window is a server-side caller pinning time (tests, fixtures). Browser
  // callers do not supply one; the API route does not forward client values.
  if (input.createdAt && input.expiresAt) {
    const createdAt = new Date(input.createdAt);
    const expiresAt = new Date(input.expiresAt);
    const evaluationTime = new Date(input.evaluationTime ?? input.createdAt);
    if ([createdAt, evaluationTime, expiresAt].some((value) => Number.isNaN(value.valueOf()))) {
      throw new Error("material_action_timestamp_invalid");
    }
    return { createdAt, evaluationTime, expiresAt };
  }

  // Scoped to this workspace AND this project. `persist_governed_material_action` treats
  // (workspace_id, idempotency_key) as the uniqueness scope, so this lookup is deliberately
  // NARROWER than the authoritative one: a key belonging to another project is simply not
  // found here, a fresh window is minted, and the RPC then answers
  // `material_action_idempotency_conflict` — fail-closed, and no other project's persisted
  // timestamps can ever be read into this proposal. RLS independently restricts the read to
  // projects the actor can access.
  const existing = await client.from("material_action_proposals")
    .select("created_at,expires_at")
    .eq("workspace_id", scope.workspaceId)
    .eq("project_id", scope.projectId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  const persistedCreatedAt = existing?.data?.created_at ? new Date(String(existing.data.created_at)) : null;
  const persistedExpiresAt = existing?.data?.expires_at ? new Date(String(existing.data.expires_at)) : null;
  if (
    persistedCreatedAt && persistedExpiresAt &&
    !Number.isNaN(persistedCreatedAt.valueOf()) && !Number.isNaN(persistedExpiresAt.valueOf())
  ) {
    // Replay: reuse the persisted window so the digest matches exactly.
    return { createdAt: persistedCreatedAt, evaluationTime: now, expiresAt: persistedExpiresAt };
  }

  return { createdAt: now, evaluationTime: now, expiresAt: new Date(now.getTime() + MATERIAL_ACTION_WINDOW_MS) };
}

export async function proposeGovernedMaterialAction(client: Client, scope: Scope, input: ProposeMaterialActionInput) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("material_action_write_denied");
  const { createdAt, evaluationTime, expiresAt } = await resolveMaterialActionWindow(client, scope, input);

  const { data: decision, error: decisionError } = await client.from("operational_decision_records")
    .select("id,workspace_id,project_id,decided_by,decision_status,recommendation_id,governance_event_id,created_at")
    .eq("id", requireValue(input.decisionId, "decision_id")).eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId).maybeSingle();
  if (decisionError || !decision || !["accepted", "modified"].includes(String(decision.decision_status))) throw new Error("material_action_source_decision_ineligible");
  if (String(decision.decided_by) !== scope.userId) throw new Error("material_action_decision_actor_mismatch");

  const { data: links, error: linksError } = await client.from("decision_evidence_links")
    .select("evidence_item_id,evidence_hash_at_decision,evidence_version_at_decision").eq("decision_record_id", input.decisionId);
  if (linksError || !links?.length) throw new Error("material_action_evidence_required");

  const role = String(scope.role);
  const isApprover = role === "owner" || role === "admin";
  const policyReference = decision.governance_event_id ? `pmfreak-governance-event:${decision.governance_event_id}` : null;
  const approvalReferences = isApprover ? [`workspace-role-approval:${role}:${scope.userId}`] : [];
  const requiredApprovalCount = input.actionClass === "ordinary_business_write" ? 0 : 1;
  const proposalInput: PMFreakMaterialActionProposalInput = {
    actionId: deterministicUuid(`${scope.workspaceId}:${input.idempotencyKey}`), workspaceId: scope.workspaceId, projectId: scope.projectId,
    originatingSubjectType: "decision", originatingSubjectId: input.decisionId, decisionReferenceId: input.decisionId,
    sourceCorrelationId: `decision:${input.decisionId}`, causationId: input.decisionId,
    evidenceReferenceIds: links.map((link) => String(link.evidence_item_id)), recommendationReferenceIds: decision.recommendation_id ? [String(decision.recommendation_id)] : [],
    actionClass: input.actionClass, actionType: input.actionType, targetResourceType: input.targetResourceType, targetResourceId: input.targetResourceId,
    intendedOperation: input.intendedOperation, intendedEffect: input.intendedEffect, risk: input.risk, reversibility: input.reversibility,
    sideEffect: input.sideEffect, proposedActorId: scope.userId, accountableActorId: scope.userId, requiredApprovalCount,
    justification: input.justification, policySnapshotReference: policyReference, grantReference: `workspace-role-grant:${role}:${scope.userId}`,
    createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), idempotencyKey: input.idempotencyKey, fixture: null,
  };
  const proposal = createPMFreakMaterialActionProposal(proposalInput);

  const initialState = input.actionClass === "knowledge_elevation" ? "denied" : proposal.materiality === "unknown" ? "degraded" : proposal.materiality === "ordinary" ? "not_required" : policyReference ? (isApprover ? "authorized" : "requires_approval") : "unavailable";
  const evidence = {
    evaluationId: randomUUID(), evaluatedAt: evaluationTime.toISOString(), evaluatorActorId: "aoc-e:in-process:v1", state: initialState as "degraded" | "not_required" | "authorized" | "unavailable" | "denied" | "requires_approval",
    policyDecisionReference: policyReference ?? undefined, grantReference: proposal.grantReference ?? undefined,
    obligationReferenceIds: proposal.obligationReferenceIds ?? [], approvalReferenceIds: approvalReferences,
    validUntil: expiresAt.toISOString(), reasonCodes: [initialState === "authorized" ? "in_process_policy_allow" : `in_process_${initialState}`],
  };
  const evaluation = evaluatePMFreakMaterialActionGovernance(proposal, evidence, evaluationTime);
  const persistenceEvaluation = { ...evaluation.evidence, state: evaluation.state, canCommitAction: evaluation.canCommitAction,
    grantReferenceIds: evaluation.evidence.grantReference ? [evaluation.evidence.grantReference] : [], contractVersion: "pmfreak.aoc-e.in-process-governance.v1",
    evaluatorKind: "aoc_e_in_process", canExecute: false };
  const persist = async (candidate: ReturnType<typeof createPMFreakMaterialActionProposal>, evaluationPayload: Record<string, unknown>) => {
    const attempt = await client.rpc("persist_governed_material_action", { p_proposal: candidate, p_evaluation: evaluationPayload });
    if (attempt.error || !attempt.data) throw new Error(`persist_governed_material_action:${attempt.error?.message ?? "no_data"}`);
    return attempt.data as Record<string, unknown> & { disposition?: string };
  };

  let data = await persist(proposal, persistenceEvaluation);

  /**
   * Recover a CONCURRENT retry of the same logical submission.
   *
   * The advisory lock lives inside the RPC, so two requests carrying the same attempt key
   * can both miss the pre-flight window lookup, each derive its own `now`, and produce
   * different digests. The loser is then told `material_action_idempotency_conflict` for
   * what is the same submission.
   *
   * Recovery normalises ONLY the two server-generated timestamps: reload the persisted
   * row, rebuild this proposal on its `created_at`/`expires_at`, and recompute the digest.
   * Because `canonicalProposal` folds every business field plus those timestamps, equality
   * after that substitution means the business intent is byte-identical — the digest is the
   * contract's own comparator, so this cannot drift from it. Anything else is a genuine
   * conflict and stays one.
   *
   * Exactly one recovery attempt, never a loop.
   */
  if (data.disposition === "conflict") {
    const persisted = await client.from("material_action_proposals")
      .select("created_at,expires_at,proposal_digest")
      .eq("workspace_id", scope.workspaceId)
      .eq("project_id", scope.projectId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    const row = persisted?.data as { created_at?: string; expires_at?: string; proposal_digest?: string } | null | undefined;
    if (row?.created_at && row?.expires_at && row?.proposal_digest) {
      const reconciled = createPMFreakMaterialActionProposal({
        ...proposalInput,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      });
      if (reconciled.deterministicDigest === row.proposal_digest) {
        // Same submission, different wall-clock reading. Replay it under the persisted window.
        data = await persist(reconciled, {
          ...persistenceEvaluation,
          validUntil: new Date(row.expires_at).toISOString(),
        });
      }
    }
  }

  return { ...data, authorizationMessage: "Authorized does not mean Executed.", taskMessage: "No task has been created.", dispatchMessage: "No action has been dispatched.", remoteAocMessage: "Remote AOC writeback is not enabled." } as Record<string, unknown> & { disposition?: string };
}

/**
 * P0-PKG-06. The Frontera enforcement boundary sits here, and only here.
 *
 * Frontera is asked BEFORE the dispatch RPC because the RPC is the side
 * effect: it is where the Task is created, under the advisory lock and the
 * unique expression index that make one governed Action yield at most one
 * Task. A denial arriving after it would have nothing left to prevent.
 *
 * Frontera is asked on EVERY dispatch attempt, including one PMFreak would
 * itself refuse. A pre-check that skipped the Frontera call for an
 * apparently-ineligible action was considered and rejected twice over: it
 * would restate PMFreak governance semantics outside the RPC that owns them,
 * and — worse — it would open a hole, because an action that looked
 * ineligible at read time but passed the RPC's own re-check a moment later
 * would then dispatch having never been authorized at all. Asking every time
 * costs one read-only evaluation and has neither problem.
 *
 * Composition is conjunction, and Frontera can only narrow:
 *
 *     PMFREAK_DENY  + FRONTERA_ALLOW  = DENY   (the RPC still refuses)
 *     PMFREAK_ALLOW + FRONTERA_DENY   = DENY   (the RPC is never reached)
 *     PMFREAK_ALLOW + FRONTERA_ALLOW  = dispatch
 *
 * A Frontera ALLOW is never sufficient on its own: it does not skip, relax or
 * pre-satisfy a single PMFreak precondition, all of which the RPC re-checks
 * inside its own transaction afterwards.
 */
export type DispatchGovernedActionDeps = {
  /** Test seam. Production uses the packaged Frontera runtime. */
  readonly authorizeDispatch?: typeof authorizeFronteraDispatch;
  readonly fronteraDeps?: FronteraEnforcementDeps;
};

export async function dispatchGovernedMaterialActionToTask(
  client: Client,
  scope: Scope,
  input: { actionId: string; expectedProposalDigest?: string | null },
  deps: DispatchGovernedActionDeps = {},
) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("action_task_write_denied");

  const actionId = requireValue(input.actionId, "action_id");
  const expectedProposalDigest = input.expectedProposalDigest?.trim() || null;
  if (expectedProposalDigest && !/^[a-f0-9]{64}$/.test(expectedProposalDigest)) {
    throw new Error("action_task_expected_digest_invalid");
  }

  const authorize = deps.authorizeDispatch ?? authorizeFronteraDispatch;
  const frontera = await authorize(
    {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      principalUserId: scope.userId,
      actionId,
    },
    deps.fronteraDeps,
  );

  // Fail closed. Denial, revocation, an unbound principal, an unreachable or
  // corrupt store, a kernel error and a malformed result all land here, and
  // none of them reaches the RPC.
  if (!frontera.allowed) {
    // Frontera's reason codes and any infrastructure diagnostic stay server-side.
    // They are what an operator needs and precisely what an arbitrary client
    // should not be told about another system's authority structure; the
    // caller gets a narrow failure class and nothing further.
    logger.warn("governed material action dispatch refused at the Frontera boundary", {
      routeId: "operational-flow.dispatch_material_action_to_task",
      actionId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      failureClass: frontera.failureClass,
      fronteraReasonCodes: frontera.reasonCodes,
      fronteraDecisionId: frontera.decisionId,
      diagnostic: frontera.diagnostic,
    });
    return {
      disposition: "denied" as const,
      failureClass: frontera.failureClass,
      reason: "frontera_enforcement_denied",
    };
  }

  const result = await client.rpc("dispatch_governed_action_to_internal_task", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_action_id: actionId,
    p_expected_proposal_digest: expectedProposalDigest,
  });

  if (result.error || !result.data) {
    throw new Error(`dispatch_governed_action_to_internal_task:${result.error?.message ?? "no_data"}`);
  }

  // The RPC stays the transaction and idempotency boundary: the Task is created
  // there, once, or not at all. Frontera authorized the attempt; it did not
  // create anything and cannot.
  // Correlation only. The Frontera decision id is an opaque handle that ties
  // this dispatch to Frontera's own audit trail; it is not PMFreak evidence and
  // is not written to any PMFreak table.
  return {
    ...(result.data as Record<string, unknown>),
    fronteraDecisionId: frontera.decisionId,
  } as Record<string, unknown> & {
    disposition?: "created" | "existing" | "conflict" | "denied";
    failureClass?: string;
  };
}

/** P2-06 revocation remains append-only governance evidence. */
export async function revokeGovernedMaterialAction(client: Client, scope: Scope, input: { actionId: string; evaluationTime: string; reasonCode: string }) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("material_action_revoke_denied");
  const evaluationTime = new Date(requireValue(input.evaluationTime, "evaluation_time"));
  if (Number.isNaN(evaluationTime.valueOf())) throw new Error("material_action_timestamp_invalid");
  const result = await client.rpc("revoke_governed_material_action", {
    p_action_id: requireValue(input.actionId, "action_id"), p_evaluation_id: randomUUID(),
    p_evaluated_at: evaluationTime.toISOString(), p_reason_code: requireValue(input.reasonCode, "reason_code"),
  });
  if (result.error || !result.data) throw new Error(`revoke_governed_material_action:${result.error?.message ?? "no_data"}`);
  return result.data as Record<string, unknown>;
}

export async function ensureExpectedOutcome(
  client: Client,
  scope: Scope,
  input: EnsureExpectedOutcomeInput,
) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("outcome_write_denied");
  for (const [value, name] of [
    [input.taskId, "task_id"],
    [input.expectedResult, "expected_result"],
    [input.correlationId, "correlation_id"],
  ] as const) {
    requireValue(value, name);
  }

  const result = await client.rpc("ensure_expected_task_outcome", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_task_id: input.taskId,
    p_expected_result: input.expectedResult.trim(),
    p_success_criteria: input.successCriteria ?? [],
    p_correlation_id: input.correlationId.trim(),
    p_causation_id: input.causationId?.trim() || null,
  });

  return unwrap(result, "ensure_expected_task_outcome") as Record<string, unknown> & {
    disposition: "created" | "existing";
    outcome: Record<string, unknown>;
    achievementInferred: false;
  };
}

export async function recordOutcomeObservation(
  client: Client,
  scope: Scope,
  input: RecordOutcomeObservationInput,
) {
  if (!canCreateOperationalEvidence(scope.role ?? null)) throw new Error("outcome_observation_write_denied");
  for (const [value, name] of [
    [input.outcomeId, "outcome_id"],
    [input.summary, "observation_summary"],
    [input.observedAt, "observed_at"],
    [input.evaluatedAt, "evaluated_at"],
    [input.correlationId, "correlation_id"],
    [input.idempotencyKey, "idempotency_key"],
  ] as const) {
    requireValue(value, name);
  }

  if (!Number.isFinite(input.confidenceScore) || input.confidenceScore < 0 || input.confidenceScore > 1) {
    throw new Error("observation_confidence_invalid");
  }

  if (!Array.isArray(input.evidenceReferenceIds) || input.evidenceReferenceIds.length === 0) {
    throw new Error("observation_evidence_required");
  }

  const observedAt = new Date(input.observedAt);
  const evaluatedAt = new Date(input.evaluatedAt);
  if (Number.isNaN(observedAt.valueOf()) || Number.isNaN(evaluatedAt.valueOf())) {
    throw new Error("observation_timestamp_invalid");
  }
  const staleAt = input.staleAt ? new Date(input.staleAt) : null;
  if (staleAt && Number.isNaN(staleAt.valueOf())) {
    throw new Error("stale_at_invalid");
  }

  const result = await client.rpc("record_canonical_outcome_observation", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_outcome_id: input.outcomeId,
    p_observation_state: input.observationState,
    p_summary: input.summary.trim(),
    p_evidence_reference_ids: input.evidenceReferenceIds,
    p_confidence_score: input.confidenceScore,
    p_missing_data_state: input.missingDataState,
    p_observed_at: observedAt.toISOString(),
    p_evaluated_at: evaluatedAt.toISOString(),
    p_stale_at: staleAt?.toISOString() ?? null,
    p_correlation_id: input.correlationId.trim(),
    p_causation_id: input.causationId?.trim() || null,
    p_idempotency_key: input.idempotencyKey.trim(),
  });

  return unwrap(result, "record_canonical_outcome_observation") as Record<string, unknown> & {
    disposition: "created" | "existing" | "conflict";
    observation?: Record<string, unknown>;
    outcomeState?: string;
  };
}

export async function reconstructAuditTrail(
  client: Client,
  workspaceId: string,
  projectId: string,
  options?: { correlationId?: string; outcomeId?: string; limit?: number },
): Promise<AuditReconstructionItem[]> {
  const limit = options?.limit ?? 100;
  const rowsOrThrow = (
    res: { data: unknown; error: { message: string } | null },
    label: string,
  ): Array<Record<string, unknown>> => {
    if (res.error) throw new Error(`${label}: ${res.error.message}`);
    return (res.data as Array<Record<string, unknown>> | null) ?? [];
  };

  // record_canonical_outcome_observation writes canonical_outcome_observations and updates
  // the outcome state, but emits NO platform_event. Reading platform_events alone therefore
  // omits every canonical outcome observation from the audit trail. Both sources are read
  // here and merged service-side. Nothing is fabricated as an emitted event: reconstructed
  // records are explicitly labelled as canonical-record reconstructions.
  let observationsQuery = client
    .from("canonical_outcome_observations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .order("observed_at", { ascending: true })
    .limit(limit);
  // correlation_id is text on this table and is used verbatim — no uuid coercion, no guard.
  if (options?.correlationId) observationsQuery = observationsQuery.eq("correlation_id", options.correlationId);
  if (options?.outcomeId) observationsQuery = observationsQuery.eq("outcome_id", options.outcomeId);

  const loadPlatformEvents = async (correlationId: string | null) => {
    // uuid column vs text filter value: skip the query rather than raise 22P02. Contributing
    // zero rows is the honest degradation; it is never an assertion that none exist.
    if (correlationId !== null && !UUID_CANONICAL_PATTERN.test(correlationId)) return [];
    let query = client
      .from("platform_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .order("occurred_at", { ascending: true })
      .limit(limit);
    if (correlationId !== null) query = query.eq("correlation_id", correlationId);
    return rowsOrThrow(await query, "reconstruct_audit_trail");
  };

  let observationRows: Array<Record<string, unknown>>;
  let eventRows: Array<Record<string, unknown>>;

  if (options?.outcomeId) {
    // No emitter in this repository tags platform_events with a canonical outcome id:
    // raw_reference_table is only ever operational_raw_inputs / evidence_items /
    // operational_decision_records, and no reachable payload carries one. correlation_id is
    // therefore the ONLY association available without a schema or emission change, and it
    // is correlation, NOT causation. The platform_events side of an outcome-filtered audit
    // is consequently not provably complete; it is deterministic and honestly scoped only.
    const [observationsRes, outcomeRes] = await Promise.all([
      observationsQuery,
      client
        .from("canonical_task_outcomes")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("project_id", projectId)
        .eq("id", options.outcomeId),
    ]);
    observationRows = rowsOrThrow(observationsRes, "reconstruct_audit_trail_observations");
    const outcomeRow = rowsOrThrow(outcomeRes, "reconstruct_audit_trail_outcome")[0];
    const outcomeCorrelationId = outcomeRow ? String(outcomeRow.correlation_id ?? "") : "";
    // Outcome absent from tenant scope, or an explicit correlationId that contradicts the
    // outcome's own: the intersection is empty, so platform_events contributes nothing.
    const contradictsExplicitFilter =
      Boolean(options.correlationId) && options.correlationId !== outcomeCorrelationId;
    eventRows =
      !outcomeCorrelationId || contradictsExplicitFilter ? [] : await loadPlatformEvents(outcomeCorrelationId);
  } else {
    const [observationsRes, events] = await Promise.all([
      observationsQuery,
      loadPlatformEvents(options?.correlationId ?? null),
    ]);
    observationRows = rowsOrThrow(observationsRes, "reconstruct_audit_trail_observations");
    eventRows = events;
  }

  // Under an outcomeId request a platform_event was selected ONLY because it shares the
  // canonical outcome's correlation_id. That selection basis travels with the data instead
  // of living in a source comment. It describes how the row was selected for the requested
  // outcome and is independent of the row's own causation/correlation `relationship`.
  // Observations are not annotated: they carry an exact stored outcome_id relationship.
  const outcomeAssociationMetadata = options?.outcomeId
    ? {
        outcomeAssociation: "correlation_only",
        requestedOutcomeId: options.outcomeId,
        outcomeAssociationComplete: false,
      }
    : {};

  const events: AuditReconstructionItem[] = eventRows.map((row) => ({
    id: String(row.id),
    eventType: String(row.event_type),
    eventCategory: String(row.event_category),
    actorId: (row.actor_id as string | null) ?? null,
    actorType: String(row.actor_type || "user"),
    occurredAt: String(row.occurred_at),
    recordedAt: String(row.created_at || row.occurred_at),
    correlationId: (row.correlation_id as string | null) ?? null,
    causationId: (row.causation_id as string | null) ?? null,
    rawReferenceTable: (row.raw_reference_table as string | null) ?? null,
    rawReferenceId: (row.raw_reference_id as string | null) ?? null,
    payload: (row.event_payload as Record<string, unknown>) ?? {},
    metadata: { ...((row.metadata as Record<string, unknown>) ?? {}), ...outcomeAssociationMetadata },
    relationship: row.causation_id ? "causation" : row.correlation_id ? "correlation_only" : "unlinked",
  }));

  // Forward guard only: no writer in this repository currently emits a platform_event
  // referencing canonical_outcome_observations, so this set is empty against today's data.
  // If one is ever emitted, that event is the record of truth and is not duplicated here.
  const observationsAlreadyEmitted = new Set(
    eventRows
      .filter((row) => row.raw_reference_table === "canonical_outcome_observations")
      .map((row) => String(row.raw_reference_id)),
  );

  const reconstructed: AuditReconstructionItem[] = observationRows
    .filter((obs) => !observationsAlreadyEmitted.has(String(obs.id)))
    .map((obs) => ({
      // Namespaced so a reconstruction can never be mistaken for a platform_events.id.
      id: `canonical_outcome_observations:${String(obs.id)}`,
      eventType: "CANONICAL_OUTCOME_OBSERVATION_RECORDED",
      eventCategory: "operational_assurance",
      actorId: (obs.observed_by as string | null) ?? null,
      // canonical_outcome_observations.observed_by carries no FK and no actor-class
      // constraint, so the schema does not establish an actor type. None is asserted.
      actorType: "unknown",
      // Stored values only — observed_at and recorded_at stay distinct.
      occurredAt: String(obs.observed_at ?? ""),
      recordedAt: String(obs.recorded_at ?? ""),
      correlationId: (obs.correlation_id as string | null) ?? null,
      causationId: (obs.causation_id as string | null) ?? null,
      rawReferenceTable: "canonical_outcome_observations",
      rawReferenceId: String(obs.id),
      payload: {
        outcomeId: obs.outcome_id,
        taskId: obs.task_id,
        observationState: obs.observation_state,
        summary: obs.summary,
        confidenceScore: obs.confidence_score,
        missingDataState: obs.missing_data_state,
        evidenceReferenceIds: obs.evidence_reference_ids,
      },
      metadata: {
        reconstructed: true,
        reconstructedFrom: "canonical_outcome_observations",
        reconstructionReason:
          "record_canonical_outcome_observation emits no platform_event. This audit record is reconstructed from the stored canonical_outcome_observations row and is NOT an emitted platform event.",
        actorAttribution:
          "observed_by is stored without a schema-level actor classification; actor type is not asserted.",
      },
      relationship: obs.causation_id ? "causation" : obs.correlation_id ? "correlation_only" : "unlinked",
    }));

  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  // Deterministic chronological merge, then ONE limit over the COMBINED result. Each source
  // was fetched oldest-first bounded by the same limit, so the first `limit` of the merge is
  // the true oldest-first prefix across both sources. Oldest-first direction preserved
  // (T5 remains unresolved).
  return [...events, ...reconstructed]
    .sort(
      (a, b) =>
        time(a.occurredAt) - time(b.occurredAt) ||
        time(a.recordedAt) - time(b.recordedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/**
 * Deterministic recency ordering for governance evaluations: newest first by
 * evaluated_at, then recorded_at, then id. Row arrival order is never authoritative.
 * Missing/unparseable timestamps sort oldest rather than producing a NaN comparator.
 */
function compareGovernanceEvaluationRecency(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const time = (value: unknown) => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const byEvaluatedAt = time(b.evaluated_at) - time(a.evaluated_at);
  if (byEvaluatedAt !== 0) return byEvaluatedAt;
  const byRecordedAt = time(b.recorded_at) - time(a.recorded_at);
  if (byRecordedAt !== 0) return byRecordedAt;
  return String(b.id ?? "").localeCompare(String(a.id ?? ""));
}

/**
 * Stable ordering for decision_evidence_links. created_at is the link-recording time;
 * evidence_item_id is unique per decision_record_id (unique (decision_record_id,
 * evidence_item_id) — 20260611000000_operational_evidence_decision_loop.sql), so this pair
 * is a strict total order with no possible tie. Database row order is never consulted.
 */
function compareDecisionEvidenceLinkStability(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const time = (value: unknown) => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const byCreatedAt = time(a.created_at) - time(b.created_at);
  if (byCreatedAt !== 0) return byCreatedAt;
  return String(a.evidence_item_id ?? "").localeCompare(String(b.evidence_item_id ?? ""));
}

export async function getCompleteLineageProjection(
  client: Client,
  workspaceId: string,
  projectId: string,
  options?: { outcomeId?: string; taskId?: string },
): Promise<CompleteLineageProjection[]> {
  const [
    outcomesRes,
    observationsRes,
    tasksRes,
    executionsRes,
    actionsRes,
    evaluationsRes,
    decisionsRes,
    recommendationsRes,
    governanceRes,
    signalsRes,
    evidenceRes,
    eventsRes,
    rawInputsRes,
    sourcesRes,
    platformEventsRes,
  ] = await Promise.all([
    client
      .from("canonical_task_outcomes")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    client
      .from("canonical_outcome_observations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .order("recorded_at", { ascending: false }),
    client
      .from("execution_tasks")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("internal_task_executions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("material_action_proposals")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("material_action_governance_evaluations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("operational_decision_records")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("recommended_actions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("governance_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("operational_signals")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("evidence_items")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("operational_normalized_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("operational_raw_inputs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("operational_sources")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId),
    client
      .from("platform_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .order("occurred_at", { ascending: true }),
  ]);

  for (const [name, res] of [
    ["canonical_task_outcomes", outcomesRes],
    ["canonical_outcome_observations", observationsRes],
    ["execution_tasks", tasksRes],
    ["internal_task_executions", executionsRes],
    ["material_action_proposals", actionsRes],
    ["material_action_governance_evaluations", evaluationsRes],
    ["operational_decision_records", decisionsRes],
    ["recommended_actions", recommendationsRes],
    ["governance_events", governanceRes],
    ["operational_signals", signalsRes],
    ["evidence_items", evidenceRes],
    ["operational_normalized_events", eventsRes],
    ["operational_raw_inputs", rawInputsRes],
    ["operational_sources", sourcesRes],
    ["platform_events", platformEventsRes],
  ] as const) {
    if (res.error) throw new Error(`load_${name}_for_lineage: ${res.error.message}`);
  }

  let outcomes = outcomesRes.data ?? [];
  if (options?.outcomeId) {
    outcomes = outcomes.filter((o) => o.id === options.outcomeId);
  }
  if (options?.taskId) {
    outcomes = outcomes.filter((o) => o.task_id === options.taskId);
  }

  const observationsByOutcome = new Map<string, Array<Record<string, unknown>>>();
  for (const obs of observationsRes.data ?? []) {
    const list = observationsByOutcome.get(String(obs.outcome_id)) ?? [];
    list.push(obs);
    observationsByOutcome.set(String(obs.outcome_id), list);
  }

  const tasksById = new Map((tasksRes.data ?? []).map((r) => [String(r.id), r]));
  const executionsByTaskId = new Map((executionsRes.data ?? []).map((r) => [String(r.task_id), r]));
  const actionsById = new Map((actionsRes.data ?? []).map((r) => [String(r.id), r]));
  // Every evaluation is retained. Collapsing to one row per action here is what made
  // selection depend on row arrival order.
  const evaluationsById = new Map((evaluationsRes.data ?? []).map((r) => [String(r.id), r]));
  const evaluationsByActionId = new Map<string, Array<Record<string, unknown>>>();
  for (const evaluationRow of evaluationsRes.data ?? []) {
    const list = evaluationsByActionId.get(String(evaluationRow.action_id)) ?? [];
    list.push(evaluationRow);
    evaluationsByActionId.set(String(evaluationRow.action_id), list);
  }
  const decisionsById = new Map((decisionsRes.data ?? []).map((r) => [String(r.id), r]));

  // decision_evidence_links carries no workspace_id/project_id of its own: its tenancy is
  // derived through operational_decision_records, exactly as the RLS policy
  // decision_evidence_links_scoped_select does. decisionsRes is already scoped by both
  // workspace_id and project_id, so scoping by decision_record_id preserves tenant isolation.
  const decisionIds = [...decisionsById.keys()];
  const decisionLinksRes = decisionIds.length
    ? await client.from("decision_evidence_links").select("*").in("decision_record_id", decisionIds)
    : { data: [], error: null };
  if (decisionLinksRes.error) {
    throw new Error(`load_decision_evidence_links_for_lineage: ${decisionLinksRes.error.message}`);
  }

  const decisionLinksByDecisionId = new Map<string, Array<Record<string, unknown>>>();
  for (const link of decisionLinksRes.data ?? []) {
    const list = decisionLinksByDecisionId.get(String(link.decision_record_id)) ?? [];
    list.push(link);
    decisionLinksByDecisionId.set(String(link.decision_record_id), list);
  }
  const recommendationsById = new Map((recommendationsRes.data ?? []).map((r) => [String(r.id), r]));
  const governanceById = new Map((governanceRes.data ?? []).map((r) => [String(r.id), r]));
  const signalsById = new Map((signalsRes.data ?? []).map((r) => [String(r.id), r]));
  const evidenceById = new Map((evidenceRes.data ?? []).map((r) => [String(r.id), r]));
  const eventsById = new Map((eventsRes.data ?? []).map((r) => [String(r.id), r]));
  const rawInputsById = new Map((rawInputsRes.data ?? []).map((r) => [String(r.id), r]));
  const sourcesById = new Map((sourcesRes.data ?? []).map((r) => [String(r.id), r]));

  const projections: CompleteLineageProjection[] = [];

  for (const outcome of outcomes) {
    const steps: LineageStepNode[] = [];
    const transitions: LineageTransition[] = [];
    const gaps: string[] = [];
    const disputes: string[] = [];

    const task = tasksById.get(String(outcome.task_id));
    const execution = executionsByTaskId.get(String(outcome.task_id));
    const actionId = outcome.source_action_id || task?.source_action_id;
    const action = actionId ? actionsById.get(String(actionId)) : undefined;
    // internal_task_executions.governance_evaluation_id is NOT NULL and is the historical
    // authority for an action that was actually executed: it pins the evaluation the
    // dispatch was authorized against. A newer evaluation must never be back-projected
    // onto a past execution.
    const executionEvaluationId = execution?.governance_evaluation_id
      ? String(execution.governance_evaluation_id)
      : null;
    const executionEvaluation = executionEvaluationId
      ? evaluationsById.get(executionEvaluationId)
      : undefined;
    // A referenced-but-absent evaluation is an integrity failure, NOT a cue to substitute
    // another row. Substituting latest-per-action here would silently rewrite authorization
    // history. The lineage is reported as broken instead.
    const executionEvaluationMissing = executionEvaluationId !== null && executionEvaluation === undefined;
    // Deterministic latest-per-action applies ONLY when no execution pins an evaluation:
    // evaluated_at, then recorded_at, then id.
    const actionEvaluations = action
      ? [...(evaluationsByActionId.get(String(action.id)) ?? [])].sort(compareGovernanceEvaluationRecency)
      : [];
    const evaluation = executionEvaluationId !== null ? executionEvaluation : actionEvaluations[0];

    if (executionEvaluationMissing) {
      gaps.push(
        `Governance evaluation: internal execution ${String(execution?.id)} references governance evaluation ${executionEvaluationId}, which is absent from project scope. Authorization history cannot be reconstructed and no substitute evaluation was used.`,
      );
    }
    const decisionId = action?.source_decision_id || (action?.proposal as Record<string, unknown> | undefined)?.decisionReferenceId;
    const decision = decisionId ? decisionsById.get(String(decisionId)) : undefined;
    const recommendation = decision?.recommendation_id ? recommendationsById.get(String(decision.recommendation_id)) : undefined;
    const governanceId = decision?.governance_event_id || recommendation?.governance_event_id;
    const governance = governanceId ? governanceById.get(String(governanceId)) : undefined;
    const signalId = recommendation?.signal_id || governance?.signal_id;
    const signal = signalId ? signalsById.get(String(signalId)) : undefined;

    // Upstream evidence for decision
    const links = decision ? decisionLinksByDecisionId.get(String(decision.id)) ?? [] : [];
    // links[0] was raw database row order. The earliest-recorded link, tie-broken by
    // evidence_item_id, is the deterministic primary when nothing upstream determines it.
    const orderedLinks = [...links].sort(compareDecisionEvidenceLinkStability);
    const decisionEvidenceId =
      signal?.evidence_item_id || decision?.manual_evidence_item_id || orderedLinks[0]?.evidence_item_id;
    const evidence = decisionEvidenceId ? evidenceById.get(String(decisionEvidenceId)) : undefined;

    // LineageStepNode renders exactly one primary evidence chain. Omission accounting is
    // computed over decision_evidence_links itself and makes NO assumption that the primary
    // evidence is one of those links: when it originates from a signal or a manual decision
    // reference, every link may be unrepresented.
    const linkedEvidenceIds = [...new Set(orderedLinks.map((link) => String(link.evidence_item_id)))];
    const primaryEvidenceId = decisionEvidenceId ? String(decisionEvidenceId) : null;
    const omittedDecisionEvidenceIds = linkedEvidenceIds.filter((id) => id !== primaryEvidenceId);
    const normalizedEvent = evidence?.normalized_event_id ? eventsById.get(String(evidence.normalized_event_id)) : undefined;
    const rawInput = normalizedEvent?.raw_input_id ? rawInputsById.get(String(normalizedEvent.raw_input_id)) : undefined;
    const source = (rawInput?.source_id ? sourcesById.get(String(rawInput.source_id)) : undefined) ||
                   (normalizedEvent?.source_id ? sourcesById.get(String(normalizedEvent.source_id)) : undefined);

    // 1. Source
    if (source) {
      steps.push({
        kind: "source",
        id: String(source.id),
        title: `Source: ${String(source.display_name || source.source_key)}`,
        status: source.is_fixture ? "fixture" : "intact",
        summary: `Kind: ${source.source_kind}, Status: ${source.status}`,
        entity: source,
        correlationId: null,
        causationId: null,
        isFixture: Boolean(source.is_fixture),
        fixtureLabel: (source.fixture_label as string | null) ?? null,
        gapReason: null,
        occurredAt: null,
        recordedAt: String(source.created_at || ""),
        actorId: (source.created_by as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "source",
        id: null,
        title: "Source: missing",
        status: "missing",
        summary: "No operational source registered.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "No source registered for upstream input.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Source: missing upstream source registration.");
    }

    // 2. Raw Input
    if (rawInput) {
      steps.push({
        kind: "raw_input",
        id: String(rawInput.id),
        title: "Raw Input",
        status: "intact",
        summary: `Digest: ${String(rawInput.content_digest || "").slice(0, 16)}... Status: ${rawInput.status}`,
        entity: rawInput,
        correlationId: (rawInput.correlation_id as string | null) ?? null,
        causationId: (rawInput.causation_id as string | null) ?? null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(rawInput.occurred_at || ""),
        recordedAt: String(rawInput.captured_at || ""),
        actorId: (rawInput.actor_user_id as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "raw_input",
        id: null,
        title: "Raw Input: missing",
        status: "missing",
        summary: "No immutable raw input payload captured.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Raw input payload was not retained or is absent.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Raw Input: missing raw input payload.");
    }

    // 3. Normalized Event
    if (normalizedEvent) {
      steps.push({
        kind: "normalized_event",
        id: String(normalizedEvent.id),
        title: `Event: ${String(normalizedEvent.event_type)}`,
        status: "intact",
        summary: `Schema v${normalizedEvent.schema_version}, Digest: ${String(normalizedEvent.event_digest || "").slice(0, 16)}...`,
        entity: normalizedEvent,
        correlationId: (normalizedEvent.correlation_id as string | null) ?? null,
        causationId: (normalizedEvent.causation_id as string | null) ?? null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(normalizedEvent.occurred_at || ""),
        recordedAt: String(normalizedEvent.recorded_at || ""),
        actorId: (normalizedEvent.actor_user_id as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "normalized_event",
        id: null,
        title: "Normalized Event: missing",
        status: "missing",
        summary: "No typed normalized event recorded.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Normalized event absent.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Normalized Event: missing normalized event.");
    }

    // 4. Evidence
    if (evidence) {
      const isFixture = evidence.fixture_state === "DEMO_FIXTURE";
      const isDegraded = evidence.freshness_state === "STALE" || evidence.degraded_reason !== null;
      steps.push({
        kind: "evidence",
        id: String(evidence.id),
        title: `Evidence (${evidence.assertion_type}): ${evidence.classification}`,
        status: isFixture ? "fixture" : isDegraded ? "degraded" : "intact",
        summary: `Confidence: ${(Number(evidence.confidence_score) * 100).toFixed(1)}%, Data: ${evidence.missing_data_state}, Freshness: ${evidence.freshness_state}`,
        entity: evidence,
        // Provenance is used exactly as recorded on the evidence row. A null causation_id
        // stays null: a structural reference (e.g. normalized_event_id) is never promoted
        // into a causal claim.
        correlationId: (evidence.correlation_id as string | null) ?? null,
        causationId: (evidence.causation_id as string | null) ?? null,
        isFixture,
        fixtureLabel: isFixture ? "DEMO / FIXTURE" : null,
        gapReason: null,
        occurredAt: String(evidence.evaluated_at || ""),
        recordedAt: String(evidence.created_at || ""),
        actorId: (evidence.created_by as string | null) ?? null,
        evidenceAssertionType: evidence.assertion_type as "FACT" | "INFERENCE" | "ASSUMPTION",
        confidenceScore: Number(evidence.confidence_score),
        missingDataState: evidence.missing_data_state as "COMPLETE" | "PARTIAL" | "UNKNOWN",
      });
    } else {
      steps.push({
        kind: "evidence",
        id: null,
        title: "Evidence: missing",
        status: "missing",
        summary: "No upstream evidence item found for this decision.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Decision or signal has no verifiable evidence backing.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Evidence: missing upstream evidence link.");
    }

    if (omittedDecisionEvidenceIds.length > 0) {
      gaps.push(
        `Evidence: decision has ${linkedEvidenceIds.length} linked evidence item(s) in decision_evidence_links; lineage renders one primary evidence chain (${primaryEvidenceId ?? "none"}). ${omittedDecisionEvidenceIds.length} linked evidence item(s) not represented: ${omittedDecisionEvidenceIds.join(", ")}.`,
      );
    }

    // 5. Finding (Signal)
    if (signal) {
      steps.push({
        kind: "finding",
        id: String(signal.id),
        title: `Finding: ${String(signal.signal_type).replace(/_/g, " ")}`,
        status: "intact",
        summary: `Severity: ${signal.severity}, Confidence: ${(Number(signal.confidence_score) * 100).toFixed(1)}% — ${signal.summary}`,
        entity: signal,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(signal.created_at || ""),
        recordedAt: String(signal.created_at || ""),
        actorId: null,
        confidenceScore: Number(signal.confidence_score),
      });
    } else {
      steps.push({
        kind: "finding",
        id: null,
        title: "Finding: not present",
        status: "missing",
        summary: decision?.manual_evidence_item_id ? "Direct PM decision (manual entry, no deterministic signal)." : "No finding detected.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: decision?.manual_evidence_item_id ? "Direct PM manual decision (no signal required)." : "Finding missing.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      if (!decision?.manual_evidence_item_id) gaps.push("Finding: no operational finding linked.");
    }

    // 6. Recommendation
    if (recommendation) {
      steps.push({
        kind: "recommendation",
        id: String(recommendation.id),
        title: `Recommendation: ${String(recommendation.title)}`,
        status: "intact",
        summary: `Status: ${recommendation.status}, Urgency: ${recommendation.urgency} — Proposed: ${recommendation.proposed_action}`,
        entity: recommendation,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(recommendation.created_at || ""),
        recordedAt: String(recommendation.created_at || ""),
        actorId: null,
      });
    } else {
      steps.push({
        kind: "recommendation",
        id: null,
        title: "Recommendation: not present",
        status: "missing",
        summary: decision?.manual_evidence_item_id ? "Direct PM decision without automated recommendation." : "No recommendation recorded.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: decision?.manual_evidence_item_id ? "Manual PM decision." : "No recommendation recorded.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      if (!decision?.manual_evidence_item_id) gaps.push("Recommendation: no recommendation found.");
    }

    // 7. Decision
    if (decision) {
      steps.push({
        kind: "decision",
        id: String(decision.id),
        title: `Decision: ${decision.decision}`,
        status: ["accepted", "modified"].includes(String(decision.decision_status)) ? "intact" : "degraded",
        summary: `Status: ${decision.decision_status} — Rationale: ${decision.rationale}`,
        entity: decision,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(decision.created_at || ""),
        recordedAt: String(decision.created_at || ""),
        actorId: (decision.decided_by as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "decision",
        id: null,
        title: "Decision: missing",
        status: "missing",
        summary: "No source operational decision recorded.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Task was created without an authorized PM decision record.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Decision: no source decision recorded.");
    }

    // 8. Governed Action
    if (action) {
      // "proposed" is not a governance_state the database can hold; synthesising it made an
      // unevaluated action render as intact.
      const govState = evaluation ? String(evaluation.governance_state ?? "") : null;
      const govIntegrity: "intact" | "disputed" | "degraded" =
        govState === null ? "degraded" : (GOVERNANCE_STATE_INTEGRITY[govState] ?? "degraded");
      steps.push({
        kind: "material_action",
        id: String(action.id),
        title: `Governed Action (${action.action_class}): ${govState ?? "no governance evaluation"}`,
        status: govIntegrity,
        summary: `Materiality: ${action.materiality}, Digest: ${String(action.proposal_digest || "").slice(0, 16)}...`,
        entity: { ...action, evaluation },
        correlationId: (action.correlation_id as string | null) ?? null,
        causationId: (action.causation_id as string | null) ?? null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(action.persisted_at || ""),
        recordedAt: String(evaluation?.recorded_at || action.persisted_at || ""),
        actorId: null,
      });
      if (govIntegrity === "disputed") {
        disputes.push(`Governed Action: governance evaluation state "${govState}" withholds authorization.`);
      }
      // The execution-referenced-but-absent case already emitted a more specific gap.
      if (govState === null && !executionEvaluationMissing) {
        gaps.push("Governed Action: no governance evaluation recorded; authorization cannot be attested.");
      }
    } else {
      steps.push({
        kind: "material_action",
        id: null,
        title: "Governed Action: not present",
        status: "missing",
        summary: "Task was created directly without a Governed Action proposal.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Direct Task creation: Governed Action proposal bypassed or absent.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Governed Action: Task created directly without governed action proposal.");
    }

    // 9. Task & Execution
    if (task) {
      steps.push({
        kind: "task",
        id: String(task.id),
        title: `Task: ${String(task.title)}`,
        status: task.status === "completed" ? "intact" : "degraded",
        summary: `Status: ${task.status}, Priority: ${task.priority}`,
        entity: task,
        correlationId: (task.correlation_id as string | null) ?? null,
        causationId: (task.causation_id as string | null) ?? null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(task.created_at || ""),
        recordedAt: String(task.created_at || ""),
        actorId: (task.assignee_id as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "task",
        id: String(outcome.task_id),
        title: "Task: missing reference",
        status: "missing",
        summary: "Execution task record not found in project scope.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Task record missing.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Task: task record missing.");
    }

    if (execution) {
      steps.push({
        kind: "internal_execution",
        id: String(execution.id),
        title: `Execution: ${execution.status}`,
        status: execution.status === "completed" ? "intact" : execution.status === "failed" ? "degraded" : "intact",
        summary: `Provider: ${execution.provider_key}, Attempts: ${execution.attempt_count}, Idempotency: ${String(execution.idempotency_key).slice(0, 16)}...`,
        entity: execution,
        correlationId: (execution.correlation_id as string | null) ?? null,
        causationId: (execution.causation_id as string | null) ?? null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: null,
        occurredAt: String(execution.started_at || execution.queued_at || ""),
        recordedAt: String(execution.completed_at || execution.created_at || ""),
        actorId: (execution.dispatched_by as string | null) ?? null,
      });
    } else {
      steps.push({
        kind: "internal_execution",
        id: null,
        title: "Internal Execution: missing",
        status: "missing",
        summary: "No internal state machine execution recorded for this task.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Task completed without internal state machine execution record.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Internal Execution: no internal execution recorded.");
    }

    // 10. Expected Outcome
    const outcomeIsFixture = outcome.fixture_label === "DEMO / FIXTURE";
    const outcomeIsDisputed = outcome.state === "disputed";
    const outcomeIsInconclusive = outcome.state === "inconclusive";
    steps.push({
      kind: "outcome",
      id: String(outcome.id),
      title: `Expected Outcome (${outcome.state}): ${outcome.expected_result}`,
      status: outcomeIsFixture ? "fixture" : outcomeIsDisputed ? "disputed" : outcomeIsInconclusive ? "inconclusive" : "intact",
      summary: `State: ${outcome.state}. Criteria: ${JSON.stringify(outcome.success_criteria || [])}`,
      entity: outcome,
      correlationId: (outcome.correlation_id as string | null) ?? null,
      causationId: (outcome.causation_id as string | null) ?? null,
      isFixture: outcomeIsFixture,
      fixtureLabel: (outcome.fixture_label as string | null) ?? null,
      gapReason: null,
      occurredAt: String(outcome.created_at || ""),
      recordedAt: String(outcome.updated_at || outcome.created_at || ""),
      actorId: (outcome.created_by as string | null) ?? null,
    });
    if (outcomeIsDisputed) disputes.push("Outcome: outcome is in disputed state.");
    if (outcomeIsInconclusive) disputes.push("Outcome: outcome is inconclusive.");

    // 11. Observations
    const obsList = observationsByOutcome.get(String(outcome.id)) ?? [];
    if (obsList.length > 0) {
      for (const obs of obsList) {
        const obsIsFixture = obs.fixture_label === "DEMO / FIXTURE";
        const obsIsDisputed = obs.observation_state === "disputed";
        const obsIsInconclusive = obs.observation_state === "inconclusive";
        const obsEvRefIds = (obs.evidence_reference_ids as string[]) || [];
        const loadedEv = obsEvRefIds.map((id) => evidenceById.get(String(id))).filter(Boolean);

        steps.push({
          kind: "observation",
          id: String(obs.id),
          title: `Observation (${obs.observation_state}): ${obs.summary}`,
          status: obsIsFixture ? "fixture" : obsIsDisputed ? "disputed" : obsIsInconclusive ? "inconclusive" : "intact",
          summary: `Confidence: ${(Number(obs.confidence_score) * 100).toFixed(1)}%, Data State: ${obs.missing_data_state}, Supporting Evidence items: ${obsEvRefIds.length}`,
          entity: { ...obs, loadedEvidence: loadedEv },
          correlationId: (obs.correlation_id as string | null) ?? null,
          causationId: (obs.causation_id as string | null) ?? null,
          isFixture: obsIsFixture,
          fixtureLabel: (obs.fixture_label as string | null) ?? null,
          gapReason: null,
          occurredAt: String(obs.observed_at || ""),
          recordedAt: String(obs.recorded_at || ""),
          actorId: (obs.observed_by as string | null) ?? null,
          confidenceScore: Number(obs.confidence_score),
          missingDataState: obs.missing_data_state as "COMPLETE" | "PARTIAL" | "UNKNOWN",
        });

        if (obsIsDisputed) disputes.push(`Observation ${String(obs.id).slice(0, 8)}: observation is disputed.`);
        if (obsIsInconclusive) disputes.push(`Observation ${String(obs.id).slice(0, 8)}: observation is inconclusive.`);
        if (obs.missing_data_state === "PARTIAL" || obs.missing_data_state === "UNKNOWN") {
          gaps.push(`Observation ${String(obs.id).slice(0, 8)}: missing data state is ${obs.missing_data_state}.`);
        }
      }
    } else {
      steps.push({
        kind: "observation",
        id: null,
        title: "Observation: unobserved",
        status: "missing",
        summary: "No outcome observations recorded yet. Task completion does not imply Outcome achievement.",
        entity: null,
        correlationId: null,
        causationId: null,
        isFixture: false,
        fixtureLabel: null,
        gapReason: "Awaiting authorized, evidence-backed observation.",
        occurredAt: null,
        recordedAt: null,
        actorId: null,
      });
      gaps.push("Observation: unobserved — achievement requires authorized observation.");
    }

    // Build transitions between sequential steps
    const stepSequence: LineageStepKind[] = [
      "source",
      "raw_input",
      "normalized_event",
      "evidence",
      "finding",
      "recommendation",
      "decision",
      "material_action",
      "task",
      "internal_execution",
      "outcome",
      "observation",
    ];

    for (let i = 0; i < stepSequence.length - 1; i++) {
      const fromKind = stepSequence[i];
      const toKind = stepSequence[i + 1];
      const fromNode = steps.find((s) => s.kind === fromKind);
      const toNode = steps.find((s) => s.kind === toKind);

      if (!fromNode || !toNode) continue;

      const isCausal = Boolean(toNode.causationId && fromNode.id && toNode.causationId === fromNode.id);
      const hasSharedCorrelation = Boolean(
        toNode.correlationId && fromNode.correlationId && toNode.correlationId === fromNode.correlationId,
      );

      let relationship: LineageLinkRelationship = "unlinked";
      let relationshipExplanation = "No link established between these steps.";

      if (fromNode.status === "missing" || toNode.status === "missing") {
        relationship = "unlinked";
        relationshipExplanation = "Lineage gap: one or both steps are missing.";
      } else if (isCausal) {
        relationship = "causation";
        relationshipExplanation = "Explicit causation pointer verified (causation ID matches source entity).";
      } else if (hasSharedCorrelation) {
        relationship = "correlation_only";
        relationshipExplanation =
          "Shared correlation identifier match only. Invariant: Correlation does NOT imply causation.";
      } else if (fromNode.id && toNode.id) {
        relationship = "direct_reference";
        relationshipExplanation = "Direct relational foreign key reference.";
      }

      transitions.push({
        fromKind,
        toKind,
        relationship,
        relationshipExplanation,
        isCausal,
        correlationId: toNode.correlationId || fromNode.correlationId || null,
        causationId: toNode.causationId || null,
      });
    }

    // Collect linked audit platform events
    const outcomeCorrelationId = outcome.correlation_id;
    const linkedAuditEvents = (platformEventsRes.data ?? []).filter((e) => {
      if (outcomeCorrelationId && e.correlation_id === outcomeCorrelationId) return true;
      if (e.raw_reference_table === "canonical_task_outcomes" && e.raw_reference_id === outcome.id) return true;
      if (e.raw_reference_table === "execution_tasks" && e.raw_reference_id === outcome.task_id) return true;
      return false;
    });

    const hasCorrelationOnly = transitions.some((t) => t.relationship === "correlation_only");
    const lineageStatus =
      disputes.length > 0
        ? "disputed"
        : steps.some((s) => s.status === "inconclusive")
          ? "inconclusive"
          : steps.some((s) => s.status === "degraded")
            ? "degraded"
            : gaps.length > 0
              ? "incomplete"
              : "complete";

    const latestObservation = obsList[0];

    projections.push({
      outcomeId: String(outcome.id),
      taskId: String(outcome.task_id),
      expectedResult: String(outcome.expected_result),
      outcomeState: outcome.state as CanonicalTaskOutcomeState,
      observationsCount: obsList.length,
      latestObservationState: (latestObservation?.observation_state as CanonicalOutcomeObservationState | undefined) ?? null,
      lineageStatus,
      hasCorrelationOnly,
      steps,
      transitions,
      auditEvents: linkedAuditEvents,
      gaps,
      disputes,
      isFixture: outcomeIsFixture,
      fixtureLabel: (outcome.fixture_label as string | null) ?? null,
    });
  }

  return projections;
}

async function loadActorRole(client: Client, workspaceId: string, userId: string) {
  const { data, error } = await client.from("workspace_memberships").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`load_operational_actor_role: ${error.message}`);
  return (data?.role as OperationalWorkspaceRole | undefined) ?? null;
}

/** A canonical row as the Data API returns it: column names, untyped values. */
type SummaryRow = Record<string, unknown>;

export async function getOperationalSummary(client: Client, workspaceId: string, projectId: string, userId: string): Promise<OperationalSummary> {
  const [
    sources,
    rawInputs,
    normalizedEvents,
    evidence,
    observationEligibleEvidence,
    signals,
    risks,
    governance,
    recommendations,
    decisions,
    materialActions,
    materialActionEvaluations,
    outcomes,
    observations,
    tasks,
    executions,
    assuranceResult,
    actorRole,
  ] = await Promise.all([
    client.from("operational_sources").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
    client.from("operational_raw_inputs").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("captured_at", { ascending: false }).limit(20),
    client.from("operational_normalized_events").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("recorded_at", { ascending: false }).limit(20),
    client.from("evidence_items").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
    // P2-09 Observation eligibility, applied as SERVER predicates before the row limit.
    // The presentation window above is ordered by recency and says nothing about
    // eligibility, so filtering it client-side would report "no evidence available"
    // whenever the newest rows happen to be fixtures, stale or degraded — while
    // `record_canonical_outcome_observation` would still accept an older LIVE row.
    // These predicates are the same ones that RPC enforces.
    client.from("evidence_items").select("*")
      .eq("workspace_id", workspaceId).eq("project_id", projectId)
      .not("normalized_event_id", "is", null)
      .eq("fixture_state", "LIVE").eq("freshness_state", "CURRENT").eq("lifecycle", "RECORDED")
      .is("rejection_reason", null).is("degraded_reason", null)
      .not("evaluated_at", "is", null)
      .order("created_at", { ascending: false }).limit(50),
    client.from("operational_signals").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.from("risk_issue_records").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.from("governance_events").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.from("recommended_actions").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).not("governance_event_id", "is", null).order("created_at", { ascending: false }).limit(30),
    client.from("operational_decision_records").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.from("material_action_proposals").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("persisted_at", { ascending: false }).limit(30),
    client.from("material_action_governance_evaluations").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("recorded_at", { ascending: false }).limit(30),
    client.from("canonical_task_outcomes").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.from("canonical_outcome_observations").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("recorded_at", { ascending: false }).limit(30),
    // P2-12 reads the two canonical nodes the summary did not already carry, so the
    // PM Execution Center can project Action -> Task -> Execution from persisted rows
    // instead of holding them in browser memory. Governed tasks only: the Action->Task
    // link is `source_payload->>'sourceActionId'` under `source = 'governed_action'`
    // (P2-07), which is exactly the set this experience continues.
    client.from("execution_tasks").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).eq("source_payload->>source", "governed_action").order("created_at", { ascending: false }).limit(30),
    client.from("internal_task_executions").select("*").eq("workspace_id", workspaceId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    client.rpc("get_operational_assurance_summary", { p_workspace_id: workspaceId, p_project_id: projectId }),
    loadActorRole(client, workspaceId, userId),
  ]);
  for (const result of [sources, rawInputs, normalizedEvents, evidence, observationEligibleEvidence, signals, risks, governance, recommendations, decisions, materialActions, materialActionEvaluations, outcomes, observations, tasks, executions]) {
    if (result.error) throw new Error(`load_operational_summary: ${result.error.message}`);
  }
  if (assuranceResult.error || !assuranceResult.data) throw new Error(`load_operational_assurance: ${assuranceResult.error?.message ?? "no_data"}`);
  const decisionIds = (decisions.data ?? []).map((row) => row.id);
  const links = decisionIds.length ? await client.from("decision_evidence_links").select("*").in("decision_record_id", decisionIds) : { data: [], error: null };
  if (links.error) throw new Error(`load_evidence_links: ${links.error.message}`);

  /**
   * Complete the governed chain BY PERSISTED CANONICAL ID.
   *
   * The collections above are independently windowed to the newest N rows project-wide.
   * That is fine for listing recent activity, but a consumer that JOINS them cannot tell
   * "this chain has no Observation" from "this chain's Observation fell outside a
   * different collection's window". Reading absence out of a truncated projection is a
   * false statement about the domain — after thirty newer observations elsewhere in the
   * project, an older achieved Outcome would be reported as having no evidence at all.
   *
   * So each linked level is additionally fetched by the exact persisted reference that
   * defines it, seeded from the bounded root set already loaded, and unioned with the
   * windowed rows. Unioning rather than replacing keeps every row the windows already
   * surfaced — no existing surface loses anything — while guaranteeing that for any row
   * present here, its own linked children are present too:
   *
   *   Decision.id -> material_action_proposals.source_decision_id
   *   Action.id   -> material_action_governance_evaluations.action_id
   *   Action.id   -> execution_tasks.source_payload.sourceActionId   (P2-07)
   *   Task.id     -> internal_task_executions.task_id
   *   Task.id     -> canonical_task_outcomes.task_id
   *   Outcome.id  -> canonical_outcome_observations.outcome_id
   *
   * Every link is an exact id match. Nothing is joined by timestamp, title or proximity,
   * and no unbounded project-wide read is introduced: each query is bounded by the id set
   * it is given, which is itself bounded by the Decision window.
   */
  /**
   * How many ids go into one `.in(...)` filter.
   *
   * The root window bounds DECISIONS, not the rows beneath them: `source_decision_id`
   * carries no unique constraint, so one Decision can hold arbitrarily many Actions, each
   * with its own Task, Execution, Outcome and Observations. Passing that whole fan-out
   * through a single PostgREST URL filter makes the request grow without limit until the
   * server rejects it — and then `getOperationalSummary` fails outright rather than
   * rendering the chain, which is a worse failure than the truncation F7 set out to fix.
   *
   * 50 UUIDs is roughly 1.9 KB of filter text, comfortably inside any common proxy or
   * PostgREST limit while keeping the number of round trips small. No documented maximum
   * is assumed; the value is deliberately conservative.
   */
  const ID_FILTER_CHUNK = 50;
  /** Rows fetched per page. PostgREST applies its own max-rows cap, so a single unpaged
   *  read could silently return a truncated set — the exact false-absence F7 exists to
   *  prevent. Pages are drained explicitly until one comes back short. */
  const ROW_PAGE_SIZE = 500;

  const linkedRows = async (
    table: string,
    column: string,
    values: string[],
    /** Extra equality the WINDOWED query for this table also applies. A by-id completion
     *  that widened the set would silently change what the collection means. */
    match?: readonly [string, string]
  ): Promise<SummaryRow[]> => {
    if (values.length === 0) return [];
    const collected: SummaryRow[] = [];
    for (let start = 0; start < values.length; start += ID_FILTER_CHUNK) {
      const chunk = values.slice(start, start + ID_FILTER_CHUNK);
      for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
        const scoped = client.from(table).select("*").eq("workspace_id", workspaceId).eq("project_id", projectId);
        const result = await (match ? scoped.eq(match[0], match[1]) : scoped)
          .in(column, chunk)
          .range(offset, offset + ROW_PAGE_SIZE - 1);
        if (result.error) throw new Error(`load_operational_summary: ${result.error.message}`);
        const page = (result.data ?? []) as unknown as SummaryRow[];
        collected.push(...page);
        // A short page is the last page. Every id filter is bounded, so this terminates.
        if (page.length < ROW_PAGE_SIZE) break;
      }
    }
    // Duplicates across chunks/pages are removed by canonical id in `unionById`, which also
    // restores the window's ordering after the union.
    return collected;
  };

  /**
   * Union, then restore the window's own ordering.
   *
   * Each collection above is ordered by a specific column descending, and consumers read
   * that order as meaning "newest first" — the Material Action panel, for instance, folds
   * evaluations into a map expecting the newest to win. Appending by-id rows in arbitrary
   * Data API order would leave the collection looking the same while quietly changing
   * which evaluation a consumer resolves as current. Re-sorting on the same column makes
   * the result indistinguishable from a wider window, which is the whole intent.
   */
  const unionById = (orderColumn: string, ...groups: Array<SummaryRow[] | null | undefined>): SummaryRow[] => {
    const byId = new Map<string, SummaryRow>();
    for (const group of groups) for (const row of group ?? []) byId.set(String(row.id), row);
    const at = (row: SummaryRow): number => {
      const value = row[orderColumn];
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return [...byId.values()].sort((a, b) => at(b) - at(a));
  };
  const idsOf = (rows: SummaryRow[]): string[] => [...new Set(rows.map((row) => String(row.id)))];

  const allMaterialActions = unionById(
    "persisted_at",
    materialActions.data as unknown as SummaryRow[] | null,
    await linkedRows("material_action_proposals", "source_decision_id", decisionIds.map(String))
  );
  const actionIds = idsOf(allMaterialActions);
  const [linkedEvaluations, linkedTasks] = await Promise.all([
    linkedRows("material_action_governance_evaluations", "action_id", actionIds),
    // Governed tasks only, exactly as the window above. A RAID or draft task may also
    // carry a `sourceActionId`, and letting one in here would put an ungoverned row into
    // a collection every consumer is entitled to read as governed.
    linkedRows("execution_tasks", "source_payload->>sourceActionId", actionIds, ["source_payload->>source", "governed_action"]),
  ]);
  const allMaterialActionEvaluations = unionById("recorded_at", materialActionEvaluations.data as unknown as SummaryRow[] | null, linkedEvaluations);
  const allTasks = unionById("created_at", tasks.data as unknown as SummaryRow[] | null, linkedTasks);
  const taskIds = idsOf(allTasks);
  const [linkedExecutions, linkedOutcomes] = await Promise.all([
    linkedRows("internal_task_executions", "task_id", taskIds),
    linkedRows("canonical_task_outcomes", "task_id", taskIds),
  ]);
  const allExecutions = unionById("created_at", executions.data as unknown as SummaryRow[] | null, linkedExecutions);
  const allOutcomes = unionById("created_at", outcomes.data as unknown as SummaryRow[] | null, linkedOutcomes);
  const allObservations = unionById(
    "recorded_at",
    observations.data as unknown as SummaryRow[] | null,
    await linkedRows("canonical_outcome_observations", "outcome_id", idsOf(allOutcomes))
  );
  const governanceById = new Map((governance.data ?? []).map((row) => [row.id, row]));
  const safeRecommendations = (recommendations.data ?? []).map((row) => {
    const event = governanceById.get(row.governance_event_id) as Record<string, unknown> | undefined;
    const evaluations = (["accepted", "rejected", "modified", "escalated", "needs_more_evidence"] as DecisionStatus[]).map((status) => [status, evaluateOperationalDecisionAuthority({ actorRole, authorityRequired: String(event?.authority_required ?? "baseline review"), decisionStatus: status })]);
    return { ...row, actor_authority: Object.fromEntries(evaluations) };
  });

  const lineages = await getCompleteLineageProjection(client, workspaceId, projectId);

  return {
    sources: sources.data ?? [],
    rawInputs: rawInputs.data ?? [],
    normalizedEvents: normalizedEvents.data ?? [],
    // Server-side reading, so a client can measure a deadline from trusted time.
    generatedAt: new Date().toISOString(),
    evidence: evidence.data ?? [],
    observationEligibleEvidence: observationEligibleEvidence.data ?? [],
    signals: signals.data ?? [],
    risksIssues: risks.data ?? [],
    governanceEvents: governance.data ?? [],
    recommendations: safeRecommendations,
    decisions: decisions.data ?? [],
    evidenceLinks: links.data ?? [],
    materialActions: allMaterialActions,
    materialActionEvaluations: allMaterialActionEvaluations,
    outcomes: allOutcomes,
    observations: allObservations,
    tasks: allTasks,
    executions: allExecutions,
    lineages,
    assurance: assuranceResult.data as OperationalSummary["assurance"],
    // `userId` is the requesting actor's own id. P2-06 refuses a Material Action whose
    // source Decision was recorded by a different actor, so the experience needs it to
    // avoid offering a control the server would always deny. It is never authority.
    actor: { role: actorRole, userId, canCreateEvidence: canCreateOperationalEvidence(actorRole) },
  };
}
