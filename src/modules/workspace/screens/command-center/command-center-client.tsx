"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OperationalGovernanceBrief } from "@/lib/projects/first-insight";
import { projectHomePath } from "@/lib/projects/project-paths";
import { ProjectBrainOnlineHero } from "@/components/pmfreak/intelligence-inbox/project-brain-online-hero";
import { ProjectIntelligenceInbox } from "@/components/pmfreak/intelligence-inbox/project-intelligence-inbox";
import type { ProjectOnboardingSnapshot } from "@/lib/project-brain/derive-initial-response";
import { markInitialIngestionAction } from "@/app/(protected)/command-center/ingestion-actions";

/**
 * The Workspace Command Center's guided first experience — the Project
 * Intelligence Inbox shown right after a project's brain is activated.
 *
 * CHAT-SHELL-01: this used to switch, after the guided view, into the embedded
 * Command Center application (an inner project sidebar, an attention canvas and a
 * collapsible Project Brain panel). That application is gone. A project's
 * operational home is now its conversation — Project Brain in the centre of the
 * shell, the Command Center's tools beside it — so leaving the guided view goes
 * THERE, to the canonical project route, rather than revealing a second product.
 *
 * The route renders this only for the guided experience (a durable
 * initial-ingestion marker still open, an activation hand-off, an explicit
 * `view=inbox`, or a brief that failed to generate); every other visit redirects
 * to the project conversation. The conversation's Project tool links back here,
 * so the guided view is never the only way into Project Memory — and never the
 * only way out.
 */
export function CommandCenterClient({
  projectId,
  projectName,
  projectCreatedAt,
  onboarding = null,
  workspaceId,
  initialBrief,
  briefGenerationFailed = false,
}: {
  projectId: string;
  projectName: string;
  /** ISO timestamp the project was created — feeds Project Brain source references. */
  projectCreatedAt: string;
  /** The project's onboarding payload, when one exists. */
  onboarding?: ProjectOnboardingSnapshot | null;
  workspaceId: string;
  initialBrief?: OperationalGovernanceBrief | null;
  briefGenerationFailed?: boolean;
}) {
  const router = useRouter();
  const [brief, setBrief] = useState(initialBrief ?? null);
  const [briefFailed, setBriefFailed] = useState(briefGenerationFailed && !initialBrief);
  const [retryingBrief, setRetryingBrief] = useState(false);
  // Set when the durable initial-ingestion marker could not be advanced. The
  // guided view stays open rather than closing over a write that did not happen.
  const [ingestionMarkerFailed, setIngestionMarkerFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);

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

  const openConversation = () => router.push(projectHomePath(workspaceId, projectId));

  return (
    <div className="space-y-5" data-brief-ready={brief ? "true" : "false"}>
      <ProjectBrainOnlineHero projectName={projectName} />
      {briefFailed && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3">
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
          // Leave only once the durable marker actually advanced. Leaving regardless
          // used to leave the marker incomplete, so the guided view came back on the
          // next visit with no sign anything had failed.
          if (leaving) return;
          setIngestionMarkerFailed(false);
          setLeaving(true);
          void markInitialIngestionAction(workspaceId, projectId, "completed").then((result) => {
            if (result.ok) openConversation();
            else {
              setIngestionMarkerFailed(true);
              setLeaving(false);
            }
          });
        }}
      />
    </div>
  );
}
