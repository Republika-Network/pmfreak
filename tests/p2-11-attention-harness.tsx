/**
 * P2-11 acceptance harness.
 *
 * Executed by `tests/p2-11-pm-execution-center-attention-to-decision.test.mjs` through tsx, which
 * is how this repository runs real behaviour (rather than source scanning) against TypeScript
 * modules. It builds canonical-shaped OperationalSummary fixtures, runs them through the real
 * attention read model and the real Command Center components, and prints one JSON document of
 * observable results for the test file to assert on.
 *
 * Every fixture mirrors the persisted column names of the verified P2 contract. Authority maps
 * are produced by the real `evaluateOperationalDecisionAuthority` wherever the point of the
 * scenario is contract fidelity, and hand-written only where the point is that the UI honours an
 * arbitrary server-provided per-status verdict.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import {
  evaluateOperationalDecisionAuthority,
  type OperationalDecisionStatus,
  type OperationalWorkspaceRole,
} from "../src/lib/operational-flow/authority";
import {
  buildCanonicalAttention,
  selectPendingAttention,
  DECISION_OPTIONS,
  TERMINAL_DECISION_STATUSES,
} from "../src/modules/workspace/presentation/command-center/attention-read-model";
import {
  deriveNeedsYou,
  deriveAllGovernedAttention,
  deriveRaidNeedsYou,
  type RaidRecommendedAction,
} from "../src/modules/workspace/presentation/command-center/operational-data";
import { DetailDrawer } from "../src/modules/workspace/presentation/command-center/detail-drawer";
import { NeedsYouQueue } from "../src/modules/workspace/presentation/command-center/needs-you-queue";

const ALL_STATUSES: OperationalDecisionStatus[] = ["accepted", "rejected", "modified", "escalated", "needs_more_evidence"];

/** Reproduces exactly what `getOperationalSummary` projects onto each governed recommendation. */
function realAuthorityMap(actorRole: OperationalWorkspaceRole | null, authorityRequired: string) {
  return Object.fromEntries(
    ALL_STATUSES.map((status) => [status, evaluateOperationalDecisionAuthority({ actorRole, authorityRequired, decisionStatus: status })])
  );
}

const EVIDENCE = {
  id: "ev-1",
  title: "Client scope request",
  source_type: "email",
  source_reference: "mail-thread/991",
  evidence_hash: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
  assertion_type: "INFERENCE",
  classification: "RISK",
  confidence_score: 0.62,
  missing_data_state: "PARTIAL",
  freshness_state: "CURRENT",
  lifecycle: "RECORDED",
  fixture_state: "LIVE",
  degraded_reason: null,
  stale_at: null,
  raw_input_id: "raw-1",
  normalized_event_id: "ne-1",
  occurred_at: "2026-08-01T09:00:00.000Z",
  recorded_at: "2026-08-01T09:00:05.000Z",
  evaluated_at: "2026-08-01T09:00:06.000Z",
};

const SIGNAL = {
  id: "sig-1",
  evidence_item_id: "ev-1",
  signal_type: "scope_creep",
  severity: "high",
  confidence_score: 90,
  summary: "Additional work requested outside the agreed scope.",
  rationale: "Deterministic rule matched an out-of-scope request without approval.",
};

const RISK = {
  id: "risk-1",
  signal_id: "sig-1",
  type: "risk",
  status: "open",
  rationale: "The client requested additional scope without a formal change request.",
};

const GOVERNANCE = {
  id: "gov-1",
  related_entity_id: "risk-1",
  rule_key: "scope_change_requires_sponsor",
  authority_required: "sponsor or PMO",
  governance_status: "decision_required",
  explanation: "A scope change of this size requires sponsor authority before it proceeds.",
};

function recommendation(actorAuthority: Record<string, unknown>, status = "proposed") {
  return {
    id: "rec-1",
    governance_event_id: "gov-1",
    risk_issue_id: "risk-1",
    recommendation: "Raise a formal Change Request",
    status,
    actor_authority: actorAuthority,
  };
}

function summary(overrides: Partial<OperationalSummary> = {}): OperationalSummary {
  return {
    sources: [],
    rawInputs: [],
    normalizedEvents: [],
    evidence: [EVIDENCE],
    signals: [SIGNAL],
    risksIssues: [RISK],
    governanceEvents: [GOVERNANCE],
    recommendations: [recommendation(realAuthorityMap("admin", GOVERNANCE.authority_required))],
    decisions: [],
    evidenceLinks: [],
    materialActions: [],
    materialActionEvaluations: [],
    outcomes: [],
    observations: [],
    lineages: [],
    assurance: {
      scope: "project",
      workspaceId: "ws-1",
      projectId: "pr-1",
      asOf: "2026-08-01T10:00:00.000Z",
      totalGovernanceEvents: 1,
      decisionRequiredCount: 1,
      violationsCount: 0,
      openRecommendations: 1,
      unresolvedRisksIssues: 1,
      evidenceLinkedDecisionsCount: 0,
      evidenceWithoutSignalCount: 0,
      incompleteChainCount: 0,
    },
    actor: { role: "admin", canCreateEvidence: true },
    ...overrides,
  };
}

const ACCEPTED_DECISION = {
  id: "dec-1",
  recommendation_id: "rec-1",
  governance_event_id: "gov-1",
  decision_status: "accepted",
  decision: "Recommendation accepted by an authorized reviewer.",
  rationale: "Sponsor approved the change request.",
  decided_by: "user-42",
  authority_basis: "admin workspace authority (PMFreak role mapping v1)",
  created_at: "2026-08-02T11:00:00.000Z",
};

const ESCALATED_DECISION = {
  id: "dec-esc",
  recommendation_id: "rec-1",
  governance_event_id: "gov-1",
  decision_status: "escalated",
  decision: "Recommendation escalated by an authorized reviewer.",
  rationale: "Needs the sponsor to weigh in before we decide.",
  decided_by: "user-7",
  authority_basis: "pm escalation/review authority (PMFreak role mapping v1)",
  created_at: "2026-08-02T09:00:00.000Z",
};

const EVIDENCE_LINK = {
  decision_record_id: "dec-1",
  evidence_item_id: "ev-1",
  evidence_hash_at_decision: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
  evidence_version_at_decision: "3",
  evidence_title_snapshot: "Client scope request",
};

const RAID_ACTION: RaidRecommendedAction = {
  id: "raid-9",
  raid_item_id: "raid-item-9",
  title: "Confirm the integration owner",
  description: "The notes mention an unowned integration dependency.",
  recommended_action_type: "clarify_dependency",
  status: "proposed",
  confidence_score: 0.8,
  impact_level: "medium",
  recommended_owner: "Delivery lead",
  recommended_due_window: "this week",
  evidence_summary: { raidTitle: "Integration owner unknown", raidCategory: "dependency" },
  created_at: "2026-08-01T12:00:00.000Z",
};

const noopDecide = async () => {};

function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function drawerMarkupFor(items: ReturnType<typeof deriveAllGovernedAttention>, id: string): string {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`no attention item with id ${id}`);
  return markup(<DetailDrawer content={item.drawer} onClose={() => {}} />);
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/** Admin: every status permitted by the real authority mapping. */
const adminSummary = summary();

/** PM against a sponsor-required governance rule: the real mapping denies the terminal statuses
 *  and permits only the non-terminal ones. This is the contract-fidelity case. */
const pmSummary = summary({
  recommendations: [recommendation(realAuthorityMap("pm", GOVERNANCE.authority_required))],
  actor: { role: "pm", canCreateEvidence: true },
});

/** Viewer: read-only actor. */
const viewerSummary = summary({
  recommendations: [recommendation(realAuthorityMap("viewer", GOVERNANCE.authority_required))],
  actor: { role: "viewer", canCreateEvidence: false },
});

/** Arbitrary server verdict, per the P2-11 status-specific authority requirement:
 *  accepted denied, rejected allowed, escalated allowed. */
const syntheticSummary = summary({
  recommendations: [
    recommendation({
      accepted: { allowed: false, reason: "authority_requirement_not_satisfied", authorityRequired: "sponsor or PMO", authorityBasis: null },
      rejected: { allowed: true, reason: "workspace_authority", authorityRequired: "sponsor or PMO", authorityBasis: "test basis" },
      modified: { allowed: false, reason: "authority_requirement_not_satisfied", authorityRequired: "sponsor or PMO", authorityBasis: null },
      escalated: { allowed: true, reason: "non_terminal_escalation_authority", authorityRequired: "sponsor or PMO", authorityBasis: "test basis" },
      needs_more_evidence: { allowed: false, reason: "authority_requirement_not_satisfied", authorityRequired: "sponsor or PMO", authorityBasis: null },
    }),
  ],
});

/** Terminal accepted Decision persisted; the recommendation has left `proposed`. */
const decidedSummary = summary({
  recommendations: [recommendation(realAuthorityMap("admin", GOVERNANCE.authority_required), "accepted")],
  decisions: [ACCEPTED_DECISION],
  evidenceLinks: [EVIDENCE_LINK],
});

/** Non-terminal escalation recorded; the contract returns the recommendation to `proposed`. */
const escalatedSummary = summary({ decisions: [ESCALATED_DECISION] });

/** Governed recommendation whose supporting evidence is absent. */
/** Evidence genuinely absent from the PROJECT, not merely from a presentation window.
 *  `getOperationalSummary` resolves each Recommendation's upstream lineage by exact
 *  reference and reports the result, so a fixture claiming canonical absence must say so
 *  through that projection — reading it back off a truncated collection is exactly the
 *  false-absence defect the attention read model no longer permits. */
const missingEvidenceSummary = summary({
  evidence: [],
  signals: [],
  risksIssues: [],
  governanceEvents: [GOVERNANCE],
  governedAttentionContexts: [
    {
      recommendationId: "rec-1",
      governanceEvent: GOVERNANCE,
      riskIssue: null,
      signal: null,
      evidence: null,
      lineageComplete: false,
      authorityRequired: GOVERNANCE.authority_required,
    },
  ],
});

const raidItems = deriveRaidNeedsYou([RAID_ACTION], noopDecide);

const result = {
  contract: {
    decisionOptionStatuses: DECISION_OPTIONS.map((option) => option.status),
    terminalStatuses: [...TERMINAL_DECISION_STATUSES],
    // Proves no UI-only status leaked into the governed path.
    hasDeferredStatus: DECISION_OPTIONS.some((option) => String(option.status) === "deferred"),
  },

  admin: {
    all: buildCanonicalAttention(adminSummary).length,
    pending: selectPendingAttention(buildCanonicalAttention(adminSummary)).map((item) => ({
      id: item.id,
      recommendationId: item.recommendationId,
      governanceEventId: item.governanceEventId,
      signalId: item.signalId,
      riskIssueId: item.riskIssueId,
      evidenceIds: item.evidenceIds,
      title: item.title,
      recommendationStatus: item.recommendationStatus,
      state: item.state,
      why: item.why,
      provenance: item.provenance,
      evidenceQuality: item.evidenceQuality,
      governance: item.governance,
      allowedStatuses: item.decisionOptions.filter((option) => option.allowed).map((option) => option.status),
      decisions: item.decisions,
    })),
    needsYouIds: deriveNeedsYou(adminSummary, noopDecide).map((item) => item.id),
    needsYouKinds: deriveNeedsYou(adminSummary, noopDecide).map((item) => item.kind),
  },

  pm: {
    allowedStatuses: buildCanonicalAttention(pmSummary)[0].decisionOptions.filter((o) => o.allowed).map((o) => o.status),
    deniedStatuses: buildCanonicalAttention(pmSummary)[0].decisionOptions.filter((o) => !o.allowed).map((o) => o.status),
    anyDecisionAllowed: buildCanonicalAttention(pmSummary)[0].anyDecisionAllowed,
  },

  viewer: {
    allowedStatuses: buildCanonicalAttention(viewerSummary)[0].decisionOptions.filter((o) => o.allowed).map((o) => o.status),
    anyDecisionAllowed: buildCanonicalAttention(viewerSummary)[0].anyDecisionAllowed,
    stillVisibleInQueue: deriveNeedsYou(viewerSummary, noopDecide).length,
    drawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(viewerSummary, noopDecide), "governed-rec-rec-1"),
  },

  synthetic: {
    allowedStatuses: buildCanonicalAttention(syntheticSummary)[0].decisionOptions.filter((o) => o.allowed).map((o) => o.status),
    drawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(syntheticSummary, noopDecide), "governed-rec-rec-1"),
  },

  decided: {
    pendingCount: selectPendingAttention(buildCanonicalAttention(decidedSummary)).length,
    needsYouCount: deriveNeedsYou(decidedSummary, noopDecide).length,
    state: buildCanonicalAttention(decidedSummary)[0].state,
    recommendationStatus: buildCanonicalAttention(decidedSummary)[0].recommendationStatus,
    terminalDecision: buildCanonicalAttention(decidedSummary)[0].terminalDecision,
    title: buildCanonicalAttention(decidedSummary)[0].title,
    drawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(decidedSummary, noopDecide), "governed-rec-rec-1"),
  },

  escalated: {
    pendingCount: selectPendingAttention(buildCanonicalAttention(escalatedSummary)).length,
    state: buildCanonicalAttention(escalatedSummary)[0].state,
    decisions: buildCanonicalAttention(escalatedSummary)[0].decisions.map((d) => ({ id: d.decisionId, status: d.decisionStatus, terminal: d.terminal })),
    drawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(escalatedSummary, noopDecide), "governed-rec-rec-1"),
  },

  missingEvidence: {
    evidenceMissing: buildCanonicalAttention(missingEvidenceSummary)[0].evidenceQuality.evidenceMissing,
    drawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(missingEvidenceSummary, noopDecide), "governed-rec-rec-1"),
  },

  raid: {
    ids: raidItems.map((item) => item.id),
    kinds: raidItems.map((item) => item.kind),
    badges: raidItems.map((item) => item.badge.label),
    writePathLabels: raidItems.map((item) => item.drawer.decisionPanel?.writePathLabel ?? null),
    controlStatuses: raidItems.map((item) => item.drawer.decisionPanel?.controls.map((c) => c.status) ?? []),
    kindSummaries: raidItems.map((item) => item.drawer.kindSummary ?? null),
    markup: markup(<DetailDrawer content={raidItems[0].drawer} onClose={() => {}} />),
  },

  governedBadges: deriveNeedsYou(adminSummary, noopDecide).map((item) => item.badge.label),

  pendingDrawerMarkup: drawerMarkupFor(deriveAllGovernedAttention(adminSummary, noopDecide), "governed-rec-rec-1"),

  queue: {
    loading: markup(<NeedsYouQueue items={[]} onSelect={() => {}} loading />),
    empty: markup(<NeedsYouQueue items={[]} onSelect={() => {}} />),
    error: markup(<NeedsYouQueue items={[]} onSelect={() => {}} errorMessage="We couldn't load project attention." onRetry={() => {}} />),
    populated: markup(<NeedsYouQueue items={deriveNeedsYou(adminSummary, noopDecide)} onSelect={() => {}} />),
  },

  /** Cross-tenant guard: a recommendation belonging to another project is simply not present in
   *  this project's summary, so no attention item and no decision control can address it. */
  foreignRecommendation: {
    lookup: buildCanonicalAttention(adminSummary).filter((item) => item.recommendationId === "rec-from-other-project").length,
  },
};

console.log(JSON.stringify(result));
