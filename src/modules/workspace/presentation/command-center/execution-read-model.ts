/**
 * P2-12 — PM Execution Center canonical action-to-outcome read model.
 *
 * This module is an EXPERIENCE / READ MODEL over the canonical P2 operational flow,
 * exactly like P2-11's `attention-read-model.ts`. It owns no records, defines no second
 * Action/Task/Outcome/Observation aggregate, mints no identity and adds no status. It
 * only joins what `GET /api/operational-flow` already returns and projects the stages a
 * PM continues after a Decision has been recorded.
 *
 * Every link below is a real persisted reference — never a timestamp guess, title match
 * or array-order assumption:
 *
 *   Decision       operational_decision_records.id
 *   -> Action      material_action_proposals.source_decision_id
 *   -> Task        execution_tasks.source_payload.sourceActionId  (P2-07 unique index)
 *   -> Execution   internal_task_executions.task_id
 *   -> Outcome     canonical_task_outcomes.task_id
 *   -> Observation canonical_outcome_observations.outcome_id
 *   -> Lineage     CompleteLineageProjection.outcomeId            (P2-10)
 *
 * Deliberately framework-free (no React, no SWR) so the domain boundaries — above all
 * "Task completion is not Outcome achievement" — are exercised as real behaviour in
 * tests rather than asserted by scanning source text.
 */

import type { CompleteLineageProjection, OperationalSummary } from "@/lib/operational-flow/types";

type AnyRecord = Record<string, unknown>;

/** Decision statuses P2-06 accepts as a source for a Material Action. Read from the
 *  server rule in `proposeGovernedMaterialAction` — never widened here. */
export const ACTION_ELIGIBLE_DECISION_STATUSES: readonly string[] = ["accepted", "modified"];

/** Governance states P2-07 accepts before an Action may become a Task. Read from
 *  `dispatch_governed_action_to_internal_task` — never widened here. */
export const TASK_ELIGIBLE_GOVERNANCE_STATES: readonly string[] = ["authorized", "not_required"];

/** Canonical internal execution commands (P2-08 `InternalExecutionCommand`). No UI-only
 *  command is invented, and no command is renamed into a friendlier concept. */
export const EXECUTION_COMMANDS: readonly string[] = ["queue", "start", "block", "fail", "retry", "complete"];

/** Terminal execution states after which internal work is finished. Completion here says
 *  nothing whatsoever about the Outcome — see `boundary` below. */
export const COMPLETED_EXECUTION_STATES: readonly string[] = ["completed"];

/** `execution_tasks.status` values that are canonically completed. `ensure_expected_task_outcome`
 *  compares `status = 'completed'` exactly, so no friendlier synonym is accepted here. */
export const COMPLETED_TASK_STATES: readonly string[] = ["completed"];

/** P2-08 opens a new execution only from a `not_started` Task
 *  (`new_internal_execution_requires_not_started_task`). */
export const QUEUEABLE_TASK_STATES: readonly string[] = ["not_started"];

/**
 * Canonical P2-08 transition table, read from
 * `p2_08_transition_internal_execution` — offering a command the contract cannot accept
 * would be a knowingly invalid control policed only by a server error.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  none: ["queue"],
  queued: ["start", "block", "fail"],
  running: ["block", "fail", "complete"],
  blocked: ["start", "fail"],
  failed: ["retry"],
  completed: [],
});

/** Where each canonical command lands, read from the same server function as the table
 *  above. Used to walk the matrix rather than assume its shape. */
export const EXECUTION_COMMAND_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  queue: "queued",
  start: "running",
  block: "blocked",
  fail: "failed",
  retry: "queued",
  complete: "completed",
});

export function allowedExecutionCommands(status: string | null | undefined): readonly string[] {
  return EXECUTION_TRANSITIONS[status ?? "none"] ?? [];
}

/** Governance states P2-07 will dispatch. Anything else is not "authorized". */
export function isDispatchableGovernanceState(state: string): boolean {
  return TASK_ELIGIBLE_GOVERNANCE_STATES.includes(state);
}

/**
 * Why P2-07 would refuse to turn this Action into a Task right now — or null when it
 * would not — stated in the order `dispatch_governed_action_to_internal_task` checks.
 *
 * The actor check the server performs FIRST is deliberately not here: it needs the
 * requesting actor, which this view does not carry. `buildBranchStages` applies it ahead
 * of this call, so the combined order still matches the contract.
 *
 * Only gates whose inputs this projection actually holds are mirrored. The server also
 * verifies the source Decision's status, its evidence lineage, the project's archival
 * state and the proposer's workspace membership; those stay server-enforced rather than
 * being restated here from data this surface does not have. Mirroring is for telling the
 * PM the truth up front — it never becomes the authority.
 */
export function dispatchBlockReason(action: GovernedActionView): string | null {
  // `governance_evaluation_missing`: an unevaluated proposal authorizes nothing.
  if (!action.hasEvaluation) {
    return "This Action has no persisted governance evaluation yet, so it cannot become work.";
  }
  // `action_expired`: the authorization window on the Action itself has closed.
  if (action.expired) {
    return "This Action's authorization has expired, so it can no longer become work. Request a replacement authorization to continue.";
  }
  // `governance_evaluation_stale`: the evaluation's own `valid_until` has passed. The
  // Action may still be inside its window, but the grant that justified it is not.
  if (action.evaluationStale) {
    return "This Action's governance evaluation is no longer valid, so it cannot become work. Request a replacement authorization to continue.";
  }
  if (action.revoked) return "This Action's authorization was revoked.";
  // `governed_action_not_dispatchable`, which the server raises for a false
  // `can_commit_action` just as much as for an ineligible state.
  if (!action.canCommitAction) {
    return `Governance evaluated this Action as "${action.governanceState.replaceAll("_", " ")}" without permitting it to be committed, so it cannot become work.`;
  }
  if (!isDispatchableGovernanceState(action.governanceState)) {
    return `Governance evaluated this Action as "${action.governanceState.replaceAll("_", " ")}", so it cannot become work.`;
  }
  // `policy_or_grant_reference_missing`: authorized material work must retain the
  // policy decision and grant evidence that made it allowable.
  if (action.governanceState === "authorized" && !action.authorizationEvidenceComplete) {
    return "This Action's authorization does not carry the policy decision and grant references it requires, so it cannot become work.";
  }
  return null;
}

/** Plain-language rendering of the persisted governance state — never a positive
 *  interpretation of a state the server did not grant. */
export function describeGovernanceState(state: string): string {
  const labels: Record<string, string> = {
    authorized: "Action authorized",
    not_required: "Action allowed (no governance required)",
    requires_approval: "Action requires approval",
    requires_review: "Action requires review",
    denied: "Action denied",
    degraded: "Action evaluation degraded",
    unavailable: "Action governance unavailable",
    expired: "Action authorization expired",
    stale: "Action authorization stale",
    revoked: "Action authorization revoked",
    proposed: "Action proposed, not yet evaluated",
  };
  return labels[state] ?? `Action governance: ${state.replaceAll("_", " ")}`;
}

/** Outcome states `record_canonical_outcome_observation` refuses. `superseded` is the
 *  only one; `expected`, `observing`, `achieved`, `partially_achieved`, `not_achieved`,
 *  `disputed` and `inconclusive` are all observable. */
export const UNOBSERVABLE_OUTCOME_STATES: readonly string[] = ["superseded"];

export type ExecutionStageKey = "material_action" | "task" | "execution" | "outcome" | "observation" | "review";

/** P2-06 classification inputs. `classifyPMFreakMaterialAction` derives `materiality`
 *  from exactly these four, and materiality drives the governance state, so none of them
 *  may be assumed on the PM's behalf — they are supplied by the authorized human. */
export const MATERIAL_ACTION_CLASSES: readonly string[] = [
  "ordinary_business_write",
  "external_write",
  "authority_mutation",
  "material_agent_action",
  "knowledge_elevation",
  "policy_classified",
];
export const MATERIAL_ACTION_RISKS: readonly string[] = ["low", "medium", "high", "critical", "unknown"];
export const MATERIAL_ACTION_REVERSIBILITY: readonly string[] = ["reversible", "partially_reversible", "irreversible", "unknown"];
export const MATERIAL_ACTION_SIDE_EFFECTS: readonly string[] = ["internal", "external", "authority", "knowledge", "unknown"];

/** P2-09 `missing_data_state`. Never defaulted to COMPLETE on the PM's behalf. */
export const MISSING_DATA_STATES: readonly string[] = ["COMPLETE", "PARTIAL", "UNKNOWN"];

/** The human-supplied P2-06 classification for one governed action. */
export type MaterialActionDraft = {
  actionType: string;
  intendedEffect: string;
  actionClass: string;
  risk: string;
  reversibility: string;
  sideEffect: string;
};

/** The human-supplied P2-09 evidence quality for one observation. */
export type ObservationQuality = {
  confidenceScore: number;
  missingDataState: string;
};

/**
 * One governed continuation operation the PM can request. Each maps 1:1 onto an
 * operation that already existed before P2-12; none collapses two canonical transitions.
 */
export type ExecutionCommand = "queue" | "start" | "block" | "fail" | "retry" | "complete";

export type ExecutionOperation =
  | { kind: "material_action"; decisionId: string; draft: MaterialActionDraft; justification: string }
  | { kind: "task"; actionId: string }
  | { kind: "execution"; taskId: string; command: ExecutionCommand }
  | { kind: "outcome"; taskId: string; expectedResult: string; correlationId: string }
  | {
      kind: "observation";
      outcomeId: string;
      observationState: string;
      summary: string;
      evidenceReferenceIds: string[];
      quality: ObservationQuality;
      correlationId: string;
    };

/** Canonical rendering of a confidence score, so `0.40`, `0.4` and `.4` are one value
 *  rather than three identities. P2-09 persists `numeric(5,4)`. */
export function canonicalConfidenceScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "invalid";
}

export type ObservationSubmission = {
  outcomeId: string;
  observationState: string;
  summary: string;
  evidenceReferenceIds: string[];
  /** P2-09 persists `confidence_score` NOT NULL. It is material epistemic content, so it
   *  belongs to the submission's identity — see `canonicalObservationPayload`. */
  confidenceScore: number;
  /** P2-09 persists `missing_data_state` NOT NULL. Likewise material. */
  missingDataState: string;
  /** Opaque per-submission-attempt token. Never a canonical id. */
  attemptNonce: string;
};

/**
 * Canonical deterministic serialization of an Observation submission.
 *
 * A JSON array (not a delimiter-joined string) so a summary containing the delimiter
 * cannot collide with a different submission — the encoding is unambiguous.
 *
 * `summary` is trimmed and nothing else: the server stores `btrim(p_summary)` and
 * compares against it, so trimming keeps key and stored content in step. Collapsing
 * internal whitespace would map two server-distinct summaries onto one key and turn a
 * legitimate new observation into a spurious `idempotency_conflict`.
 *
 * Evidence ids are sorted because the set, not its order, is what identifies the claim.
 *
 * `attemptNonce` is included because canonical Observations are a TEMPORAL STREAM: the
 * same Outcome may legitimately receive two Observations at different times carrying an
 * identical state, summary and evidence set (there is no content uniqueness constraint,
 * `observed_at` is a distinct per-event fact, and each Observation re-evaluates the
 * Outcome). Content alone would therefore be over-deduplication — a later honest
 * re-observation would silently reconcile to the first and be lost. `observed_at` is
 * deliberately NOT part of the identity: it is the fact being recorded, and including it
 * would break retry stability.
 */
/**
 * The classification the PM actually stated, canonicalised.
 *
 * One submission is one payload: P2-06 compares the stored proposal digest against the
 * row already held under an idempotency key and answers
 * `material_action_idempotency_conflict` on any difference. So a retry of the SAME
 * classification must resolve to the same submission identity, and a CHANGED
 * classification must not — otherwise a PM who mis-stated the materiality inputs would be
 * locked out of correcting them until the attempt aged out, which is the same stuck chain
 * an expired authorization used to create.
 *
 * Every field the server folds into its digest is folded in here, so the two agree on
 * what "the same submission" means.
 */
export function canonicalMaterialActionDraft(draft: MaterialActionDraft, justification: string): string {
  return JSON.stringify([
    draft.actionType.trim(),
    draft.intendedEffect.trim(),
    draft.actionClass,
    draft.risk,
    draft.reversibility,
    draft.sideEffect,
    justification,
  ]);
}

/**
 * The canonical content of one Observation submission.
 *
 * `confidenceScore` and `missingDataState` are included because P2-09 persists both as
 * NOT NULL columns while its replay check compares only outcome, state, summary and
 * evidence ids. Without them, a PM who retried after an ambiguous failure having changed
 * *only* the confidence or missing-data answer would submit the same key, and the server
 * would return the previously persisted row as `existing` — acknowledging the submission
 * while silently discarding the corrected epistemic values. Changing them must therefore
 * be a new identity, not a replay.
 *
 * Deliberately absent: `observedAt`/`evaluatedAt`. Those move on every attempt, so folding
 * them in would make every retry a new canonical Observation — the duplication F4 exists
 * to prevent.
 */
export function canonicalObservationPayload(input: ObservationSubmission): string {
  return JSON.stringify([
    input.outcomeId,
    input.observationState,
    input.summary.trim(),
    [...input.evidenceReferenceIds].sort(),
    canonicalConfidenceScore(input.confidenceScore),
    input.missingDataState,
    input.attemptNonce,
  ]);
}

/**
 * How long one Material Action submission stays "the same submission".
 *
 * This is a CLIENT retry window only. It carries no governance authority: the
 * authorization window itself is owned by the server, which derives `created_at` /
 * `expires_at` from its own clock and reuses the persisted pair on a retry. This constant
 * only bounds how long the browser keeps offering the same submission identity, matched to
 * the server window's nominal length so a retry cannot outlive the grant it describes.
 */
export const MATERIAL_ACTION_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/** Observation submissions carry no server-side expiry, so the retry window only has to
 *  outlive a lost response and the remount that follows it. */
export const OBSERVATION_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long one intake submission stays "the same submission".
 *
 * Deliberately short. Intake is a two-step transition — capture, then derive Evidence —
 * and the window only has to cover an observer retrying a request whose response was lost,
 * typically seconds later. Beyond it, pasting the same notes again is a genuinely new
 * capture and must be recorded as one rather than reconciling onto an older Raw Input.
 */
export const INTAKE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Deterministic SHA-256 over the canonical submission, via the platform Web Crypto
 * primitive — no dependency, no truncation (`idempotency_key` is unbounded `text`).
 *
 * P2-09 makes `(workspace_id, project_id, idempotency_key)` unique and replays an
 * identical submission as `existing`, so the key must be a function of WHAT is being
 * recorded — never of when it was clicked. A timestamp-derived key would make every
 * retry a second canonical Observation, which is exactly what the contract prevents.
 * The same idiom the server itself uses (`'internal-execution:' || task_id`).
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Idempotency identity for one logical Observation submission. Identical content
 * reconciles to the existing row; genuinely different content is a new observation.
 */
export async function observationIdempotencyKey(input: ObservationSubmission): Promise<string> {
  return `p2-12:observation:${input.outcomeId}:${await sha256Hex(canonicalObservationPayload(input))}`;
}

export type ExecutionStageState = "not_started" | "present" | "complete";

export type ExecutionStage = {
  key: ExecutionStageKey;
  label: string;
  state: ExecutionStageState;
  /** True only when the canonical prerequisite exists AND the actor could legitimately
   *  advance it. Never true merely because the UI wants a complete demo. */
  actionable: boolean;
  /** Plain-language reason the stage cannot be advanced. Text, never colour alone. */
  blockedReason: string | null;
  /** What advancing this stage actually persists. */
  effect: string;
};

export type GovernedActionView = {
  actionId: string;
  actionClass: string | null;
  actionType: string | null;
  materiality: string | null;
  governanceState: string;
  /** P2-06 persists `canExecute: false`. Authorization is not execution. */
  canExecute: boolean;
  proposalDigestShort: string | null;
  sourceDecisionId: string | null;
  correlationId: string | null;
  causationId: string | null;
  evaluatedAt: string | null;
  policyDecisionReference: string | null;
  grantReferences: string[];
  evidenceReferenceIds: string[];
  revoked: boolean;
  /** P2-06 persists the submission's idempotency key. Reading it back is what lets a
   *  pending client attempt be retired once persisted state proves it landed — the same
   *  mechanism P2-09 Observations use. */
  idempotencyKey: string | null;
  /** P2-06 persists the proposer; P2-07 refuses dispatch by anyone else. */
  proposedBy: string | null;
  expiresAt: string | null;
  /** P2-07 denies dispatch once `expires_at` has passed (failureClass `expired`). */
  expired: boolean;
  /** False when no governance evaluation has been persisted for this Action at all.
   *  `governanceState` then reads "proposed", which is this surface's word, not a
   *  canonical evaluation result. */
  hasEvaluation: boolean;
  /** The evaluation's own validity horizon, distinct from the Action's `expires_at`. */
  validUntil: string | null;
  /** P2-07 denies dispatch once `valid_until` has passed (failureClass `stale`). */
  evaluationStale: boolean;
  /** P2-06's own verdict on whether the Action may be committed. P2-07 requires it
   *  alongside an eligible governance state, so an eligible state is not sufficient. */
  canCommitAction: boolean;
  /** P2-07 requires an `authorized` evaluation to retain the policy decision and grant
   *  references that made it allowable (`policy_or_grant_reference_missing`). */
  authorizationEvidenceComplete: boolean;
  /** True when governance would let this Action become work right now. Derived from
   *  `dispatchBlockReason`, so it can never drift from the reason shown to the PM. */
  dispatchable: boolean;
};

export type GovernedTaskView = {
  taskId: string;
  title: string;
  status: string;
  sourceActionId: string | null;
  createdAt: string | null;
  completedAt: string | null;
};

export type InternalExecutionView = {
  executionId: string;
  taskId: string | null;
  sourceActionId: string | null;
  status: string;
  attemptCount: number | null;
  providerKey: string | null;
  failureClass: string | null;
  /** P2-08 refuses a transition by anyone other than the dispatching actor. */
  dispatchedBy: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type ExpectedOutcomeView = {
  outcomeId: string;
  taskId: string | null;
  sourceActionId: string | null;
  internalExecutionId: string | null;
  state: string;
  expectedResult: string | null;
};

export type OutcomeObservationView = {
  observationId: string;
  outcomeId: string | null;
  taskId: string | null;
  observationState: string;
  missingDataState: string | null;
  confidenceScore: number | null;
  summary: string | null;
  evidenceReferenceIds: string[];
  recordedAt: string | null;
  /** P2-09 persists the submission's idempotency key. Reading it back is what lets a
   *  pending client attempt be retired once persisted state proves it landed. */
  idempotencyKey: string | null;
};

/**
 * The P2-12 invariant, derived from persisted rows only.
 *
 * `completedWorkWithoutAchievedOutcome` is the honest state after internal execution
 * finishes and before evidence says anything: the work is done, the Outcome is not
 * achieved, and nothing may present it as achieved.
 */
export type OutcomeBoundary = {
  executionCompleted: boolean;
  taskCompleted: boolean;
  outcomeExists: boolean;
  outcomeState: string | null;
  outcomeAchieved: boolean;
  observationCount: number;
  completedWorkWithoutAchievedOutcome: boolean;
  statement: string;
};

/** One canonical Material Action and everything persisted beneath it. `source_decision_id`
 *  is NOT unique, so a Decision may legitimately carry several — each stays reachable. */
export type GovernedActionBranch = {
  /** Stable identity derived from the canonical Action — never random. */
  id: string;
  action: GovernedActionView;
  task: GovernedTaskView | null;
  executions: InternalExecutionView[];
  latestExecution: InternalExecutionView | null;
  /** Execution commands P2-08 would accept from this actor right now. The panel renders
   *  exactly these — it never re-derives the list, so it cannot offer a rejected one. */
  offeredCommands: readonly ExecutionCommand[];
  outcome: ExpectedOutcomeView | null;
  observations: OutcomeObservationView[];
  /** P2-10 projection for this branch's Outcome. Null when none exists — reported, never synthesised. */
  lineage: CompleteLineageProjection | null;
  stages: ExecutionStage[];
  boundary: OutcomeBoundary;
};

/** How a chain reads at a glance. Derived from persisted state so the queue cannot
 *  describe a rejected Decision or an unauthorized Action as generic progress. */
export type ChainStatus = {
  label: string;
  tone: "success" | "task" | "danger" | "info";
  detail: string;
};

export type GovernedExecutionChain = {
  kind: "governed_execution_chain";
  /** Stable identity derived from the canonical Decision — never random. */
  id: string;
  decisionId: string;
  decisionStatus: string;
  decisionTerminal: boolean;
  decidedBy: string | null;
  decisionRecordedAt: string | null;
  rationale: string | null;
  recommendationId: string | null;
  title: string;
  /** Every canonical Action for this Decision, newest first. Never truncated to one. */
  branches: GovernedActionBranch[];
  /** Requesting a first or replacement governed Action. */
  proposalStage: ExecutionStage;
  status: ChainStatus;
  /** Boundary of the most advanced branch, or the decision-level default when none. */
  boundary: OutcomeBoundary;
};

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function shortDigest(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const bare = text.startsWith("sha256:") ? text.slice(7) : text;
  return `${bare.slice(0, 16)}…`;
}

export function isActionEligibleDecisionStatus(status: unknown): boolean {
  return ACTION_ELIGIBLE_DECISION_STATUSES.includes(String(status));
}

/** Reads the governed Action -> Task link exactly as P2-07 persists it. */
export function readSourceActionId(task: AnyRecord): string | null {
  const payload = task.source_payload as AnyRecord | null | undefined;
  if (!payload || payload.source !== "governed_action") return null;
  return str(payload.sourceActionId);
}

/**
 * Evidence P2-09 will accept as the basis of an Observation.
 *
 * `record_canonical_outcome_observation` refuses anything that is not canonical,
 * provenance-bearing LIVE evidence (`observation_evidence_scope_invalid`). Offering
 * ineligible evidence would put a control on screen that the server always denies, so
 * the same predicate is mirrored here — and when nothing qualifies the experience says
 * so rather than failing at submit time.
 */
export function isObservationEligibleEvidence(row: AnyRecord, evaluatedAt: Date = new Date()): boolean {
  if (str(row.normalized_event_id) === null) return false;
  if (str(row.fixture_state) !== "LIVE") return false;
  if (str(row.freshness_state) !== "CURRENT") return false;
  if (str(row.lifecycle) !== "RECORDED") return false;
  if (str(row.rejection_reason) !== null) return false;
  if (str(row.degraded_reason) !== null) return false;
  if (str(row.evaluated_at) === null) return false;
  const staleAt = str(row.stale_at);
  if (staleAt && new Date(staleAt) <= evaluatedAt) return false;
  return true;
}

function buildActionView(
  action: AnyRecord,
  evaluation: AnyRecord | undefined,
  now: Date
): GovernedActionView {
  const proposal = (action.proposal ?? {}) as AnyRecord;
  const governanceState = str(evaluation?.governance_state) ?? "proposed";
  const expiresAt = str(action.expires_at);
  // P2-07 denies dispatch once expires_at has passed, so expiry is part of the view
  // rather than something the PM discovers only from a server rejection.
  const expired = expiresAt !== null && new Date(expiresAt) <= now;
  // The evaluation carries its own, separate horizon. Both comparisons use `<=`, exactly
  // as the server does, so the surface and the contract agree on the boundary instant.
  const validUntil = str(evaluation?.valid_until);
  const evaluationStale = validUntil !== null && new Date(validUntil) <= now;
  const policyDecisionReference = str(evaluation?.policy_decision_reference);
  const grantReferences = strList(evaluation?.grant_references);
  const view: GovernedActionView = {
    actionId: String(action.id),
    actionClass: str(action.action_class),
    actionType: str(proposal.actionType),
    materiality: str(action.materiality),
    governanceState,
    canExecute: evaluation?.can_execute === true,
    proposalDigestShort: shortDigest(action.proposal_digest),
    sourceDecisionId: str(action.source_decision_id),
    correlationId: str(action.correlation_id),
    causationId: str(action.causation_id),
    evaluatedAt: str(evaluation?.evaluated_at),
    policyDecisionReference,
    grantReferences,
    evidenceReferenceIds: strList(proposal.evidenceReferenceIds),
    revoked: governanceState === "revoked",
    idempotencyKey: str(action.idempotency_key),
    proposedBy: str(action.proposed_by),
    expiresAt,
    expired,
    hasEvaluation: evaluation !== undefined,
    validUntil,
    evaluationStale,
    canCommitAction: evaluation?.can_commit_action === true,
    authorizationEvidenceComplete: policyDecisionReference !== null && grantReferences.length > 0,
    // Provisional: `dispatchBlockReason` reads the fields above, so the real value is
    // settled once they exist. Deriving it from that one function is what keeps
    // "the control is offered" and "here is why it is not" from ever disagreeing.
    dispatchable: false,
  };
  return { ...view, dispatchable: dispatchBlockReason(view) === null };
}

function buildBoundary(input: {
  latestExecution: InternalExecutionView | null;
  task: GovernedTaskView | null;
  outcome: ExpectedOutcomeView | null;
  observations: OutcomeObservationView[];
}): OutcomeBoundary {
  const executionCompleted = Boolean(input.latestExecution && COMPLETED_EXECUTION_STATES.includes(input.latestExecution.status));
  const taskCompleted = Boolean(input.task && COMPLETED_TASK_STATES.includes(String(input.task.status)));
  const outcomeState = input.outcome?.state ?? null;
  // `achieved` is the only canonical achieved state. Every other value the contract
  // allows — `expected`, `observing`, `partially_achieved`, `not_achieved`, `disputed`,
  // `inconclusive`, `superseded` — is NOT achievement and must never be shown as one.
  const outcomeAchieved = outcomeState === "achieved";
  const workFinished = executionCompleted || taskCompleted;
  const completedWorkWithoutAchievedOutcome = workFinished && !outcomeAchieved;

  let statement: string;
  if (!workFinished) {
    statement = "Internal work has not finished, so no outcome conclusion is available.";
  } else if (!input.outcome) {
    statement = "Internal work completed. No expected Outcome has been defined yet, so nothing has been achieved.";
  } else if (input.observations.length === 0) {
    statement = "Internal work completed. The Outcome has no evidence-backed Observation yet, so achievement is still unknown.";
  } else if (outcomeAchieved) {
    statement = "Internal work completed and an evidence-backed Observation supports the expected Outcome.";
  } else {
    statement = `Internal work completed. The Outcome is "${String(outcomeState)}" — completing the work did not achieve it.`;
  }

  return {
    executionCompleted,
    taskCompleted,
    outcomeExists: Boolean(input.outcome),
    outcomeState,
    outcomeAchieved,
    observationCount: input.observations.length,
    completedWorkWithoutAchievedOutcome,
    statement,
  };
}

/** The decision-level boundary used before any Material Action exists. */
function emptyBoundary(): OutcomeBoundary {
  return buildBoundary({ latestExecution: null, task: null, outcome: null, observations: [] });
}

/**
 * Commands that authorize NEW work, and therefore re-run the whole governance gate.
 *
 * `dispatch_internal_task_execution` and the `start`/`retry` arms of
 * `transition_internal_task_execution` both call `p2_08_validate_execution_governance`,
 * which repeats every P2-07 check against the source Action: proposer identity, evaluation
 * present, `expires_at`, `valid_until`, `can_commit_action`, eligible state, and the
 * policy/grant evidence behind an `authorized` verdict.
 *
 * `block`, `fail` and `complete` deliberately do NOT revalidate, and must stay offered
 * even after an authorization lapses — otherwise a PM whose grant expired mid-flight could
 * no longer record that the work stopped, and the canonical execution would be stranded
 * in `running` forever. Recording that work ended is not authorizing new work.
 */
export const GOVERNANCE_REVALIDATED_COMMANDS: readonly ExecutionCommand[] = ["queue", "start", "retry"];

/**
 * Execution commands the P2-08 contract can actually accept right now.
 *
 * Three gates, all mirrored from the server rather than approximated:
 *
 *  1. The transition table above — `internal_execution_transition_invalid` otherwise.
 *  2. `queue` additionally requires a `not_started` Task, because
 *     `dispatch_internal_task_execution` refuses to open a first execution against a Task
 *     already in flight (`new_internal_execution_requires_not_started_task`).
 *  3. Governance revalidation for `queue`/`start`/`retry`, which is the same gate the task
 *     stage applies — so an authorization that lapsed after the Task was created stops
 *     offering new work here too, instead of failing at the server.
 */
export function offeredExecutionCommands(input: {
  action: GovernedActionView;
  task: GovernedTaskView | null;
  latestExecution: InternalExecutionView | null;
  actorUserId: string | null;
}): readonly ExecutionCommand[] {
  if (!input.task) return [];
  // `p2_08_validate_execution_governance` checks the ACTION's proposer, not the
  // execution's dispatcher, before authorizing new work.
  const actorIsProposer = !input.action.proposedBy || input.action.proposedBy === input.actorUserId;
  const newWorkAllowed = actorIsProposer && dispatchBlockReason(input.action) === null;
  const commands = allowedExecutionCommands(input.latestExecution?.status).filter((command) => {
    if (command === "queue" && !QUEUEABLE_TASK_STATES.includes(String(input.task!.status))) return false;
    if (!newWorkAllowed && GOVERNANCE_REVALIDATED_COMMANDS.includes(command as ExecutionCommand)) return false;
    return true;
  });
  return commands as readonly ExecutionCommand[];
}

/**
 * Can this branch still reach a completed internal execution, using only the commands the
 * contract would accept right now?
 *
 * Walks `EXECUTION_TRANSITIONS` as a real graph rather than hard-coding an answer, so it
 * stays correct if the canonical matrix changes. Governance-revalidated commands
 * (`queue`/`start`/`retry`) are removed from the edge set when new work is not authorized,
 * because `p2_08_validate_execution_governance` would reject them.
 *
 * A completed execution matters because it is the sole gate to an expected Outcome, which
 * is the only route to an Observation. If `completed` is unreachable, the branch cannot
 * advance toward its canonical terminal no matter what the PM clicks.
 */
export function canReachCompletedExecution(
  currentStatus: string | null | undefined,
  taskStatus: string | null,
  newWorkAllowed: boolean
): boolean {
  const start = currentStatus ?? "none";
  const seen = new Set<string>();
  const frontier = [start];
  while (frontier.length > 0) {
    const state = frontier.pop()!;
    if (state === "completed") return true;
    if (seen.has(state)) continue;
    seen.add(state);
    for (const command of EXECUTION_TRANSITIONS[state] ?? []) {
      if (!newWorkAllowed && GOVERNANCE_REVALIDATED_COMMANDS.includes(command as ExecutionCommand)) continue;
      // `queue` opens a first execution only from a not_started Task.
      if (command === "queue" && !QUEUEABLE_TASK_STATES.includes(String(taskStatus))) continue;
      const next = EXECUTION_COMMAND_TARGETS[command];
      if (next) frontier.push(next);
    }
  }
  return false;
}

/**
 * Whether this branch can still carry the chain forward at all.
 *
 * A Task existing is NOT proof of this. When the Action's authorization lapses after the
 * Task was created, `queue`/`start`/`retry` are withdrawn by governance revalidation, and
 * a Task sitting at `not_started`, `queued`, `blocked` or `failed` then has no accepted
 * operation that advances it — the chain is stranded, and treating the Task as proof of
 * life would deny the very replacement authorization that could recover it.
 *
 * Live means one of:
 *   - an Outcome already exists (the Observation path is open, and P2-09 needs no Action
 *     authorization), or
 *   - the work already finished (completed Task and execution — the Outcome path is open), or
 *   - a completed execution is still reachable from here, or
 *   - no Task exists yet and the authorization is still dispatchable.
 */
export function isBranchLive(branch: GovernedActionBranch): boolean {
  // A superseded Outcome is terminal, and the schema makes it a dead end rather than a
  // hand-off: `canonical_task_outcomes_one_per_task` is UNIQUE on (workspace, project,
  // task), so no replacement Outcome for this Task can exist, and
  // `record_canonical_outcome_observation` refuses to observe it. There is therefore no
  // canonical operation left on this branch — but that is NOT grounds to reopen Material
  // Action authorization. No contract in this repository produces `superseded` at all,
  // and none defines a transition from it, so inventing "superseded Outcome -> new
  // Action" would be fabricating domain the server does not have. The branch is reported
  // as stopped; the proposal stage is gated separately on that.
  if (branch.outcome) return !UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state);
  if (!branch.task) return branch.action.dispatchable;
  const executionCompleted = Boolean(
    branch.latestExecution && COMPLETED_EXECUTION_STATES.includes(branch.latestExecution.status)
  );
  const taskCompleted = COMPLETED_TASK_STATES.includes(String(branch.task.status));
  if (executionCompleted && taskCompleted) return true;
  const newWorkAllowed = dispatchBlockReason(branch.action) === null;
  return canReachCompletedExecution(branch.latestExecution?.status, branch.task.status, newWorkAllowed);
}

/**
 * Stages for ONE canonical Material Action and the work persisted beneath it.
 *
 * Every gate below mirrors a rule the authoritative server function enforces, so the
 * surface never offers an operation the contract must reject. Where the server would
 * refuse, the PM is told why here instead of discovering it from a rejected write.
 */
function buildBranchStages(input: {
  canWrite: boolean;
  actorUserId: string | null;
  action: GovernedActionView;
  task: GovernedTaskView | null;
  latestExecution: InternalExecutionView | null;
  /** Computed once by `offeredExecutionCommands` and shared with the branch, so the
   *  controls rendered and the stage gate can never be derived differently. */
  offeredCommands: readonly ExecutionCommand[];
  outcome: ExpectedOutcomeView | null;
  observations: OutcomeObservationView[];
  lineage: CompleteLineageProjection | null;
}): ExecutionStage[] {
  const roleBlocked = "Your role cannot record governed operations in this project.";

  // ---- Task ----------------------------------------------------------------
  // `dispatch_governed_action_to_internal_task`, in the order it checks: write capability,
  // then the actor who proposed it, then every governance gate — the last of which is the
  // single `dispatchBlockReason` predicate `action.dispatchable` is also derived from, so
  // the offered control and the stated reason can never disagree.
  let taskBlocked: string | null = null;
  if (!input.canWrite) taskBlocked = roleBlocked;
  else if (input.action.proposedBy && input.action.proposedBy !== input.actorUserId) {
    // The P2-06 in-process grant is actor-scoped and P2-07 refuses to transfer it
    // (`governed_action_actor_mismatch`). Ownership is read from the persisted
    // `proposed_by`, never inferred from a workspace role.
    taskBlocked = "Only the person who proposed this Material Action can turn it into a Task.";
  } else taskBlocked = dispatchBlockReason(input.action);

  // ---- Execution -----------------------------------------------------------
  const commands = input.offeredCommands;
  let executionBlocked: string | null = null;
  if (!input.task) executionBlocked = "No canonical Task exists yet.";
  else if (!input.canWrite) executionBlocked = roleBlocked;
  else if (input.latestExecution?.dispatchedBy && input.latestExecution.dispatchedBy !== input.actorUserId) {
    // `transition_internal_task_execution` refuses a transition by anyone other than the
    // dispatching actor (`internal_execution_actor_mismatch`).
    executionBlocked = "Only the person who dispatched this internal execution can change its state.";
  } else if (commands.length === 0) {
    // Distinguish "the state machine has nothing left" from "governance withdrew the
    // authorization new work needs". Both stop the control; only one is recoverable by a
    // replacement authorization, so the PM must be told which one this is.
    const transitionable = allowedExecutionCommands(input.latestExecution?.status);
    const governanceBlocked = dispatchBlockReason(input.action);
    if (transitionable.length > 0 && governanceBlocked) {
      executionBlocked = governanceBlocked;
    } else if (transitionable.length > 0 && input.action.proposedBy && input.action.proposedBy !== input.actorUserId) {
      executionBlocked = "Only the person who proposed this Material Action can authorize further work on it.";
    } else {
      executionBlocked = input.latestExecution
        ? `Internal execution is "${input.latestExecution.status.replaceAll("_", " ")}", which has no further transition available.`
        : `The canonical Task is "${String(input.task.status).replaceAll("_", " ")}", so a new internal execution cannot be opened for it.`;
    }
  }

  // ---- Expected Outcome ----------------------------------------------------
  // `ensure_expected_task_outcome` requires a completed Task AND a completed internal
  // execution. Defining an expected Outcome still says nothing about achievement.
  const executionCompleted = Boolean(input.latestExecution && COMPLETED_EXECUTION_STATES.includes(input.latestExecution.status));
  const taskCompleted = Boolean(input.task && COMPLETED_TASK_STATES.includes(String(input.task.status)));
  let outcomeBlocked: string | null = null;
  if (!input.task) outcomeBlocked = "An expected Outcome is defined against a canonical Task.";
  else if (!input.canWrite) outcomeBlocked = roleBlocked;
  else if (!taskCompleted) {
    outcomeBlocked = `The canonical Task is "${String(input.task.status).replaceAll("_", " ")}". An expected Outcome can only be defined once the Task is completed.`;
  } else if (!executionCompleted) {
    outcomeBlocked = "This Task has no completed internal execution yet, which an expected Outcome requires.";
  }

  // ---- Observation ---------------------------------------------------------
  // `record_canonical_outcome_observation` rejects a superseded Outcome outright
  // (`canonical_outcome_superseded`). It is the only outcome state the contract refuses;
  // every other state — including `disputed` and `inconclusive` — remains observable.
  let observationBlocked: string | null = null;
  if (!input.outcome) observationBlocked = "No expected Outcome exists to observe.";
  else if (!input.canWrite) observationBlocked = roleBlocked;
  else if (UNOBSERVABLE_OUTCOME_STATES.includes(input.outcome.state)) {
    observationBlocked =
      "This Outcome was superseded, so it is no longer the current Outcome to observe. Its recorded Observations remain part of the lineage.";
  }

  const executionState: ExecutionStageState = input.latestExecution
    ? COMPLETED_EXECUTION_STATES.includes(input.latestExecution.status) ? "complete" : "present"
    : "not_started";

  return [
    {
      key: "task",
      label: "Canonical internal task",
      state: input.task ? "present" : "not_started",
      actionable: taskBlocked === null && !input.task,
      blockedReason: taskBlocked,
      effect: "Turns the authorized Action into one canonical internal Task. Retrying reconciles to the same Task.",
    },
    {
      key: "execution",
      label: "Internal execution",
      state: executionState,
      actionable: executionBlocked === null && commands.length > 0,
      blockedReason: executionBlocked,
      effect: "Records internal execution state against the Task. It does not decide whether the Outcome happened.",
    },
    {
      key: "outcome",
      label: "Expected outcome",
      state: input.outcome ? "present" : "not_started",
      actionable: outcomeBlocked === null && !input.outcome,
      blockedReason: outcomeBlocked,
      effect: "Defines what this work is expected to achieve. Defining it does not claim it happened.",
    },
    {
      key: "observation",
      label: "Evidence-backed observation",
      state: input.observations.length > 0 ? "present" : "not_started",
      actionable: observationBlocked === null,
      blockedReason: observationBlocked,
      effect: "Records what evidence says actually happened, including missing, disputed or inconclusive.",
    },
    {
      key: "review",
      label: "Outcome review and lineage",
      state: input.lineage ? "present" : "not_started",
      actionable: false,
      blockedReason: input.lineage
        ? null
        : input.outcome
          ? "Complete lineage for this outcome is not available yet."
          : "Complete lineage becomes available once an expected Outcome exists.",
      effect: "Shows the canonical chain behind the conclusion, including gaps and disputes.",
    },
  ];
}

/**
 * The stage that requests a governed Material Action for this Decision.
 *
 * It stays available for a REPLACEMENT once no existing Action can still carry the chain
 * forward — the recovery path an expired authorization needs. P2-06 is append-only, so a
 * replacement never mutates or hides the earlier Action: it is a new canonical proposal
 * with its own idempotency key, evaluated on its own terms, and the expired one remains
 * visible with its audit lineage intact.
 */
function buildProposalStage(input: {
  decisionStatus: string;
  decisionIsOwnedByActor: boolean;
  hasEvidenceLink: boolean;
  canWrite: boolean;
  branches: GovernedActionBranch[];
}): ExecutionStage {
  const eligibleStatus = isActionEligibleDecisionStatus(input.decisionStatus);
  // A branch still carrying the chain: it either produced a Task (work exists and
  // continues there) or its authorization is still dispatchable.
  const liveBranch = input.branches.find((branch) => isBranchLive(branch));
  // A branch that stopped at a superseded Outcome is not live, but it is also not a
  // stranded authorization: reauthorizing would not revive it, because the dead end is
  // the Outcome, not the grant. Recovery via replacement is offered only for branches
  // stranded by governance (N7), never for this.
  const supersededBranch = input.branches.find(
    (branch) => branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)
  );

  let blocked: string | null = null;
  if (!input.canWrite) blocked = "Your role cannot record governed operations in this project.";
  else if (!eligibleStatus) blocked = `A ${String(input.decisionStatus).replaceAll("_", " ")} Decision does not authorize a material action.`;
  else if (!input.decisionIsOwnedByActor) blocked = "Only the person who recorded this Decision can request its material action.";
  else if (!input.hasEvidenceLink) blocked = "This Decision has no linked evidence snapshot, which a material action requires.";
  else if (liveBranch) {
    blocked = liveBranch.task
      ? "A governed Material Action for this Decision has already become a canonical Task."
      : "A governed Material Action for this Decision is still authorized to proceed.";
  } else if (supersededBranch) {
    blocked =
      "This Decision's Outcome was superseded. That is a terminal state for the Outcome, and no governed operation continues from it.";
  }

  const replacement = input.branches.length > 0;
  return {
    key: "material_action",
    label: replacement ? "Replacement governed material action" : "Governed material action",
    state: input.branches.length > 0 ? "present" : "not_started",
    actionable: blocked === null,
    blockedReason: blocked,
    effect: replacement
      ? "Records a NEW governed authorization for this Decision. The earlier Action and its audit trail are preserved unchanged."
      : "Records a governed authorization to act. It does not execute anything and does not create a Task.",
  };
}

/** Every stage of a chain, proposal first, then each branch in order. Used for gating
 *  and ordering — never to hide a stage. */
export function chainStages(chain: GovernedExecutionChain): ExecutionStage[] {
  return [chain.proposalStage, ...chain.branches.flatMap((branch) => branch.stages)];
}

/**
 * A short, honest summary of one branch, derived from the persisted governance state.
 *
 * "Authorized" is reserved for states P2-07 will actually dispatch. Every other state is
 * named as the contract names it rather than given a positive reading.
 */
export function describeBranch(branch: GovernedActionBranch): string {
  if (!branch.task) {
    const action = branch.action;
    // The positive reading is reachable ONLY through `dispatchable`, which answers every
    // gate P2-07 applies. `governance_state` alone can say "authorized" while the
    // evaluation has lapsed, withheld `can_commit_action`, or lost the grant evidence that
    // made it allowable — none of which authorizes anything.
    if (action.dispatchable) return `${describeGovernanceState(action.governanceState)} — no task yet`;
    if (action.revoked) return describeGovernanceState(action.governanceState);
    // A lapsed grant is named for what lapsed: the evaluation's `valid_until` counts here
    // exactly as the Action's own `expires_at` does, because dispatch dies on either.
    if (action.expired) return "Action authorization expired — no task";
    if (action.evaluationStale) return "Action authorization stale — no task";
    if (!action.hasEvaluation) return "Action proposed, not yet evaluated — no task";
    if (!isDispatchableGovernanceState(action.governanceState)) {
      return `${describeGovernanceState(action.governanceState)} — cannot become work`;
    }
    // An eligible state whose evaluation still withheld what dispatch requires.
    return "Action not dispatchable — governance withheld what dispatch requires";
  }
  if (!branch.outcome) {
    return branch.boundary.executionCompleted
      ? "Work completed — no expected outcome yet"
      : `Task ${String(branch.task.status).replaceAll("_", " ")} — work in progress`;
  }
  if (UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)) {
    return "Outcome superseded — no longer observable";
  }
  if (branch.observations.length === 0) return "Outcome expected — no observation yet";
  return `Observed: ${branch.observations[0].observationState.replaceAll("_", " ")}`;
}

/**
 * How the chain reads at a glance.
 *
 * A terminal stopped Decision is reported as stopped BEFORE any generic progress reading,
 * so a rejected Decision cannot sit in a queue looking like unfinished work forever. It is
 * never called "failed": the canonical Decision says rejected, and that is what is shown.
 */
export function describeChainStatus(
  decisionStatus: string,
  branches: GovernedActionBranch[]
): ChainStatus {
  if (decisionStatus === "rejected") {
    return {
      label: "Decision rejected",
      tone: "danger",
      detail: "Decision rejected — no governed action follows",
    };
  }

  const achieved = branches.find((branch) => branch.boundary.outcomeAchieved);
  if (achieved) return { label: "Outcome achieved", tone: "success", detail: describeBranch(achieved) };

  if (branches.length === 0) {
    return { label: "No action yet", tone: "info", detail: "Decision recorded — no material action requested yet" };
  }

  const live = branches.filter((branch) => isBranchLive(branch));
  if (live.length === 0) {
    // A superseded Outcome is a stopped chain, not an authorization problem. Reporting it
    // as "expired"/"not authorized" would name the wrong cause and imply reauthorization
    // could help, which it cannot.
    const superseded = branches.find(
      (branch) => branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)
    );
    if (superseded) {
      return {
        label: "Outcome superseded",
        tone: "info",
        detail: "Outcome superseded — no governed operation continues from it",
      };
    }
    const expired = branches.some((branch) => branch.action.expired);
    const stale = branches.some((branch) => branch.action.evaluationStale);
    return {
      label: expired ? "Authorization expired" : stale ? "Authorization stale" : "Not authorized to proceed",
      tone: "danger",
      detail: describeBranch(branches[0]),
    };
  }

  return { label: "In progress", tone: "task", detail: describeBranch(live[0]) };
}

/**
 * Projects one execution chain per persisted Decision, carrying EVERY canonical Material
 * Action beneath it.
 *
 * `material_action_proposals.source_decision_id` is not unique — the only uniqueness the
 * schema declares is `(workspace_id, idempotency_key)` — so one Decision may legitimately
 * hold several Actions, whether created by another surface or as a replacement after an
 * authorization expired. Keeping only the first would make the others' Tasks, Executions,
 * Outcomes and Observations unreachable here, so each is projected as its own branch with
 * a stable identity derived from the canonical Action id.
 *
 * Non-terminal Decisions (escalated / needs_more_evidence) are deliberately excluded:
 * they leave the Recommendation open and authorize nothing downstream. Rejected
 * Decisions ARE included so the PM can see that they legitimately stop here, rather
 * than the surface quietly hiding them.
 */
export function buildExecutionChains(
  summary: OperationalSummary | undefined,
  now: Date = new Date()
): GovernedExecutionChain[] {
  if (!summary) return [];

  const actionsByDecision = new Map<string, AnyRecord[]>();
  for (const action of summary.materialActions ?? []) {
    const decisionId = str(action.source_decision_id);
    if (!decisionId) continue;
    const bucket = actionsByDecision.get(decisionId);
    if (bucket) bucket.push(action);
    else actionsByDecision.set(decisionId, [action]);
  }

  // Newest evaluation wins: P2-06 appends an evaluation row per governance transition,
  // and `dispatch_governed_action_to_internal_task` reads the latest one the same way.
  const evaluationsByAction = new Map<string, AnyRecord>();
  for (const evaluation of summary.materialActionEvaluations ?? []) {
    const actionId = str(evaluation.action_id);
    if (!actionId) continue;
    const previous = evaluationsByAction.get(actionId);
    // Strictly greater, so an exact tie on BOTH timestamps keeps the first row rather
    // than letting iteration order decide.
    if (!previous || compareEvaluations(evaluation, previous) > 0) {
      evaluationsByAction.set(actionId, evaluation);
    }
  }

  const taskByActionId = new Map<string, AnyRecord>();
  for (const task of summary.tasks ?? []) {
    const sourceActionId = readSourceActionId(task);
    // P2-07's unique expression index makes this at most one Task per Action.
    if (sourceActionId && !taskByActionId.has(sourceActionId)) taskByActionId.set(sourceActionId, task);
  }

  const evidenceLinkedDecisionIds = new Set(
    (summary.evidenceLinks ?? []).map((link) => String(link.decision_record_id))
  );

  const recommendationTitleById = new Map(
    (summary.recommendations ?? []).map((row) => [String(row.id), str(row.recommendation)])
  );

  const actorUserId = str(summary.actor?.userId);
  const canWrite = summary.actor?.canCreateEvidence === true;

  const chains: GovernedExecutionChain[] = [];

  /*
   * The chain ROOT: the recent Decision window PLUS every Decision the server proved still
   * has open governed work.
   *
   * `summary.decisions` is a newest-30 history window. A Decision older than that with a
   * Task still running is not "finished" — it is invisible, and a queue rooted on the
   * window alone would report an empty "In Progress" while the work continued. W4 adds
   * `governedExecutionRootDecisions`, resolved server-side from non-terminal executions,
   * pending results and unexpired Actions.
   *
   * Deduped by canonical id, so a Decision present in both is projected once. Ordering
   * follows the window first, which keeps the recent-activity reading stable and appends
   * the older still-open chains behind it rather than reshuffling the surface.
   */
  const rootDecisions: AnyRecord[] = [];
  const seenDecisionIds = new Set<string>();
  for (const decision of [...(summary.decisions ?? []), ...(summary.governedExecutionRootDecisions ?? [])]) {
    const id = str(decision.id);
    if (!id || seenDecisionIds.has(id)) continue;
    seenDecisionIds.add(id);
    rootDecisions.push(decision);
  }

  for (const decision of rootDecisions) {
    const decisionId = String(decision.id);
    const decisionStatus = String(decision.decision_status);
    const terminal = ["accepted", "rejected", "modified"].includes(decisionStatus);
    if (!terminal) continue;

    // Newest Action first, so a replacement leads and the superseded one stays visible
    // beneath it rather than disappearing.
    const actionRows = [...(actionsByDecision.get(decisionId) ?? [])].sort(
      (a, b) => actionOrder(b) - actionOrder(a)
    );

    const branches: GovernedActionBranch[] = actionRows.map((actionRow) => {
      const action = buildActionView(actionRow, evaluationsByAction.get(String(actionRow.id)), now);

      const taskRow = taskByActionId.get(action.actionId);
      const task: GovernedTaskView | null = taskRow
        ? {
            taskId: String(taskRow.id),
            title: str(taskRow.title) ?? "Governed task",
            status: String(taskRow.status ?? "unknown"),
            sourceActionId: readSourceActionId(taskRow),
            createdAt: str(taskRow.created_at),
            completedAt: str(taskRow.completed_at),
          }
        : null;

      const executions: InternalExecutionView[] = task
        ? (summary.executions ?? [])
            .filter((row) => str(row.task_id) === task.taskId)
            .map((row) => ({
              executionId: String(row.id),
              taskId: str(row.task_id),
              sourceActionId: str(row.source_action_id),
              status: String(row.status ?? "unknown"),
              attemptCount: num(row.attempt_count),
              providerKey: str(row.provider_key),
              failureClass: str(row.failure_class),
              dispatchedBy: str(row.dispatched_by),
              queuedAt: str(row.queued_at),
              startedAt: str(row.started_at),
              completedAt: str(row.completed_at),
            }))
            .sort((a, b) => String(b.queuedAt ?? "").localeCompare(String(a.queuedAt ?? "")))
        : [];
      const latestExecution = executions[0] ?? null;

      const outcomeRow = task ? (summary.outcomes ?? []).find((row) => str(row.task_id) === task.taskId) : undefined;
      const outcome: ExpectedOutcomeView | null = outcomeRow
        ? {
            outcomeId: String(outcomeRow.id),
            taskId: str(outcomeRow.task_id),
            sourceActionId: str(outcomeRow.source_action_id),
            internalExecutionId: str(outcomeRow.internal_execution_id),
            state: String(outcomeRow.state ?? "unknown"),
            expectedResult: str(outcomeRow.expected_result),
          }
        : null;

      const observations: OutcomeObservationView[] = outcome
        ? (summary.observations ?? [])
            .filter((row) => str(row.outcome_id) === outcome.outcomeId)
            .map((row) => ({
              observationId: String(row.id),
              outcomeId: str(row.outcome_id),
              taskId: str(row.task_id),
              observationState: String(row.observation_state ?? "unknown"),
              missingDataState: str(row.missing_data_state),
              confidenceScore: num(row.confidence_score),
              summary: str(row.summary),
              evidenceReferenceIds: strList(row.evidence_reference_ids),
              recordedAt: str(row.recorded_at),
              idempotencyKey: str(row.idempotency_key),
            }))
            .sort((a, b) => String(b.recordedAt ?? "").localeCompare(String(a.recordedAt ?? "")))
        : [];

      const lineage = outcome
        ? (summary.lineages ?? []).find((projection) => projection.outcomeId === outcome.outcomeId) ?? null
        : null;

      const offeredCommands = offeredExecutionCommands({ action, task, latestExecution, actorUserId });

      return {
        id: `governed-branch-${action.actionId}`,
        action,
        task,
        executions,
        latestExecution,
        offeredCommands,
        outcome,
        observations,
        lineage,
        stages: buildBranchStages({
          canWrite,
          actorUserId,
          action,
          task,
          latestExecution,
          offeredCommands,
          outcome,
          observations,
          lineage,
        }),
        boundary: buildBoundary({ latestExecution, task, outcome, observations }),
      };
    });

    // The chain speaks for its most advanced branch: an achieved Outcome if one exists,
    // otherwise the newest branch that is still carrying work.
    const leading =
      branches.find((branch) => branch.boundary.outcomeAchieved) ??
      branches.find((branch) => isBranchLive(branch)) ??
      branches[0] ??
      null;

    chains.push({
      kind: "governed_execution_chain",
      id: `governed-chain-${decisionId}`,
      decisionId,
      decisionStatus,
      decisionTerminal: terminal,
      decidedBy: str(decision.decided_by),
      decisionRecordedAt: str(decision.created_at),
      rationale: str(decision.rationale),
      recommendationId: str(decision.recommendation_id),
      title:
        (decision.recommendation_id ? recommendationTitleById.get(String(decision.recommendation_id)) : null) ??
        str(decision.decision) ??
        "Recorded decision",
      branches,
      proposalStage: buildProposalStage({
        decisionStatus,
        decisionIsOwnedByActor: Boolean(actorUserId) && str(decision.decided_by) === actorUserId,
        hasEvidenceLink: evidenceLinkedDecisionIds.has(decisionId),
        canWrite,
        branches,
      }),
      status: describeChainStatus(decisionStatus, branches),
      boundary: leading?.boundary ?? emptyBoundary(),
    });
  }

  return chains;
}

/** Sort key for Material Actions of one Decision. Uses persisted times only. */
function actionOrder(action: AnyRecord): number {
  const value = str(action.persisted_at) ?? str(action.created_at);
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Sort key for governance evaluations, matching the server's own
 * `order by evaluated_at desc, recorded_at desc` — as a TUPLE, not a single column.
 *
 * Collapsing the two into one number made tied `evaluated_at` values compare equal, and
 * whichever row happened to be iterated last then won. The summary arrives newest-first,
 * so the last-iterated row is the OLDEST: a revocation recorded after an authorization at
 * the same evaluation instant was silently replaced by the authorization it superseded,
 * and the surface would offer operations the RPC rejects.
 */
function evaluationOrder(evaluation: AnyRecord): [number, number] {
  const at = (column: string): number => {
    const value = str(evaluation[column]);
    const parsed = value ? new Date(value).valueOf() : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [at("evaluated_at"), at("recorded_at")];
}

/** Descending tuple comparison. Positive when `a` is the newer evaluation. */
function compareEvaluations(a: AnyRecord, b: AnyRecord): number {
  const [aEvaluated, aRecorded] = evaluationOrder(a);
  const [bEvaluated, bRecorded] = evaluationOrder(b);
  if (aEvaluated !== bEvaluated) return aEvaluated - bEvaluated;
  return aRecorded - bRecorded;
}

export function findExecutionChainByDecisionId(
  chains: GovernedExecutionChain[],
  decisionId: string
): GovernedExecutionChain | undefined {
  return chains.find((chain) => chain.decisionId === decisionId);
}

/** Every canonical Action projected across all chains. Nothing persisted is dropped. */
export function selectAllBranches(chains: GovernedExecutionChain[]): GovernedActionBranch[] {
  return chains.flatMap((chain) => chain.branches);
}

/** Chains a PM can still move forward. Used for ordering only — never to hide a chain. */
export function selectAdvanceableChains(chains: GovernedExecutionChain[]): GovernedExecutionChain[] {
  return chains.filter((chain) => chainStages(chain).some((stage) => stage.actionable));
}
