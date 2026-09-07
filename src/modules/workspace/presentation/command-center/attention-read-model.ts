/**
 * P2-11 — PM Execution Center canonical attention read model.
 *
 * This module is an EXPERIENCE / READ MODEL over the canonical P2 operational flow.
 * It owns no records. It creates no second Recommendation, Decision, Evidence or
 * Action aggregate. It only joins what `GET /api/operational-flow` already returns
 * and projects it into the shape the Command Center renders.
 *
 * Deliberately framework-free (no React, no SWR, no runtime import of the `@/` alias)
 * so the attention/authority rules can be exercised as real behaviour in tests rather
 * than asserted by scanning source text.
 *
 * Canonical chain preserved end to end:
 *   Evidence -> Finding/Signal -> Risk/Issue -> Governance -> Recommendation -> Decision
 */

import type { OperationalSummary } from "@/lib/operational-flow/types";
import type { StatusTone } from "./types";

type AnyRecord = Record<string, unknown>;

/** The canonical decision statuses accepted by `record_operational_decision`. Read from the
 *  verified contract (`src/lib/operational-flow/types.ts` + the route's DECISION_STATUSES) —
 *  never widened here, and no UI-only status such as "deferred" is invented. */
export type CanonicalDecisionStatus = "accepted" | "rejected" | "modified" | "escalated" | "needs_more_evidence";

/** Statuses that close the Recommendation. The database enforces this exact set with a partial
 *  unique index (`operational_decision_terminal_recommendation_uidx`) — one terminal Decision
 *  per Recommendation, ever. */
export const TERMINAL_DECISION_STATUSES: readonly CanonicalDecisionStatus[] = ["accepted", "rejected", "modified"];

/** Statuses that record a real Decision but deliberately leave the Recommendation `proposed`.
 *  `record_operational_decision` maps both back to `proposed`, so the item legitimately stays
 *  in the attention queue afterwards — recording an escalation is not resolving the item. */
export const NON_TERMINAL_DECISION_STATUSES: readonly CanonicalDecisionStatus[] = ["escalated", "needs_more_evidence"];

export function isTerminalDecisionStatus(status: unknown): boolean {
  return TERMINAL_DECISION_STATUSES.includes(String(status) as CanonicalDecisionStatus);
}

/**
 * UI label -> canonical Decision status. Every entry maps 1:1 onto a real status the
 * contract supports; nothing is renamed into a friendlier concept that would misdescribe
 * what gets persisted.
 *
 * Note on "Defer": the Command Center previously showed a "Defer" button for governed
 * recommendations and silently posted `escalated`. Deferring and escalating are different
 * business acts, and the canonical contract has no `deferred` status, so that label is gone
 * from the governed path. "Defer" survives only on the RAID-derived bounded path, where
 * `/api/recommended-actions/decision` genuinely persists a `deferred` decision with a
 * `deferredUntil` horizon.
 */
export const DECISION_OPTIONS: ReadonlyArray<{
  status: CanonicalDecisionStatus;
  label: string;
  terminal: boolean;
  /** Plain-language statement of what recording this status actually does to the Recommendation. */
  effect: string;
}> = [
  {
    status: "accepted",
    label: "Accept",
    terminal: true,
    effect: "Records an accepted Decision and closes the Recommendation. It does not create an Action, Task or Outcome.",
  },
  {
    status: "rejected",
    label: "Reject",
    terminal: true,
    effect: "Records a rejected Decision and closes the Recommendation.",
  },
  {
    status: "modified",
    label: "Record modification",
    terminal: true,
    effect: "Records a modified Decision — your rationale is the modification — and closes the Recommendation.",
  },
  {
    status: "needs_more_evidence",
    label: "Record: needs more evidence",
    terminal: false,
    effect: "Records the Decision and leaves the Recommendation open, so it stays in your queue.",
  },
  {
    status: "escalated",
    label: "Record escalation",
    terminal: false,
    effect: "Records an escalation Decision and leaves the Recommendation open, so it stays in your queue.",
  },
];

/** Per-status authority as evaluated server-side and projected onto the Recommendation as
 *  `actor_authority`. The UI never re-derives this from role names. */
export type AttentionDecisionOption = {
  status: CanonicalDecisionStatus;
  label: string;
  terminal: boolean;
  effect: string;
  allowed: boolean;
  /** Canonical machine reason from `evaluateOperationalDecisionAuthority`, e.g. `authority_requirement_not_satisfied`. */
  reason: string;
  /** Human-readable version of `reason`, for the denial text shown next to a withheld control. */
  deniedExplanation: string | null;
  authorityRequired: string;
  authorityBasis: string | null;
};

export type AttentionProvenance = {
  sourceType: string | null;
  sourceReference: string | null;
  evidenceTitle: string | null;
  evidenceId: string | null;
  /** Truncated digest for technical disclosure only — never a raw payload. */
  evidenceHashShort: string | null;
  assertionType: string | null;
  classification: string | null;
  rawInputId: string | null;
  normalizedEventId: string | null;
  occurredAt: string | null;
  recordedAt: string | null;
  evaluatedAt: string | null;
};

export type AttentionEvidenceQuality = {
  /** Evidence-level confidence recorded at derivation (0-1), distinct from the signal's rule score. */
  evidenceConfidence: number | null;
  /** Deterministic rule-match score for the detected signal — NOT a model/AI confidence. */
  ruleMatchScore: number | null;
  missingDataState: string | null;
  freshnessState: string | null;
  lifecycle: string | null;
  degradedReason: string | null;
  staleAt: string | null;
  /** `LIVE` or `DEMO_FIXTURE` straight from the persisted row — never inferred. */
  fixtureState: string | null;
  isFixture: boolean;
  /** True when the canonical lineage the write requires is incomplete — mirrors
   *  `governedLineageComplete` on the item, and is never a windowed read. */
  evidenceMissing: boolean;
};

export type AttentionGovernance = {
  governanceEventId: string | null;
  ruleKey: string | null;
  authorityRequired: string;
  governanceStatus: string | null;
  explanation: string | null;
};

export type AttentionDecisionRecord = {
  decisionId: string;
  decisionStatus: string;
  terminal: boolean;
  decision: string | null;
  rationale: string | null;
  decidedBy: string | null;
  recordedAt: string | null;
  authorityBasis: string | null;
  /** Evidence snapshot frozen at decision time, via `decision_evidence_links`. */
  evidenceSnapshotHashShort: string | null;
  evidenceSnapshotTitle: string | null;
  evidenceSnapshotVersion: string | null;
};

export type CanonicalAttentionItem = {
  /** Distinguishes the governed canonical path from the RAID-derived bounded path. */
  kind: "governed_recommendation";
  /** Stable identity derived from the canonical Recommendation — never random, never client-minted. */
  id: string;
  recommendationId: string;
  governanceEventId: string | null;
  signalId: string | null;
  riskIssueId: string | null;
  evidenceIds: string[];
  title: string;
  recommendationStatus: string;
  why: string;
  severity: string | null;
  tone: StatusTone;
  signalType: string | null;
  /** The detected signal's own persisted `summary` — a plain sentence written by the
   *  deterministic detector, which reads to a PM far better than the recommendation text
   *  alone. Null when the Recommendation has no linked signal. */
  signalSummary: string | null;
  riskIssueType: string | null;
  riskIssueStatus: string | null;
  provenance: AttentionProvenance;
  evidenceQuality: AttentionEvidenceQuality;
  governance: AttentionGovernance;
  decisionOptions: AttentionDecisionOption[];
  /** True when at least one status is permitted — used only for read-only messaging, never to
   *  enable a control whose own status is denied. */
  anyDecisionAllowed: boolean;
  /** Decisions already recorded against this Recommendation, newest first. */
  decisions: AttentionDecisionRecord[];
  terminalDecision: AttentionDecisionRecord | null;
  /**
   * Whether every canonical node `record_operational_decision` requires actually exists
   * for this Recommendation — Governance Event, Risk/Issue, Signal and Evidence.
   *
   * Resolved server-side by exact persisted reference (`governedAttentionContexts`), so it
   * is a statement about the database rather than about which rows a presentation window
   * happened to include. When the write would be refused for lineage reasons, this is
   * false and no decision may be offered however much authority the actor holds.
   */
  governedLineageComplete: boolean;
  /** `awaiting_decision` while the Recommendation is open; `decided` once terminally decided. */
  state: "awaiting_decision" | "decided";
};

const REASON_TEXT: Record<string, string> = {
  read_only_or_non_human_role: "Your role is read-only for governed decisions.",
  authority_requirement_not_satisfied: "Your role does not hold the authority this governance rule requires.",
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

function shortDigest(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const bare = text.startsWith("sha256:") ? text.slice(7) : text;
  return `${bare.slice(0, 16)}…`;
}

function severityTone(severity: unknown): StatusTone {
  return severity === "critical" || severity === "high" ? "danger" : "approval";
}

/** Reads the server-evaluated `actor_authority` map for one status. Absent entries fail closed. */
function readAuthority(recommendation: AnyRecord, status: CanonicalDecisionStatus) {
  const map = (recommendation.actor_authority ?? {}) as Record<string, AnyRecord | undefined>;
  const evaluation = map[status];
  return {
    allowed: evaluation?.allowed === true,
    reason: str(evaluation?.reason) ?? "authority_unavailable",
    authorityRequired: str(evaluation?.authorityRequired) ?? "an authorized reviewer",
    authorityBasis: str(evaluation?.authorityBasis),
  };
}

function buildDecisionOptions(recommendation: AnyRecord, fallbackAuthority: string): AttentionDecisionOption[] {
  return DECISION_OPTIONS.map((option) => {
    const evaluation = readAuthority(recommendation, option.status);
    return {
      status: option.status,
      label: option.label,
      terminal: option.terminal,
      effect: option.effect,
      allowed: evaluation.allowed,
      reason: evaluation.reason,
      deniedExplanation: evaluation.allowed ? null : (REASON_TEXT[evaluation.reason] ?? "This decision is not available to your role."),
      authorityRequired: evaluation.authorityRequired === "an authorized reviewer" ? fallbackAuthority : evaluation.authorityRequired,
      authorityBasis: evaluation.authorityBasis,
    };
  });
}

function buildDecisionRecord(decision: AnyRecord, links: AnyRecord[]): AttentionDecisionRecord {
  const link = links.find((item) => String(item.decision_record_id) === String(decision.id));
  return {
    decisionId: String(decision.id),
    decisionStatus: String(decision.decision_status),
    terminal: isTerminalDecisionStatus(decision.decision_status),
    decision: str(decision.decision),
    rationale: str(decision.rationale),
    decidedBy: str(decision.decided_by),
    recordedAt: str(decision.created_at),
    authorityBasis: str(decision.authority_basis),
    evidenceSnapshotHashShort: shortDigest(link?.evidence_hash_at_decision),
    evidenceSnapshotTitle: str(link?.evidence_title_snapshot),
    evidenceSnapshotVersion: str(link?.evidence_version_at_decision),
  };
}

/**
 * Joins the canonical chain and projects one attention item per governed Recommendation.
 *
 * Governed Recommendations are exactly the rows the operational-flow service returns in
 * `recommendations` — the service already filters `governance_event_id is not null`, so
 * RAID-derived suggestions can never enter this list.
 */
export function buildCanonicalAttention(summary: OperationalSummary | undefined): CanonicalAttentionItem[] {
  if (!summary) return [];
  const evidenceById = new Map((summary.evidence ?? []).map((row) => [String(row.id), row]));
  const signalById = new Map((summary.signals ?? []).map((row) => [String(row.id), row]));
  const riskById = new Map((summary.risksIssues ?? []).map((row) => [String(row.id), row]));
  const governanceById = new Map((summary.governanceEvents ?? []).map((row) => [String(row.id), row]));
  const evidenceLinks = summary.evidenceLinks ?? [];

  // Risk/Issue -> Signal is the only reliable direction back down the chain: governance events
  // reference the risk, and the risk references the signal that produced it.
  const riskBySignalId = new Map<string, AnyRecord>();
  for (const risk of summary.risksIssues ?? []) {
    const signalId = str(risk.signal_id);
    if (signalId) riskBySignalId.set(signalId, risk);
  }

  /**
   * The server's exact-reference resolution of each Recommendation's upstream lineage.
   *
   * This is the authority for "does this node exist". The windowed collections below are a
   * FALLBACK only, for payloads that predate the projection (older clients, fixtures): a
   * row's absence from a truncated window has never been evidence that it is absent from
   * the project, and must never again be read as such.
   */
  const attentionContextById = new Map(
    (summary.governedAttentionContexts ?? []).map((context) => [context.recommendationId, context]),
  );
  const items: CanonicalAttentionItem[] = [];

  for (const recommendation of summary.recommendations ?? []) {
    const recommendationId = String(recommendation.id);
    const context = attentionContextById.get(recommendationId);

    // Exact linked rows where the server resolved them; the windows only fill in for a
    // payload that carries no projection at all.
    const governance =
      (context?.governanceEvent as AnyRecord | null | undefined) ??
      (context
        ? undefined
        : str(recommendation.governance_event_id)
          ? governanceById.get(String(recommendation.governance_event_id))
          : undefined);

    // Prefer the recommendation's own risk link; fall back to the governance event's related entity.
    const riskId = str(recommendation.risk_issue_id) ?? str(governance?.related_entity_id);
    const risk =
      (context?.riskIssue as AnyRecord | null | undefined) ??
      (context ? undefined : riskId ? riskById.get(riskId) : undefined);
    const signalId = str(risk?.signal_id);
    const signal =
      (context?.signal as AnyRecord | null | undefined) ??
      (context ? undefined : signalId ? signalById.get(signalId) : undefined);
    const evidenceId = str(signal?.evidence_item_id);
    const evidence =
      (context?.evidence as AnyRecord | null | undefined) ??
      (context ? undefined : evidenceId ? evidenceById.get(evidenceId) : undefined);

    /**
     * Does the canonical lineage `record_operational_decision` requires actually exist?
     *
     * From the server's exact-id resolution when it is available. Without it, the honest
     * answer is that this payload cannot tell — and the surface must not claim the write
     * would be refused on the strength of a windowed read, so it assumes complete.
     */
    const lineageComplete = context ? context.lineageComplete : true;

    const decisions = (summary.decisions ?? [])
      .filter((row) => str(row.recommendation_id) === recommendationId)
      .map((row) => buildDecisionRecord(row, evidenceLinks))
      .sort((a, b) => String(b.recordedAt ?? "").localeCompare(String(a.recordedAt ?? "")));
    const terminalDecision = decisions.find((row) => row.terminal) ?? null;

    const authorityRequired =
      (context?.authorityRequired ?? null) ?? str(governance?.authority_required) ?? "an authorized reviewer";
    const decisionOptions = buildDecisionOptions(recommendation, authorityRequired);
    const confidence = num(evidence?.confidence_score);

    items.push({
      kind: "governed_recommendation",
      id: `governed-rec-${recommendationId}`,
      recommendationId,
      governanceEventId: str(recommendation.governance_event_id),
      signalId: signalId ?? null,
      riskIssueId: riskId ?? null,
      evidenceIds: evidenceId ? [evidenceId] : [],
      governedLineageComplete: lineageComplete,
      title: str(recommendation.recommendation) ?? "Review recommendation",
      recommendationStatus: String(recommendation.status ?? "proposed"),
      why: str(risk?.rationale) ?? str(signal?.rationale) ?? str(governance?.explanation) ?? "This needs a human decision before it proceeds.",
      severity: str(signal?.severity),
      tone: severityTone(signal?.severity),
      signalType: str(signal?.signal_type),
      signalSummary: str(signal?.summary),
      riskIssueType: str(risk?.type),
      riskIssueStatus: str(risk?.status),
      provenance: {
        sourceType: str(evidence?.source_type),
        sourceReference: str(evidence?.source_reference),
        evidenceTitle: str(evidence?.title),
        evidenceId: evidenceId ?? null,
        evidenceHashShort: shortDigest(evidence?.evidence_hash),
        assertionType: str(evidence?.assertion_type),
        classification: str(evidence?.classification),
        rawInputId: str(evidence?.raw_input_id),
        normalizedEventId: str(evidence?.normalized_event_id),
        occurredAt: str(evidence?.occurred_at),
        recordedAt: str(evidence?.recorded_at),
        evaluatedAt: str(evidence?.evaluated_at),
      },
      evidenceQuality: {
        evidenceConfidence: confidence,
        ruleMatchScore: num(signal?.confidence_score),
        missingDataState: str(evidence?.missing_data_state),
        freshnessState: str(evidence?.freshness_state),
        lifecycle: str(evidence?.lifecycle),
        degradedReason: str(evidence?.degraded_reason),
        staleAt: str(evidence?.stale_at),
        fixtureState: str(evidence?.fixture_state),
        isFixture: str(evidence?.fixture_state) === "DEMO_FIXTURE",
        // Canonical absence, from the server's exact-reference resolution — never
        // "this row was not in the newest-20 evidence window".
        evidenceMissing: !lineageComplete,
      },
      governance: {
        governanceEventId: str(recommendation.governance_event_id),
        ruleKey: str(governance?.rule_key),
        authorityRequired,
        governanceStatus: str(governance?.governance_status),
        explanation: str(governance?.explanation),
      },
      decisionOptions,
      anyDecisionAllowed: decisionOptions.some((option) => option.allowed),
      decisions,
      terminalDecision,
      state: terminalDecision ? "decided" : "awaiting_decision",
    });
  }

  return items;
}

/**
 * Attention inclusion rule: a governed Recommendation still open (`proposed`) with no terminal
 * Decision recorded against it.
 *
 * Exclusion rule: anything terminally decided, and anything whose Recommendation has already
 * left `proposed`. A recorded escalation or needs-more-evidence Decision does NOT exclude the
 * item — the contract deliberately returns the Recommendation to `proposed`, so it genuinely
 * still needs a human decision and must keep saying so.
 */
export function selectPendingAttention(items: CanonicalAttentionItem[]): CanonicalAttentionItem[] {
  return items.filter((item) => item.state === "awaiting_decision" && item.recommendationStatus === "proposed");
}

export function findAttentionByRecommendationId(
  items: CanonicalAttentionItem[],
  recommendationId: string
): CanonicalAttentionItem | undefined {
  return items.find((item) => item.recommendationId === recommendationId);
}
