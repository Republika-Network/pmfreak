"use client";

import { useEffect, useMemo, useState } from "react";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import type { Agent, ChatMessage, DrawerContent, MemoryItem, NeedsYouItem, ProjectListItem, RepositoryItem } from "../../presentation/command-center/types";
import {
  deriveAgents,
  deriveAllGovernedAttention,
  deriveMonitoring,
  deriveNeedsYou,
  deriveRaidNeedsYou,
  deriveEvidenceOptions,
  deriveExecutionChains,
  deriveRepository,
  postOperationalFlow,
  postRaidActionDecision,
  nextProjectionDeadline,
  reconcileExecutionAttempts,
  runExecutionOperation,
  useOperationalFlow,
  useRaidRecommendedActions,
} from "../../presentation/command-center/operational-data";
import type { DecisionStatus } from "../../presentation/command-center/operational-data";
import { isBranchLive } from "../../presentation/command-center/execution-read-model";
import type { ExecutionOperation, GovernedExecutionChain } from "../../presentation/command-center/execution-read-model";
import { deriveWhatChanged } from "../../presentation/command-center/change-read-model";
import { deriveLastUpdatedLabel } from "../../presentation/command-center/activity-read-model";
import { assessAttentionCompleteness } from "../../presentation/command-center/attention-completeness";
import { chatMessagesToConversationTurns, conversationResultToAssistantMessage, postConversationMessage } from "../../presentation/command-center/conversation-data";
import { ProjectSidebar } from "../../presentation/command-center/project-sidebar";
import { CommandCenterCanvas } from "../../presentation/command-center/command-center-canvas";
import { CommandFeed } from "../../presentation/command-center/command-feed";
import { AgentDock } from "../../presentation/command-center/agent-dock";
import { DetailDrawer } from "../../presentation/command-center/detail-drawer";
import { VaultIntakePanel } from "../../presentation/command-center/vault-intake-panel";
import { CloseIcon } from "../../presentation/command-center/icons";
import { WorkspaceOnboardingPanel } from "@/components/pmfreak/onboarding/workspace-onboarding-panel";

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Default "remind me later" horizon for deferring a RAID-derived suggested action. */
function deferralDate(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

/** Memory categories backed by real operational records only — empty when nothing is recorded. */
function deriveMemory(data: OperationalSummary | undefined): MemoryItem[] {
  if (!data) return [];
  const decisions = data.decisions.length;
  const risks = data.risksIssues.length;
  const commitments = data.decisions.filter((d) => d.decision_status === "accepted").length;
  return [
    decisions > 0 ? { id: "decisions", label: `Decisions · ${decisions}` } : null,
    risks > 0 ? { id: "risks", label: `Risks · ${risks}` } : null,
    commitments > 0 ? { id: "commitments", label: `Commitments · ${commitments}` } : null,
  ].filter(Boolean) as MemoryItem[];
}

function buildRealMessages(project: ProjectListItem, needsYou: NeedsYouItem[]): ChatMessage[] {
  const welcome: ChatMessage = {
    id: "welcome",
    role: "assistant",
    content: `${project.fullName} is ready. I can help you review changes, spot risks, prepare updates, create tasks, or generate a project brief.`,
  };
  const topItems = needsYou.slice(0, 3).map((item) => item.title);
  if (topItems.length === 0) {
    return [welcome];
  }
  return [
    welcome,
    {
      id: "summary",
      role: "assistant",
      content:
        topItems.length === 1
          ? "One thing needs your attention right now."
          : `${topItems.length} things need your attention right now.`,
      structuredList: topItems,
    },
  ];
}

function MobileOverlay({ open, onClose, side, children }: { open: boolean; onClose: () => void; side: "left" | "right"; children: React.ReactNode }) {
  return (
    <div className={`fixed inset-0 z-30 xl:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div onClick={onClose} className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <div
        className={`absolute top-0 h-full w-72 max-w-[85vw] bg-[#0a0a0d] shadow-2xl transition-transform duration-200 ${
          side === "left" ? `left-0 ${open ? "translate-x-0" : "-translate-x-full"}` : `right-0 ${open ? "translate-x-0" : "translate-x-full"}`
        }`}
      >
        <div className="flex justify-end p-2">
          <button type="button" onClick={onClose} aria-label="Close panel" className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="h-[calc(100%-2.5rem)] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function CommandCenterLayout({
  workspaceName,
  workspaceId,
  projects,
  activeProjectId,
  hasBrief = false,
  onSelectProject,
  onEvidenceAdded,
}: {
  workspaceName: string;
  /** Real workspace id, used to load/record project evidence and decisions. */
  workspaceId: string;
  projects: ProjectListItem[];
  activeProjectId?: string;
  /** Whether a governance brief already exists for the active project (drives the Executive Briefing agent card). */
  hasBrief?: boolean;
  /** Called when the user picks a different project. Use this to navigate so the new
   *  project's server-scoped data (governance brief, etc.) is actually loaded — selecting
   *  a project only updates local UI state otherwise. */
  onSelectProject?: (id: string) => void;
  /** Called after new project evidence is added (e.g. to refresh the governance brief). */
  onEvidenceAdded?: () => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId ?? projects[0]?.id ?? "");

  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
    onSelectProject?.(id);
  };

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId]
  );

  const { data: flowData, error: flowError, mutate: mutateFlow, successGeneration } = useOperationalFlow(workspaceId, selectedProject?.id ?? "");
  const { data: raidActions, error: raidError, mutate: mutateRaidActions } = useRaidRecommendedActions(selectedProject?.id ?? "");
  const hasRealData = Boolean(flowData && flowData.evidence.length > 0);
  const flowLoading = flowData === undefined && !flowError;
  // SWR is given a null key when there is no project, and then never resolves. That is not
  // a pending read, so it must not read as one.
  const raidLoading = Boolean(selectedProject?.id) && raidActions === undefined && !raidError;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userInteracted, setUserInteracted] = useState(false);
  // Tracks whether the chat has been seeded from the first real operational-flow load for this
  // mount (a fresh mount — and fresh seeding — happens automatically whenever the active project
  // changes, since the page keys CommandCenterClient by projectId).
  const [seededFromFlowData, setSeededFromFlowData] = useState<typeof flowData>(undefined);

  if (!userInteracted && seededFromFlowData === undefined && flowData !== undefined && selectedProject) {
    setSeededFromFlowData(flowData);
    if (hasRealData) {
      setMessages(buildRealMessages(selectedProject, deriveNeedsYou(flowData, async () => {})));
    } else {
      // Honest first message: no invented findings, no fake sources — just the real state.
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content: `${selectedProject.fullName} has no recorded project data yet. Add your first notes and I'll start tracking risks, commitments, and decisions from them.`,
        },
      ]);
    }
  }

  // Ad-hoc drawers (chat sources, agent cards) are content snapshots. Canonical attention items
  // are addressed by their stable id instead, so an open drawer always re-reads the freshest
  // persisted state — that is what reconciles it when a decision lands or another actor decides.
  const [drawerContent, setDrawerContent] = useState<DrawerContent | null>(null);
  const [openAttentionId, setOpenAttentionId] = useState<string | null>(null);
  /** P2-12: the canonical Decision whose governed chain is open in the drawer. */
  const [openChainId, setOpenChainId] = useState<string | null>(null);
  /** A governed write committed but the follow-up summary read did not. The work is saved;
   *  only this surface's view of it is stale. Never rendered as a write failure.
   *
   *  Holds the success generation observed at the moment of failure, so the condition can
   *  be retired by a CONFIRMED later revalidation — SWR's interval and focus revalidation
   *  recover on their own, and a warning that outlives the problem is its own inaccuracy. */
  const [staleSinceGeneration, setStaleSinceGeneration] = useState<number | null>(null);
  const refreshFailedAfterWrite = staleSinceGeneration !== null && successGeneration <= staleSinceGeneration;

  /** Server-anchored clock for deadline-sensitive projections.
   *
   *  `generatedAt` is the server's own reading at load; elapsed time since then is measured
   *  locally, inside effects only — render stays pure and never reads a clock or a ref.
   *  This decides only WHEN the surface recomputes and what it offers, never whether an
   *  operation is allowed, which stays server-validated (see the P2-06 window). */
  const [projectionFloor, setProjectionFloor] = useState<number>(() => Date.now());
  const [leftOpen, setLeftOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  /** Chat is the copilot layer: present on every screen, expanded only on demand. The
   *  transcript lives in `messages` above and survives collapsing — this flag governs
   *  visibility, never conversation state. */
  const [chatOpen, setChatOpen] = useState(false);

  /** Records a canonical Decision. Rejects on failure so the drawer keeps the rationale, stays
   *  open and shows the error — never an optimistic success. The status posted is a canonical
   *  `operational_decision_records` status; no UI-only status is invented or remapped here. */
  const handleDecide = async (recommendationId: string, decisionStatus: string, rationale: string) => {
    await postOperationalFlow(workspaceId, selectedProject?.id ?? "", {
      operation: "record_decision",
      recommendationId,
      decisionStatus,
      decision: `Recommendation ${decisionStatus.replaceAll("_", " ")} by an authorized reviewer.`,
      rationale,
    });
    // The rendered result comes from persisted server state, not from the request payload.
    await mutateFlow();
  };

  // Triage for RAID-derived suggestions: accepting/rejecting/deferring goes through
  // /api/recommended-actions/decision (these are bounded, ungoverned suggestions — the governed
  // operational-flow recommendations above use record_decision and write a different table).
  const handleRaidDecide = async (actionId: string, status: DecisionStatus, reason: string) => {
    await postRaidActionDecision({
      actionId,
      decision: status,
      reason: reason || `Suggested action ${status} from the Command Center.`,
      ...(status === "deferred" ? { deferredUntil: deferralDate() } : {}),
    });
    await Promise.all([mutateRaidActions(), mutateFlow()]);
    onEvidenceAdded?.();
  };

  const needsYouReal = useMemo(() => deriveNeedsYou(flowData, handleDecide), [flowData]); // eslint-disable-line react-hooks/exhaustive-deps
  const governedAttentionAll = useMemo(() => deriveAllGovernedAttention(flowData, handleDecide), [flowData]); // eslint-disable-line react-hooks/exhaustive-deps
  const raidNeedsYou = useMemo(() => deriveRaidNeedsYou(raidActions, handleRaidDecide), [raidActions]); // eslint-disable-line react-hooks/exhaustive-deps
  // P2-12: governed chains that continue past a recorded Decision, plus the canonical
  // evidence a PM may cite when recording an Observation.
  /** Pure: the later of the server's own reading for this payload and the last deadline
   *  this surface has already crossed. No clock is read during render. */
  const projectionNow = useMemo(() => {
    const generatedAt = flowData?.generatedAt ? Date.parse(flowData.generatedAt) : Number.NaN;
    return new Date(Math.max(Number.isFinite(generatedAt) ? generatedAt : 0, projectionFloor));
  }, [flowData, projectionFloor]);
  const executionChains = useMemo(() => deriveExecutionChains(flowData, projectionNow), [flowData, projectionNow]);
  const evidenceOptions = useMemo(() => deriveEvidenceOptions(flowData, projectionNow), [flowData, projectionNow]);
  // One wake-up at the next deadline, then the next — never a polling loop. When nothing is
  // pending, no timer exists at all. Waking advances the projection clock to just past the
  // deadline that fired, so the recomputation is deterministic rather than clock-sampled.
  useEffect(() => {
    const next = nextProjectionDeadline(flowData, executionChains, projectionNow);
    if (next === null) return;
    // The wait is measured on the local clock; the VALUE the projection then adopts is the
    // server-side deadline instant. So client skew can only shift when this surface
    // recomputes, never what it concludes — and never whether a write is accepted, which
    // the server decides regardless.
    const delay = Math.min(Math.max(0, next - Date.now()) + 1000, 2 ** 31 - 1);
    const timer = setTimeout(() => setProjectionFloor(next + 1000), delay);
    return () => clearTimeout(timer);
  }, [flowData, executionChains, projectionNow]);
  // A submission whose response was lost still landed. Retire its pending attempt from the
  // server's own persisted idempotency key, so a later honest re-submission is recorded as
  // its own event instead of colliding with the row that attempt already wrote.
  useEffect(() => {
    reconcileExecutionAttempts(workspaceId, selectedProject?.id ?? "", executionChains);
  }, [workspaceId, selectedProject?.id, executionChains]);

  const repositoryReal = useMemo(() => deriveRepository(flowData), [flowData]);
  const agentsReal = useMemo(() => deriveAgents(flowData, hasBrief), [flowData, hasBrief]);
  // "What changed" and "PMFreak is monitoring" are re-projections of the SAME payload the
  // queues above already read — `data.signals`, and the signal families `deriveAgents`
  // already groups. No additional request, no new intelligence, no new backend derivation.
  const changes = useMemo(() => deriveWhatChanged(flowData, projectionNow), [flowData, projectionNow]);
  const monitoring = useMemo(() => deriveMonitoring(flowData), [flowData]);
  const memoryReal = useMemo(() => deriveMemory(flowData), [flowData]);
  // Reads every collection of persisted records the summary carries, including everything
  // downstream of a Decision. Deliberately NOT given `projectionNow`: that value is floored
  // on the browser's clock, and a client running fast would then accept persisted timestamps
  // the server considers to be in the future. Both the ceiling and the "ago" baseline come
  // from the server's own reading inside the payload.
  const lastUpdatedLabel = useMemo(() => deriveLastUpdatedLabel(flowData), [flowData]);

  // Real data or nothing: sections render honest empty states instead of fixtures.
  // RAID-derived suggestions are real extracted intelligence, so they show even
  // when the evidence chain is still empty.
  const needsYouItems = [...(hasRealData ? needsYouReal : []), ...raidNeedsYou];
  const repositoryItems = repositoryReal;
  const agentItems = hasRealData ? agentsReal : [];

  /**
   * Needs You is fed by two independent reads, so its completeness is a property of BOTH.
   * The governed path and the RAID suggestion path stay separate business objects with
   * separate write paths — only the question "have we heard from everything?" is combined.
   */
  /**
   * The governed source proves its own completeness against the project-wide open count.
   *
   * The operational flow request finishing is not the same fact as "we have every governed
   * item that needs you". `governedAttentionComplete` is the server's comparison of what it
   * loaded against `assurance.openRecommendations`; when it is false there are open
   * Recommendations this page has not got, and the surface must not state a total or say
   * the PM is clear.
   */
  const governedAttentionPartial = flowData !== undefined && flowData.governedAttentionComplete === false;
  const governedAttentionTotal = flowData?.governedAttentionTotal ?? null;

  const attention = assessAttentionCompleteness([
    { label: "governed recommendations", loading: flowLoading, failed: Boolean(flowError), partial: governedAttentionPartial },
    { label: "suggested actions", loading: raidLoading, failed: Boolean(raidError) },
  ]);
  // Either attention read failing is an attention failure. It is reported as one rather
  // than allowed to become a reassuring empty state.
  const attentionErrorMessage = attention.failed ? "We couldn't load project attention." : null;
  // Project ACTIVITY — what changed, what is in progress, what is being monitored — comes
  // only from the operational flow, so a failed suggestion read must not make those three
  // sections claim they failed.
  const activityErrorMessage = flowError ? "We couldn't load project attention." : null;
  // A header must not answer "how much needs me?" with a number it does not have. Only a
  // COMPLETE read produces a count; a successful read of zero is a real answer and is
  // stated as one.
  const needsYouCount = attention.complete ? needsYouItems.length : null;
  // Shown beneath an empty attention queue. Built from the real monitored families, and
  // only once this project actually has evidence for PMFreak to read — otherwise "clear"
  // would be paired with a claim that something is watching, which nothing is yet.
  const monitoringNote = hasRealData
    ? `PMFreak is still monitoring ${monitoring.areas.map((area) => area.label.toLowerCase()).join(", ")}.`
    : null;

  const handleSendMessage = (text: string) => {
    setUserInteracted(true);
    setChatOpen(true);
    const userMessage: ChatMessage = { id: nextId("user"), role: "user", content: text };
    let historyForGateway: ChatMessage[] = [];
    setMessages((current) => {
      const next = [...current, userMessage];
      historyForGateway = next;
      return next;
    });

    void postConversationMessage({
      message: text,
      workspaceId,
      activeProjectId: selectedProject?.id,
      activeProjectName: selectedProject?.fullName,
      conversationHistory: chatMessagesToConversationTurns(historyForGateway),
    })
      .then((result) => {
        setMessages((current) => [...current, conversationResultToAssistantMessage(nextId("assistant"), result)]);
      })
      .catch(() => {
        setMessages((current) => [
          ...current,
          {
            id: nextId("assistant"),
            role: "assistant",
            content: "Sorry — I couldn't process that just now. Please try again in a moment.",
          },
        ]);
      });
  };

  // Suggested-action chips post the action through the real gateway — no faked
  // "starting on..." confirmation for work nothing is actually doing.
  const handleActionClick = (action: string) => {
    handleSendMessage(action);
  };

  /**
   * One drawer at a time.
   *
   * `activeDrawer` resolves `openChainId` before `openAttentionId` before `drawerContent`,
   * so any selection that leaves a higher-precedence id set would be masked by it and the
   * click would look unresponsive. Every selection path therefore goes through this
   * helper, which clears the two it is not, instead of each handler remembering to.
   */
  const selectDrawer = (next: { chainId?: string | null; attentionId?: string | null; content?: DrawerContent | null }) => {
    setOpenChainId(next.chainId ?? null);
    setOpenAttentionId(next.attentionId ?? null);
    setDrawerContent(next.content ?? null);
  };

  const handleSourceClick = (source: string) => {
    selectDrawer({ content: {
      title: source,
      why: "This source was used to help answer your question.",
      evidence: [source],
      nextStep: "Open the source to see the full context.",
    } });
  };

  const handleTopBarSourceClick = (source: RepositoryItem) => {
    selectDrawer({ content: {
      title: source.label,
      why: "This is one of the sources of truth currently attached to this conversation.",
      evidence: [`${source.count ?? 0} ${source.label.toLowerCase()} recorded for this project`],
      nextStep: "Open the project repository to review these in full.",
    } });
  };

  // Canonical/RAID items open by stable id; everything else falls back to a content snapshot.
  const handleNeedsYouSelect = (item: NeedsYouItem) => {
    selectDrawer({ attentionId: item.id });
  };
  const handleAgentSelect = (agent: Agent) => {
    selectDrawer({ content: agent.drawer });
  };
  const closeDrawer = () => {
    selectDrawer({});
  };

  /**
   * P2-12 — the authoritative request runs first, and only then does the surface revalidate.
   *
   * These are two separate facts and must not be collapsed:
   *
   *   CANONICAL WRITE SUCCESS  !=  POST-WRITE READ REFRESH SUCCESS
   *
   * The refresh is its own request against a summary the write already committed to. If it
   * fails — offline, a slow gateway, a transient 5xx — the canonical row still exists.
   * Reporting that as an operation failure tells the PM their governed Action or Observation
   * did not happen when it did, and invites them to submit it again.
   *
   * So only a rejection from the write itself propagates. A refresh failure surfaces as a
   * read-side condition instead, and the durable submission attempt deliberately survives
   * it (it is marked acknowledged, not retired), so if the PM does resubmit, the same
   * idempotency identity reconciles to the row already written rather than appending a
   * second one. The next successful revalidation retires the attempt from persisted state.
   */
  const handleRunExecution = async (operation: ExecutionOperation) => {
    await runExecutionOperation(workspaceId, selectedProject?.id ?? "", operation);
    setStaleSinceGeneration(null);
    try {
      await mutateFlow();
    } catch {
      setStaleSinceGeneration(successGeneration);
    }
  };

  const handleChainSelect = (chain: GovernedExecutionChain) => {
    selectDrawer({ chainId: chain.decisionId });
  };

  /** Builds the drawer for a governed chain, resolved fresh so it reconciles after each write.
   *  The summary rows describe the branch the chain currently speaks for; every other
   *  canonical Action stays rendered in full inside the panel below. */
  const buildChainDrawer = (chain: GovernedExecutionChain): DrawerContent => {
    const leading =
      chain.branches.find((branch) => branch.boundary.outcomeAchieved) ??
      chain.branches.find((branch) => isBranchLive(branch)) ??
      chain.branches[0] ??
      null;
    const actionValue = leading
      ? `${leading.action.governanceState.replaceAll("_", " ")}${leading.action.expired ? " (expired)" : ""} · ${leading.action.actionId}` +
        (chain.branches.length > 1 ? ` · ${chain.branches.length} actions on this decision` : "")
      : "Not requested";
    return {
      title: chain.title,
      why: chain.rationale ?? "A human decision was recorded for this recommendation.",
      evidence: leading?.action.evidenceReferenceIds ?? [],
      nextStep: chain.boundary.statement,
      badge: { tone: chain.status.tone, label: `Governed · ${chain.status.label}` },
      kindSummary: "The governed chain that follows your recorded decision.",
      chain: [
        { label: "Decision", value: `${chain.decisionStatus.replaceAll("_", " ")} · ${chain.decisionId}` },
        { label: "Material action", value: actionValue },
        { label: "Task", value: leading?.task ? `${leading.task.status.replaceAll("_", " ")} · ${leading.task.taskId}` : "Not created" },
        { label: "Execution", value: leading?.latestExecution ? `${leading.latestExecution.status.replaceAll("_", " ")} · ${leading.latestExecution.executionId}` : "Not started" },
        { label: "Expected outcome", value: leading?.outcome ? `${leading.outcome.state.replaceAll("_", " ")} · ${leading.outcome.outcomeId}` : "Not defined" },
        {
          label: "Observation",
          value: leading && leading.observations.length > 0
            ? `${leading.observations[0].observationState.replaceAll("_", " ")} · ${leading.observations[0].observationId}`
            : "None recorded",
        },
      ],
      executionPanel: {
        chain,
        evidenceOptions,
        onRun: handleRunExecution,
        refreshFailedAfterWrite,
        onRetryRefresh: () => {
          void mutateFlow()
            .then(() => setStaleSinceGeneration(null))
            .catch(() => setStaleSinceGeneration(successGeneration));
        },
      },
    };
  };

  // Resolved fresh on every render: once a decision is persisted and the summary revalidates,
  // the open drawer shows the recorded Decision and drops the now-unavailable controls.
  const activeDrawer = openChainId
    ? (() => {
        const chain = executionChains.find((entry) => entry.decisionId === openChainId);
        return chain ? buildChainDrawer(chain) : null;
      })()
    : openAttentionId
      ? ([...governedAttentionAll, ...raidNeedsYou].find((item) => item.id === openAttentionId)?.drawer ?? null)
      : drawerContent;

  const handleIntakeComplete = (summary: string) => {
    setUserInteracted(true);
    setMessages((current) => [...current, { id: nextId("assistant"), role: "assistant", content: summary }]);
    void mutateFlow();
    void mutateRaidActions();
    onEvidenceAdded?.();
  };

  if (!selectedProject) return null;

  return (
    <div
      data-build="command-center-light-v2"
      data-shell="pmfreak-light-command-center"
      className="overflow-hidden rounded-[28px] border border-white/10 bg-[#0a0a0d] shadow-[0_40px_90px_-60px_rgba(0,0,0,0.7)]"
    >
      <div className="flex min-h-[600px] xl:h-[calc(100vh-190px)]">
        <aside className="hidden w-[280px] shrink-0 border-r border-white/10 bg-white/[0.015] xl:block">
          <ProjectSidebar
            workspaceName={workspaceName}
            projects={projects}
            selectedProjectId={selectedProject.id}
            onSelectProject={handleSelectProject}
            repository={repositoryItems}
            memory={memoryReal}
            onAddNotes={() => setNotesOpen(true)}
          />
        </aside>

        {/*
         * The attention-first canvas IS the main region. Everything a PM opens this screen
         * to know — what needs them, what changed, what is under way, what is being watched
         * — is in the document itself, in that order, on every viewport. The conversation
         * is the last section, collapsed until asked for.
         */}
        <main className="flex min-w-0 flex-1 flex-col">
          <CommandCenterCanvas
            project={selectedProject}
            sources={repositoryItems}
            lastUpdatedLabel={lastUpdatedLabel}
            onOpenProjects={() => setLeftOpen(true)}
            onSourceClick={handleTopBarSourceClick}
            onAttach={() => setNotesOpen(true)}
            needsYouItems={needsYouItems}
            needsYouCount={needsYouCount}
            onSelectNeedsYou={handleNeedsYouSelect}
            attentionLoading={attention.loading}
            attentionIncomplete={attention.partial}
            attentionErrorMessage={attentionErrorMessage}
            attentionIncompleteNote={
              // A known-partial governed read gets the server's own numbers, so the PM is
              // told how much of the answer they are looking at rather than a vague caveat.
              governedAttentionPartial && !attention.failed && governedAttentionTotal !== null
                ? `Showing ${needsYouItems.filter((item) => item.kind === "governed_recommendation").length} of ${governedAttentionTotal} governed items needing review.`
                : attention.loading && !attention.failed && needsYouItems.length > 0
                  ? `Still checking ${attention.unresolved.join(" and ")}.`
                  : null
            }
            onRetryAttention={() => {
              void mutateFlow();
              void mutateRaidActions();
            }}
            onAddNotes={() => setNotesOpen(true)}
            monitoringNote={monitoringNote}
            changes={changes}
            chains={executionChains}
            onSelectChain={handleChainSelect}
            monitoring={monitoring}
            monitoringActive={hasRealData}
            agentDetail={
              <AgentDock agents={agentItems} onSelect={handleAgentSelect} loading={flowLoading} onAddContext={() => setNotesOpen(true)} />
            }
            chatOpen={chatOpen}
            onToggleChat={setChatOpen}
            chatMessageCount={messages.length}
            chat={
              <CommandFeed
                messages={messages}
                onSendMessage={handleSendMessage}
                onSourceClick={handleSourceClick}
                onActionClick={handleActionClick}
                onOpenNotes={() => setNotesOpen((v) => !v)}
              />
            }
            activityLoading={flowLoading}
            activityErrorMessage={activityErrorMessage}
            intakeSlot={
              notesOpen ? (
                <div className="border-b border-white/10 p-4">
                  <VaultIntakePanel
                    workspaceId={workspaceId}
                    projectId={selectedProject.id}
                    onClose={() => setNotesOpen(false)}
                    onIntakeComplete={handleIntakeComplete}
                  />
                </div>
              ) : null
            }
            footerSlot={<WorkspaceOnboardingPanel surface="dashboard" />}
          />
        </main>
      </div>

      {/* Project navigation may live behind an overlay on a small screen; attention content
          never does — it is in the main document flow above, at every width. */}
      <MobileOverlay open={leftOpen} onClose={() => setLeftOpen(false)} side="left">
        <ProjectSidebar
          workspaceName={workspaceName}
          projects={projects}
          selectedProjectId={selectedProject.id}
          onSelectProject={(id) => {
            handleSelectProject(id);
            setLeftOpen(false);
          }}
          repository={repositoryItems}
          memory={memoryReal}
          onAddNotes={() => {
            setNotesOpen(true);
            setLeftOpen(false);
          }}
        />
      </MobileOverlay>

      <DetailDrawer content={activeDrawer} onClose={closeDrawer} />
    </div>
  );
}
