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
  deriveRaidNeedsYou,
  deriveAgents,
  type RaidRecommendedAction,
} from "../src/modules/workspace/presentation/command-center/operational-data";
import { projectChainProgress, classifyChainProgress } from "../src/modules/workspace/presentation/command-center/in-progress-read-model";
import { assessAttentionCompleteness } from "../src/modules/workspace/presentation/command-center/attention-completeness";
import { deriveLastUpdatedLabel, latestOperationalActivityAt } from "../src/modules/workspace/presentation/command-center/activity-read-model";
import { ExecutionQueue } from "../src/modules/workspace/presentation/command-center/execution-queue";
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
      attentionLoading={false}
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
      activityLoading={false}
      activityErrorMessage={null}
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
  activityErrorMessage: "We couldn't load project attention.",
  activityLoading: false,
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


// ── W2-P1-01: chain-progress fixtures ────────────────────────────────────────
//
// The original W2 fixture carried one non-terminal post-decision chain, which is exactly
// the case that CANNOT reveal the defect: every chain in it was genuinely in progress. So
// this builds one summary holding six Decisions, one per canonical outcome of the chain
// projection, and asserts what the rendered "In Progress" list actually contains.

const PROGRESS_NOW = new Date("2026-08-17T12:00:00.000Z");
const PROGRESS_ACTOR = "actor-pm";

const progressRecommendations = [
  { id: "prec-live", recommendation: "LIVE work under way" },
  { id: "prec-noaction", recommendation: "DECIDED with no action" },
  { id: "prec-expired", recommendation: "EXPIRED authorization" },
  { id: "prec-rejected", recommendation: "REJECTED decision" },
  { id: "prec-achieved", recommendation: "ACHIEVED outcome" },
  { id: "prec-superseded", recommendation: "SUPERSEDED outcome" },
];

const progressDecision = (id: string, recommendationId: string, status = "accepted") => ({
  id,
  decision_status: status,
  decided_by: PROGRESS_ACTOR,
  recommendation_id: recommendationId,
  rationale: "W2 chain-progress fixture",
  created_at: "2026-08-17T10:00:00Z",
});

const progressAction = (id: string, decisionId: string, over: Record<string, unknown> = {}) => ({
  id,
  source_decision_id: decisionId,
  proposed_by: PROGRESS_ACTOR,
  action_class: "external_write",
  materiality: "material",
  proposal_digest: "sha256:abcdef0123456789abcdef",
  correlation_id: `corr-${id}`,
  causation_id: decisionId,
  proposal: { actionType: "governed_project_change", evidenceReferenceIds: ["ev-1"] },
  created_at: "2026-08-17T10:02:00Z",
  persisted_at: "2026-08-17T10:02:00Z",
  expires_at: "2026-08-17T13:00:00Z",
  ...over,
});

const progressEvaluation = (actionId: string, over: Record<string, unknown> = {}) => ({
  action_id: actionId,
  governance_state: "authorized",
  can_commit_action: true,
  can_execute: false,
  evaluated_at: "2026-08-17T10:05:00Z",
  valid_until: "2026-08-17T13:00:00Z",
  policy_decision_reference: "pmfreak-governance-event:gov-1",
  grant_references: [`workspace-role-grant:owner:${PROGRESS_ACTOR}`],
  ...over,
});

const progressTask = (id: string, actionId: string, over: Record<string, unknown> = {}) => ({
  id,
  title: "Governed task",
  status: "in_progress",
  created_at: "2026-08-17T10:10:00Z",
  completed_at: null,
  source_payload: { source: "governed_action", sourceActionId: actionId },
  ...over,
});

const progressExecution = (id: string, taskId: string, actionId: string, over: Record<string, unknown> = {}) => ({
  id,
  task_id: taskId,
  source_action_id: actionId,
  status: "completed",
  attempt_count: 1,
  provider_key: "pmfreak/internal-state-machine:v1",
  dispatched_by: PROGRESS_ACTOR,
  queued_at: "2026-08-17T10:11:00Z",
  started_at: "2026-08-17T10:12:00Z",
  completed_at: "2026-08-17T10:20:00Z",
  ...over,
});

const progressOutcome = (id: string, taskId: string, actionId: string, state: string) => ({
  id,
  task_id: taskId,
  source_action_id: actionId,
  internal_execution_id: `exec-${taskId}`,
  state,
  expected_result: "The client confirms the revised scope in writing.",
});

const progressSummary: OperationalSummary = {
  generatedAt: PROGRESS_NOW.toISOString(),
  sources: [],
  rawInputs: [],
  normalizedEvents: [],
  evidence: [{ id: "ev-1", title: "Client confirmation email" }],
  signals: [],
  risksIssues: [],
  governanceEvents: [],
  recommendations: progressRecommendations,
  decisions: [
    progressDecision("dec-live", "prec-live"),
    progressDecision("dec-noaction", "prec-noaction"),
    progressDecision("dec-expired", "prec-expired"),
    progressDecision("dec-rejected", "prec-rejected", "rejected"),
    progressDecision("dec-achieved", "prec-achieved"),
    progressDecision("dec-superseded", "prec-superseded"),
  ],
  evidenceLinks: [],
  materialActions: [
    progressAction("act-live", "dec-live"),
    // Authorization window closed before NOW: no new work may be dispatched against it.
    progressAction("act-expired", "dec-expired", { expires_at: "2026-08-17T11:00:00Z" }),
    progressAction("act-achieved", "dec-achieved"),
    progressAction("act-superseded", "dec-superseded"),
  ],
  materialActionEvaluations: [
    progressEvaluation("act-live"),
    progressEvaluation("act-expired"),
    progressEvaluation("act-achieved"),
    progressEvaluation("act-superseded"),
  ],
  tasks: [
    progressTask("task-live", "act-live"),
    progressTask("task-achieved", "act-achieved", { status: "completed", completed_at: "2026-08-17T10:20:00Z" }),
    progressTask("task-superseded", "act-superseded", { status: "completed", completed_at: "2026-08-17T10:20:00Z" }),
  ],
  executions: [
    progressExecution("exec-task-live", "task-live", "act-live", { status: "running", completed_at: null }),
    progressExecution("exec-task-achieved", "task-achieved", "act-achieved"),
    progressExecution("exec-task-superseded", "task-superseded", "act-superseded"),
  ],
  outcomes: [
    progressOutcome("out-achieved", "task-achieved", "act-achieved", "achieved"),
    progressOutcome("out-superseded", "task-superseded", "act-superseded", "superseded"),
  ],
  observations: [],
  lineages: [],
  assurance: {} as OperationalSummary["assurance"],
  actor: { role: "owner", userId: PROGRESS_ACTOR, canCreateEvidence: true },
};

const progressChains = deriveExecutionChains(progressSummary, PROGRESS_NOW);
const progressGroups = projectChainProgress(progressChains);
const progressQueueMarkup = renderToStaticMarkup(<ExecutionQueue chains={progressChains} onSelect={noop} />);

/** The chain titles rendered under a given test id, in document order. */
function titlesFor(markup: string, testId: string): string[] {
  return [...markup.matchAll(new RegExp(`data-testid="${testId}"[\\s\\S]*?<span class="block truncate text-sm[^"]*">([^<]*)<`, "g"))].map((m) => m[1]);
}

// ── W2-P1-02: attention completeness scenarios ───────────────────────────────
//
// Mirrors exactly how the screen binds completeness to the canvas, so the four scenarios
// below are the ones a PM would really see.

const RAID_ACTION: RaidRecommendedAction = {
  id: "raid-1",
  raid_item_id: "raid-item-1",
  title: "Confirm the integration owner",
  description: "The notes mention an unowned integration dependency.",
  recommended_action_type: "clarify_dependency",
  status: "proposed",
  confidence_score: 0.8,
  impact_level: "medium",
  recommended_owner: "Delivery lead",
  recommended_due_window: "this week",
  evidence_summary: { raidTitle: "Integration owner unknown", raidCategory: "dependency" },
  created_at: "2026-09-06T12:00:00.000Z",
};

function renderAttention(input: {
  flowLoading: boolean;
  flowFailed: boolean;
  raidLoading: boolean;
  raidFailed: boolean;
  governedItems: number;
}) {
  const attention = assessAttentionCompleteness([
    { label: "governed recommendations", loading: input.flowLoading, failed: input.flowFailed },
    { label: "suggested actions", loading: input.raidLoading, failed: input.raidFailed },
  ]);
  const data = input.governedItems > 0 ? populatedSummary : summary({ recommendations: [], risksIssues: [], governanceEvents: [] });
  const needsYouItems = input.flowFailed ? [] : deriveNeedsYou(data, noopDecide);
  const markup = renderCanvas(populatedSummary, {
    needsYouItems,
    needsYouCount: attention.complete ? needsYouItems.length : null,
    attentionLoading: attention.loading,
    attentionErrorMessage: attention.failed ? "We couldn't load project attention." : null,
    attentionIncompleteNote:
      attention.loading && !attention.failed && needsYouItems.length > 0
        ? `Still checking ${attention.unresolved.join(" and ")}.`
        : null,
  });
  return {
    completeness: attention,
    needsYou: section(markup, "cc-section-needs-you"),
    header: section(markup, "cc-project-header"),
  };
}

// ── W2-P1-03: header freshness ───────────────────────────────────────────────

const FRESHNESS_NOW = new Date("2026-09-06T12:00:00.000Z");

/** The review's own example: everything upstream is a day old; the newest real activity
 *  is an Observation two minutes ago and an execution five minutes ago. */
const downstreamActivitySummary = summary({
  evidence: [{ id: "ev-1", created_at: "2026-09-05T12:00:00.000Z", updated_at: "2026-09-05T12:00:00.000Z" }],
  signals: [],
  decisions: [{ id: "dec-1", decision_status: "accepted", created_at: "2026-09-05T12:00:00.000Z" }],
  executions: [{ id: "exec-1", task_id: "task-1", status: "completed", completed_at: "2026-09-06T11:55:00.000Z" }],
  observations: [{ id: "obs-1", outcome_id: "out-1", observation_state: "achieved", recorded_at: "2026-09-06T11:58:00.000Z" }],
});

/** Only unusable timestamps. Nothing here may become "now". */
const unusableTimestampSummary = summary({
  evidence: [{ id: "ev-1", created_at: null, updated_at: "not-a-date" }],
  signals: [],
  decisions: [{ id: "dec-1", decision_status: "accepted" }],
  executions: [],
  observations: [],
});

/** A human-entered `observed_at` in the future, and nothing else. "Updated in the future"
 *  is not an answer, so the header states no time at all. */
const futureOnlySummary = summary({
  evidence: [],
  signals: [],
  decisions: [],
  executions: [],
  observations: [{ id: "obs-1", outcome_id: "out-1", observation_state: "achieved", observed_at: "2027-01-01T00:00:00.000Z" }],
});

/** No records at all, but the summary itself was fetched just now. Fetch time is not
 *  project activity. */
const fetchedButEmptySummary = summary({
  generatedAt: FRESHNESS_NOW.toISOString(),
  evidence: [],
  signals: [],
  risksIssues: [],
  governanceEvents: [],
  recommendations: [],
  decisions: [],
  executions: [],
  observations: [],
});

/** The header rendered from the REAL derivation rather than a literal. */
const freshnessHeader = section(
  renderCanvas(downstreamActivitySummary, {
    lastUpdatedLabel: deriveLastUpdatedLabel(downstreamActivitySummary, FRESHNESS_NOW),
    needsYouCount: 0,
  }),
  "cc-project-header"
);


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
      chainProgress: {
        statuses: progressChains.map((chain) => ({
          decisionId: chain.decisionId,
          title: chain.title,
          statusLabel: chain.status.label,
          group: classifyChainProgress(chain),
        })),
        groups: {
          inProgress: progressGroups.inProgress.map((chain) => chain.decisionId),
          notProgressing: progressGroups.notProgressing.map((chain) => chain.decisionId),
          closed: progressGroups.closed.map((chain) => chain.decisionId),
        },
        rendered: {
          inProgressTitles: titlesFor(progressQueueMarkup, "cc-in-progress-item"),
          notProgressingTitles: titlesFor(progressQueueMarkup, "cc-not-progressing-item"),
          closedTitles: titlesFor(progressQueueMarkup, "cc-closed-chain-item"),
          headingCount: /In Progress\s*<\/h2>\s*<span[^>]*>(\d+)<\/span>/.exec(progressQueueMarkup)?.[1] ?? null,
          closedDetailsTag: (() => {
            const at = progressQueueMarkup.indexOf('data-testid="cc-closed-chains"');
            return at < 0 ? null : progressQueueMarkup.slice(progressQueueMarkup.lastIndexOf("<details", at), at + 60);
          })(),
          notProgressingGroupPresent: progressQueueMarkup.includes('data-testid="cc-not-progressing-group"'),
          markup: progressQueueMarkup,
        },
      },
      attentionCompleteness: {
        // A) flow success with zero governed items, RAID still loading.
        raidLoading: renderAttention({ flowLoading: false, flowFailed: false, raidLoading: true, raidFailed: false, governedItems: 0 }),
        // B) flow success with zero governed items, RAID failed.
        raidFailed: renderAttention({ flowLoading: false, flowFailed: false, raidLoading: false, raidFailed: true, governedItems: 0 }),
        // C) governed items known, RAID still loading.
        governedKnownRaidLoading: renderAttention({ flowLoading: false, flowFailed: false, raidLoading: true, raidFailed: false, governedItems: 1 }),
        // D) both resolved successfully, both empty.
        bothComplete: renderAttention({ flowLoading: false, flowFailed: false, raidLoading: false, raidFailed: false, governedItems: 0 }),
        raidItemsAreStillTheirOwnKind: deriveRaidNeedsYou([RAID_ACTION], async () => {}).map((item) => item.kind),
      },
      headerFreshness: {
        downstreamLatest: latestOperationalActivityAt(downstreamActivitySummary, FRESHNESS_NOW),
        downstreamLabel: deriveLastUpdatedLabel(downstreamActivitySummary, FRESHNESS_NOW),
        unusableLatest: latestOperationalActivityAt(unusableTimestampSummary, FRESHNESS_NOW),
        unusableLabel: deriveLastUpdatedLabel(unusableTimestampSummary, FRESHNESS_NOW),
        futureOnlyLatest: latestOperationalActivityAt(futureOnlySummary, FRESHNESS_NOW),
        fetchedButEmptyLatest: latestOperationalActivityAt(fetchedButEmptySummary, FRESHNESS_NOW),
        renderedHeader: text(freshnessHeader),
      },
    },
    null,
    2
  )
);
