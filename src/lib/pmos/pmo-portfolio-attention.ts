/**
 * P2-17 — Qualified Portfolio Projection (pure).
 *
 * The PMO Command Center's attention projection: which of a PMO's projects need attention,
 * why, how confident PMFreak is, how complete the view is, and where to drill down. It is a
 * READ projection — ADR-PMF-065 ("Command Centers are Query compositions, not stores") — so
 * nothing here is persisted and no project-level record is owned or rewritten here.
 *
 * Honesty rules this module enforces:
 *   - Every attention reason is ONE canonical fact (a P2-16 schedule exposure, an unresolved
 *     risk/issue record, a governed Recommendation awaiting decision, an observed Outcome
 *     divergence, or an incomplete canonical chain) mapped to a level by a PUBLISHED rule
 *     (`PMO_ATTENTION_RULES`). There is no composite score and no weights: projects are
 *     ordered lexicographically by `PMO_ATTENTION_ORDERING`, so every placement is explainable.
 *   - Coverage (how many projects PMFreak could assess) and confidence (how certain the claims
 *     it does make are) are separate values and never collapse into one number.
 *   - Absence of a signal is not health. A project with no canonical basis for a dimension is
 *     reported as missing inputs, never as "no attention needed".
 *   - Freshness is carried per reason. A schedule exposure recorded against a schedule that has
 *     since changed is SUPERSEDED (stale), not current, and is kept apart from the reasons as
 *     provenance: it never sets a level, a ranking or a confidence.
 *   - Cross-project dependencies and resource conflicts are reported as unsupported/unavailable
 *     because PMFreak holds no canonical contract for them (see the constants below).
 *   - Identical membership + canonical state + evaluation clock yields identical content; the
 *     membership and assessment digests never include a wall-clock value.
 *
 * Inputs are identifiers and rows the SERVER read under the caller's RLS client — never
 * caller-supplied metrics. The loader lives in `./pmo-portfolio-attention-loader`.
 */
import { createHash } from "node:crypto";
import type { ProjectStatus } from "@/lib/db/database-contract";
import type { ScheduleExposureRecord } from "@/lib/critical-path/schedule-exposure-service";
import { projectCommandCenterPath } from "@/lib/projects/project-command-center-paths";
import { workspaceCommandCenterPath } from "@/lib/workspaces/workspace-paths";

export const PMO_ATTENTION_CONTRACT = "pmfreak/pmo-portfolio-attention:v1";
export const PMO_ATTENTION_METHOD = "pmo-attention-rules:v1";
export const PMO_MEMBERSHIP_CANONICALIZATION = "pmo-membership:v1";
export const PMO_ASSESSMENT_CANONICALIZATION = "pmo-assessment:v1";
export const PMO_ATTENTION_CONFIDENCE_METHOD = "pmo-attention-confidence:v1";
/** Deterministic templates render reason summaries from structured facts; no model writes them. */
export const PMO_ATTENTION_SUMMARY_SOURCE = "deterministic-template:v1";
/** Projects evaluated per request. Beyond this, projects are reported as not evaluated. */
export const PMO_ATTENTION_EVALUATION_LIMIT = 40;
/** Rows read per canonical collection. A full page is reported as truncated, never as complete. */
export const PMO_ATTENTION_ROW_CAP = 500;

export type PmoAttentionLevel = "critical" | "high" | "medium" | "low";
export const PMO_ATTENTION_LEVELS: readonly PmoAttentionLevel[] = ["critical", "high", "medium", "low"];
const LEVEL_RANK: Record<PmoAttentionLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export type PmoAttentionReasonKind =
  | "schedule_exposure"
  | "open_finding"
  | "pending_recommendation"
  | "outcome_divergence"
  | "incomplete_evidence_chain";

/**
 * The published rule table. Every level on the screen is produced by exactly one row here, and
 * the row id travels with the reason so a PMO (or a reviewer) can see which rule placed it.
 */
export const PMO_ATTENTION_RULES = [
  { id: "schedule.severity.critical", kind: "schedule_exposure", level: "critical", when: "P2-16 schedule exposure severity is critical (maximum slip ≥ 15 days)" },
  { id: "schedule.severity.high", kind: "schedule_exposure", level: "high", when: "P2-16 schedule exposure severity is high (slip ≥ 5 days, or any slip on a critical milestone)" },
  { id: "schedule.severity.medium", kind: "schedule_exposure", level: "medium", when: "P2-16 schedule exposure severity is medium (any slip)" },
  { id: "schedule.severity.low", kind: "schedule_exposure", level: "low", when: "P2-16 schedule exposure qualified without slip" },
  { id: "finding.unresolved.critical", kind: "open_finding", level: "critical", when: "Unresolved risk/issue record (status not resolved/closed) with severity critical" },
  { id: "finding.unresolved.high", kind: "open_finding", level: "high", when: "Unresolved risk/issue record (status not resolved/closed) with severity high" },
  { id: "recommendation.pending.immediate", kind: "pending_recommendation", level: "high", when: "Governed Recommendation awaiting decision with urgency immediate" },
  { id: "recommendation.pending.high", kind: "pending_recommendation", level: "medium", when: "Governed Recommendation awaiting decision with urgency high" },
  { id: "recommendation.pending.other", kind: "pending_recommendation", level: "low", when: "Governed Recommendation awaiting decision with urgency medium, low or unset" },
  { id: "outcome.not_achieved", kind: "outcome_divergence", level: "high", when: "Canonical Outcome observed as not achieved" },
  { id: "outcome.partially_achieved", kind: "outcome_divergence", level: "medium", when: "Canonical Outcome observed as partially achieved" },
  { id: "outcome.disputed", kind: "outcome_divergence", level: "medium", when: "Canonical Outcome is disputed" },
  { id: "evidence.chain_incomplete", kind: "incomplete_evidence_chain", level: "low", when: "A recorded schedule exposure has Evidence but no Finding/Recommendation yet" },
] as const satisfies ReadonlyArray<{ id: string; kind: PmoAttentionReasonKind; level: PmoAttentionLevel; when: string }>;

export type PmoAttentionRuleId = (typeof PMO_ATTENTION_RULES)[number]["id"];
const RULES_BY_ID = new Map<string, (typeof PMO_ATTENTION_RULES)[number]>(PMO_ATTENTION_RULES.map((rule) => [rule.id, rule]));

/** Lexicographic ordering keys, most significant first. Published with every projection. */
export const PMO_ATTENTION_ORDERING = [
  "highest attention level among the project's reasons",
  "number of reasons at that level",
  "number of current (non-stale) reasons",
  "project name (case-insensitive), then project id",
] as const;

export const CROSS_PROJECT_DEPENDENCY_SUPPORT = {
  support: "unsupported",
  relationships: [] as never[],
  reason:
    "PMFreak has no supported cross-project dependency relationship. The canonical dependency write path refuses edges between projects, so any such edge would not be a governed fact. Shared dates, owners, customers or labels are not treated as dependencies.",
} as const;

export const RESOURCE_CONFLICT_SUPPORT = {
  support: "unavailable",
  conflicts: [] as never[],
  reason:
    "Resource conflict analysis is unavailable. PMFreak records task owners and dates, but no resource allocation amount, capacity or allocation period, so it cannot prove over-allocation. A shared assignee is not a conflict.",
  missingInputs: ["resource identity with allocation amount", "allocation period", "resource capacity"],
} as const;

// ── Inputs (rows the server read under the caller's RLS client) ────────────────────────

export type PmoAttentionProjectRow = { id: string; name: string; status: ProjectStatus | string };

export type PmoRiskRow = {
  id: string;
  project_id: string;
  signal_id: string;
  type: string;
  title: string;
  severity: string;
  status: string;
  updated_at: string;
};

export type PmoRecommendationRow = {
  id: string;
  project_id: string;
  title: string;
  recommendation: string | null;
  urgency: string | null;
  confidence_score: number | string | null;
  source_signal_id: string | null;
  created_at: string;
};

export type PmoOutcomeRow = {
  id: string;
  project_id: string;
  task_id: string;
  state: string;
  expected_result: string;
  updated_at: string;
  fixture_label: string | null;
};

export type PmoObservationRow = {
  id: string;
  project_id: string;
  outcome_id: string;
  observation_state: string;
  confidence_score: number | string;
  missing_data_state: string;
  observed_at: string;
  stale_at: string | null;
  recorded_at: string;
  fixture_label: string | null;
};

export type PmoSignalRow = { id: string; project_id: string; evidence_item_id: string; confidence_score: number | string; signal_type: string };

export type PmoEvidenceRow = {
  id: string;
  project_id: string;
  /** `schedule_evaluation` marks P2-16 schedule Evidence (see SCHEDULE_EVIDENCE_SOURCE_TYPE). */
  source_type: string;
  fixture_state: string;
  freshness_state: string;
  lifecycle: string;
  stale_at: string | null;
};

/** One batched read. `ok: false` means the read failed; `truncated` means the page was full. */
export type PmoCollection<T> = { ok: true; rows: T[]; truncated: boolean } | { ok: false };

export type PmoProjectSignalInput = {
  /** Canonical (normalized-event-derived) Evidence counts; null when the read failed. */
  evidenceBasis: { canonical: number; live: number } | null;
  /** Number of canonical Outcomes of any state; null when the read failed. */
  outcomeCount: number | null;
  /** P2-16 projection plus the digest of the CURRENT schedule; null when the read failed. */
  schedule: { exposures: ScheduleExposureRecord[]; currentSnapshotDigest: string } | null;
};

export type PmoAttentionInput = {
  workspaceId: string;
  pmoId: string;
  /** The PMO's projects, already scoped by workspace AND exact pmo_id. */
  projects: readonly PmoAttentionProjectRow[];
  /** Explicit evaluation clock (server time). Never part of any digest. */
  evaluatedAt: string;
  /** Keyed by project id; only projects that were evaluated have an entry. */
  perProject: Readonly<Record<string, PmoProjectSignalInput>>;
  batch: {
    risks: PmoCollection<PmoRiskRow>;
    recommendations: PmoCollection<PmoRecommendationRow>;
    outcomes: PmoCollection<PmoOutcomeRow>;
    observations: PmoCollection<PmoObservationRow>;
    signals: PmoCollection<PmoSignalRow>;
    evidence: PmoCollection<PmoEvidenceRow>;
  };
};

// ── Output contract ─────────────────────────────────────────────────────────────────────

/** Unit-interval confidence of ONE recorded claim, with the column it came from. */
export type PmoConfidence = { value: number; scale: "unit_interval"; source: string };

export type PmoFreshnessState = "current" | "stale" | "unknown";
export type PmoFreshness = { state: PmoFreshnessState; basis: string; recordedAt: string | null };

export type PmoEvidenceRef = {
  entity:
    | "evidence_item"
    | "operational_signal"
    | "risk_issue_record"
    | "recommended_action"
    | "canonical_task_outcome"
    | "canonical_outcome_observation";
  id: string;
};

export type PmoAttentionReason = {
  kind: PmoAttentionReasonKind;
  ruleId: PmoAttentionRuleId;
  level: PmoAttentionLevel;
  /** Deterministic template output over the structured facts below (PMO_ATTENTION_SUMMARY_SOURCE). */
  summary: string;
  /** Null when the underlying record carries no confidence. */
  confidence: PmoConfidence | null;
  freshness: PmoFreshness;
  /** True when any supporting record is a DEMO / FIXTURE record. */
  fixture: boolean;
  /** Inference (engine/rule output) versus an observed/recorded human fact. */
  assertion: "inference" | "observed";
  evidence: PmoEvidenceRef[];
  drillDown: "execution" | "project";
};

export type PmoDimensionKey = "schedule" | "findings" | "recommendations" | "outcomes";
export const PMO_DIMENSIONS: readonly PmoDimensionKey[] = ["schedule", "findings", "recommendations", "outcomes"];
export type PmoDimensionState = "assessed" | "no_basis" | "unavailable" | "truncated" | "not_evaluated";

export type PmoMissingInput = { code: string; message: string };

export type PmoProjectEvaluation =
  | "qualified"
  | "missing_inputs"
  | "unavailable"
  | "not_evaluated_lifecycle"
  | "not_evaluated_limit";

export type PmoProjectAssessment = {
  projectId: string;
  projectName: string;
  lifecycle: string;
  evaluation: PmoProjectEvaluation;
  /** Highest reason level; null means no supported attention signal (NOT "healthy"). */
  attentionLevel: PmoAttentionLevel | null;
  reasons: PmoAttentionReason[];
  /**
   * Schedule reasons from exposures recorded against a schedule that has since changed (e.g. it
   * was fixed and re-evaluated to no exposure, which P2-16 does not record). Provenance only:
   * never counted in `attentionLevel`, ordering, confidence or attention/quiet placement.
   */
  superseded: PmoAttentionReason[];
  dimensions: Record<PmoDimensionKey, PmoDimensionState>;
  missingInputs: PmoMissingInput[];
  /** Weakest recorded confidence among this project's reasons; null when none is recorded. */
  confidence: PmoConfidence | null;
  /** Worst freshness among this project's reasons and schedule basis. */
  freshness: PmoFreshnessState | "not_applicable";
  fixture: boolean;
  drillDown: { project: string; execution: string };
};

export type PmoPortfolioState = "empty" | "no_eligible_projects" | "current" | "partial" | "stale";
export type PmoPortfolioQualification = "partial_coverage" | "degraded_dimension" | "stale_inputs" | "fixture_data";

export type PmoCoverage = {
  /** Projects of this PMO visible to the viewer (workspace + exact pmo_id). */
  projectsInScope: number;
  /** Active projects — the ones attention is assessed for. */
  eligible: number;
  notEvaluatedLifecycle: number;
  notEvaluatedLimit: number;
  /** Eligible projects whose canonical reads were attempted. */
  evaluated: number;
  /** Evaluated projects with at least one dimension that has a canonical basis. */
  qualified: number;
  missingInputs: number;
  unavailable: number;
  /**
   * Projects in this PMO withheld from the viewer. Project visibility is workspace membership
   * (there is no project-level restriction), so every project of the PMO is visible to anyone
   * authorized to open it; the count is structurally zero and the basis says why.
   */
  withheld: { count: 0; basis: "workspace_membership" };
  /** True only when every eligible project is qualified and no dimension is degraded. */
  complete: boolean;
  dimensions: Record<PmoDimensionKey, Record<Exclude<PmoDimensionState, "not_evaluated">, number>>;
};

export type PmoPortfolioAttention = {
  contract: typeof PMO_ATTENTION_CONTRACT;
  method: {
    id: typeof PMO_ATTENTION_METHOD;
    rules: typeof PMO_ATTENTION_RULES;
    ordering: typeof PMO_ATTENTION_ORDERING;
    confidence: { id: typeof PMO_ATTENTION_CONFIDENCE_METHOD; description: string };
    freshness: string;
    summaries: typeof PMO_ATTENTION_SUMMARY_SOURCE;
    evaluationLimit: number;
    rowCap: number;
  };
  scope: { workspaceId: string; pmoId: string };
  evaluatedAt: string;
  membership: { canonicalization: typeof PMO_MEMBERSHIP_CANONICALIZATION; digest: string; projectCount: number };
  /** Digest of every material field below (everything except `evaluatedAt` and this digest). */
  assessmentDigest: string;
  state: PmoPortfolioState;
  qualifications: PmoPortfolioQualification[];
  coverage: PmoCoverage;
  /** Weakest recorded confidence among the attention claims; null when none is recorded. */
  confidence: (PmoConfidence & { projectId: string; ruleId: PmoAttentionRuleId }) | null;
  /** Projects with at least one reason, in published order. */
  attention: PmoProjectAssessment[];
  /** Qualified projects with no supported attention signal. */
  quiet: PmoProjectAssessment[];
  /** Projects PMFreak could not assess (missing inputs, unavailable, not evaluated). */
  notAssessed: PmoProjectAssessment[];
  crossProjectDependencies: typeof CROSS_PROJECT_DEPENDENCY_SUPPORT;
  resourceConflicts: typeof RESOURCE_CONFLICT_SUPPORT;
  /** Earliest recorded validity deadline after `evaluatedAt`: the next time this view can change with no new data. */
  nextFreshnessDeadline: string | null;
  fixture: boolean;
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function unitFromPercent(value: number | string | null | undefined, source: string): PmoConfidence | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return { value: Math.round((n / 100) * 10000) / 10000, scale: "unit_interval", source };
}

function unit(value: number | string | null | undefined, source: string): PmoConfidence | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return { value: Math.round(n * 10000) / 10000, scale: "unit_interval", source };
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

function rule(id: PmoAttentionRuleId) {
  const found = RULES_BY_ID.get(id);
  if (!found) throw new Error(`pmo_attention_unknown_rule:${id}`);
  return found;
}

/**
 * Canonical Evidence freshness, as the repository defines it: the persisted `freshness_state`
 * and `lifecycle`, plus a recorded `stale_at` compared against the EXPLICIT evaluation clock
 * (the same convention as `OperationalSummary.generatedAt`).
 */
function evidenceFreshness(evidence: PmoEvidenceRow | undefined, evaluatedAtMs: number): PmoFreshness {
  if (!evidence) return { state: "unknown", basis: "supporting Evidence not readable", recordedAt: null };
  if (evidence.freshness_state !== "CURRENT") return { state: "stale", basis: `Evidence freshness ${evidence.freshness_state}`, recordedAt: null };
  if (evidence.lifecycle !== "RECORDED") return { state: "stale", basis: `Evidence lifecycle ${evidence.lifecycle}`, recordedAt: null };
  const staleAt = isoOrNull(evidence.stale_at);
  if (staleAt && new Date(staleAt).getTime() <= evaluatedAtMs) return { state: "stale", basis: `Evidence validity ended ${staleAt}`, recordedAt: null };
  return { state: "current", basis: "Evidence CURRENT and RECORDED", recordedAt: null };
}

function worstFreshness(values: PmoFreshnessState[]): PmoFreshnessState | "not_applicable" {
  if (values.length === 0) return "not_applicable";
  if (values.includes("stale")) return "stale";
  if (values.includes("unknown")) return "unknown";
  return "current";
}

function weakest(confidences: Array<PmoConfidence | null>): PmoConfidence | null {
  let min: PmoConfidence | null = null;
  for (const c of confidences) {
    if (!c) continue;
    if (!min || c.value < min.value || (c.value === min.value && compareText(c.source, min.source) < 0)) min = c;
  }
  return min;
}

function reasonOrder(a: PmoAttentionReason, b: PmoAttentionReason): number {
  return (
    LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    compareText(a.kind, b.kind) ||
    compareText(a.evidence[0]?.id ?? "", b.evidence[0]?.id ?? "")
  );
}

const LEVEL_WORD: Record<PmoAttentionLevel, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

// ── Membership snapshot ─────────────────────────────────────────────────────────────────

/**
 * Deterministic identity of the membership this projection evaluated: the PMO, its workspace
 * and the exact set of project ids linked by `projects.pmo_id`. No timestamp enters it, so the
 * same membership always digests identically, and adding, removing or reassigning a project
 * changes it.
 */
export function computePmoMembershipSnapshot(workspaceId: string, pmoId: string, projectIds: readonly string[]) {
  const ids = [...new Set(projectIds)].sort(compareText);
  return {
    canonicalization: PMO_MEMBERSHIP_CANONICALIZATION,
    digest: sha256(JSON.stringify({ canonicalization: PMO_MEMBERSHIP_CANONICALIZATION, workspaceId, pmoId, projectIds: ids })),
    projectCount: ids.length,
  } as const;
}

/**
 * The projects a view evaluates: active projects, ordered by id, up to the evaluation limit.
 * Shared by the loader (which reads only these) and the builder (which assesses only these),
 * so the two can never disagree about which projects were evaluated.
 */
export function selectEvaluatedProjectIds(projects: readonly PmoAttentionProjectRow[]): string[] {
  return projects
    .filter((p) => p.status === "active")
    .map((p) => p.id)
    .sort(compareText)
    .slice(0, PMO_ATTENTION_EVALUATION_LIMIT);
}

// ── Per-project assessment ──────────────────────────────────────────────────────────────

/** P2-16 schedule Evidence and the Signal type its Finding is recorded with. */
const SCHEDULE_EVIDENCE_SOURCE_TYPE = "schedule_evaluation";
const SCHEDULE_SIGNAL_TYPE = "schedule_risk";

type ProjectBatch = {
  risks: PmoRiskRow[];
  recommendations: PmoRecommendationRow[];
  outcomes: PmoOutcomeRow[];
};

function scheduleReasons(
  schedule: NonNullable<PmoProjectSignalInput["schedule"]>,
): { reasons: PmoAttentionReason[]; superseded: PmoAttentionReason[]; freshness: PmoFreshnessState[]; missing: PmoMissingInput[]; findingIds: Set<string> } {
  // Every listed exposure's Finding — current or superseded — is schedule evidence. Only the
  // considered records below describe the schedule; older ones must not resurface elsewhere.
  const findingIds = new Set(schedule.exposures.flatMap((e) => (e.finding ? [e.finding.id] : [])));
  const reasons: PmoAttentionReason[] = [];
  const missing: PmoMissingInput[] = [];
  const freshness: PmoFreshnessState[] = [];
  // listScheduleExposures returns newest first. Exposures recorded against the CURRENT schedule
  // are the ones that describe it; older snapshots are superseded by later schedule edits.
  const current = schedule.exposures.filter((e) => e.snapshotDigest === schedule.currentSnapshotDigest);
  const considered = current.length > 0 ? current : schedule.exposures.slice(0, 1);
  const superseded = current.length === 0;
  if (superseded) {
    missing.push({
      code: "schedule_reevaluation_needed",
      message: "The schedule changed after its last recorded exposure evaluation; that exposure is superseded and does not count toward attention until the schedule is re-evaluated.",
    });
  }
  for (const record of considered) {
    const fresh: PmoFreshness = superseded
      ? { state: "stale", basis: "schedule changed since this evaluation (snapshot superseded)", recordedAt: isoOrNull(record.recordedAt) }
      : record.freshnessState !== "CURRENT"
        ? { state: "stale", basis: `Evidence freshness ${record.freshnessState}`, recordedAt: isoOrNull(record.recordedAt) }
        : { state: "current", basis: "evaluated against the current schedule snapshot", recordedAt: isoOrNull(record.recordedAt) };
    freshness.push(fresh.state);
    const fixture = record.fixtureState !== "LIVE";
    const evidence: PmoEvidenceRef[] = [{ entity: "evidence_item", id: record.evidenceId }];
    if (record.finding) evidence.push({ entity: "operational_signal", id: record.finding.id });
    if (record.recommendation) evidence.push({ entity: "recommended_action", id: record.recommendation.id });
    if (record.severity) {
      const ruleId = `schedule.severity.${record.severity}` as PmoAttentionRuleId;
      const worst = [...record.exposures].sort(
        (a, b) => Math.max(b.networkSlipDays ?? 0, b.forecastVarianceDays ?? 0) - Math.max(a.networkSlipDays ?? 0, a.forecastVarianceDays ?? 0) || compareText(a.milestoneId, b.milestoneId),
      )[0];
      const slip = worst ? Math.max(worst.networkSlipDays ?? 0, worst.forecastVarianceDays ?? 0) : 0;
      const summary = worst
        ? slip > 0
          ? `Schedule exposure · ${LEVEL_WORD[rule(ruleId).level]}: "${worst.title}" projected ${slip} day${slip === 1 ? "" : "s"} past target${worst.isCritical ? " (critical milestone)" : ""}.`
          : `Schedule exposure · ${LEVEL_WORD[rule(ruleId).level]}: "${worst.title}" is at risk without projected slip.`
        : `Schedule exposure · ${LEVEL_WORD[rule(ruleId).level]}.`;
      reasons.push({
        kind: "schedule_exposure",
        ruleId,
        level: rule(ruleId).level,
        summary: record.recommendation?.status === "proposed" ? `${summary} Recommendation awaiting decision.` : summary,
        confidence: unit(record.confidence, "evidence_items.confidence_score (schedule-coverage:v1)"),
        freshness: fresh,
        fixture,
        assertion: "inference",
        evidence,
        drillDown: "execution",
      });
    }
    if (record.materializationState !== "complete") {
      reasons.push({
        kind: "incomplete_evidence_chain",
        ruleId: "evidence.chain_incomplete",
        level: rule("evidence.chain_incomplete").level,
        summary: "Schedule evaluation recorded as Evidence, but its Finding or Recommendation has not been materialised.",
        confidence: null,
        freshness: fresh,
        fixture,
        assertion: "observed",
        evidence: [{ entity: "evidence_item", id: record.evidenceId }],
        drillDown: "execution",
      });
    }
  }
  // A superseded exposure does not describe the current schedule — which may no longer be exposed
  // at all — so it is reported as provenance and never ranked as current attention.
  return superseded ? { reasons: [], superseded: reasons, freshness, missing, findingIds } : { reasons, superseded: [], freshness, missing, findingIds };
}

function assessProject(
  project: PmoAttentionProjectRow,
  signal: PmoProjectSignalInput,
  rows: ProjectBatch,
  lookups: { signals: Map<string, PmoSignalRow>; evidence: Map<string, PmoEvidenceRow>; latestObservation: Map<string, PmoObservationRow> },
  batchState: { risks: PmoDimensionState | null; recommendations: PmoDimensionState | null; outcomes: PmoDimensionState | null },
  workspaceId: string,
  evaluatedAtMs: number,
): PmoProjectAssessment {
  const reasons: PmoAttentionReason[] = [];
  const superseded: PmoAttentionReason[] = [];
  const missingInputs: PmoMissingInput[] = [];
  const freshness: PmoFreshnessState[] = [];
  const dimensions: Record<PmoDimensionKey, PmoDimensionState> = {
    schedule: "no_basis",
    findings: "no_basis",
    recommendations: "no_basis",
    outcomes: "no_basis",
  };

  // Schedule — P2-16's verified projection, compared against the current schedule snapshot.
  let scheduleFindingIds = new Set<string>();
  if (signal.schedule === null) {
    dimensions.schedule = "unavailable";
  } else if (signal.schedule.exposures.length === 0) {
    missingInputs.push({ code: "schedule_not_evaluated", message: "No schedule exposure evaluation has been recorded for this project." });
  } else {
    dimensions.schedule = "assessed";
    const s = scheduleReasons(signal.schedule);
    reasons.push(...s.reasons);
    superseded.push(...s.superseded);
    freshness.push(...s.freshness);
    missingInputs.push(...s.missing);
    scheduleFindingIds = s.findingIds;
  }

  // Findings / Recommendations need canonical Evidence as their basis: with none recorded, "no
  // open Findings" would be a claim about data PMFreak never saw.
  const evidenceBasis = signal.evidenceBasis;
  const governanceBasis: PmoDimensionState = evidenceBasis === null ? "unavailable" : evidenceBasis.canonical > 0 ? "assessed" : "no_basis";
  if (evidenceBasis !== null && evidenceBasis.canonical === 0) {
    missingInputs.push({ code: "no_canonical_evidence", message: "No canonical Evidence has been recorded for this project, so Findings and Recommendations cannot be assessed." });
  }
  // The project's own basis decides first; only an assessable project inherits a batch state.
  dimensions.findings = governanceBasis === "assessed" ? batchState.risks ?? "assessed" : governanceBasis;
  dimensions.recommendations = governanceBasis === "assessed" ? batchState.recommendations ?? "assessed" : governanceBasis;

  // One canonical fact, one reason: a P2-16 schedule-derived Finding/Recommendation is evidence
  // behind the Schedule dimension, which alone represents the CURRENT schedule. It never
  // re-enters as a generic reason — P2-16 Evidence carries no stale_at and nothing supersedes it
  // in persistence, so generic freshness would report an old or since-cleared exposure as current.
  // Schedule risks detected from other Evidence (e.g. a note saying "delayed") are not P2-16
  // evidence and stay generic.
  const isScheduleDerived = (signalId: string) => {
    if (scheduleFindingIds.has(signalId)) return true;
    const sig = lookups.signals.get(signalId);
    return sig?.signal_type === SCHEDULE_SIGNAL_TYPE && lookups.evidence.get(sig.evidence_item_id)?.source_type === SCHEDULE_EVIDENCE_SOURCE_TYPE;
  };

  if (dimensions.findings === "assessed" || dimensions.findings === "truncated") {
    for (const risk of rows.risks) {
      if (isScheduleDerived(risk.signal_id)) continue;
      const ruleId = risk.severity === "critical" ? "finding.unresolved.critical" : risk.severity === "high" ? "finding.unresolved.high" : null;
      if (!ruleId) continue;
      const sig = lookups.signals.get(risk.signal_id);
      const ev = sig ? lookups.evidence.get(sig.evidence_item_id) : undefined;
      const fresh = evidenceFreshness(ev, evaluatedAtMs);
      freshness.push(fresh.state);
      const evidence: PmoEvidenceRef[] = [{ entity: "risk_issue_record", id: risk.id }, { entity: "operational_signal", id: risk.signal_id }];
      if (sig) evidence.push({ entity: "evidence_item", id: sig.evidence_item_id });
      reasons.push({
        kind: "open_finding",
        ruleId,
        level: rule(ruleId).level,
        summary: `Unresolved ${risk.type.replace(/_/g, " ")} · ${LEVEL_WORD[rule(ruleId).level]}: ${risk.title} (${risk.status}).`,
        confidence: sig ? unitFromPercent(sig.confidence_score, "operational_signals.confidence_score ÷ 100") : null,
        freshness: { ...fresh, recordedAt: isoOrNull(risk.updated_at) },
        fixture: ev?.fixture_state === "DEMO_FIXTURE",
        assertion: "inference",
        evidence,
        drillDown: "execution",
      });
    }
  }

  if (dimensions.recommendations === "assessed" || dimensions.recommendations === "truncated") {
    for (const rec of rows.recommendations) {
      if (rec.source_signal_id && isScheduleDerived(rec.source_signal_id)) continue;
      const ruleId: PmoAttentionRuleId =
        rec.urgency === "immediate" ? "recommendation.pending.immediate" : rec.urgency === "high" ? "recommendation.pending.high" : "recommendation.pending.other";
      const sig = rec.source_signal_id ? lookups.signals.get(rec.source_signal_id) : undefined;
      const ev = sig ? lookups.evidence.get(sig.evidence_item_id) : undefined;
      const fresh = evidenceFreshness(ev, evaluatedAtMs);
      freshness.push(fresh.state);
      const evidence: PmoEvidenceRef[] = [{ entity: "recommended_action", id: rec.id }];
      if (sig) evidence.push({ entity: "operational_signal", id: sig.id }, { entity: "evidence_item", id: sig.evidence_item_id });
      reasons.push({
        kind: "pending_recommendation",
        ruleId,
        level: rule(ruleId).level,
        summary: `Recommendation awaiting decision${rec.urgency ? ` · urgency ${rec.urgency}` : ""}: ${rec.title}.`,
        confidence:
          unitFromPercent(rec.confidence_score, "recommended_actions.confidence_score ÷ 100") ??
          (sig ? unitFromPercent(sig.confidence_score, "operational_signals.confidence_score ÷ 100") : null),
        freshness: { ...fresh, recordedAt: isoOrNull(rec.created_at) },
        fixture: ev?.fixture_state === "DEMO_FIXTURE",
        assertion: "inference",
        evidence,
        drillDown: "execution",
      });
    }
  }

  // Outcomes — observed divergence only. Completed work without an observation is "unknown",
  // never "failed", so it is not an attention reason.
  if (signal.outcomeCount === null) dimensions.outcomes = "unavailable";
  else if (signal.outcomeCount === 0) {
    dimensions.outcomes = "no_basis";
    missingInputs.push({ code: "no_canonical_outcomes", message: "No canonical Outcome has been recorded for this project, so execution/outcome divergence cannot be assessed." });
  } else dimensions.outcomes = batchState.outcomes ?? "assessed";

  if (dimensions.outcomes === "assessed" || dimensions.outcomes === "truncated") {
    for (const outcome of rows.outcomes) {
      const ruleId: PmoAttentionRuleId | null =
        outcome.state === "not_achieved" ? "outcome.not_achieved" : outcome.state === "partially_achieved" ? "outcome.partially_achieved" : outcome.state === "disputed" ? "outcome.disputed" : null;
      if (!ruleId) continue;
      const obs = lookups.latestObservation.get(outcome.id);
      const staleAt = isoOrNull(obs?.stale_at);
      const fresh: PmoFreshness = !obs
        ? { state: "unknown", basis: "no Observation recorded for this Outcome", recordedAt: isoOrNull(outcome.updated_at) }
        : staleAt && new Date(staleAt).getTime() <= evaluatedAtMs
          ? { state: "stale", basis: `Observation validity ended ${staleAt}`, recordedAt: isoOrNull(obs.recorded_at) }
          : { state: "current", basis: "latest Observation within its validity", recordedAt: isoOrNull(obs.recorded_at) };
      freshness.push(fresh.state);
      const evidence: PmoEvidenceRef[] = [{ entity: "canonical_task_outcome", id: outcome.id }];
      if (obs) evidence.push({ entity: "canonical_outcome_observation", id: obs.id });
      reasons.push({
        kind: "outcome_divergence",
        ruleId,
        level: rule(ruleId).level,
        summary: `Outcome ${outcome.state.replace(/_/g, " ")}: ${outcome.expected_result}`,
        confidence: obs ? unit(obs.confidence_score, "canonical_outcome_observations.confidence_score") : null,
        freshness: fresh,
        fixture: outcome.fixture_label !== null || (obs?.fixture_label ?? null) !== null,
        assertion: "observed",
        evidence,
        drillDown: "execution",
      });
    }
  }

  reasons.sort(reasonOrder);
  superseded.sort(reasonOrder);
  const assessedAny = PMO_DIMENSIONS.some((d) => dimensions[d] === "assessed" || dimensions[d] === "truncated");
  const unavailableAny = PMO_DIMENSIONS.some((d) => dimensions[d] === "unavailable");
  const evaluation: PmoProjectEvaluation = assessedAny ? "qualified" : unavailableAny ? "unavailable" : "missing_inputs";
  const attentionLevel = reasons.length === 0 ? null : reasons[0].level;

  return {
    projectId: project.id,
    projectName: project.name,
    lifecycle: String(project.status),
    evaluation,
    attentionLevel,
    reasons,
    superseded,
    dimensions,
    missingInputs,
    confidence: weakest(reasons.map((r) => r.confidence)),
    freshness: worstFreshness(freshness),
    fixture: reasons.some((r) => r.fixture) || (evidenceBasis !== null && evidenceBasis.canonical > 0 && evidenceBasis.live === 0),
    drillDown: {
      project: projectCommandCenterPath(workspaceId, project.id),
      execution: workspaceCommandCenterPath(workspaceId, { projectId: project.id }),
    },
  };
}

function notEvaluated(project: PmoAttentionProjectRow, evaluation: "not_evaluated_lifecycle" | "not_evaluated_limit", workspaceId: string): PmoProjectAssessment {
  return {
    projectId: project.id,
    projectName: project.name,
    lifecycle: String(project.status),
    evaluation,
    attentionLevel: null,
    reasons: [],
    superseded: [],
    dimensions: { schedule: "not_evaluated", findings: "not_evaluated", recommendations: "not_evaluated", outcomes: "not_evaluated" },
    missingInputs:
      evaluation === "not_evaluated_lifecycle"
        ? [{ code: "project_not_active", message: `Project is ${project.status}; attention is assessed for active projects only.` }]
        : [{ code: "evaluation_limit", message: `Only the first ${PMO_ATTENTION_EVALUATION_LIMIT} active projects are evaluated per view.` }],
    confidence: null,
    freshness: "not_applicable",
    fixture: false,
    drillDown: {
      project: projectCommandCenterPath(workspaceId, project.id),
      execution: workspaceCommandCenterPath(workspaceId, { projectId: project.id }),
    },
  };
}

function projectOrder(a: PmoProjectAssessment, b: PmoProjectAssessment): number {
  const levelA = a.attentionLevel ? LEVEL_RANK[a.attentionLevel] : 0;
  const levelB = b.attentionLevel ? LEVEL_RANK[b.attentionLevel] : 0;
  const atLevel = (p: PmoProjectAssessment) => p.reasons.filter((r) => r.level === p.attentionLevel).length;
  const currentCount = (p: PmoProjectAssessment) => p.reasons.filter((r) => r.freshness.state === "current").length;
  return (
    levelB - levelA ||
    atLevel(b) - atLevel(a) ||
    currentCount(b) - currentCount(a) ||
    compareText(a.projectName.toLowerCase(), b.projectName.toLowerCase()) ||
    compareText(a.projectId, b.projectId)
  );
}

function batchDimension<T>(collection: PmoCollection<T>): PmoDimensionState | null {
  if (!collection.ok) return "unavailable";
  return collection.truncated ? "truncated" : null;
}

// ── Portfolio projection ────────────────────────────────────────────────────────────────

export function buildPmoPortfolioAttention(input: PmoAttentionInput): PmoPortfolioAttention {
  const evaluatedAt = new Date(input.evaluatedAt).toISOString();
  const evaluatedAtMs = new Date(evaluatedAt).getTime();
  const { workspaceId, pmoId } = input;
  const projects = [...input.projects].sort((a, b) => compareText(a.id, b.id));
  const membership = computePmoMembershipSnapshot(workspaceId, pmoId, projects.map((p) => p.id));

  const eligible = projects.filter((p) => p.status === "active");
  const evaluatedIds = new Set(selectEvaluatedProjectIds(projects));

  const rowsOf = <T>(c: PmoCollection<T>): T[] => (c.ok ? c.rows : []);
  const signals = new Map(rowsOf(input.batch.signals).map((s) => [s.id, s]));
  const evidence = new Map(rowsOf(input.batch.evidence).map((e) => [e.id, e]));
  const latestObservation = new Map<string, PmoObservationRow>();
  for (const obs of rowsOf(input.batch.observations)) {
    const prior = latestObservation.get(obs.outcome_id);
    if (!prior || compareText(prior.recorded_at, obs.recorded_at) < 0 || (prior.recorded_at === obs.recorded_at && compareText(prior.id, obs.id) < 0)) {
      latestObservation.set(obs.outcome_id, obs);
    }
  }
  const byProject = <T extends { project_id: string }>(rows: T[], projectId: string) => rows.filter((r) => r.project_id === projectId);
  // A failed Signal/Evidence lookup degrades freshness to "unknown" per reason; it does not
  // fabricate freshness, so the dimensions themselves stay assessable.
  const batchState = {
    risks: batchDimension(input.batch.risks),
    recommendations: batchDimension(input.batch.recommendations),
    outcomes: batchDimension(input.batch.outcomes) ?? (input.batch.observations.ok ? null : "unavailable"),
  };

  const assessments: PmoProjectAssessment[] = projects.map((project) => {
    if (project.status !== "active") return notEvaluated(project, "not_evaluated_lifecycle", workspaceId);
    if (!evaluatedIds.has(project.id)) return notEvaluated(project, "not_evaluated_limit", workspaceId);
    const signal = input.perProject[project.id] ?? { evidenceBasis: null, outcomeCount: null, schedule: null };
    return assessProject(
      project,
      signal,
      {
        risks: byProject(rowsOf(input.batch.risks), project.id),
        recommendations: byProject(rowsOf(input.batch.recommendations), project.id),
        outcomes: byProject(rowsOf(input.batch.outcomes), project.id),
      },
      { signals, evidence, latestObservation },
      batchState,
      workspaceId,
      evaluatedAtMs,
    );
  });

  const evaluatedAssessments = assessments.filter((a) => a.evaluation === "qualified" || a.evaluation === "missing_inputs" || a.evaluation === "unavailable");
  const count = (e: PmoProjectEvaluation) => assessments.filter((a) => a.evaluation === e).length;
  const dimensionCoverage = Object.fromEntries(
    PMO_DIMENSIONS.map((d) => [
      d,
      {
        assessed: evaluatedAssessments.filter((a) => a.dimensions[d] === "assessed").length,
        no_basis: evaluatedAssessments.filter((a) => a.dimensions[d] === "no_basis").length,
        unavailable: evaluatedAssessments.filter((a) => a.dimensions[d] === "unavailable").length,
        truncated: evaluatedAssessments.filter((a) => a.dimensions[d] === "truncated").length,
      },
    ]),
  ) as PmoCoverage["dimensions"];
  const degraded = PMO_DIMENSIONS.some((d) => dimensionCoverage[d].unavailable > 0 || dimensionCoverage[d].truncated > 0);
  const coverage: PmoCoverage = {
    projectsInScope: projects.length,
    eligible: eligible.length,
    notEvaluatedLifecycle: count("not_evaluated_lifecycle"),
    notEvaluatedLimit: count("not_evaluated_limit"),
    evaluated: evaluatedAssessments.length,
    qualified: count("qualified"),
    missingInputs: count("missing_inputs"),
    unavailable: count("unavailable"),
    withheld: { count: 0, basis: "workspace_membership" },
    complete: eligible.length > 0 && count("qualified") === eligible.length && !degraded,
    dimensions: dimensionCoverage,
  };

  const attention = assessments.filter((a) => a.reasons.length > 0).sort(projectOrder);
  const quiet = assessments.filter((a) => a.evaluation === "qualified" && a.reasons.length === 0).sort(projectOrder);
  const notAssessed = assessments
    .filter((a) => a.evaluation !== "qualified" && a.reasons.length === 0)
    .sort((a, b) => compareText(a.evaluation, b.evaluation) || projectOrder(a, b));

  const qualifications: PmoPortfolioQualification[] = [];
  if (coverage.eligible > 0 && coverage.qualified < coverage.eligible) qualifications.push("partial_coverage");
  if (degraded) qualifications.push("degraded_dimension");
  const staleInputs = assessments.some((a) => a.freshness === "stale" || a.freshness === "unknown" || a.missingInputs.some((m) => m.code === "schedule_reevaluation_needed"));
  if (staleInputs) qualifications.push("stale_inputs");
  const fixture = assessments.some((a) => a.fixture);
  if (fixture) qualifications.push("fixture_data");

  const state: PmoPortfolioState =
    projects.length === 0
      ? "empty"
      : eligible.length === 0
        ? "no_eligible_projects"
        : qualifications.includes("partial_coverage") || qualifications.includes("degraded_dimension")
          ? "partial"
          : staleInputs
            ? "stale"
            : "current";

  let confidence: PmoPortfolioAttention["confidence"] = null;
  for (const a of attention) {
    for (const r of a.reasons) {
      if (!r.confidence) continue;
      if (!confidence || r.confidence.value < confidence.value) confidence = { ...r.confidence, projectId: a.projectId, ruleId: r.ruleId };
    }
  }

  // The next recorded validity deadline after the evaluation clock — the only way this view can
  // change without new canonical data. Stated so a PMO can see when "current" would lapse.
  const deadlines: string[] = [];
  for (const e of rowsOf(input.batch.evidence)) {
    const s = isoOrNull(e.stale_at);
    if (s && new Date(s).getTime() > evaluatedAtMs) deadlines.push(s);
  }
  for (const o of latestObservation.values()) {
    const s = isoOrNull(o.stale_at);
    if (s && new Date(s).getTime() > evaluatedAtMs) deadlines.push(s);
  }
  deadlines.sort(compareText);

  const material = {
    contract: PMO_ATTENTION_CONTRACT,
    method: {
      id: PMO_ATTENTION_METHOD,
      rules: PMO_ATTENTION_RULES,
      ordering: PMO_ATTENTION_ORDERING,
      confidence: {
        id: PMO_ATTENTION_CONFIDENCE_METHOD,
        description:
          "Weakest recorded confidence: each reason carries its source record's own confidence re-expressed on the 0–1 scale (0–100 columns divided by 100). A project's and the portfolio's confidence is the lowest of them, so it states how certain the least certain claim on screen is. It says nothing about coverage.",
      },
      freshness:
        "Evidence freshness_state/lifecycle as persisted, recorded stale_at compared with evaluatedAt, and P2-16 schedule exposures compared with the digest of the current schedule (a changed schedule supersedes the exposure; a superseded exposure is reported under `superseded` and never ranked).",
      summaries: PMO_ATTENTION_SUMMARY_SOURCE,
      evaluationLimit: PMO_ATTENTION_EVALUATION_LIMIT,
      rowCap: PMO_ATTENTION_ROW_CAP,
    },
    scope: { workspaceId, pmoId },
    membership,
    state,
    qualifications,
    coverage,
    confidence,
    attention,
    quiet,
    notAssessed,
    crossProjectDependencies: CROSS_PROJECT_DEPENDENCY_SUPPORT,
    resourceConflicts: RESOURCE_CONFLICT_SUPPORT,
    nextFreshnessDeadline: deadlines[0] ?? null,
    fixture,
  } as const;
  const assessmentDigest = sha256(JSON.stringify({ canonicalization: PMO_ASSESSMENT_CANONICALIZATION, material }));
  return { ...material, evaluatedAt, assessmentDigest } as PmoPortfolioAttention;
}
