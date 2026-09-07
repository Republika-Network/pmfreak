/**
 * UX-W3 — Needs You interaction quality harness.
 *
 * Executed by `tests/ux-w3-needs-you-interaction-quality.test.mjs` through tsx, the way this
 * repository runs REAL behaviour rather than source scanning.
 *
 * It builds canonical-shaped fixtures, runs them through the REAL attention read models
 * (`deriveNeedsYou`, `deriveRaidNeedsYou`) and the REAL grouping, renders the REAL queue and
 * drawer, and prints one JSON document of what a PM would actually see. Whether a card is
 * understandable is a rendering question; source reading cannot answer it.
 *
 * The fixtures are deliberately varied: a governed item this actor may decide, a governed
 * item they may only review (a real authority condition, not a category invented to fill a
 * heading), two items in one group, a RAID suggestion, an item with thin evidence and no
 * signal, and the partial/failed attention states W2 established.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import {
  evaluateOperationalDecisionAuthority,
  type OperationalDecisionStatus,
  type OperationalWorkspaceRole,
} from "../src/lib/operational-flow/authority";
import {
  deriveNeedsYou,
  deriveRaidNeedsYou,
  type RaidRecommendedAction,
} from "../src/modules/workspace/presentation/command-center/operational-data";
import {
  groupAttentionItems,
  humanJobFor,
  APPROVAL_ITEMS_AVAILABLE,
  HUMAN_JOB_GROUP_LABELS,
} from "../src/modules/workspace/presentation/command-center/attention-presentation";
import { NeedsYouQueue } from "../src/modules/workspace/presentation/command-center/needs-you-queue";
import { DetailDrawer } from "../src/modules/workspace/presentation/command-center/detail-drawer";
import { DECISION_OPTIONS } from "../src/modules/workspace/presentation/command-center/attention-read-model";
import type { NeedsYouItem } from "../src/modules/workspace/presentation/command-center/types";

const ALL_STATUSES: OperationalDecisionStatus[] = ["accepted", "rejected", "modified", "escalated", "needs_more_evidence"];

function realAuthorityMap(actorRole: OperationalWorkspaceRole | null, authorityRequired: string) {
  return Object.fromEntries(
    ALL_STATUSES.map((status) => [status, evaluateOperationalDecisionAuthority({ actorRole, authorityRequired, decisionStatus: status })])
  );
}

// ── Canonical-shaped fixtures ────────────────────────────────────────────────

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
  occurred_at: "2026-09-01T09:00:00.000Z",
};

/** A second evidence row, so the two governed items do not share provenance. */
const EVIDENCE_2 = { ...EVIDENCE, id: "ev-2", title: "Steering committee minutes", source_reference: "minutes/2026-09-02" };

const SIGNAL = {
  id: "sig-1",
  evidence_item_id: "ev-1",
  signal_type: "scope_creep",
  severity: "critical",
  confidence_score: 92,
  summary: "Work outside the agreed scope was requested.",
  rationale: "Deterministic rule matched an out-of-scope request without approval.",
};

const SIGNAL_2 = {
  id: "sig-2",
  evidence_item_id: "ev-2",
  signal_type: "schedule_risk",
  severity: "high",
  confidence_score: 84,
  summary: "The delivery date for the integration milestone is slipping.",
  rationale: "Deterministic rule matched explicit delay language.",
};

const RISK = {
  id: "risk-1",
  signal_id: "sig-1",
  type: "risk",
  status: "open",
  title: "Finding: scope creep",
  rationale: "The client requested additional scope without a formal change request.",
};

const RISK_2 = {
  id: "risk-2",
  signal_id: "sig-2",
  type: "risk",
  status: "open",
  title: "Finding: schedule risk",
  rationale: "Two dependencies slipped and the milestone has no revised date.",
};

const GOVERNANCE = {
  id: "gov-1",
  related_entity_id: "risk-1",
  rule_key: "scope_change_requires_sponsor",
  authority_required: "sponsor or PMO",
  governance_status: "decision_required",
  explanation: "A scope change of this size requires sponsor authority before it proceeds.",
};

const GOVERNANCE_2 = {
  id: "gov-2",
  related_entity_id: "risk-2",
  rule_key: "schedule_slip_requires_replan",
  authority_required: "project manager",
  governance_status: "decision_required",
  explanation: "A slip of this size requires an agreed replan before delivery continues.",
};

/** A Recommendation with NO signal and NO evidence link: the thin-data card. */
const GOVERNANCE_3 = {
  id: "gov-3",
  related_entity_id: "risk-3",
  rule_key: "unowned_dependency",
  authority_required: "project manager",
  governance_status: "decision_required",
  explanation: "An unowned dependency needs an owner before it can be tracked.",
};

const recommendation = (id: string, governanceEventId: string, riskId: string, text: string, authority: string, role: OperationalWorkspaceRole) => ({
  id,
  governance_event_id: governanceEventId,
  risk_issue_id: riskId,
  recommendation: text,
  status: "proposed",
  actor_authority: realAuthorityMap(role, authority),
});

function summary(overrides: Partial<OperationalSummary> = {}): OperationalSummary {
  return {
    generatedAt: "2026-09-07T12:00:00.000Z",
    sources: [],
    rawInputs: [],
    normalizedEvents: [],
    evidence: [EVIDENCE, EVIDENCE_2],
    signals: [SIGNAL, SIGNAL_2],
    risksIssues: [RISK, RISK_2],
    governanceEvents: [GOVERNANCE, GOVERNANCE_2],
    recommendations: [],
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
      asOf: "2026-09-07T12:00:00.000Z",
      totalGovernanceEvents: 2,
      decisionRequiredCount: 2,
      violationsCount: 0,
      openRecommendations: 2,
      unresolvedRisksIssues: 2,
      evidenceLinkedDecisionsCount: 0,
      evidenceWithoutSignalCount: 0,
      incompleteChainCount: 0,
    },
    actor: { role: "admin", userId: "user-42", canCreateEvidence: true },
    ...overrides,
  };
}

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
  created_at: "2026-09-01T12:00:00.000Z",
};

const noop = () => {};
const noopDecide = async () => {};

// ── Scenarios ────────────────────────────────────────────────────────────────

/**
 * An admin against two rules they hold authority for: two governed items the actor may
 * decide, so one group legitimately holds more than one card.
 */
const decidableSummary = summary({
  recommendations: [
    recommendation("rec-1", "gov-1", "risk-1", "Raise a formal Change Request", GOVERNANCE.authority_required, "admin"),
    recommendation("rec-2", "gov-2", "risk-2", "Agree a replan for the delayed milestone", GOVERNANCE_2.authority_required, "admin"),
  ],
});

/**
 * A viewer: the real authority mapping denies every status, so these are genuinely
 * review-only items. This is a persisted condition, not an invented category.
 */
const reviewOnlySummary = summary({
  recommendations: [
    recommendation("rec-1", "gov-1", "risk-1", "Raise a formal Change Request", GOVERNANCE.authority_required, "viewer"),
  ],
  actor: { role: "viewer", userId: "user-9", canCreateEvidence: false },
});

/** Both at once: two decidable items and one review-only item, so both groups render. */
const mixedSummary = summary({
  recommendations: [
    recommendation("rec-1", "gov-1", "risk-1", "Raise a formal Change Request", GOVERNANCE.authority_required, "admin"),
    recommendation("rec-2", "gov-2", "risk-2", "Agree a replan for the delayed milestone", GOVERNANCE_2.authority_required, "admin"),
    // A rule this admin does NOT satisfy — the real mapping denies it.
    recommendation("rec-3", "gov-3", "risk-3", "Assign an owner to the integration dependency", "sponsor", "pm"),
  ],
  governanceEvents: [GOVERNANCE, GOVERNANCE_2, { ...GOVERNANCE_3, authority_required: "sponsor" }],
  // rec-3's risk carries no signal and no evidence: the thin-data card.
  risksIssues: [RISK, RISK_2, { id: "risk-3", signal_id: null, type: "risk", status: "open", rationale: "" }],
  actor: { role: "pm", userId: "user-7", canCreateEvidence: true },
});

/**
 * A Recommendation whose governed lineage is incomplete — no signal, no evidence.
 *
 * `record_operational_decision` walks that lineage BEFORE it evaluates authority and raises
 * `governed_lineage_incomplete` when the evidence row is absent, so the write is refused for
 * this item however much authority the actor holds. Mirrors the P2-11 missing-evidence
 * scenario: full admin authority, nothing behind the Recommendation.
 */
const missingEvidenceSummary = summary({
  evidence: [],
  signals: [],
  risksIssues: [{ id: "risk-1", signal_id: null, type: "risk", status: "open", rationale: "Reported verbally at the steering committee." }],
  governanceEvents: [GOVERNANCE],
  recommendations: [
    recommendation("rec-1", "gov-1", "risk-1", "Raise a formal Change Request", GOVERNANCE.authority_required, "admin"),
  ],
  // The server resolves each Recommendation's lineage by exact reference and reports the
  // result. A fixture asserting canonical absence must therefore say so HERE — inferring it
  // from an empty presentation collection is the false-absence defect the read model no
  // longer permits, and `tests/ux-w3-attention-lineage-harness.tsx` proves that end to end.
  governedAttentionContexts: [
    {
      recommendationId: "rec-1",
      governanceEvent: GOVERNANCE,
      riskIssue: { id: "risk-1", signal_id: null },
      signal: null,
      evidence: null,
      lineageComplete: false,
      authorityRequired: GOVERNANCE.authority_required,
    },
  ],
});

/**
 * A non-terminal Decision already recorded against a still-open item.
 *
 * `escalated` maps the Recommendation back to `proposed`, so this item legitimately stays
 * in Needs You with a Decision attached — which is why its record renders in front of a
 * live judgment and must not carry canonical identifiers there.
 */
const ESCALATED_DECISION = {
  id: "dec-esc",
  recommendation_id: "rec-1",
  governance_event_id: "gov-1",
  decision_status: "escalated",
  decision: "Recommendation escalated by an authorized reviewer.",
  rationale: "Needs the sponsor to weigh in before we decide.",
  decided_by: "8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60",
  authority_basis: "admin workspace authority (PMFreak role mapping v1)",
  created_at: "2026-09-05T09:00:00.000Z",
};

const escalatedSummary = summary({
  recommendations: [
    recommendation("rec-1", "gov-1", "risk-1", "Raise a formal Change Request", GOVERNANCE.authority_required, "admin"),
  ],
  decisions: [ESCALATED_DECISION],
  evidenceLinks: [
    {
      decision_record_id: "dec-esc",
      evidence_item_id: "ev-1",
      evidence_hash_at_decision: EVIDENCE.evidence_hash,
      evidence_version_at_decision: "3",
      evidence_title_snapshot: EVIDENCE.title,
    },
  ],
});

const decidableItems = deriveNeedsYou(decidableSummary, noopDecide);
const missingEvidenceItems = deriveNeedsYou(missingEvidenceSummary, noopDecide);
const escalatedItems = deriveNeedsYou(escalatedSummary, noopDecide);
const reviewOnlyItems = deriveNeedsYou(reviewOnlySummary, noopDecide);
const mixedItems = deriveNeedsYou(mixedSummary, noopDecide);
const raidItems = deriveRaidNeedsYou([RAID_ACTION], noopDecide);

/** The queue as the Command Center composes it: governed items then RAID suggestions. */
const allItems: NeedsYouItem[] = [...mixedItems, ...raidItems];

function renderQueue(items: NeedsYouItem[], overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <NeedsYouQueue variant="canvas" items={items} onSelect={noop} loading={false} errorMessage={null} {...overrides} />
  );
}

/** Visible text, tags stripped — what the reader actually gets. */
function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** The markup of each rendered attention card, in document order. */
function cards(markup: string): Array<{ job: string | null; body: string; text: string }> {
  return [...markup.matchAll(/<button[^>]*data-testid="cc-attention-card"[\s\S]*?<\/button>/g)].map((match) => ({
    job: /data-human-job="([a-z]+)"/.exec(match[0])?.[1] ?? null,
    body: match[0],
    text: text(match[0]),
  }));
}

/** Group headings in document order. */
function groupHeadings(markup: string): string[] {
  return [...markup.matchAll(/data-testid="cc-attention-group-([a-z]+)"/g)].map((m) => m[1]);
}

const queueAll = renderQueue(allItems);
const queueDecidable = renderQueue(decidableItems);
const queueReviewOnly = renderQueue(reviewOnlyItems);
const queueRaidOnly = renderQueue(raidItems);
const queueEmpty = renderQueue([], { emptyStateNote: "PMFreak is still monitoring risks, schedule." });
const queueLoadingWithKnown = renderQueue(decidableItems, {
  loading: true,
  incompleteNote: "Still checking suggested actions.",
});
const queueFailed = renderQueue([], { errorMessage: "We couldn't load project attention.", onRetry: noop });

const governedDrawer = renderToStaticMarkup(<DetailDrawer content={decidableItems[0].drawer} onClose={noop} />);
const raidDrawer = renderToStaticMarkup(<DetailDrawer content={raidItems[0].drawer} onClose={noop} />);
const reviewOnlyDrawer = renderToStaticMarkup(<DetailDrawer content={reviewOnlyItems[0].drawer} onClose={noop} />);
const missingEvidenceDrawer = renderToStaticMarkup(<DetailDrawer content={missingEvidenceItems[0].drawer} onClose={noop} />);
const escalatedDrawer = renderToStaticMarkup(<DetailDrawer content={escalatedItems[0].drawer} onClose={noop} />);

/** Everything a card is allowed to know about one item, for the card-anatomy assertions. */
const itemShape = (item: NeedsYouItem) => ({
  id: item.id,
  kind: item.kind ?? null,
  humanJob: humanJobFor(item),
  title: item.title,
  subject: item.subject ?? null,
  severity: item.severity ?? null,
  whyItMatters: item.whyItMatters ?? null,
  evidenceSummary: item.evidenceSummary ?? null,
  recommendation: item.recommendation ?? null,
  badgeLabel: item.badge.label,
  decisionStatuses: (item.drawer.decisionPanel?.controls ?? []).map((control) => control.status),
  decisionLabels: (item.drawer.decisionPanel?.controls ?? []).map((control) => control.label),
  anyAllowed: item.drawer.decisionPanel?.anyAllowed ?? null,
  /** The exact fact the human-job derivation turns on: may this actor record a status that
   *  CLOSES the item? Computed here from the controls the server-evaluated authority map
   *  produced, so the assertions compare the grouping against the contract, not itself. */
  terminalAllowed: (item.drawer.decisionPanel?.controls ?? []).some((control) => control.terminal && control.allowed),
  allowedStatuses: (item.drawer.decisionPanel?.controls ?? []).filter((c) => c.allowed).map((c) => c.status),
  requiresRationale: item.drawer.decisionPanel?.requiresRationale ?? null,
  writePathLabel: item.drawer.decisionPanel?.writePathLabel ?? null,
  blockedReason: item.drawer.decisionPanel?.blockedReason ?? null,
  recordedDecisionIds: (item.drawer.decisionPanel?.decisions ?? []).map((d) => d.decisionId),
});

process.stdout.write(
  JSON.stringify(
    {
      approvalItemsAvailable: APPROVAL_ITEMS_AVAILABLE,
      raidContract: {
        // The generator's own field meanings, so the assertions compare presentation
        // against the contract rather than against itself.
        sourceRaidTitle: (RAID_ACTION.evidence_summary as Record<string, unknown>).raidTitle,
        recommendedActionTitle: RAID_ACTION.title,
        owner: RAID_ACTION.recommended_owner,
        dueWindow: RAID_ACTION.recommended_due_window,
      },
      escalatedFixture: { decisionId: ESCALATED_DECISION.id, decidedBy: ESCALATED_DECISION.decided_by, authorityBasis: ESCALATED_DECISION.authority_basis, evidenceHash: EVIDENCE.evidence_hash },
      groupLabels: HUMAN_JOB_GROUP_LABELS,
      canonicalDecisionOptions: DECISION_OPTIONS.map((option) => ({ status: option.status, label: option.label, terminal: option.terminal })),

      items: {
        decidable: decidableItems.map(itemShape),
        reviewOnly: reviewOnlyItems.map(itemShape),
        mixed: mixedItems.map(itemShape),
        raid: raidItems.map(itemShape),
        missingEvidence: missingEvidenceItems.map(itemShape),
        escalated: escalatedItems.map(itemShape),
        all: allItems.map(itemShape),
      },

      grouping: {
        missingEvidence: groupAttentionItems(missingEvidenceItems).map((g) => ({ job: g.job, ids: g.items.map((i) => i.id) })),
        escalated: groupAttentionItems(escalatedItems).map((g) => ({ job: g.job, ids: g.items.map((i) => i.id) })),
        all: groupAttentionItems(allItems).map((group) => ({ job: group.job, label: group.label, ids: group.items.map((i) => i.id) })),
        decidable: groupAttentionItems(decidableItems).map((group) => ({ job: group.job, ids: group.items.map((i) => i.id) })),
        reviewOnly: groupAttentionItems(reviewOnlyItems).map((group) => ({ job: group.job, ids: group.items.map((i) => i.id) })),
        raidOnly: groupAttentionItems(raidItems).map((group) => ({ job: group.job, ids: group.items.map((i) => i.id) })),
        empty: groupAttentionItems([]),
      },

      queue: {
        all: { markup: queueAll, headings: groupHeadings(queueAll), cards: cards(queueAll), text: text(queueAll) },
        decidable: { headings: groupHeadings(queueDecidable), cards: cards(queueDecidable) },
        reviewOnly: { headings: groupHeadings(queueReviewOnly), cards: cards(queueReviewOnly) },
        raidOnly: { headings: groupHeadings(queueRaidOnly), cards: cards(queueRaidOnly) },
        missingEvidence: { headings: groupHeadings(renderQueue(missingEvidenceItems)), cards: cards(renderQueue(missingEvidenceItems)) },
        escalated: { headings: groupHeadings(renderQueue(escalatedItems)), cards: cards(renderQueue(escalatedItems)) },
        empty: { headings: groupHeadings(queueEmpty), text: text(queueEmpty) },
        loadingWithKnown: { headings: groupHeadings(queueLoadingWithKnown), cardCount: cards(queueLoadingWithKnown).length, text: text(queueLoadingWithKnown) },
        failed: { headings: groupHeadings(queueFailed), text: text(queueFailed) },
      },

      drawers: {
        governed: { markup: governedDrawer, text: text(governedDrawer) },
        raid: { markup: raidDrawer, text: text(raidDrawer) },
        reviewOnly: { markup: reviewOnlyDrawer, text: text(reviewOnlyDrawer) },
        missingEvidence: { markup: missingEvidenceDrawer, text: text(missingEvidenceDrawer) },
        escalated: { markup: escalatedDrawer, text: text(escalatedDrawer) },
      },
    },
    null,
    2
  )
);
