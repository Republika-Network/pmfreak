"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OperationalGovernanceBrief } from "@/lib/projects/first-insight";
import { workspaceCommandCenterPath } from "@/lib/workspace/command-center-paths";
import { CommandCenterLayout } from "./command-center-layout";
import type { ProjectListItem, ToneBadge } from "../../presentation/command-center/types";
import { ProjectBrainOnlineHero } from "@/components/pmfreak/intelligence-inbox/project-brain-online-hero";
import { ProjectIntelligenceInbox } from "@/components/pmfreak/intelligence-inbox/project-intelligence-inbox";
import type { ProjectOnboardingSnapshot } from "@/lib/project-brain/derive-initial-response";
import { markInitialIngestionAction } from "@/app/(protected)/command-center/ingestion-actions";

type UserProject = { id: string; name: string };

function deriveProjectCode(name: string, id: string): string {
  const initials = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
  const suffix = id.replace(/-/g, "").slice(0, 5).toUpperCase();
  return `${initials || "PRJ"}-${suffix}`;
}

function buildProjectListItem(project: UserProject, brief: OperationalGovernanceBrief | null): ProjectListItem {
  const badges: ToneBadge[] = [];
  if (brief) {
    const dangerCount = brief.topExecutionRisks.filter((r) => r.severity === "high" || r.severity === "critical").length;
    if (dangerCount > 0) badges.push({ tone: "danger", label: String(dangerCount) });

    const taskCount = brief.detectedRaidOverview.snapshot.issues;
    if (taskCount > 0) badges.push({ tone: "task", label: String(taskCount) });

    const approvalCount = Math.min(brief.governanceGaps.length, 9);
    if (approvalCount > 0) badges.push({ tone: "approval", label: String(approvalCount) });
  }

  return {
    id: project.id,
    code: deriveProjectCode(project.name, project.id),
    name: project.name,
    fullName: project.name,
    badges,
    hasIntelligence: brief !== null,
    healthy: brief !== null && badges.length === 0,
  };
}

export function CommandCenterClient({
  firstRun = false,
  projectId,
  projectName,
  projectCreatedAt,
  onboarding = null,
  workspaceId,
  projects,
  companyName,
  initialBrief,
  briefGenerationFailed = false,
}: {
  firstRun?: boolean;
  projectId: string;
  projectName: string;
  /** ISO timestamp the project was created — feeds Project Brain source references. */
  projectCreatedAt: string;
  /** The project's onboarding payload, when one exists. */
  onboarding?: ProjectOnboardingSnapshot | null;
  workspaceId: string;
  projects: UserProject[];
  companyName?: string;
  role: string;
  onboardingCompleted: boolean;
  planTier: "free" | "pro" | "pmo";
  canUseAdvancedAi: boolean;
  canUsePortfolioMemory: boolean;
  canUseGovernanceDirectives: boolean;
  initialBrief?: OperationalGovernanceBrief | null;
  briefGenerationFailed?: boolean;
}) {
  const router = useRouter();
  const [brief, setBrief] = useState(initialBrief ?? null);
  const [briefFailed, setBriefFailed] = useState(briefGenerationFailed && !initialBrief);
  const [retryingBrief, setRetryingBrief] = useState(false);
  // The full-screen Project Intelligence Inbox is the landing screen right
  // after activation, but it is never the *only* way back to Project
  // Memory — the "Project Brain" button in the regular dashboard header
  // below re-opens it on any later visit, so this being false after the
  // first visit never means Project Memory becomes unreachable.
  const [showIntelligenceInbox, setShowIntelligenceInbox] = useState(firstRun);
  // Set when the durable initial-ingestion marker could not be advanced. The
  // guided view stays open rather than closing over a write that did not happen.
  const [ingestionMarkerFailed, setIngestionMarkerFailed] = useState(false);

  const projectListItems = useMemo(() => {
    const source = projects.length > 0 ? projects : [{ id: projectId, name: projectName }];
    return source.map((project) => buildProjectListItem(project, project.id === projectId ? brief : null));
  }, [projects, projectId, projectName, brief]);

  const retryBrief = async () => {
    setRetryingBrief(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/operational-governance-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) throw new Error("retry_failed");
      const payload = await response.json();
      setBrief(payload.brief ?? null);
      setBriefFailed(!payload.brief);
    } catch {
      setBriefFailed(true);
    } finally {
      setRetryingBrief(false);
    }
  };

  if (showIntelligenceInbox) {
    return (
      <div className="space-y-5">
        <ProjectBrainOnlineHero projectName={projectName} />
        {ingestionMarkerFailed && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
            <p className="text-xs text-amber-800">
              We couldn&apos;t record that you finished setting up, so this view would have come back
              next time. Nothing you added has been lost — try again in a moment.
            </p>
          </div>
        )}
        <ProjectIntelligenceInbox
          projectId={projectId}
          workspaceId={workspaceId}
          projectName={projectName}
          createdAt={projectCreatedAt}
          onboarding={onboarding}
          onEvidenceAdded={() => { void retryBrief(); }}
          onEnterCommandCenter={() => {
            // Close only once the durable marker actually advanced. Closing
            // regardless used to leave the marker incomplete, so the guided view
            // came back on the next refresh with no sign anything had failed.
            setIngestionMarkerFailed(false);
            void markInitialIngestionAction(workspaceId, projectId, "completed").then((result) => {
              if (result.ok) setShowIntelligenceInbox(false);
              else setIngestionMarkerFailed(true);
            });
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setShowIntelligenceInbox(true)}
          className="flex items-center gap-1.5 rounded-xl border border-cyan-200/60 bg-cyan-400/[0.08] px-3.5 py-1.5 text-xs font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Project Brain
        </button>
      </div>
      {briefFailed && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3">
          <p className="text-sm text-amber-900">Project created. We couldn&apos;t generate the first governance brief yet.</p>
          <button
            type="button"
            onClick={retryBrief}
            disabled={retryingBrief}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-50 disabled:opacity-50"
          >
            {retryingBrief ? "Retrying..." : "Retry brief generation"}
          </button>
        </div>
      )}
      <CommandCenterLayout
        workspaceName={companyName ?? "Your workspace"}
        workspaceId={workspaceId}
        projects={projectListItems}
        activeProjectId={projectId}
        hasBrief={brief !== null}
        onSelectProject={(id) => router.push(workspaceCommandCenterPath(workspaceId, { projectId: id }))}
        onEvidenceAdded={() => { void retryBrief(); }}
      />
    </div>
  );
}
