export const SIGNAL_TYPES = [
  "scope_creep", "schedule_risk", "cost_risk", "quality_risk", "stakeholder_blocker",
  "missing_approval", "decision_needed", "delivery_impediment", "billing_risk", "governance_gap",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];
export type Severity = "low" | "medium" | "high" | "critical";
export type DecisionStatus = "accepted" | "rejected" | "modified" | "escalated" | "needs_more_evidence";
export type EvidenceAssertionType = "FACT" | "INFERENCE" | "ASSUMPTION";
export type EvidenceClassification = "UNCLASSIFIED" | "PROJECT_STATUS" | "RISK" | "ISSUE" | "DECISION_CONTEXT" | "DELIVERY";
export type MissingDataState = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type DeriveEvidenceInput = {
  normalizedEventId: string;
  idempotencyKey: string;
  assertionType: EvidenceAssertionType;
  classification: EvidenceClassification;
  confidenceScore: number;
  missingDataState: MissingDataState;
  evaluatedAt: string;
  staleAt?: string | null;
};

export type EvidenceProvenanceResult = {
  disposition: "created" | "duplicate";
  source: Record<string, unknown>;
  rawInput: Record<string, unknown>;
  normalizedEvent: Record<string, unknown>;
  evidence: Record<string, unknown>;
  auditEventId?: string | null;
  intelligenceRan: false;
};

export type DetectedSignal = {
  signalType: SignalType;
  severity: Severity;
  confidenceScore: number;
  summary: string;
  rationale: string;
};

export type GovernanceEvaluation = {
  ruleKey: string;
  authorityRequired: string;
  evidenceRequired: boolean;
  governanceStatus: "compliant" | "warning" | "violation" | "decision_required";
  explanation: string;
};

export type OperationalAssuranceSummary = {
  scope: "project";
  workspaceId: string;
  projectId: string;
  asOf: string;
  totalGovernanceEvents: number;
  decisionRequiredCount: number;
  violationsCount: number;
  openRecommendations: number;
  /**
   * Canonical ids of exactly the Recommendations `openRecommendations` counted, produced by
   * the SAME statement — therefore the same snapshot.
   *
   * `asOf` is `now()`, a wall-clock reading, not a token of MVCC visibility: a transaction
   * that began before `asOf` can commit after the assurance statement's snapshot, and its
   * row then satisfies `created_at <= asOf AND updated_at <= asOf` for every later read
   * while never having been counted. Timestamps therefore cannot decide membership, and
   * cardinality cannot prove it. These ids can.
   *
   * Optional because a database that has not yet applied
   * `20260908000000_p2_02_attention_membership_snapshot.sql` does not return it. Absence
   * means membership is unfrozen, and completeness is then UNPROVEN rather than assumed.
   */
  openRecommendationIds?: string[];
  unresolvedRisksIssues: number;
  evidenceLinkedDecisionsCount: number;
  evidenceWithoutSignalCount: number;
  incompleteChainCount: number;
};

export type CanonicalTaskOutcomeState =
  | "expected"
  | "observing"
  | "achieved"
  | "partially_achieved"
  | "not_achieved"
  | "disputed"
  | "inconclusive"
  | "superseded";

export type CanonicalOutcomeObservationState =
  | "achieved"
  | "partial"
  | "failed"
  | "disputed"
  | "inconclusive";

export type EnsureExpectedOutcomeInput = {
  taskId: string;
  expectedResult: string;
  successCriteria?: unknown[];
  correlationId: string;
  causationId?: string | null;
};

export type RecordOutcomeObservationInput = {
  outcomeId: string;
  observationState: CanonicalOutcomeObservationState;
  summary: string;
  evidenceReferenceIds: string[];
  confidenceScore: number;
  missingDataState: MissingDataState;
  observedAt: string;
  evaluatedAt: string;
  staleAt?: string | null;
  correlationId: string;
  causationId?: string | null;
  idempotencyKey: string;
};

export type LineageStepKind =
  | "source"
  | "raw_input"
  | "normalized_event"
  | "evidence"
  | "finding"
  | "governance"
  | "recommendation"
  | "decision"
  | "material_action"
  | "task"
  | "internal_execution"
  | "outcome"
  | "observation";

export type LineageLinkRelationship =
  | "causation"
  | "correlation_only"
  | "direct_reference"
  | "unlinked";

export type LineageLinkStatus =
  | "intact"
  | "missing"
  | "disputed"
  | "inconclusive"
  | "degraded"
  | "fixture";

export type LineageStepNode = {
  kind: LineageStepKind;
  id: string | null;
  title: string;
  status: LineageLinkStatus;
  summary: string;
  entity: Record<string, unknown> | null;
  correlationId: string | null;
  causationId: string | null;
  isFixture: boolean;
  fixtureLabel: string | null;
  gapReason: string | null;
  occurredAt: string | null;
  recordedAt: string | null;
  actorId: string | null;
  evidenceAssertionType?: EvidenceAssertionType | null;
  confidenceScore?: number | null;
  missingDataState?: MissingDataState | null;
};

export type LineageTransition = {
  fromKind: LineageStepKind;
  toKind: LineageStepKind;
  relationship: LineageLinkRelationship;
  relationshipExplanation: string;
  isCausal: boolean;
  correlationId: string | null;
  causationId: string | null;
};

export type CompleteLineageProjection = {
  outcomeId: string;
  taskId: string;
  expectedResult: string;
  outcomeState: CanonicalTaskOutcomeState;
  observationsCount: number;
  latestObservationState: CanonicalOutcomeObservationState | null;
  lineageStatus: "complete" | "incomplete" | "disputed" | "inconclusive" | "degraded";
  hasCorrelationOnly: boolean;
  steps: LineageStepNode[];
  transitions: LineageTransition[];
  auditEvents: Record<string, unknown>[];
  gaps: string[];
  disputes: string[];
  isFixture: boolean;
  fixtureLabel: string | null;
};

export type AuditReconstructionItem = {
  id: string;
  eventType: string;
  eventCategory: string;
  actorId: string | null;
  actorType: string;
  occurredAt: string;
  recordedAt: string;
  correlationId: string | null;
  causationId: string | null;
  rawReferenceTable: string | null;
  rawReferenceId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  relationship: "causation" | "correlation_only" | "unlinked";
};

/**
 * One governed Recommendation's upstream canonical lineage, resolved by exact reference
 * rather than read out of a presentation window.
 *
 * `lineageComplete` mirrors exactly what `record_operational_decision` requires before it
 * evaluates authority: the Governance Event (matching this Recommendation's risk), the
 * Risk/Issue, the Signal and the Evidence must all exist. It is a statement about the
 * database, not about what a page happened to load.
 */
export type GovernedAttentionContext = {
  recommendationId: string;
  governanceEvent: Record<string, unknown> | null;
  riskIssue: Record<string, unknown> | null;
  signal: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  /** True when every node the canonical write requires exists. */
  lineageComplete: boolean;
  /** The exact linked Governance Event's `authority_required`. Null ONLY when that event
   *  genuinely does not exist — never because it fell outside a window. */
  authorityRequired: string | null;
};

export type OperationalSummary = {
  /**
   * The server's own clock reading when this summary was produced, ISO-8601.
   *
   * Deadline-sensitive facts — Action `expires_at`, evaluation `valid_until`, Evidence
   * `stale_at` — are compared against a clock, and the browser's is not authoritative
   * (see the P2-06 window). This anchor lets a surface measure elapsed time locally
   * while still starting from server time. It governs only WHEN the surface recomputes
   * and what it offers; every write remains validated server-side.
   */
  generatedAt?: string;
  sources: Array<Record<string, unknown>>;
  rawInputs: Array<Record<string, unknown>>;
  normalizedEvents: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  /**
   * Evidence that satisfies P2-09's Observation eligibility predicate, selected by that
   * predicate on the server BEFORE any row limit.
   *
   * `evidence` above is a presentation window — the newest N rows, whatever their state.
   * Filtering it client-side answers "which of the newest rows are eligible", not "is any
   * eligible Evidence available", and those differ the moment the newest rows are
   * fixtures, stale or degraded. A surface that offers Evidence must read this collection,
   * or it will tell a PM there is none while the RPC would happily accept an older row.
   */
  observationEligibleEvidence?: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
  risksIssues: Array<Record<string, unknown>>;
  governanceEvents: Array<Record<string, unknown>>;
  recommendations: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  evidenceLinks: Array<Record<string, unknown>>;
  materialActions: Array<Record<string, unknown>>;
  materialActionEvaluations: Array<Record<string, unknown>>;
  outcomes?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  /** Governed `execution_tasks` rows (P2-07). Linked to their Action by
   *  `source_payload.sourceActionId`; never client-minted. */
  tasks?: Array<Record<string, unknown>>;
  /** `internal_task_executions` rows (P2-08). A Task's execution history is a
   *  separate record from the Task itself and is never collapsed into it. */
  executions?: Array<Record<string, unknown>>;
  /**
   * Authoritative upstream lineage for each governed Recommendation in the bounded
   * recommendation window — the ONE thing the windowed collections cannot answer.
   *
   * Every other collection above is an independently truncated presentation window, and
   * absence from one is not absence from the project. `record_operational_decision`
   * resolves Governance -> Risk -> Signal -> Evidence by exact persisted reference and
   * refuses only when a node genuinely does not exist, so a surface that decides
   * "the evidence is missing" from the newest-20 evidence window will tell a PM their
   * decision would be refused when the server would happily accept it.
   *
   * This carries that resolution, completed by exact id. It is deliberately SEPARATE from
   * `evidence`, `signals`, `risksIssues` and `governanceEvents`: those keep their
   * recent-window meaning, which "What changed" and "PMFreak is monitoring" depend on, and
   * nothing here is unioned into them.
   */
  /**
   * The governed Recommendations that currently need human attention — every one whose
   * `status` is `proposed`, fetched for Needs You specifically.
   *
   * DISTINCT from `recommendations` above, which is a recent HISTORY window across all
   * statuses. Thirty newer accepted/rejected/modified Recommendations push an older
   * still-open one out of that window, and an attention queue rooted on it would then show
   * nothing and tell the PM they are clear while a real decision waited.
   */
  /**
   * Decisions with OPEN governed work that the recent `decisions` window does not reach.
   *
   * `decisions` is the newest-30 project-wide history window, and the execution chain
   * projection walks outward from it. Thirty newer decisions push an older one out, taking
   * every Action, Task, Execution and Outcome beneath it off the surface — so "In Progress"
   * would render empty while work was genuinely running.
   *
   * Membership is named by the DATABASE, as canonical ids, from ONE statement:
   * `get_governed_execution_root` returns `openExecutionDecisionIds` under exactly the
   * predicate `deriveDecisionJourney` uses for `closure === "open"` — a work-bearing
   * Decision with no Material Action yet, or with at least one branch that is neither
   * superseded nor observed. Only ids the snapshot named appear here; a row that became
   * open after the projection was taken is a NONMEMBER and cannot stand in for one.
   *
   * An earlier cut assembled this from three independent reads (active executions, pending
   * outcomes, unexpired actions). Three statements are three MVCC snapshots, so a
   * completion committing between two of them could empty all three for a chain that was
   * open throughout — and those three predicates never covered the two open journeys that
   * carry no work-shaped row at all.
   *
   * Deliberately SEPARATE from `decisions`, which keeps its recent-history meaning.
   */
  governedExecutionRootDecisions?: Array<Record<string, unknown>>;
  /**
   * Whether the execution root above provably holds every open governed chain.
   *
   * Proven BY IDENTITY: every id the single-statement projection named was resolved. False
   * whenever the projection is absent (an older database), disagrees with its own count, a
   * frozen member could not be loaded, or membership exceeded the read's safety ceiling.
   * The surface must then withhold both its count and the claim that nothing is in
   * progress — a successful request is not completeness. Absent on a payload produced
   * before W4.
   */
  governedExecutionRootComplete?: boolean;
  governedAttentionRecommendations?: Array<Record<string, unknown>>;
  /**
   * Whether the set above provably represents every open governed Recommendation in the
   * project, checked against the assurance RPC's own project-wide count.
   *
   * A successful request is NOT completeness. This is false whenever fewer open
   * Recommendations were loaded than the project actually has, and the surface must then
   * never state a definitive total or tell the PM they are clear.
   */
  governedAttentionComplete?: boolean;
  /** Project-wide count of open governed Recommendations, from `assurance.openRecommendations`
   *  — never counted from a presentation window. */
  governedAttentionTotal?: number;
  /**
   * Governed Recommendations referenced by the Decisions already in `decisions`, fetched by
   * exact canonical id.
   *
   * Needed because the attention root reaches Recommendations older than every history
   * window. Deciding one terminally removes it from the open set, and it was never in the
   * newest-30 Recommendation window — so without this the drawer the PM just used would
   * resolve to nothing at the moment their decision landed. This is a LOOKUP projection:
   * `selectPendingAttention` still decides queue membership, so a decided Recommendation
   * never re-enters Needs You.
   */
  governedAttentionReconciliationRecommendations?: Array<Record<string, unknown>>;
  /**
   * Decisions recorded against the OPEN attention roots, fetched by exact
   * `recommendation_id`.
   *
   * `decisions` is the newest-30 project-wide window. `escalated` and
   * `needs_more_evidence` write a real Decision and return the Recommendation to
   * `proposed`, so an open item legitimately carries history — and that history can be
   * older than the window. Reading it from the window alone loses it.
   */
  governedAttentionDecisions?: Array<Record<string, unknown>>;
  /** Frozen evidence snapshots for `governedAttentionDecisions`, by exact
   *  `decision_record_id`, so the technical disclosure keeps its provenance. */
  governedAttentionDecisionEvidenceLinks?: Array<Record<string, unknown>>;
  governedAttentionContexts?: GovernedAttentionContext[];
  lineages?: CompleteLineageProjection[];
  assurance: OperationalAssuranceSummary;
  actor: { role: string | null; userId?: string | null; canCreateEvidence: boolean };
};
