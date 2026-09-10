"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DERIVED_LENS_METADATA } from "@/lib/workspace/derived-lens-metadata";
import { NAVIGATION_HIERARCHY } from "@/lib/workspace/navigation-hierarchy";
import {
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  navEntryMatchesPathname,
  workspaceCommandCenterPath,
} from "@/lib/workspace/command-center-paths";
import { AdvancedDrawer } from "@/components/pmfreak/navigation/advanced-drawer";
import { SidebarPmoTree } from "@/components/pmfreak/navigation/sidebar-pmo-tree";
import { computeCapabilityRevealState, computeNavigationRail } from "@/features/runtime/capability-reveal/capability-reveal-selectors";
import { AWAKENING_EVENT, isLensUnlocked, loadAwakeningState, deriveAwakeningState, type AwakeningState } from "@/lib/workspace/awakening-state";
import type { CapabilityProfile } from "@/lib/workspace/pilot-capability-set";

type UserProject = { id: string; name: string };
type DiscoverySummary = {
  version: number;
  stakeholders_json?: unknown[];
  dependencies_json?: unknown[];
  risks_json?: unknown[];
  milestones_json?: unknown[];
  deliverables_json?: unknown[];
  unknowns_json?: unknown[];
  confidence_score?: number | string;
};
type RecommendedAction = {
  id: string;
  title: string;
  recommended_action_type: string;
  impact_level: string | null;
  confidence_score: number | string;
  status: string;
  decision_reason?: string | null;
  decided_at?: string | null;
  deferred_until?: string | null;
  evidence_summary?: { raidCategory?: string; raidItemId?: string } | null;
};

type TaskDraft = {
  id: string;
  title: string;
  description: string;
  draft_status: string;
  priority: string;
  suggested_owner: string | null;
  suggested_due_window: string | null;
  suggested_due_date: string | null;
  acceptance_criteria: string[];
  checklist: string[];
  confidence_score: number | null;
  recommended_action_id: string;
  raid_item_id: string | null;
  source_payload: Record<string, unknown>;
};

type ExecutionTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  owner_name: string | null;
  due_date: string | null;
  completed_at: string | null;
  progress_percent: number;
  raid_item_id: string | null;
  recommended_action_id: string | null;
  task_draft_id: string;
  source_payload: Record<string, unknown>;
};

type ExecutionTaskDependency = {
  id: string;
  predecessor_task_id: string;
  successor_task_id: string;
  dependency_type: string;
  status: string;
  reason: string | null;
  confidence_score: number | null;
};

type ExecutionNetworkSummary = {
  totalTasks: number;
  totalDependencies: number;
  readyTasks: number;
  blockedTasks: number;
  completedTasks: number;
  proposedDependencies: number;
  activeDependencies: number;
  cycleRisk: boolean;
};

type ProjectMilestone = {
  id: string;
  title: string;
  milestone_type: string;
  status: string;
  target_date: string | null;
  forecast_date: string | null;
  completed_at: string | null;
  confidence_score: number | null;
};

type ScheduledTask = {
  id: string;
  title: string;
  status: string;
  planned_finish_date: string | null;
  forecast_finish_date: string | null;
  schedule_status: string;
  milestone_id: string | null;
};

type ScheduleHealth = {
  totalTasks: number;
  scheduledTasks: number;
  unscheduledTasks: number;
  delayedTasks: number;
  atRiskTasks: number;
  overdueTasks: number;
  dueSoonTasks: number;
  milestoneCount: number;
  blockedMilestones: number;
  atRiskMilestones: number;
  completedMilestones: number;
  scheduleConfidence: number;
  signals: Array<{ severity: string; code: string; message: string }>;
};

type OperationalShellProps = {
  children: React.ReactNode;
  user: { fullName: string; role: string; companyName: string };
  /** Pilot capability set (Task 7): resolved server-side; defaults to the curated pilot profile. */
  capabilityProfile?: CapabilityProfile;
  /**
   * Active workspace, resolved server-side by `(protected)/layout.tsx`, which
   * already computes it for the onboarding gate — so this costs no extra query.
   *
   * Optional on purpose: when it is absent the Command Center nav entry falls
   * back to the legacy `/command-center` entry point, which resolves the
   * workspace and redirects. The nav therefore degrades to one extra hop rather
   * than to a broken link.
   */
  workspaceId?: string;
};


export function OperationalShell({ children, user, capabilityProfile = "pilot", workspaceId }: OperationalShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<UserProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [discoverySummary, setDiscoverySummary] = useState<DiscoverySummary | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [recommendedActions, setRecommendedActions] = useState<RecommendedAction[]>([]);
  const [actionsFilter, setActionsFilter] = useState<string>("all");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [taskDraftPreview, setTaskDraftPreview] = useState<TaskDraft | null>(null);
  const [draftConvertingId, setDraftConvertingId] = useState<string | null>(null);
  const [draftActionError, setDraftActionError] = useState<string | null>(null);
  const [executionTasks, setExecutionTasks] = useState<ExecutionTask[]>([]);
  const [executionTasksFilter, setExecutionTasksFilter] = useState<string>("all");
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [taskActingId, setTaskActingId] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<ExecutionTaskDependency[]>([]);
  const [networkSummary, setNetworkSummary] = useState<ExecutionNetworkSummary | null>(null);
  const [depActionError, setDepActionError] = useState<string | null>(null);
  const [depActingId, setDepActingId] = useState<string | null>(null);
  const [showDepForm, setShowDepForm] = useState(false);
  const [depFormPred, setDepFormPred] = useState("");
  const [depFormSucc, setDepFormSucc] = useState("");
  const [depFormType, setDepFormType] = useState("finish_to_start");
  const [depFormReason, setDepFormReason] = useState("");
  const [scheduleMilestones, setScheduleMilestones] = useState<ProjectMilestone[]>([]);
  const [scheduleHealth, setScheduleHealth] = useState<ScheduleHealth | null>(null);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [showMilestoneForm, setShowMilestoneForm] = useState(false);
  const [milestoneFormTitle, setMilestoneFormTitle] = useState("");
  const [milestoneFormType, setMilestoneFormType] = useState("delivery");
  const [milestoneFormDate, setMilestoneFormDate] = useState("");
  const [milestoneActing, setMilestoneActing] = useState(false);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);
  const [criticalPathData, setCriticalPathData] = useState<{
    summary: { totalTasks: number; criticalTaskCount: number; criticalMilestoneCount: number; projectDurationDays: number; forecastVarianceDays: number; scheduleConfidence: number; criticalPathCount?: number; criticalComponentCount?: number; hasMultipleCriticalPaths?: boolean; hasCriticalBranches?: boolean };
    forecast: { plannedFinish: string | null; forecastFinish: string | null; varianceDays: number };
    criticalTasks: Array<{ taskId: string; title: string; totalFloat: number; freeFloat: number; earlyStart: number; earlyFinish: number; lateStart: number; lateFinish: number; criticalityScore: number; varianceDays: number }>;
    criticalMilestones: Array<{ milestoneId: string; title: string; targetDate: string | null; forecastDate: string | null; varianceDays: number; isCritical: boolean; isAtRisk: boolean; isDelayed: boolean }>;
    path: string[];
    topVarianceTasks: Array<{ taskId: string; title: string; plannedFinish: string | null; forecastFinish: string | null; varianceDays: number }>;
    criticalPaths?: Array<{ id: string; taskIds: string[]; length: number; startTaskId: string; endTaskId: string; isCompletePath: boolean }>;
    criticalSegments?: Array<{ id: string; taskIds: string[]; length: number; startTaskId: string; endTaskId: string; isCompletePath: boolean }>;
    branchPoints?: Array<{ taskId: string; outgoingCriticalSuccessors: string[]; incomingCriticalPredecessors: string[]; branchType: "split" | "merge" | "split_merge" }>;
  } | null>(null);
  const [cpMaterializeLoading, setCpMaterializeLoading] = useState(false);
  const [cpMaterializeError, setCpMaterializeError] = useState<string | null>(null);

  type PortfolioData = {
    summary: {
      projectCount: number;
      activeProjectCount: number;
      blockedProjectCount: number;
      delayedProjectCount: number;
      criticalProjectCount: number;
      portfolioHealthScore: number;
      portfolioRiskScore: number;
      criticalPathProjectCount: number;
      overdueTaskCount: number;
      blockedTaskCount: number;
      unresolvedRaidCount: number;
      lastUpdatedAt: string;
    };
    projects: Array<{
      projectId: string;
      projectName: string;
      healthScore: number;
      riskScore: number;
      blockedTaskCount: number;
      overdueTaskCount: number;
      criticalTaskCount: number;
      criticalPathLength: number;
      unresolvedRaidCount: number;
      scheduleVarianceDays: number;
      requiresExecutiveAttention: boolean;
    }>;
    bottlenecks: Array<{
      entityType: string;
      entityId: string;
      entityLabel: string;
      blockingCount: number;
      impactScore: number;
    }>;
    dependencyRisks: Array<{
      sourceProjectId: string;
      targetProjectId: string;
      dependencyCount: number;
      riskLevel: string;
    }>;
    executiveAttention: Array<{
      projectId: string;
      projectName: string;
      healthScore: number;
      riskScore: number;
      blockedTaskCount: number;
      overdueTaskCount: number;
      criticalTaskCount: number;
      criticalPathLength: number;
      unresolvedRaidCount: number;
      scheduleVarianceDays: number;
      requiresExecutiveAttention: boolean;
    }>;
  };
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);

  const initializedRef = useRef(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [awakening, setAwakening] = useState<AwakeningState>(() => loadAwakeningState("", ""));

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<AwakeningState>).detail;
      if (next) setAwakening(next);
    };
    window.addEventListener(AWAKENING_EVENT, handler);
    return () => window.removeEventListener(AWAKENING_EVENT, handler);
  }, []);

  // Mobile "More". The mobile strip used to render the primary rail and nothing else, so
  // every supporting surface — and every unlocked advanced one — was desktop-only. It now
  // reads the same `utilityNav`/`advancedNav` arrays the desktop rail does.
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const fromQuery = new URLSearchParams(window.location.search).get("projectId") ?? "";
    const fromStorage = window.localStorage.getItem("pmfreak.currentProjectId") ?? "";
    return fromQuery || fromStorage;
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setProjectsLoading(true);
      setProjectsError(null);
      try {
        // Scope the switcher to the workspace this shell is rendering. Without
        // it the list comes back from the preferred-workspace cookie, so a
        // canonical deep link shows one workspace's Command Center wrapped in
        // another workspace's projects.
        const res = await fetch(
          workspaceId ? `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/projects",
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { projects?: UserProject[] };
        if (active) setProjects(data.projects ?? []);
      } catch {
        if (active) {
          setProjects([]);
          setProjectsError("Project list unavailable — continue in portfolio scope.");
        }
      } finally {
        if (active) setProjectsLoading(false);
      }
    }
    void load();
    return () => { active = false; };
    // Refetch when the rendered workspace changes: navigating between two
    // workspaces' Command Centers must reload the switcher, not keep showing the
    // first workspace's projects.
  }, [workspaceId]);

  useEffect(() => {
    if (projectId) globalThis.localStorage?.setItem("pmfreak.currentProjectId", projectId);
  }, [projectId]);

  // Once projects finish loading: clean stale localStorage and hydrate URL from stored id.
  // Skip on network error — a failed fetch must not incorrectly invalidate a valid stored context.
   
  useEffect(() => {
    if (projectsLoading || initializedRef.current) return;
    if (projectsError) return;
    initializedRef.current = true;

    const urlParams = new URLSearchParams(window.location.search);
    const urlProjectId = urlParams.get("projectId");
    const validIds = new Set(projects.map((p) => p.id));

    if (urlProjectId) {
      if (!validIds.has(urlProjectId)) {
        globalThis.localStorage?.removeItem("pmfreak.currentProjectId");
        queueMicrotask(() => setProjectId(""));
      }
      return;
    }

    if (projectId && validIds.has(projectId)) {
      urlParams.set("projectId", projectId);
      router.replace(`${window.location.pathname}?${urlParams.toString()}`);
    } else if (projectId && !validIds.has(projectId)) {
      globalThis.localStorage?.removeItem("pmfreak.currentProjectId");
      queueMicrotask(() => setProjectId(""));
    }
  }, [projectId, projects, projectsError, projectsLoading, router]);

  useEffect(() => {
    let active = true;
    async function loadDiscovery() {
      if (!projectId) {
        setDiscoverySummary(null);
        return;
      }
      setDiscoveryLoading(true);
      try {
        const res = await fetch(`/api/project-discovery?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as { discovery?: DiscoverySummary | null };
        if (active) setDiscoverySummary(res.ok ? data.discovery ?? null : null);
      } catch {
        if (active) setDiscoverySummary(null);
      } finally {
        if (active) setDiscoveryLoading(false);
      }
    }
    void loadDiscovery();
    return () => { active = false; };
  }, [projectId]);

  const refreshActions = async () => {
    if (!projectId) { setRecommendedActions([]); return; }
    try {
      const res = await fetch(`/api/recommended-actions?projectId=${encodeURIComponent(projectId)}&decision_fields=true`, { cache: "no-store" });
      const data = (await res.json()) as { recommendedActions?: RecommendedAction[] };
      setRecommendedActions(res.ok ? data.recommendedActions ?? [] : []);
    } catch {
      setRecommendedActions([]);
    }
  };

  const refreshExecutionTasks = async () => {
    if (!projectId) { setExecutionTasks([]); return; }
    try {
      const res = await fetch(`/api/execution-tasks?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const data = (await res.json()) as { tasks?: ExecutionTask[] };
      setExecutionTasks(res.ok ? data.tasks ?? [] : []);
    } catch {
      setExecutionTasks([]);
    }
  };

  const refreshExecutionNetwork = async () => {
    if (!projectId) { setDependencies([]); setNetworkSummary(null); return; }
    try {
      const res = await fetch(`/api/execution-task-graph?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const data = (await res.json()) as { dependencies?: ExecutionTaskDependency[]; graphSummary?: ExecutionNetworkSummary };
      setDependencies(res.ok ? data.dependencies ?? [] : []);
      setNetworkSummary(res.ok ? data.graphSummary ?? null : null);
    } catch {
      setDependencies([]);
      setNetworkSummary(null);
    }
  };

  const handleDepAction = async (dependencyId: string, status: "active" | "resolved" | "invalidated") => {
    setDepActingId(dependencyId);
    setDepActionError(null);
    try {
      const res = await fetch("/api/execution-task-dependencies/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dependencyId, status }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setDepActionError(data.error ?? "Action failed.");
      } else {
        await refreshExecutionNetwork();
      }
    } catch {
      setDepActionError("Network error.");
    } finally {
      setDepActingId(null);
    }
  };

  const handleCreateDependency = async () => {
    if (!depFormPred || !depFormSucc) { setDepActionError("Predecessor and successor are required."); return; }
    setDepActionError(null);
    try {
      const res = await fetch("/api/execution-task-dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          predecessorTaskId: depFormPred,
          successorTaskId: depFormSucc,
          dependencyType: depFormType,
          reason: depFormReason || undefined,
          status: "active",
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setDepActionError(data.error ?? "Could not create dependency.");
      } else {
        setShowDepForm(false);
        setDepFormPred("");
        setDepFormSucc("");
        setDepFormReason("");
        setDepFormType("finish_to_start");
        await refreshExecutionNetwork();
      }
    } catch {
      setDepActionError("Network error.");
    }
  };

  const handleTaskAction = async (
    taskId: string,
    action: "start" | "block" | "complete" | "cancel",
    extra?: { ownerName?: string; dueDate?: string; progressPercent?: number }
  ) => {
    setTaskActingId(taskId);
    setTaskActionError(null);
    const statusMap: Record<string, string> = {
      start: "in_progress",
      block: "blocked",
      complete: "completed",
      cancel: "cancelled",
    };
    try {
      const res = await fetch("/api/execution-tasks/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, status: statusMap[action], ...extra }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setTaskActionError(data.error ?? "Action failed. Please try again.");
      } else {
        await refreshExecutionTasks();
      }
    } catch {
      setTaskActionError("Network error. Please try again.");
    } finally {
      setTaskActingId(null);
    }
  };

  const handleConvertDraftToTask = async (draftId: string) => {
    setTaskActingId(draftId);
    setTaskActionError(null);
    try {
      const res = await fetch("/api/execution-tasks/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskDraftId: draftId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setTaskActionError(data.error ?? "Could not convert draft. Please try again.");
      } else {
        await refreshExecutionTasks();
        setTaskDraftPreview(null);
      }
    } catch {
      setTaskActionError("Network error. Please try again.");
    } finally {
      setTaskActingId(null);
    }
  };

  useEffect(() => {
    let active = true;
    async function loadActions() {
      if (!projectId) { setRecommendedActions([]); return; }
      try {
        const res = await fetch(`/api/recommended-actions?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as { recommendedActions?: RecommendedAction[] };
        if (active) setRecommendedActions(res.ok ? data.recommendedActions ?? [] : []);
      } catch {
        if (active) setRecommendedActions([]);
      }
    }
    void loadActions();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    async function loadTasks() {
      if (!projectId) { setExecutionTasks([]); return; }
      try {
        const res = await fetch(`/api/execution-tasks?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as { tasks?: ExecutionTask[] };
        if (active) setExecutionTasks(res.ok ? data.tasks ?? [] : []);
      } catch {
        if (active) setExecutionTasks([]);
      }
    }
    void loadTasks();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    async function loadNetwork() {
      if (!projectId) { setDependencies([]); setNetworkSummary(null); return; }
      try {
        const res = await fetch(`/api/execution-task-graph?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as { dependencies?: ExecutionTaskDependency[]; graphSummary?: ExecutionNetworkSummary };
        if (active) {
          setDependencies(res.ok ? data.dependencies ?? [] : []);
          setNetworkSummary(res.ok ? data.graphSummary ?? null : null);
        }
      } catch {
        if (active) { setDependencies([]); setNetworkSummary(null); }
      }
    }
    void loadNetwork();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    async function loadSchedule() {
      if (!projectId) { setScheduleMilestones([]); setScheduleHealth(null); setScheduledTasks([]); return; }
      try {
        const res = await fetch(`/api/schedule?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as { milestones?: ProjectMilestone[]; tasks?: ScheduledTask[]; health?: ScheduleHealth };
        if (active && res.ok) {
          setScheduleMilestones(data.milestones ?? []);
          setScheduledTasks(data.tasks ?? []);
          setScheduleHealth(data.health ?? null);
        }
      } catch {
        if (active) { setScheduleMilestones([]); setScheduleHealth(null); setScheduledTasks([]); }
      }
    }
    void loadSchedule();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    async function loadCriticalPath() {
      if (!projectId) { setCriticalPathData(null); return; }
      try {
        const res = await fetch(`/api/critical-path?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json()) as typeof criticalPathData & { ok?: boolean };
        if (active && res.ok && data) setCriticalPathData(data);
      } catch {
        if (active) setCriticalPathData(null);
      }
    }
    void loadCriticalPath();
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    async function loadPortfolio() {
      setPortfolioLoading(true);
      try {
        const res = await fetch("/api/portfolio", { cache: "no-store" });
        const data = (await res.json()) as PortfolioData & { ok?: boolean };
        if (active && res.ok && data.ok) setPortfolioData(data);
      } catch {
        if (active) setPortfolioData(null);
      } finally {
        if (active) setPortfolioLoading(false);
      }
    }
    void loadPortfolio();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPortfolio = async () => {
    setPortfolioRefreshing(true);
    try {
      const res = await fetch("/api/portfolio/refresh", { method: "POST", cache: "no-store" });
      const data = (await res.json()) as PortfolioData & { ok?: boolean };
      if (res.ok && data.ok) setPortfolioData(data);
    } catch {
      // silently ignore
    } finally {
      setPortfolioRefreshing(false);
    }
  };

  const refreshSchedule = async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/schedule?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const data = (await res.json()) as { milestones?: ProjectMilestone[]; tasks?: ScheduledTask[]; health?: ScheduleHealth };
      if (res.ok) {
        setScheduleMilestones(data.milestones ?? []);
        setScheduledTasks(data.tasks ?? []);
        setScheduleHealth(data.health ?? null);
      }
    } catch { /* silent */ }
  };

  const refreshCriticalPath = async () => {
    if (!projectId) { setCriticalPathData(null); return; }
    try {
      const res = await fetch(`/api/critical-path?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const data = (await res.json()) as typeof criticalPathData & { ok?: boolean };
      if (res.ok && data) setCriticalPathData(data);
    } catch { /* silent */ }
  };

  const handleMaterializeCriticalPath = async () => {
    if (!projectId) return;
    setCpMaterializeLoading(true);
    setCpMaterializeError(null);
    try {
      const res = await fetch("/api/critical-path/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setCpMaterializeError(data.error ?? "Computation failed.");
      } else {
        await refreshCriticalPath();
      }
    } catch {
      setCpMaterializeError("Network error.");
    } finally {
      setCpMaterializeLoading(false);
    }
  };

  const handleCreateMilestone = async () => {
    if (!projectId || !milestoneFormTitle.trim()) { setMilestoneError("Title is required."); return; }
    setMilestoneActing(true);
    setMilestoneError(null);
    try {
      const res = await fetch("/api/schedule/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: milestoneFormTitle.trim(),
          milestoneType: milestoneFormType,
          targetDate: milestoneFormDate || null,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMilestoneError(data.error ?? "Failed to create milestone.");
      } else {
        setShowMilestoneForm(false);
        setMilestoneFormTitle("");
        setMilestoneFormDate("");
        setMilestoneFormType("delivery");
        await refreshSchedule();
      }
    } catch {
      setMilestoneError("Network error.");
    } finally {
      setMilestoneActing(false);
    }
  };

  const handleMilestoneAction = async (milestoneId: string, status: "completed" | "at_risk" | "cancelled") => {
    setMilestoneActing(true);
    setMilestoneError(null);
    try {
      const res = await fetch("/api/schedule/milestones/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ milestoneId, status }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMilestoneError(data.error ?? "Action failed.");
      } else {
        await refreshSchedule();
      }
    } catch {
      setMilestoneError("Network error.");
    } finally {
      setMilestoneActing(false);
    }
  };

  const handleDecision = async (
    actionId: string,
    decision: "accepted" | "rejected" | "deferred" | "converted_to_task",
    extra?: { reason?: string; deferredUntil?: string }
  ) => {
    setDecidingId(actionId);
    setDecisionError(null);
    try {
      const res = await fetch("/api/recommended-actions/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, decision, ...extra }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setDecisionError(data.error ?? "Decision failed. Please try again.");
      } else {
        await refreshActions();
      }
    } catch {
      setDecisionError("Network error. Please try again.");
    } finally {
      setDecidingId(null);
    }
  };

  const promptReject = (actionId: string) => {
    const reason = window.prompt("Reason for rejection (optional):") ?? undefined;
    void handleDecision(actionId, "rejected", { reason: reason || undefined });
  };

  const promptDefer = (actionId: string) => {
    const until = window.prompt("Defer until (YYYY-MM-DD):");
    if (!until) return;
    void handleDecision(actionId, "deferred", { deferredUntil: new Date(until).toISOString() });
  };

  const handleConvert = async (actionId: string) => {
    setDraftConvertingId(actionId);
    setDraftActionError(null);
    try {
      const res = await fetch("/api/task-drafts/from-recommended-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendedActionId: actionId }),
      });
      const data = (await res.json()) as { ok?: boolean; draft?: TaskDraft; error?: string };
      if (!res.ok || !data.ok || !data.draft) {
        setDraftActionError(data.error ?? "Could not create task draft. Please try again.");
      } else {
        setTaskDraftPreview(data.draft);
        await refreshActions();
      }
    } catch {
      setDraftActionError("Network error. Please try again.");
    } finally {
      setDraftConvertingId(null);
    }
  };

  const handleDraftStatus = async (draftId: string, status: "reviewed" | "approved" | "discarded") => {
    setDraftActionError(null);
    try {
      const res = await fetch("/api/task-drafts/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, status }),
      });
      const data = (await res.json()) as { ok?: boolean; draft?: TaskDraft; error?: string };
      if (!res.ok || !data.ok) {
        setDraftActionError(data.error ?? "Status update failed. Please try again.");
      } else {
        setTaskDraftPreview(data.draft ?? null);
      }
    } catch {
      setDraftActionError("Network error. Please try again.");
    }
  };

  const hasProjects = projects.length > 0;
  const revealState = useMemo(() => computeCapabilityRevealState({
    planTier: "free",
    role: user.role,
    onboardingCompleted: true,
    hasProject: hasProjects,
    firstRun: false,
    evidenceSignals: hasProjects ? 2 : 0,
    operationalMemorySignals: hasProjects ? 1 : 0,
    continuitySignals: hasProjects ? 1 : 0,
    canUseAdvancedAi: true,
    canUsePortfolioMemory: true,
    canUseGovernanceDirectives: user.role === "admin" || user.role === "owner",
  }), [hasProjects, user.role]);
  // Navigation destination resolution. The Command Center entry is rewritten to
  // its canonical, entity-qualified route when the workspace is known, so the
  // URL the PM lands on (and can copy, bookmark or share) names the workspace
  // rather than relying on whatever their session last selected.
  const navHref = (href: string) => {
    if (href === WORKSPACE_COMMAND_CENTER_LEGACY_PATH && workspaceId) {
      return workspaceCommandCenterPath(workspaceId, { projectId: projectId ?? undefined });
    }
    return projectId ? `${href}?projectId=${projectId}` : href;
  };
  const navItems = computeNavigationRail(revealState, capabilityProfile).map((item) => ({
    ...item,
    locked: !isLensUnlocked(item.href, awakening.stage),
  }));
  const tierByHref = new Map(NAVIGATION_HIERARCHY.map((node) => [node.href, node.tier]));
  // Desktop and mobile both read these same three arrays, so the conceptual hierarchy
  // cannot drift between them: there is one derivation, rendered twice.
  const primaryNav = navItems.filter((item) => tierByHref.get(item.href) === "primary");
  const utilityNav = navItems.filter((item) => tierByHref.get(item.href) === "utility");
  const advancedNav = navItems.filter((item) => tierByHref.get(item.href) === "advanced");

  // The lens rail used to be reordered here from the imprint profile. It went with the
  // lens tier: primary order is now the fixed product hierarchy declared in
  // NAVIGATION_HIERARCHY, not something the profile reshuffles under the user. (The sort
  // was already dead code — the render read `lensNav`, never its sorted copy.)

  const activeLens = DERIVED_LENS_METADATA.find((lens) => pathname.startsWith(lens.route) && ["overview", "delivery", "leadership", "controls"].includes(lens.lensType));
  const discoveryCounts = {
    stakeholders: discoverySummary?.stakeholders_json?.length ?? 0,
    dependencies: discoverySummary?.dependencies_json?.length ?? 0,
    risks: discoverySummary?.risks_json?.length ?? 0,
    milestones: discoverySummary?.milestones_json?.length ?? 0,
    deliverables: discoverySummary?.deliverables_json?.length ?? 0,
    unknowns: discoverySummary?.unknowns_json?.length ?? 0,
  };
  const discoveryConfidence = Math.round(Number(discoverySummary?.confidence_score ?? 0));

  // /workspace/setup is the onboarding wizard: a linear, single-purpose flow
  // that intentionally has no workspace/PMO/project data to build this rail's
  // navigation from yet, so it renders its own bare light shell instead
  // (see (protected)/layout.tsx). Every other authenticated route — including
  // Command Center, which used to get a bespoke bare shell here — renders
  // through this same rail so the app has one consistent navigation surface.
  if (pathname.startsWith("/workspace/setup")) {
    return <div data-shell="pmfreak-light-workspace-setup" className="min-h-screen bg-[#FCFBF9] px-3 py-4 md:px-5 md:py-6">{children}</div>;
  }

  return (
    <div data-shell="pmfreak-shell" className="min-h-screen bg-[#FCFBF9] text-slate-900">
      <div className="mx-auto flex w-full max-w-[1540px] gap-4 px-3 py-4 md:gap-6 md:px-5 md:py-6">

        {/* ── Left rail ── */}
        <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-[15.5rem] flex-col rounded-3xl border border-slate-200 bg-[#FCFBF9]/80 shadow-[0_36px_80px_-55px_rgba(14,116,144,0.4)] backdrop-blur-xl lg:flex overflow-hidden">

          {/* Scrollable interior */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">

            {/* Identity block */}
            <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
              <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-indigo-500/20 blur-2xl motion-safe:animate-[breathe_8s_ease-in-out_infinite]" />
              <div className="pointer-events-none absolute -bottom-4 -left-4 h-16 w-16 rounded-full bg-cyan-500/15 blur-xl" />

              <div className="relative">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400/60 motion-safe:animate-[pulse_3s_ease-in-out_infinite]" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
                  </span>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.36em] text-indigo-200/80">PMFreak</p>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">{user.companyName}</p>
              </div>
            </div>

            {/* Primary navigation — Start Here */}
            <nav aria-label="Primary navigation">
              <div className="space-y-1">
                <p className="mb-1.5 px-1 text-[9px] uppercase tracking-[0.3em] text-zinc-400">Start Here</p>
                {primaryNav.map((item) => {
                  const isActive = navEntryMatchesPathname(item.href, pathname);
                  return (
                    <Link
                      key={item.href}
                      href={navHref(item.href)}
                      className={`group relative block overflow-hidden rounded-xl border px-3 py-2.5 text-sm transition-all duration-200 ${
                        isActive
                          ? `${item.active} border-opacity-100`
                          : `border-slate-200 bg-white ${item.idle} hover:border-slate-200 hover:bg-white hover:-translate-y-px`
                      }`}
                    >
                      <span className={`pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 bg-gradient-to-r group-hover:opacity-100 ${item.accent}`} />
                      <span className="relative">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </nav>

            {/* Grouped navigation hierarchy */}
            <nav aria-label="Grouped navigation">
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between px-1">
                    <p className="text-[9px] uppercase tracking-[0.28em] text-zinc-400">Workspace</p>
                    <Link href="/workspaces/new" className="text-[10px] font-semibold text-cyan-300/80 hover:text-cyan-800" title="Create a new workspace">
                      + New
                    </Link>
                  </div>
                  <Link href="/workspaces" className="block truncate rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:border-slate-200">
                    {user.companyName || "Workspace"}
                  </Link>
                </div>
                <SidebarPmoTree activeProjectId={projectId || undefined} onSelectProject={(id) => setProjectId(id)} />
                <div>
                  <p className="mb-1 text-[9px] uppercase tracking-[0.28em] text-zinc-400">More</p>
                  <div className="space-y-1">
                    {utilityNav.map((item) => (
                      <Link key={item.href} href={item.href} className={`block rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${navEntryMatchesPathname(item.href, pathname) ? item.active : `border-slate-200 ${item.idle} hover:border-slate-200`}`}>{item.label}</Link>
                    ))}
                  </div>
                </div>
                <AdvancedDrawer items={advancedNav} pathname={pathname} navHref={navHref} />
              </div>
            </nav>

            <section className="rounded-2xl border border-indigo-300/15 bg-indigo-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(129,140,248,0.8)]">
              <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-indigo-200/80">Discovery Summary</p>
              <p className="mt-1 text-[11px] leading-5 text-slate-600">Operational structure inferred from canonical evidence.</p>
              <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] text-slate-700">
                <span>Stakeholders: {discoveryCounts.stakeholders}</span>
                <span>Dependencies: {discoveryCounts.dependencies}</span>
                <span>Risks: {discoveryCounts.risks}</span>
                <span>Milestones: {discoveryCounts.milestones}</span>
                <span>Deliverables: {discoveryCounts.deliverables}</span>
                <span>Unknowns: {discoveryCounts.unknowns}</span>
              </div>
              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-indigo-900">
                Discovery Confidence: {discoveryLoading ? "Loading" : `${discoveryConfidence}%`}
              </div>
            </section>

            {/* Recommended Actions Panel */}
            {recommendedActions.length > 0 && (() => {
              const ACTION_FILTERS = ["all", "proposed", "accepted", "rejected", "deferred", "converted"] as const;
              const filtered = actionsFilter === "all"
                ? recommendedActions
                : recommendedActions.filter((a) => a.status === actionsFilter || (actionsFilter === "converted" && a.status === "converted_to_task"));
              const topAction = filtered[0] ?? null;
              return (
                <section className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(251,191,36,0.5)]">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-amber-200/80">Recommended Actions</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-600">PM-reviewed action recommendations from RAID findings.</p>

                  {/* Quick filters */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {ACTION_FILTERS.map((f) => (
                      <button
                        key={f}
                        onClick={() => setActionsFilter(f)}
                        className={`rounded-md border px-2 py-0.5 text-[10px] capitalize transition-colors ${
                          actionsFilter === f
                            ? "border-amber-300/40 bg-amber-300/[0.15] text-amber-900"
                            : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  {/* Top action highlight */}
                  {topAction && (
                    <div className="mt-2 rounded-xl border border-amber-200/20 bg-slate-50 p-2.5">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-amber-300/70">Top Recommended Action</p>
                      <p className="mt-1 text-[11px] font-medium leading-4 text-slate-900">{topAction.title}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-600">
                        <span>Impact: <span className="capitalize text-slate-800">{topAction.impact_level ?? "—"}</span></span>
                        <span>Confidence: <span className="text-amber-800">{Math.round(Number(topAction.confidence_score))}%</span></span>
                        {topAction.evidence_summary?.raidCategory && (
                          <span>Source: <span className="capitalize text-slate-700">{topAction.evidence_summary.raidCategory}</span></span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Decision error */}
                  {decisionError && (
                    <p className="mt-1.5 rounded-lg border border-rose-300/20 bg-rose-300/[0.06] px-2 py-1.5 text-[10px] text-rose-700">{decisionError}</p>
                  )}

                  {/* Action list */}
                  <div className="mt-2 space-y-2">
                    {filtered.slice(0, 5).map((action) => {
                      const isDeciding = decidingId === action.id;
                      const status = action.status;
                      const isTerminal = status === "rejected" || status === "converted_to_task";
                      return (
                        <div key={action.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                          <p className="text-[11px] leading-4 text-slate-800">{action.title}</p>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                            <span className="capitalize">{action.recommended_action_type.replace(/_/g, " ")}</span>
                            {action.impact_level && <span className="capitalize">{action.impact_level}</span>}
                            <span className={`capitalize font-medium ${
                              status === "proposed" ? "text-amber-400/70" :
                              status === "accepted" ? "text-green-400/80" :
                              status === "rejected" ? "text-rose-400/70" :
                              status === "deferred" ? "text-sky-400/70" :
                              status === "converted_to_task" ? "text-indigo-400/70" :
                              "text-slate-400"
                            }`}>{status === "converted_to_task" ? "Converted" : status}</span>
                          </div>

                          {/* Decision history summary */}
                          {(status !== "proposed") && action.decided_at && (
                            <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[9px] text-slate-500">
                              {status === "deferred" && action.deferred_until && (
                                <span>Deferred until {new Date(action.deferred_until).toLocaleDateString()} · </span>
                              )}
                              <span>Decided {new Date(action.decided_at).toLocaleDateString()}</span>
                              {action.decision_reason && <span> · {action.decision_reason}</span>}
                            </div>
                          )}

                          {/* Decision controls */}
                          {!isTerminal && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {(status === "proposed" || status === "deferred") && (
                                <button
                                  disabled={isDeciding}
                                  onClick={() => void handleDecision(action.id, "accepted")}
                                  className="rounded border border-green-300/20 bg-green-300/[0.07] px-2 py-0.5 text-[10px] text-green-700 hover:bg-green-300/[0.15] disabled:opacity-40"
                                >
                                  Accept
                                </button>
                              )}
                              {(status === "proposed" || status === "deferred") && (
                                <button
                                  disabled={isDeciding}
                                  onClick={() => promptReject(action.id)}
                                  className="rounded border border-rose-300/20 bg-rose-300/[0.07] px-2 py-0.5 text-[10px] text-rose-700 hover:bg-rose-300/[0.15] disabled:opacity-40"
                                >
                                  Reject
                                </button>
                              )}
                              {(status === "proposed") && (
                                <button
                                  disabled={isDeciding}
                                  onClick={() => promptDefer(action.id)}
                                  className="rounded border border-sky-300/20 bg-sky-300/[0.07] px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-300/[0.15] disabled:opacity-40"
                                >
                                  Defer
                                </button>
                              )}
                              {(status === "proposed" || status === "deferred" || status === "accepted") && (
                                <button
                                  disabled={isDeciding || draftConvertingId === action.id}
                                  onClick={() => void handleConvert(action.id)}
                                  className="rounded border border-indigo-300/20 bg-indigo-300/[0.07] px-2 py-0.5 text-[10px] text-indigo-700 hover:bg-indigo-300/[0.15] disabled:opacity-40"
                                >
                                  {draftConvertingId === action.id ? "Creating…" : "Convert"}
                                </button>
                              )}
                            </div>
                          )}
                          {status === "rejected" && (
                            <p className="mt-1.5 text-[9px] text-rose-400/60">Rejected — no further actions</p>
                          )}
                          {status === "converted_to_task" && (
                            <p className="mt-1.5 text-[9px] text-indigo-400/60">
                              Converted — task draft created
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {filtered.length > 5 && (
                      <p className="px-1 text-[10px] text-slate-400">+{filtered.length - 5} more</p>
                    )}
                  </div>
                </section>
              );
            })()}

            {/* Draft Action Error (outside actions section, persists until dismissed) */}
            {draftActionError && (
              <div className="rounded-xl border border-rose-300/20 bg-rose-300/[0.06] px-2.5 py-2 text-[10px] text-rose-700 flex items-start justify-between gap-2">
                <span>{draftActionError}</span>
                <button onClick={() => setDraftActionError(null)} className="shrink-0 text-rose-400/60 hover:text-rose-700">✕</button>
              </div>
            )}

            {/* Task Draft Preview */}
            {taskDraftPreview && (
              <section className="rounded-2xl border border-violet-300/20 bg-violet-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(167,139,250,0.5)]">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-violet-200/80">Task Draft</p>
                  <button
                    onClick={() => setTaskDraftPreview(null)}
                    className="text-[10px] text-slate-400 hover:text-slate-700"
                  >
                    ✕
                  </button>
                </div>

                <p className="mt-1.5 text-[11px] font-medium leading-4 text-slate-900">{taskDraftPreview.title}</p>

                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-600">
                  <span>Priority: <span className={`capitalize font-medium ${
                    taskDraftPreview.priority === "critical" ? "text-red-600" :
                    taskDraftPreview.priority === "high" ? "text-orange-600" :
                    taskDraftPreview.priority === "medium" ? "text-amber-600" :
                    "text-slate-700"
                  }`}>{taskDraftPreview.priority}</span></span>
                  {taskDraftPreview.suggested_owner && (
                    <span>Owner: <span className="text-slate-700">{taskDraftPreview.suggested_owner}</span></span>
                  )}
                  {taskDraftPreview.suggested_due_window && (
                    <span>Due: <span className="text-slate-700">{taskDraftPreview.suggested_due_window}</span></span>
                  )}
                  {taskDraftPreview.confidence_score !== null && (
                    <span>Confidence: <span className="text-violet-700">{Math.round(Number(taskDraftPreview.confidence_score))}%</span></span>
                  )}
                  <span className={`capitalize ${
                    taskDraftPreview.draft_status === "approved" ? "text-green-600" :
                    taskDraftPreview.draft_status === "discarded" ? "text-rose-400/70" :
                    "text-violet-300/70"
                  }`}>{taskDraftPreview.draft_status}</span>
                </div>

                {taskDraftPreview.description && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] leading-4 text-slate-600 line-clamp-3">
                    {taskDraftPreview.description}
                  </div>
                )}

                {taskDraftPreview.acceptance_criteria.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-violet-200/60 mb-1">Acceptance Criteria</p>
                    <ul className="space-y-0.5">
                      {taskDraftPreview.acceptance_criteria.map((c, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[10px] text-slate-600">
                          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/50" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {taskDraftPreview.checklist.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-violet-200/60 mb-1">Checklist</p>
                    <ul className="space-y-0.5">
                      {taskDraftPreview.checklist.slice(0, 4).map((c, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[10px] text-slate-600">
                          <span className="mt-px text-violet-400/50">☐</span>
                          {c}
                        </li>
                      ))}
                      {taskDraftPreview.checklist.length > 4 && (
                        <li className="text-[10px] text-slate-400">+{taskDraftPreview.checklist.length - 4} more steps</li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Draft action controls */}
                {(taskDraftPreview.draft_status === "draft" || taskDraftPreview.draft_status === "reviewed") && (
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    <button
                      onClick={() => void handleDraftStatus(taskDraftPreview.id, "approved")}
                      className="rounded border border-green-300/20 bg-green-300/[0.07] px-2 py-0.5 text-[10px] text-green-700 hover:bg-green-300/[0.15]"
                    >
                      Approve Draft
                    </button>
                    <button
                      onClick={() => void handleDraftStatus(taskDraftPreview.id, "discarded")}
                      className="rounded border border-rose-300/20 bg-rose-300/[0.07] px-2 py-0.5 text-[10px] text-rose-700 hover:bg-rose-300/[0.15]"
                    >
                      Discard Draft
                    </button>
                    <button
                      onClick={() => void handleDraftStatus(taskDraftPreview.id, "reviewed")}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-600 hover:text-slate-800"
                    >
                      Keep as Draft
                    </button>
                  </div>
                )}
                {taskDraftPreview.draft_status === "approved" && (
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    <button
                      disabled={taskActingId === taskDraftPreview.id}
                      onClick={() => void handleConvertDraftToTask(taskDraftPreview.id)}
                      className="rounded border border-teal-300/20 bg-teal-300/[0.07] px-2 py-0.5 text-[10px] text-teal-700 hover:bg-teal-300/[0.15] disabled:opacity-40"
                    >
                      {taskActingId === taskDraftPreview.id ? "Converting…" : "Create Execution Task"}
                    </button>
                  </div>
                )}
                {taskDraftPreview.draft_status === "discarded" && (
                  <p className="mt-1.5 text-[9px] text-rose-400/60">Draft discarded</p>
                )}
              </section>
            )}

            {/* Task Action Error */}
            {taskActionError && (
              <div className="rounded-xl border border-rose-300/20 bg-rose-300/[0.06] px-2.5 py-2 text-[10px] text-rose-700 flex items-start justify-between gap-2">
                <span>{taskActionError}</span>
                <button onClick={() => setTaskActionError(null)} className="shrink-0 text-rose-400/60 hover:text-rose-700">✕</button>
              </div>
            )}

            {/* Execution Network Panel */}
            {(networkSummary !== null || dependencies.length > 0) && (
              <section className="rounded-2xl border border-violet-300/15 bg-violet-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(139,92,246,0.5)]">
                <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-violet-200/80">Execution Network</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-600">Task dependencies and execution flow.</p>

                {networkSummary && (
                  <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] text-slate-700">
                    <span>Total Tasks: {networkSummary.totalTasks}</span>
                    <span>Ready: <span className="text-green-400/80">{networkSummary.readyTasks}</span></span>
                    <span>Blocked: <span className="text-orange-400/80">{networkSummary.blockedTasks}</span></span>
                    <span>Completed: <span className="text-slate-600">{networkSummary.completedTasks}</span></span>
                    <span>Active Deps: <span className="text-violet-700">{networkSummary.activeDependencies}</span></span>
                    <span>Proposed: <span className="text-amber-300/80">{networkSummary.proposedDependencies}</span></span>
                  </div>
                )}

                {depActionError && (
                  <p className="mt-1.5 rounded-lg border border-rose-300/20 bg-rose-300/[0.06] px-2 py-1.5 text-[10px] text-rose-700">{depActionError}</p>
                )}

                {/* Dependency list */}
                {dependencies.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-violet-200/60">Dependencies</p>
                    {dependencies.slice(0, 8).map((dep) => {
                      const pred = executionTasks.find((t) => t.id === dep.predecessor_task_id);
                      const succ = executionTasks.find((t) => t.id === dep.successor_task_id);
                      const isActing = depActingId === dep.id;
                      return (
                        <div key={dep.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                          <div className="flex items-center gap-1 text-[10px]">
                            <span className="truncate max-w-[5rem] text-slate-700" title={pred?.title}>{pred?.title ?? dep.predecessor_task_id.slice(0, 8)}</span>
                            <span className="text-violet-400/70">→</span>
                            <span className="truncate max-w-[5rem] text-slate-700" title={succ?.title}>{succ?.title ?? dep.successor_task_id.slice(0, 8)}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-slate-500">
                            <span className="capitalize">{dep.dependency_type.replace(/_/g, " ")}</span>
                            <span className={`capitalize font-medium ${
                              dep.status === "proposed" ? "text-amber-400/70" :
                              dep.status === "active" ? "text-green-400/70" :
                              dep.status === "resolved" ? "text-sky-400/70" :
                              "text-slate-400"
                            }`}>{dep.status}</span>
                            {dep.confidence_score !== null && (
                              <span>{Math.round(Number(dep.confidence_score))}%</span>
                            )}
                          </div>
                          {dep.reason && (
                            <p className="mt-0.5 text-[9px] text-slate-400 line-clamp-1">{dep.reason}</p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {dep.status === "proposed" && (
                              <>
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleDepAction(dep.id, "active")}
                                  className="rounded border border-green-300/20 bg-green-300/[0.07] px-2 py-0.5 text-[9px] text-green-700 hover:bg-green-300/[0.15] disabled:opacity-40"
                                >Activate</button>
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleDepAction(dep.id, "invalidated")}
                                  className="rounded border border-rose-300/20 bg-rose-300/[0.07] px-2 py-0.5 text-[9px] text-rose-700 hover:bg-rose-300/[0.15] disabled:opacity-40"
                                >Invalidate</button>
                              </>
                            )}
                            {dep.status === "active" && (
                              <>
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleDepAction(dep.id, "resolved")}
                                  className="rounded border border-sky-300/20 bg-sky-300/[0.07] px-2 py-0.5 text-[9px] text-sky-700 hover:bg-sky-300/[0.15] disabled:opacity-40"
                                >Resolve</button>
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleDepAction(dep.id, "invalidated")}
                                  className="rounded border border-rose-300/20 bg-rose-300/[0.07] px-2 py-0.5 text-[9px] text-rose-700 hover:bg-rose-300/[0.15] disabled:opacity-40"
                                >Invalidate</button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {dependencies.length > 8 && (
                      <p className="px-1 text-[10px] text-slate-400">+{dependencies.length - 8} more</p>
                    )}
                  </div>
                )}

                {/* Manual dependency creation form */}
                {!showDepForm ? (
                  <button
                    onClick={() => setShowDepForm(true)}
                    className="mt-2 w-full rounded-lg border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1.5 text-[10px] text-violet-300/80 hover:bg-violet-300/[0.10] text-center"
                  >
                    + Add Dependency
                  </button>
                ) : (
                  <div className="mt-2 space-y-1.5 rounded-lg border border-violet-300/15 bg-slate-50 p-2">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-violet-200/60">New Dependency</p>
                    <select
                      value={depFormPred}
                      onChange={(e) => setDepFormPred(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[10px] text-slate-700"
                    >
                      <option value="">Predecessor task…</option>
                      {executionTasks.map((t) => (
                        <option key={t.id} value={t.id}>{t.title}</option>
                      ))}
                    </select>
                    <select
                      value={depFormSucc}
                      onChange={(e) => setDepFormSucc(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[10px] text-slate-700"
                    >
                      <option value="">Successor task…</option>
                      {executionTasks.map((t) => (
                        <option key={t.id} value={t.id}>{t.title}</option>
                      ))}
                    </select>
                    <select
                      value={depFormType}
                      onChange={(e) => setDepFormType(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[10px] text-slate-700"
                    >
                      {["finish_to_start","start_to_start","finish_to_finish","start_to_finish","blocks","gated_by","approval_required","external_dependency"].map((t) => (
                        <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={depFormReason}
                      onChange={(e) => setDepFormReason(e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[10px] text-slate-700 placeholder-slate-400"
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={() => void handleCreateDependency()}
                        className="rounded border border-violet-300/20 bg-violet-300/[0.08] px-2 py-0.5 text-[10px] text-violet-700 hover:bg-violet-300/[0.15]"
                      >Create</button>
                      <button
                        onClick={() => { setShowDepForm(false); setDepActionError(null); }}
                        className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500 hover:text-slate-700"
                      >Cancel</button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Execution Tasks Panel */}
            {executionTasks.length > 0 && (() => {
              const TASK_FILTERS = ["all", "my_tasks", "open", "blocked", "completed"] as const;
              const now = new Date();
              const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

              const filtered = executionTasks.filter((t) => {
                if (executionTasksFilter === "my_tasks") return false; // requires user context
                if (executionTasksFilter === "open") return t.status === "not_started" || t.status === "in_progress";
                if (executionTasksFilter === "blocked") return t.status === "blocked";
                if (executionTasksFilter === "completed") return t.status === "completed";
                return true;
              });

              const isOverdue = (t: ExecutionTask) =>
                t.due_date && t.status !== "completed" && t.status !== "cancelled" && new Date(t.due_date) < now;
              const isDueSoon = (t: ExecutionTask) =>
                t.due_date && t.status !== "completed" && t.status !== "cancelled" &&
                new Date(t.due_date) >= now && new Date(t.due_date) <= sevenDays;

              return (
                <section className="rounded-2xl border border-teal-300/15 bg-teal-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(20,184,166,0.5)]">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-teal-200/80">Execution Tasks</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-600">Approved Task Drafts converted to operational work units.</p>

                  {/* Quick filters */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {TASK_FILTERS.map((f) => (
                      <button
                        key={f}
                        onClick={() => setExecutionTasksFilter(f)}
                        className={`rounded-md border px-2 py-0.5 text-[10px] capitalize transition-colors ${
                          executionTasksFilter === f
                            ? "border-teal-300/40 bg-teal-300/[0.15] text-teal-900"
                            : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        {f.replace(/_/g, " ")}
                      </button>
                    ))}
                  </div>

                  {/* Task list */}
                  <div className="mt-2 space-y-2">
                    {filtered.slice(0, 6).map((task) => {
                      const isActing = taskActingId === task.id;
                      const overdue = isOverdue(task);
                      const dueSoon = isDueSoon(task);
                      const canStart = task.status === "not_started";
                      const canBlock = task.status === "in_progress";
                      const canUnblock = task.status === "blocked";
                      const canComplete = task.status === "in_progress" || task.status === "blocked";
                      const canCancel = task.status !== "completed" && task.status !== "cancelled";
                      const isTerminal = task.status === "completed" || task.status === "cancelled";

                      const activeDeps = dependencies.filter((d) => d.status === "active" || d.status === "proposed");
                      const blockingCount = activeDeps.filter((d) => d.predecessor_task_id === task.id).length;
                      const blockedByCount = activeDeps.filter((d) => d.successor_task_id === task.id).length;
                      const proposedCount = dependencies.filter((d) => d.status === "proposed" && (d.predecessor_task_id === task.id || d.successor_task_id === task.id)).length;
                      const isDepReady = task.status === "not_started" && activeDeps.filter((d) => d.successor_task_id === task.id).length === 0;
                      const isDepWaiting = task.status === "not_started" && activeDeps.filter((d) => d.successor_task_id === task.id).length > 0;

                      return (
                        <div key={task.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                          <p className="text-[11px] leading-4 text-slate-800">{task.title}</p>

                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                            <span className={`capitalize font-medium ${
                              task.status === "not_started" ? "text-slate-600" :
                              task.status === "in_progress" ? "text-teal-400/80" :
                              task.status === "blocked" ? "text-orange-400/80" :
                              task.status === "completed" ? "text-green-400/80" :
                              "text-slate-400"
                            }`}>{task.status.replace(/_/g, " ")}</span>
                            <span className={`capitalize ${
                              task.priority === "critical" ? "text-red-400/80" :
                              task.priority === "high" ? "text-orange-400/70" :
                              task.priority === "medium" ? "text-amber-400/70" :
                              "text-slate-500"
                            }`}>{task.priority}</span>
                            {task.owner_name && <span>{task.owner_name}</span>}
                          </div>

                          {/* Health badges */}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {overdue && (
                              <span className="rounded-sm border border-red-400/30 bg-red-400/[0.08] px-1.5 py-0.5 text-[9px] text-red-700">Overdue</span>
                            )}
                            {dueSoon && !overdue && (
                              <span className="rounded-sm border border-amber-400/30 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] text-amber-700">Due Soon</span>
                            )}
                            {task.status === "blocked" && (
                              <span className="rounded-sm border border-orange-400/30 bg-orange-400/[0.08] px-1.5 py-0.5 text-[9px] text-orange-700">Blocked</span>
                            )}
                            {task.status === "completed" && (
                              <span className="rounded-sm border border-green-400/30 bg-green-400/[0.08] px-1.5 py-0.5 text-[9px] text-green-700">Completed</span>
                            )}
                            {blockingCount > 0 && (
                              <span className="rounded-sm border border-violet-400/30 bg-violet-400/[0.08] px-1.5 py-0.5 text-[9px] text-violet-700">Blocking {blockingCount}</span>
                            )}
                            {blockedByCount > 0 && (
                              <span className="rounded-sm border border-orange-300/30 bg-orange-300/[0.08] px-1.5 py-0.5 text-[9px] text-orange-800">Blocked by {blockedByCount}</span>
                            )}
                            {isDepReady && task.status === "not_started" && blockingCount === 0 && blockedByCount === 0 && (
                              <span className="rounded-sm border border-green-400/30 bg-green-400/[0.08] px-1.5 py-0.5 text-[9px] text-green-700">Ready</span>
                            )}
                            {isDepWaiting && (
                              <span className="rounded-sm border border-slate-400/20 bg-slate-400/[0.06] px-1.5 py-0.5 text-[9px] text-slate-600">Waiting</span>
                            )}
                            {proposedCount > 0 && (
                              <span className="rounded-sm border border-amber-400/25 bg-amber-400/[0.06] px-1.5 py-0.5 text-[9px] text-amber-400/80">~{proposedCount} proposed</span>
                            )}
                          </div>

                          {/* Progress */}
                          {!isTerminal && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1 rounded-full bg-white">
                                <div
                                  className="h-full rounded-full bg-teal-400/60 transition-all"
                                  style={{ width: `${task.progress_percent}%` }}
                                />
                              </div>
                              <span className="text-[9px] text-slate-500">{task.progress_percent}%</span>
                            </div>
                          )}

                          {/* Due date */}
                          {task.due_date && (
                            <p className="mt-0.5 text-[9px] text-slate-500">
                              Due: {new Date(task.due_date).toLocaleDateString()}
                            </p>
                          )}

                          {/* Traceability */}
                          <div className="mt-1 text-[9px] text-slate-400">
                            {task.raid_item_id && <span>RAID · </span>}
                            {task.recommended_action_id && <span>Action · </span>}
                            <span>Draft</span>
                          </div>

                          {/* Action controls */}
                          {!isTerminal && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {canStart && (
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleTaskAction(task.id, "start")}
                                  className="rounded border border-teal-300/20 bg-teal-300/[0.07] px-2 py-0.5 text-[10px] text-teal-700 hover:bg-teal-300/[0.15] disabled:opacity-40"
                                >
                                  Start
                                </button>
                              )}
                              {canBlock && (
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleTaskAction(task.id, "block")}
                                  className="rounded border border-orange-300/20 bg-orange-300/[0.07] px-2 py-0.5 text-[10px] text-orange-700 hover:bg-orange-300/[0.15] disabled:opacity-40"
                                >
                                  Block
                                </button>
                              )}
                              {canUnblock && (
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleTaskAction(task.id, "start")}
                                  className="rounded border border-teal-300/20 bg-teal-300/[0.07] px-2 py-0.5 text-[10px] text-teal-700 hover:bg-teal-300/[0.15] disabled:opacity-40"
                                >
                                  Unblock
                                </button>
                              )}
                              {canComplete && (
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleTaskAction(task.id, "complete")}
                                  className="rounded border border-green-300/20 bg-green-300/[0.07] px-2 py-0.5 text-[10px] text-green-700 hover:bg-green-300/[0.15] disabled:opacity-40"
                                >
                                  Complete
                                </button>
                              )}
                              {canCancel && (
                                <button
                                  disabled={isActing}
                                  onClick={() => void handleTaskAction(task.id, "cancel")}
                                  className="rounded border border-rose-300/20 bg-rose-300/[0.07] px-2 py-0.5 text-[10px] text-rose-700 hover:bg-rose-300/[0.15] disabled:opacity-40"
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {filtered.length > 6 && (
                      <p className="px-1 text-[10px] text-slate-400">+{filtered.length - 6} more</p>
                    )}
                  </div>
                </section>
              );
            })()}

            {/* Schedule Foundation Panel */}
            {(scheduleHealth !== null || scheduleMilestones.length > 0) && (
              <section className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(52,211,153,0.5)]">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-emerald-200/80">Schedule Foundation</p>
                  <button
                    onClick={() => setShowMilestoneForm(v => !v)}
                    className="rounded border border-emerald-300/20 bg-emerald-300/[0.07] px-2 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-300/[0.15]"
                  >
                    + Milestone
                  </button>
                </div>

                {/* Milestone create form */}
                {showMilestoneForm && (
                  <div className="mt-2 space-y-1.5 rounded-lg border border-emerald-300/10 bg-emerald-300/[0.04] p-2">
                    <input
                      type="text"
                      placeholder="Milestone title"
                      value={milestoneFormTitle}
                      onChange={e => setMilestoneFormTitle(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
                    />
                    <select
                      value={milestoneFormType}
                      onChange={e => setMilestoneFormType(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
                    >
                      {["kickoff","discovery","design","approval","delivery","deployment","training","acceptance","go_live","handover","other"].map(t => (
                        <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={milestoneFormDate}
                      onChange={e => setMilestoneFormDate(e.target.value)}
                      className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
                    />
                    {milestoneError && <p className="text-[9px] text-rose-600">{milestoneError}</p>}
                    <div className="flex gap-1.5">
                      <button
                        disabled={milestoneActing}
                        onClick={() => void handleCreateMilestone()}
                        className="rounded border border-emerald-300/20 bg-emerald-300/[0.07] px-2 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-300/[0.15] disabled:opacity-40"
                      >
                        Create
                      </button>
                      <button
                        onClick={() => { setShowMilestoneForm(false); setMilestoneError(null); }}
                        className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 hover:text-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Schedule Summary */}
                {scheduleHealth && (
                  <div className="mt-2 space-y-0.5 text-[10px] text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>Scheduled</span>
                      <span className="text-emerald-300/80">{scheduleHealth.scheduledTasks}/{scheduleHealth.totalTasks}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Unscheduled</span>
                      <span className={scheduleHealth.unscheduledTasks > 0 ? "text-amber-400/80" : "text-slate-500"}>{scheduleHealth.unscheduledTasks}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Overdue</span>
                      <span className={scheduleHealth.overdueTasks > 0 ? "text-rose-600" : "text-slate-500"}>{scheduleHealth.overdueTasks}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Due soon</span>
                      <span className={scheduleHealth.dueSoonTasks > 0 ? "text-amber-300/80" : "text-slate-500"}>{scheduleHealth.dueSoonTasks}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Delayed</span>
                      <span className={scheduleHealth.delayedTasks > 0 ? "text-orange-400/80" : "text-slate-500"}>{scheduleHealth.delayedTasks}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>At risk</span>
                      <span className={scheduleHealth.atRiskTasks > 0 ? "text-orange-400/80" : "text-slate-500"}>{scheduleHealth.atRiskTasks}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1">
                      <span>Confidence</span>
                      <span className={
                        scheduleHealth.scheduleConfidence >= 70 ? "text-emerald-300/80" :
                        scheduleHealth.scheduleConfidence >= 40 ? "text-amber-400/80" : "text-rose-600"
                      }>{scheduleHealth.scheduleConfidence}%</span>
                    </div>
                  </div>
                )}

                {/* Milestones list */}
                {scheduleMilestones.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Milestones</p>
                    {scheduleMilestones.map(m => {
                      const isTerminal = m.status === "completed" || m.status === "cancelled";
                      return (
                        <div key={m.id} className="rounded-lg border border-slate-200 bg-white p-2">
                          <div className="flex items-start justify-between gap-1">
                            <p className="text-[10px] font-medium text-slate-800 leading-tight">{m.title}</p>
                            <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[8px] border ${
                              m.status === "completed" ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-700" :
                              m.status === "at_risk" ? "border-orange-400/25 bg-orange-400/[0.08] text-orange-700" :
                              m.status === "blocked" ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-700" :
                              m.status === "cancelled" ? "border-slate-400/20 bg-slate-400/[0.05] text-slate-500" :
                              "border-slate-400/20 bg-slate-400/[0.06] text-slate-600"
                            }`}>{m.status}</span>
                          </div>
                          <p className="mt-0.5 text-[9px] text-slate-500">{m.milestone_type.replace(/_/g, " ")}</p>
                          {m.target_date && (
                            <p className="mt-0.5 text-[9px] text-slate-500">
                              Target: {new Date(m.target_date).toLocaleDateString()}
                            </p>
                          )}
                          {m.forecast_date && (
                            <p className="mt-0.5 text-[9px] text-slate-500">
                              Forecast: {new Date(m.forecast_date).toLocaleDateString()}
                            </p>
                          )}
                          {/* Linked task count */}
                          {(() => {
                            const linked = scheduledTasks.filter(t => t.milestone_id === m.id).length;
                            return linked > 0 ? (
                              <p className="mt-0.5 text-[9px] text-slate-400">{linked} task(s) linked</p>
                            ) : null;
                          })()}
                          {!isTerminal && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              <button
                                disabled={milestoneActing}
                                onClick={() => void handleMilestoneAction(m.id, "completed")}
                                className="rounded border border-emerald-300/20 bg-emerald-300/[0.07] px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-300/[0.15] disabled:opacity-40"
                              >
                                Complete
                              </button>
                              {m.status !== "at_risk" && (
                                <button
                                  disabled={milestoneActing}
                                  onClick={() => void handleMilestoneAction(m.id, "at_risk")}
                                  className="rounded border border-orange-300/20 bg-orange-300/[0.07] px-1.5 py-0.5 text-[9px] text-orange-700 hover:bg-orange-300/[0.15] disabled:opacity-40"
                                >
                                  At Risk
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Task schedule badges on execution tasks */}
                {scheduledTasks.some(t => t.planned_finish_date || t.schedule_status !== "unscheduled") && (
                  <div className="mt-3 space-y-1">
                    <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Task Schedule</p>
                    {scheduledTasks
                      .filter(t => t.planned_finish_date || t.schedule_status !== "unscheduled")
                      .slice(0, 5)
                      .map(t => {
                        const now = new Date();
                        const finish = t.planned_finish_date ? new Date(t.planned_finish_date) : null;
                        const isOverdue = finish && finish < now && !["completed","cancelled"].includes(t.status);
                        const isDueSoon = finish && finish >= now && finish <= new Date(now.getTime() + 7*86400000) && !["completed","cancelled"].includes(t.status);
                        const linkedMilestone = t.milestone_id ? scheduleMilestones.find(m => m.id === t.milestone_id) : null;
                        return (
                          <div key={t.id} className="rounded border border-slate-200 bg-white p-1.5">
                            <p className="truncate text-[9px] text-slate-700">{t.title}</p>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {t.schedule_status !== "unscheduled" && (
                                <span className={`rounded-sm px-1 py-0.5 text-[8px] border ${
                                  t.schedule_status === "delayed" ? "border-orange-400/25 bg-orange-400/[0.08] text-orange-700" :
                                  t.schedule_status === "at_risk" ? "border-amber-400/25 bg-amber-400/[0.08] text-amber-700" :
                                  t.schedule_status === "scheduled" ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-700" :
                                  "border-slate-400/20 bg-slate-400/[0.06] text-slate-600"
                                }`}>{t.schedule_status}</span>
                              )}
                              {isOverdue && (
                                <span className="rounded-sm border border-rose-400/25 bg-rose-400/[0.08] px-1 py-0.5 text-[8px] text-rose-700">Overdue</span>
                              )}
                              {isDueSoon && !isOverdue && (
                                <span className="rounded-sm border border-amber-400/25 bg-amber-400/[0.08] px-1 py-0.5 text-[8px] text-amber-700">Due soon</span>
                              )}
                              {t.schedule_status === "delayed" && (
                                <span className="rounded-sm border border-orange-400/25 bg-orange-400/[0.08] px-1 py-0.5 text-[8px] text-orange-700">Delayed</span>
                              )}
                              {linkedMilestone && (
                                <span className="rounded-sm border border-emerald-400/20 bg-emerald-400/[0.05] px-1 py-0.5 text-[8px] text-emerald-400/80 truncate max-w-[80px]">{linkedMilestone.title}</span>
                              )}
                            </div>
                            {t.planned_finish_date && (
                              <p className="mt-0.5 text-[8px] text-slate-400">Finish: {new Date(t.planned_finish_date).toLocaleDateString()}</p>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}

                {milestoneError && !showMilestoneForm && (
                  <p className="mt-2 text-[9px] text-rose-600">{milestoneError}</p>
                )}
              </section>
            )}

            {/* Critical Path Panel */}
            <section className="rounded-2xl border border-violet-300/15 bg-violet-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(167,139,250,0.5)]" data-testid="critical-path-panel">
              <div className="flex items-center justify-between">
                <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-violet-200/80">Critical Path</p>
                <button
                  disabled={cpMaterializeLoading || !projectId}
                  onClick={() => void handleMaterializeCriticalPath()}
                  className="rounded border border-violet-300/20 bg-violet-300/[0.07] px-2 py-0.5 text-[9px] text-violet-700 hover:bg-violet-300/[0.15] disabled:opacity-40"
                >
                  {cpMaterializeLoading ? "Computing…" : "Compute"}
                </button>
              </div>
              {cpMaterializeError && <p className="mt-1 text-[9px] text-rose-600">{cpMaterializeError}</p>}

              {criticalPathData ? (
                <>
                  {/* Summary */}
                  <div className="mt-2 space-y-0.5 text-[10px] text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>Critical Tasks</span>
                      <span className={criticalPathData.summary.criticalTaskCount > 0 ? "text-rose-600" : "text-slate-500"}>{criticalPathData.summary.criticalTaskCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Critical Paths</span>
                      <span className={criticalPathData.summary.criticalPathCount && criticalPathData.summary.criticalPathCount > 1 ? "text-violet-600" : "text-slate-500"}>{criticalPathData.summary.criticalPathCount ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Critical Components</span>
                      <span className={criticalPathData.summary.criticalComponentCount && criticalPathData.summary.criticalComponentCount > 1 ? "text-amber-400/80" : "text-slate-500"}>{criticalPathData.summary.criticalComponentCount ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Branch Points</span>
                      <span className={criticalPathData.branchPoints && criticalPathData.branchPoints.length > 0 ? "text-orange-400/80" : "text-slate-500"}>{criticalPathData.branchPoints?.length ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Critical Milestones</span>
                      <span className={criticalPathData.summary.criticalMilestoneCount > 0 ? "text-orange-400/80" : "text-slate-500"}>{criticalPathData.summary.criticalMilestoneCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Project Duration</span>
                      <span className="text-violet-300/80">{criticalPathData.summary.projectDurationDays}d</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Forecast Variance</span>
                      <span className={
                        criticalPathData.summary.forecastVarianceDays > 0 ? "text-rose-600" :
                        criticalPathData.summary.forecastVarianceDays < 0 ? "text-emerald-600" : "text-slate-500"
                      }>
                        {criticalPathData.summary.forecastVarianceDays > 0 ? "+" : ""}{criticalPathData.summary.forecastVarianceDays}d
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1">
                      <span>Schedule Confidence</span>
                      <span className={
                        criticalPathData.summary.scheduleConfidence >= 70 ? "text-emerald-300/80" :
                        criticalPathData.summary.scheduleConfidence >= 40 ? "text-amber-400/80" : "text-rose-600"
                      }>{criticalPathData.summary.scheduleConfidence}%</span>
                    </div>
                  </div>

                  {/* Topology badges */}
                  {(criticalPathData.summary.hasMultipleCriticalPaths || criticalPathData.summary.hasCriticalBranches) && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {criticalPathData.summary.hasMultipleCriticalPaths && (
                        <span className="rounded-sm border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-[8px] font-medium text-violet-700">Multiple Critical Paths</span>
                      )}
                      {criticalPathData.summary.hasCriticalBranches && (
                        <span className="rounded-sm border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[8px] font-medium text-amber-700">Critical Branching</span>
                      )}
                    </div>
                  )}

                  {/* Forecast */}
                  {(criticalPathData.forecast.plannedFinish || criticalPathData.forecast.forecastFinish) && (
                    <div className="mt-2 rounded-lg border border-violet-300/10 bg-violet-300/[0.04] p-2 text-[10px]">
                      {criticalPathData.forecast.plannedFinish && (
                        <p className="text-slate-500">Planned: {new Date(criticalPathData.forecast.plannedFinish).toLocaleDateString()}</p>
                      )}
                      {criticalPathData.forecast.forecastFinish && (
                        <p className="text-slate-600">Forecast: {new Date(criticalPathData.forecast.forecastFinish).toLocaleDateString()}</p>
                      )}
                    </div>
                  )}

                  {/* Critical Task Cards */}
                  {criticalPathData.criticalTasks.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Critical Tasks</p>
                      {criticalPathData.criticalTasks.slice(0, 5).map(task => (
                        <div key={task.taskId} className="rounded-lg border border-rose-400/15 bg-rose-400/[0.04] p-2">
                          <div className="flex items-start justify-between gap-1">
                            <p className="truncate text-[10px] font-medium text-slate-800 leading-tight">{task.title}</p>
                            <div className="flex shrink-0 gap-1">
                              <span className="rounded-sm border border-rose-400/25 bg-rose-400/[0.08] px-1 py-0.5 text-[8px] text-rose-700">CRITICAL</span>
                              {task.varianceDays > 0 && (
                                <span className="rounded-sm border border-orange-400/25 bg-orange-400/[0.08] px-1 py-0.5 text-[8px] text-orange-700">DELAYED</span>
                              )}
                            </div>
                          </div>
                          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] text-slate-500">
                            <span>ES: {task.earlyStart}d</span>
                            <span>EF: {task.earlyFinish}d</span>
                            <span>LS: {task.lateStart}d</span>
                            <span>LF: {task.lateFinish}d</span>
                            <span>Float: {task.totalFloat}d</span>
                            {task.varianceDays !== 0 && (
                              <span className={task.varianceDays > 0 ? "text-orange-400/80" : "text-emerald-400/80"}>
                                Var: {task.varianceDays > 0 ? "+" : ""}{task.varianceDays}d
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Critical Paths */}
                  {criticalPathData.criticalPaths && criticalPathData.criticalPaths.length > 0 && (() => {
                    const taskTitleMap = new Map(criticalPathData.criticalTasks.map(t => [t.taskId, t.title]));
                    return (
                      <div className="mt-3 space-y-1.5">
                        <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Critical Paths</p>
                        {criticalPathData.criticalPaths.map((cp, idx) => (
                          <div key={cp.id} className="rounded-lg border border-violet-400/15 bg-violet-400/[0.04] p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] font-medium text-violet-300/80">Path {idx + 1}</span>
                              <span className="text-[9px] text-slate-500">{cp.length} task{cp.length !== 1 ? "s" : ""}</span>
                            </div>
                            <p className="mt-0.5 text-[9px] text-slate-500">
                              {taskTitleMap.get(cp.startTaskId) ?? cp.startTaskId} → {taskTitleMap.get(cp.endTaskId) ?? cp.endTaskId}
                            </p>
                            {cp.taskIds.length <= 6 && (
                              <p className="mt-1 text-[8px] text-slate-400 leading-relaxed">
                                {cp.taskIds.map(id => taskTitleMap.get(id) ?? id).join(" → ")}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Critical Segments */}
                  {criticalPathData.criticalSegments && criticalPathData.criticalSegments.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Critical Segments</p>
                      {criticalPathData.criticalSegments.map(seg => {
                        const taskTitleMap = new Map(criticalPathData.criticalTasks.map(t => [t.taskId, t.title]));
                        return (
                          <div key={seg.id} className="rounded-lg border border-slate-500/15 bg-slate-500/[0.04] p-2">
                            <div className="flex items-center justify-between">
                              <span className="truncate text-[9px] text-slate-700">
                                {taskTitleMap.get(seg.startTaskId) ?? seg.startTaskId}
                              </span>
                              <span className="mx-1 shrink-0 text-[9px] text-slate-400">→</span>
                              <span className="truncate text-[9px] text-slate-700">
                                {taskTitleMap.get(seg.endTaskId) ?? seg.endTaskId}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[9px] text-slate-400">{seg.length} task{seg.length !== 1 ? "s" : ""}{seg.isCompletePath ? " · complete path" : ""}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Branch Points */}
                  {criticalPathData.branchPoints && criticalPathData.branchPoints.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500">Branch Points</p>
                      {criticalPathData.branchPoints.map(bp => {
                        const taskTitleMap = new Map(criticalPathData.criticalTasks.map(t => [t.taskId, t.title]));
                        const branchColor = bp.branchType === "split" ? "amber" : bp.branchType === "merge" ? "sky" : "violet";
                        return (
                          <div key={bp.taskId} className={`rounded-lg border border-${branchColor}-400/15 bg-${branchColor}-400/[0.04] p-2`}>
                            <div className="flex items-center justify-between gap-1">
                              <p className="truncate text-[9px] font-medium text-slate-700">{taskTitleMap.get(bp.taskId) ?? bp.taskId}</p>
                              <span className={`shrink-0 rounded-sm border border-${branchColor}-400/25 bg-${branchColor}-400/[0.08] px-1 py-0.5 text-[8px] text-${branchColor}-300 uppercase`}>{bp.branchType.replace("_", "/")}</span>
                            </div>
                            <div className="mt-0.5 flex gap-2 text-[9px] text-slate-400">
                              {bp.incomingCriticalPredecessors.length > 1 && (
                                <span>in: {bp.incomingCriticalPredecessors.length}</span>
                              )}
                              {bp.outgoingCriticalSuccessors.length > 1 && (
                                <span>out: {bp.outgoingCriticalSuccessors.length}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <p className="mt-2 text-[10px] text-slate-400">Run computation to see critical path analysis.</p>
              )}
            </section>

            {/* Variance Panel */}
            {criticalPathData && criticalPathData.topVarianceTasks.length > 0 && (
              <section className="rounded-2xl border border-orange-300/15 bg-orange-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(251,146,60,0.4)]" data-testid="variance-panel">
                <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-orange-200/80">Schedule Variance</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-600">Top delayed tasks by forecast vs planned finish.</p>
                <div className="mt-2 space-y-1.5">
                  {criticalPathData.topVarianceTasks.map(task => (
                    <div key={task.taskId} className="rounded border border-slate-200 bg-white p-1.5">
                      <p className="truncate text-[9px] font-medium text-slate-700">{task.title}</p>
                      <div className="mt-0.5 flex items-center justify-between text-[9px]">
                        <div className="space-y-0.5 text-slate-400">
                          {task.plannedFinish && <p>Plan: {new Date(task.plannedFinish).toLocaleDateString()}</p>}
                          {task.forecastFinish && <p>Fcst: {new Date(task.forecastFinish).toLocaleDateString()}</p>}
                        </div>
                        <span className={`rounded-sm border px-1.5 py-0.5 text-[8px] ${
                          task.varianceDays > 0
                            ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-700"
                            : "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-700"
                        }`}>
                          {task.varianceDays > 0 ? "+" : ""}{task.varianceDays}d
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Critical Milestones Panel */}
            {criticalPathData && criticalPathData.criticalMilestones.some(m => m.isCritical || m.isAtRisk || m.isDelayed) && (
              <section className="rounded-2xl border border-rose-300/15 bg-rose-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(251,113,133,0.4)]" data-testid="critical-milestones-panel">
                <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-rose-200/80">Critical Milestones</p>
                <div className="mt-2 space-y-1.5">
                  {criticalPathData.criticalMilestones
                    .filter(m => m.isCritical || m.isAtRisk || m.isDelayed)
                    .map(m => (
                      <div key={m.milestoneId} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="flex items-start justify-between gap-1">
                          <p className="text-[10px] font-medium text-slate-800 leading-tight">{m.title}</p>
                          <div className="flex shrink-0 flex-wrap gap-1">
                            {m.isCritical && <span className="rounded-sm border border-rose-400/25 bg-rose-400/[0.08] px-1 py-0.5 text-[8px] text-rose-700">Critical</span>}
                            {m.isDelayed && <span className="rounded-sm border border-orange-400/25 bg-orange-400/[0.08] px-1 py-0.5 text-[8px] text-orange-700">Delayed</span>}
                            {m.isAtRisk && !m.isDelayed && <span className="rounded-sm border border-amber-400/25 bg-amber-400/[0.08] px-1 py-0.5 text-[8px] text-amber-700">At Risk</span>}
                          </div>
                        </div>
                        <div className="mt-0.5 space-y-0.5 text-[9px] text-slate-500">
                          {m.targetDate && <p>Target: {new Date(m.targetDate).toLocaleDateString()}</p>}
                          {m.forecastDate && <p>Forecast: {new Date(m.forecastDate).toLocaleDateString()}</p>}
                          {m.varianceDays !== 0 && (
                            <p className={m.varianceDays > 0 ? "text-orange-400/80" : "text-emerald-400/80"}>
                              Variance: {m.varianceDays > 0 ? "+" : ""}{m.varianceDays}d
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </section>
            )}

            {/* Portfolio Intelligence Panel */}
            <section className="rounded-2xl border border-purple-300/15 bg-purple-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(168,85,247,0.4)]" data-testid="portfolio-intelligence-section">
              <div className="flex items-center justify-between">
                <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-purple-200/80">Portfolio Intelligence</p>
                <button
                  onClick={() => void refreshPortfolio()}
                  disabled={portfolioRefreshing}
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-[8px] text-zinc-500 transition hover:border-slate-200 hover:text-slate-700 disabled:opacity-40"
                >
                  {portfolioRefreshing ? "…" : "Refresh"}
                </button>
              </div>
              {portfolioLoading ? (
                <p className="mt-2 text-[10px] text-zinc-400">Loading portfolio…</p>
              ) : portfolioData ? (
                <div className="mt-2 space-y-2">
                  {/* Portfolio Health */}
                  <div className="rounded-lg border border-slate-200 bg-white p-2">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-purple-300/70">Portfolio Health</p>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500">Health</span>
                        <span className={`font-semibold ${portfolioData.summary.portfolioHealthScore >= 70 ? "text-emerald-600" : portfolioData.summary.portfolioHealthScore >= 40 ? "text-amber-600" : "text-rose-600"}`}>
                          {portfolioData.summary.portfolioHealthScore}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500">Risk</span>
                        <span className={`font-semibold ${portfolioData.summary.portfolioRiskScore <= 30 ? "text-emerald-600" : portfolioData.summary.portfolioRiskScore <= 60 ? "text-amber-600" : "text-rose-600"}`}>
                          {portfolioData.summary.portfolioRiskScore}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500">Projects</span>
                        <span className="text-slate-700">{portfolioData.summary.activeProjectCount}/{portfolioData.summary.projectCount}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500">Critical</span>
                        <span className={`font-semibold ${portfolioData.summary.criticalProjectCount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                          {portfolioData.summary.criticalProjectCount}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Executive Attention Queue */}
                  {portfolioData.executiveAttention.length > 0 && (
                    <div data-testid="executive-attention-section">
                      <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-rose-300/70">Executive Attention</p>
                      <div className="space-y-1">
                        {portfolioData.executiveAttention.slice(0, 5).map((p) => (
                          <div key={p.projectId} className="rounded border border-rose-400/15 bg-rose-400/[0.04] px-2 py-1.5">
                            <p className="truncate text-[9px] font-medium text-slate-800">{p.projectName}</p>
                            <div className="mt-0.5 flex gap-2 text-[8px]">
                              <span className={`${p.healthScore < 50 ? "text-rose-600" : "text-zinc-500"}`}>H:{p.healthScore}</span>
                              <span className={`${p.riskScore > 70 ? "text-rose-600" : "text-zinc-500"}`}>R:{p.riskScore}</span>
                              {p.blockedTaskCount > 0 && <span className="text-amber-600">{p.blockedTaskCount} blocked</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Portfolio Bottlenecks */}
                  {portfolioData.bottlenecks.length > 0 && (
                    <div data-testid="portfolio-bottleneck-section">
                      <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-orange-300/70">Portfolio Bottlenecks</p>
                      <div className="space-y-1">
                        {portfolioData.bottlenecks.slice(0, 3).map((b) => (
                          <div key={b.entityId} className="rounded border border-orange-400/15 bg-orange-400/[0.03] px-2 py-1.5">
                            <div className="flex items-start justify-between gap-1">
                              <p className="truncate text-[9px] text-slate-700">{b.entityLabel || b.entityId}</p>
                              <span className="shrink-0 rounded-sm border border-orange-400/20 px-1 py-0.5 text-[7px] text-orange-700 uppercase">{b.entityType}</span>
                            </div>
                            <div className="mt-0.5 flex gap-2 text-[8px] text-zinc-500">
                              <span>Blocking: {b.blockingCount}</span>
                              <span>Impact: {b.impactScore}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dependency Risk */}
                  {portfolioData.dependencyRisks.length > 0 && (
                    <div data-testid="portfolio-dependency-risk-section">
                      <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-amber-300/70">Dependency Risk</p>
                      <div className="space-y-1">
                        {portfolioData.dependencyRisks.slice(0, 4).map((r, i) => {
                          const badgeStyle =
                            r.riskLevel === "critical"
                              ? "border-rose-400/30 bg-rose-400/[0.08] text-rose-700"
                              : r.riskLevel === "high"
                                ? "border-orange-400/30 bg-orange-400/[0.08] text-orange-700"
                                : r.riskLevel === "medium"
                                  ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-700"
                                  : "border-emerald-400/20 bg-emerald-400/[0.04] text-emerald-600";
                          const srcProject = portfolioData.projects.find((p) => p.projectId === r.sourceProjectId)?.projectName ?? r.sourceProjectId.slice(0, 8);
                          const tgtProject = portfolioData.projects.find((p) => p.projectId === r.targetProjectId)?.projectName ?? r.targetProjectId.slice(0, 8);
                          return (
                            <div key={i} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                              <div className="flex items-center justify-between gap-1">
                                <p className="truncate text-[9px] text-slate-600">{srcProject} → {tgtProject}</p>
                                <span className={`shrink-0 rounded-sm border px-1 py-0.5 text-[7px] uppercase font-semibold ${badgeStyle}`}>{r.riskLevel}</span>
                              </div>
                              <p className="mt-0.5 text-[8px] text-zinc-400">{r.dependencyCount} {r.dependencyCount === 1 ? "dependency" : "dependencies"}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[10px] text-zinc-400">No portfolio data available.</p>
              )}
            </section>

            <section className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-3 shadow-[0_18px_55px_-42px_rgba(34,211,238,0.8)]">
              <p className="text-[9px] font-semibold uppercase tracking-[0.28em] text-cyan-200/80">Project Evidence</p>
              <p className="mt-1 text-[11px] leading-5 text-slate-600">Evidence vault for real project artifacts.</p>
              <div className="mt-3 space-y-1.5">
                <Link
                  href={navHref("/evidence")}
                  className="block rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-cyan-900 transition hover:border-cyan-200/30 hover:bg-cyan-300/[0.08]"
                >
                  Upload Documents
                </Link>
                <Link
                  href={navHref("/evidence")}
                  className="block rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-800 transition hover:border-slate-200 hover:bg-white"
                >
                  View Evidence
                </Link>
                <Link
                  href={navHref("/evidence")}
                  className="block rounded-lg border border-rose-300/15 bg-rose-300/[0.03] px-2.5 py-2 text-[11px] text-rose-900 transition hover:border-rose-200/30 hover:bg-rose-300/[0.08]"
                >
                  Delete Evidence
                </Link>
              </div>
            </section>
          </div>

          {/* User block — pinned bottom */}
          <div className="shrink-0 border-t border-slate-200 px-3.5 py-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-800">{user.fullName}</p>
                <p className="truncate text-[10px] text-zinc-400">{user.role}</p>
              </div>
              {/* Sign-out is a mutation, so it is submitted, not navigated to.
                  A <Link> made it a GET, and Next prefetches links entering the viewport —
                  so rendering this shell issued a real GET /logout and ended the session.
                  A form POST is not prefetchable and not speculatively followed by any
                  agent, and the route now performs the transition only on POST. */}
              <form action="/logout" method="post" className="shrink-0">
                <button
                  type="submit"
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] text-zinc-400 transition-colors hover:border-slate-200 hover:text-slate-700"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </aside>

        {/* ── Main content region ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 md:gap-5">

          {/* Mobile nav strip */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 backdrop-blur-xl lg:hidden">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400/50 motion-safe:animate-[pulse_3s_ease-in-out_infinite]" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-indigo-400" />
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-indigo-300/80">PMFreak</p>
              </div>
              <span className="text-[10px] text-zinc-400">{user.companyName}</span>
            </div>
            <div className="flex snap-x gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {primaryNav.map((item) => (
                <Link
                  key={item.label}
                  href={navHref(item.href)}
                  className={`shrink-0 snap-start rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    navEntryMatchesPathname(item.href, pathname)
                      ? "border-cyan-200/30 bg-cyan-300/[0.08] text-cyan-900"
                      : "border-slate-200 bg-white text-slate-600 hover:text-slate-800"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
              {(utilityNav.length > 0 || advancedNav.length > 0) && (
                <button
                  type="button"
                  onClick={() => setMobileMoreOpen((value) => !value)}
                  aria-expanded={mobileMoreOpen}
                  aria-controls="mobile-more-navigation"
                  className="shrink-0 snap-start rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition-colors hover:text-slate-800"
                >
                  More {mobileMoreOpen ? "▾" : "▸"}
                </button>
              )}
            </div>
            {mobileMoreOpen && (
              <div id="mobile-more-navigation" className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2">
                {[...utilityNav, ...advancedNav].map((item) => (
                  <Link
                    key={item.href}
                    href={navHref(item.href)}
                    onClick={() => setMobileMoreOpen(false)}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      navEntryMatchesPathname(item.href, pathname) ? item.active : `border-slate-200 bg-white ${item.idle}`
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Page content */}
          {activeLens && (
            <p className="px-1 text-[11px] text-slate-500">{activeLens.breadcrumbLabel}</p>
          )}
          {!activeLens && !projectId && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
              <p className="text-sm font-medium text-slate-700">Monitoring</p>
              <p className="mt-1 text-xs text-zinc-500">No active context</p>
              <p className="mt-0.5 text-[11px] text-zinc-400">Create your first context.</p>
            </div>
          )}
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
