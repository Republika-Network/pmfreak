/**
 * UX-W2 — attention-first Command Center harness.
 *
 * Executed by `tests/ux-w2-attention-first-command-center.test.mjs` through tsx, the way
 * this repository runs REAL behaviour rather than source scanning (same pattern as
 * `tests/p2-11-attention-harness.tsx` and `tests/ux-w0-capture-defaults-harness.tsx`).
 *
 * It renders the real Command Center screen and the real attention canvas against
 * canonical-shaped `OperationalSummary` fixtures, through the REAL read models
 * (`deriveNeedsYou`, `deriveExecutionChains`, `deriveWhatChanged`, `deriveMonitoring`), and
 * prints one JSON document describing what a PM would actually see.
 *
 * "What the user sees first" is a rendering question. Source reading can prove which
 * component is imported; only rendering can prove which section the browser lays out first.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import { evaluateOperationalDecisionAuthority, type OperationalDecisionStatus, type OperationalWorkspaceRole } from "../src/lib/operational-flow/authority";
import {
  deriveExecutionChains,
  deriveMonitoring,
  deriveNeedsYou,
  deriveAgents,
} from "../src/modules/workspace/presentation/command-center/operational-data";
import { deriveWhatChanged } from "../src/modules/workspace/presentation/command-center/change-read-model";
import { CommandCenterCanvas } from "../src/modules/workspace/presentation/command-center/command-center-canvas";
import { AgentDock } from "../src/modules/workspace/presentation/command-center/agent-dock";
import { CommandFeed } from "../src/modules/workspace/presentation/command-center/command-feed";
import { CommandCenterLayout } from "../src/modules/workspace/screens/command-center/command-center-layout";
import type { ProjectListItem } from "../src/modules/workspace/presentation/command-center/types";

const NOW = new Date("2026-09-06T12:00:00.000Z");

const ALL_STATUSES: OperationalDecisionStatus[] = ["accepted", "rejected", "modified", "escalated", "needs_more_evidence"];

function realAuthorityMap(actorRole: OperationalWorkspaceRole | null, authorityRequired: string) {
  return Object.fromEntries(
    ALL_STATUSES.map((status) => [status, evaluateOperationalDecisionAuthority({ actorRole, authorityRequired, decisionStatus: status })])
  );
}

// ── Canonical-shaped fixtures (persisted column names) ───────────────────────

const EVIDENCE = {
  id: "ev-1",
  title: "Client scope request",
  source_type: "email",
  evidence_hash: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
  assertion_type: "INFERENCE",
  classification: "RISK",
  confidence_score: 0.62,
  missing_data_state: "PARTIAL",
  freshness_state: "CURRENT",
  lifecycle: "RECORDED",
  fixture_state: "LIVE",
  occurred_at: "2026-09-06T09:00:00.000Z",
  recorded_at: "2026-09-06T09:00:05.000Z",
  updated_at: "2026-09-06T11:52:00.000Z",
};

/** Three real `operational_signals` rows, deliberately NOT in newest-first input order,
 *  plus a duplicate of one of them and one row with no usable timestamp. */
const SIGNALS = [
  {
    id: "sig-schedule",
    evidence_item_id: "ev-1",
    signal_type: "schedule_risk",
    severity: "high",
    confidence_score: 84,
    summary: "The evidence indicates schedule exposure.",
    rationale: "Deterministic rule matched explicit language in the recorded evidence.",
    status: "open",
    created_at: "2026-09-06T10:00:00.000Z",
  },
  {
    id: "sig-scope",
    evidence_item_id: "ev-1",
    signal_type: "scope_creep",
    severity: "critical",
    confidence_score: 92,
    summary: "Work outside the agreed scope was requested.",
    rationale: "Deterministic rule matched explicit language in the recorded evidence.",
    status: "open",
    created_at: "2026-09-06T11:30:00.000Z",
  },
  {
    id: "sig-cost",
    evidence_item_id: "ev-1",
    signal_type: "cost_risk",
    severity: "medium",
    confidence_score: 86,
    summary: "The evidence indicates cost exposure.",
    rationale: "Deterministic rule matched explicit language in the recorded evidence.",
    status: "open",
    created_at: "2026-09-05T08:00:00.000Z",
  },
  // Same canonical row delivered twice — one change, not two.
  {
    id: "sig-scope",
    evidence_item_id: "ev-1",
    signal_type: "scope_creep",
    severity: "critical",
    confidence_score: 92,
    summary: "Work outside the agreed scope was requested.",
    rationale: "Deterministic rule matched explicit language in the recorded evidence.",
    status: "open",
    created_at: "2026-09-06T11:30:00.000Z",
  },
  // No usable timestamp: the surface must show the change without inventing a time.
  {
    id: "sig-undated",
    evidence_item_id: "ev-1",
    signal_type: "governance_gap",
    severity: "medium",
    confidence_score: 78,
    summary: "A governance responsibility or control is missing.",
    rationale: "Deterministic rule matched explicit language in the recorded evidence.",
    status: "open",
    created_at: null,
  },
];

const RISK = {
  id: "risk-1",
  signal_id: "sig-scope",
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

const RECOMMENDATION = {
  id: "rec-1",
  governance_event_id: "gov-1",
  risk_issue_id: "risk-1",
  recommendation: "Raise a formal Change Request",
  status: "proposed",
  actor_authority: realAuthorityMap("admin", GOVERNANCE.authority_required),
};

/** A second governed recommendation with NO decision yet, so the same payload carries both
 *  a pending attention item and a decided chain — the two surfaces W2 puts side by side. */
const RISK_2 = {
  id: "risk-2",
  signal_id: "sig-schedule",
  type: "risk",
  status: "open",
  rationale: "Delivery dates are slipping against the agreed plan.",
};

const GOVERNANCE_2 = {
  id: "gov-2",
  related_entity_id: "risk-2",
  rule_key: "schedule_slip_requires_replan",
  authority_required: "project manager",
  governance_status: "decision_required",
  explanation: "A slip of this size requires an agreed replan before delivery continues.",
};

const PENDING_RECOMMENDATION = {
  id: "rec-2",
  governance_event_id: "gov-2",
  risk_issue_id: "risk-2",
  recommendation: "Agree a replan for the delayed milestone",
  status: "proposed",
  actor_authority: realAuthorityMap("admin", GOVERNANCE_2.authority_required),
};

const ACCEPTED_DECISION = {
  id: "dec-1",
  recommendation_id: "rec-1",
  governance_event_id: "gov-1",
  decision_status: "accepted",
  decision: "Recommendation accepted by an authorized reviewer.",
  rationale: "Sponsor approved the change request.",
  decided_by: "user-42",
  authority_basis: "admin workspace authority (PMFreak role mapping v1)",
  created_at: "2026-09-06T11:00:00.000Z",
};

function summary(overrides: Partial<OperationalSummary> = {}): OperationalSummary {
  return {
    generatedAt: NOW.toISOString(),
    sources: [],
    rawInputs: [],
    normalizedEvents: [],
    evidence: [EVIDENCE],
    signals: SIGNALS,
    risksIssues: [RISK, RISK_2],
    governanceEvents: [GOVERNANCE, GOVERNANCE_2],
    recommendations: [RECOMMENDATION, PENDING_RECOMMENDATION],
    decisions: [ACCEPTED_DECISION],
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
      asOf: NOW.toISOString(),
      totalGovernanceEvents: 2,
      decisionRequiredCount: 2,
      violationsCount: 0,
      openRecommendations: 1,
      unresolvedRisksIssues: 1,
      evidenceLinkedDecisionsCount: 0,
      evidenceWithoutSignalCount: 0,
      incompleteChainCount: 0,
    },
    actor: { role: "admin", userId: "user-42", canCreateEvidence: true },
    ...overrides,
  };
}

const PROJECT: ProjectListItem = {
  id: "pr-1",
  code: "ERP-9F3A2",
  name: "ERP Transformation",
  fullName: "ERP Transformation",
  badges: [{ tone: "danger", label: "2" }],
  hasIntelligence: true,
  healthy: false,
};

const noop = () => {};
const noopDecide = async () => {};

// ── Rendering helpers ────────────────────────────────────────────────────────

/** Every `data-testid="cc-section-*"` in the order the document declares them. */
function sectionOrder(markup: string): string[] {
  return [...markup.matchAll(/data-testid="(cc-section-[a-z-]+)"/g)].map((match) => match[1]);
}

/** Visible text, tags stripped — what the reader actually gets. */
function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** The markup of the element carrying a given test id, to its matching close. */
function section(markup: string, testId: string): string {
  const start = markup.indexOf(`data-testid="${testId}"`);
  if (start < 0) return "";
  const open = markup.lastIndexOf("<", start);
  const tag = /^<([a-z0-9]+)/i.exec(markup.slice(open))?.[1] ?? "div";
  let depth = 0;
  const scanner = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  scanner.lastIndex = open;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(markup)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return markup.slice(open, scanner.lastIndex);
  }
  return markup.slice(open);
}

type CanvasOverrides = Partial<Parameters<typeof CommandCenterCanvas>[0]>;

/** Renders the real canvas from the real read models for a given payload. */
function renderCanvas(data: OperationalSummary | undefined, overrides: CanvasOverrides = {}): string {
  const chains = deriveExecutionChains(data, NOW);
  const monitoring = deriveMonitoring(data);
  const needsYouItems = deriveNeedsYou(data, noopDecide);
  const hasRealData = Boolean(data && data.evidence.length > 0);
  return renderToStaticMarkup(
    <CommandCenterCanvas
      project={PROJECT}
      sources={[]}
      lastUpdatedLabel="8 minutes ago"
      onOpenProjects={noop}
      needsYouItems={hasRealData ? needsYouItems : []}
      needsYouCount={hasRealData ? needsYouItems.length : 0}
      onSelectNeedsYou={noop}
      attentionErrorMessage={null}
      onRetryAttention={noop}
      onAddNotes={noop}
      monitoringNote={hasRealData ? `PMFreak is still monitoring ${monitoring.areas.map((a) => a.label.toLowerCase()).join(", ")}.` : null}
      changes={deriveWhatChanged(data, NOW)}
      chains={chains}
      onSelectChain={noop}
      monitoring={monitoring}
      monitoringActive={hasRealData}
      // Mirrors the screen: agents render from real evidence, or not at all.
      agentDetail={<AgentDock agents={hasRealData ? deriveAgents(data, false) : []} onSelect={noop} />}
      chatOpen={false}
      onToggleChat={noop}
      chatMessageCount={2}
      chat={<CommandFeed messages={[]} onSendMessage={noop} onSourceClick={noop} onActionClick={noop} />}
      {...overrides}
    />
  );
}

const populatedSummary = summary();
const noSignalsSummary = summary({ signals: [] });

const populated = renderCanvas(populatedSummary);
const chatExpanded = renderCanvas(populatedSummary, { chatOpen: true });
const noAttention = renderCanvas(summary({ recommendations: [], risksIssues: [], governanceEvents: [] }));
const noSignals = renderCanvas(noSignalsSummary);
const noProjectData = renderCanvas(summary({ evidence: [], signals: [], recommendations: [], decisions: [] }));
const readFailed = renderCanvas(undefined, {
  needsYouCount: null,
  attentionErrorMessage: "We couldn't load project attention.",
  loading: false,
  monitoringActive: false,
});

/** The real screen, mounted the way the route mounts it. SWR has no data during a static
 *  render, so this is the Command Center's first paint — which is exactly the state the
 *  "what does a PM see first" question is about. */
const screen = renderToStaticMarkup(
  <CommandCenterLayout workspaceName="Republika" workspaceId="ws-1" projects={[PROJECT]} activeProjectId="pr-1" />
);

const mainRegion = (() => {
  const start = screen.indexOf("<main");
  const end = screen.indexOf("</main>", start);
  return start < 0 ? "" : screen.slice(start, end + 7);
})();

process.stdout.write(
  JSON.stringify(
    {
      canvas: {
        populated,
        populatedOrder: sectionOrder(populated),
        populatedText: text(populated),
        needsYou: section(populated, "cc-section-needs-you"),
        whatChanged: section(populated, "cc-section-what-changed"),
        inProgress: section(populated, "cc-section-in-progress"),
        monitoring: section(populated, "cc-section-monitoring"),
        askPmfreak: section(populated, "cc-section-ask-pmfreak"),
        header: section(populated, "cc-project-header"),
      },
      chatExpanded: {
        askPmfreak: section(chatExpanded, "cc-section-ask-pmfreak"),
        order: sectionOrder(chatExpanded),
      },
      emptyAttention: {
        needsYou: text(section(noAttention, "cc-section-needs-you")),
        order: sectionOrder(noAttention),
      },
      emptySignals: {
        whatChanged: text(section(noSignals, "cc-section-what-changed")),
        changeItemCount: (section(noSignals, "cc-section-what-changed").match(/cc-change-item/g) ?? []).length,
      },
      noProjectData: {
        monitoring: text(section(noProjectData, "cc-section-monitoring")),
        inProgress: text(section(noProjectData, "cc-section-in-progress")),
      },
      readFailed: {
        order: sectionOrder(readFailed),
        needsYou: text(section(readFailed, "cc-section-needs-you")),
        whatChanged: text(section(readFailed, "cc-section-what-changed")),
        monitoring: text(section(readFailed, "cc-section-monitoring")),
        header: text(section(readFailed, "cc-project-header")),
      },
      screen: {
        order: sectionOrder(screen),
        mainOrder: sectionOrder(mainRegion),
        mainHasCanvas: mainRegion.includes('data-testid="command-center-canvas"'),
        canvasCount: (screen.match(/data-testid="command-center-canvas"/g) ?? []).length,
        needsYouCount: (screen.match(/data-testid="cc-section-needs-you"/g) ?? []).length,
        primarySurface: /data-primary-surface="([A-Z_]+)"/.exec(screen)?.[1] ?? null,
        chatRole: /data-chat-role="([A-Z_]+)"/.exec(screen)?.[1] ?? null,
        headerBeforeCanvasBody: screen.indexOf('data-testid="cc-project-header"') < screen.indexOf('data-testid="cc-section-needs-you"'),
      },
      readModels: {
        changes: deriveWhatChanged(populatedSummary, NOW),
        changesRepeat: deriveWhatChanged(populatedSummary, NOW).map((item) => item.id),
        changesFromReversedInput: deriveWhatChanged(summary({ signals: [...SIGNALS].reverse() }), NOW).map((item) => item.id),
        changesEmpty: deriveWhatChanged(noSignalsSummary, NOW),
        changesUndefined: deriveWhatChanged(undefined, NOW),
        monitoring: deriveMonitoring(populatedSummary),
        monitoringEmpty: deriveMonitoring(undefined),
        chainIds: deriveExecutionChains(populatedSummary, NOW).map((chain) => ({ id: chain.id, decisionId: chain.decisionId, title: chain.title })),
        agentNames: deriveAgents(populatedSummary, false).map((agent) => agent.name),
      },
    },
    null,
    2
  )
);
