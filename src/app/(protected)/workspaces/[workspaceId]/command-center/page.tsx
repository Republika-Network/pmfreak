import Link from "next/link";
import { activateContextAction } from "@/app/(protected)/command-center/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthUser } from "@/lib/auth";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { workspaceCommandCenterPath } from "@/lib/workspace/command-center-paths";
import { listPmosWithProjects, type PmoWithProjects } from "@/lib/pmos/pmo-service";
import { CommandCenterClient, CommandCenterEmptyState } from "@/features/command-center";
import { resolveActiveProject } from "@/lib/resolve-active-project";
import { getCompanySubscription } from "@/lib/billing";
import { getPlanCapabilities } from "@/lib/feature-gates";
import { WorkspaceContextBanner } from "@/components/pmfreak/workspace/workspace-context-banner";
import { loadLatestOperationalGovernanceBrief } from "@/lib/projects/first-insight";
import { noteFounderCommandCenterVisit } from "@/lib/founder-program/checkpoints";
import { toProjectBrainOnboardingSnapshot } from "@/lib/projects/onboarding-snapshot";
import { readInitialIngestionStatus, resolveCommandCenterLanding } from "@/lib/projects/initial-ingestion-state";
import { summarizePortfolio } from "@/app/(protected)/command-center/portfolio-summary";

/**
 * Workspace Command Center — the canonical, entity-qualified route.
 *
 * `07-route-layout-and-navigation-architecture.md` §1 names this path; the bare
 * `/command-center` is its compatibility entry point and now resolves the
 * caller's workspace and redirects here (ADR-PMF-068 rule 2 — the old surface
 * keeps working until its replacement is verified).
 *
 * WHY THE WORKSPACE ID IS AUTHORIZED HERE AND NOT TRUSTED
 * ------------------------------------------------------
 * The legacy route derived the workspace from the SESSION, so there was no
 * caller-supplied identity to check. This route reads it from the URL, which
 * makes it untrusted input, and `resolveCanonicalWorkspace` runs on the SERVICE
 * ROLE client — it deliberately bypasses RLS in order to see memberships. So the
 * membership comparison below is the authorization boundary for the path
 * segment; it is not a redundant nicety layered over RLS.
 *
 * `resolveCanonicalWorkspace(userId, requested)` returns the requested
 * workspace when the caller is a member of it and it is not archived/deleted,
 * and otherwise FALLS BACK to their oldest active membership. That fallback is
 * correct for a stale cookie and wrong for a URL: silently rendering workspace
 * B's data at workspace A's address would make the address lie, which is the one
 * thing an entity-qualified route exists to prevent. So a resolution that does
 * not equal the request is refused rather than substituted.
 *
 * The refusal deliberately does not distinguish "no such workspace" from "not
 * your workspace" — the reply is identical either way, so the route cannot be
 * used to probe which workspace ids exist.
 */
export default async function WorkspaceCommandCenterPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ from?: string; projectId?: string; briefGeneration?: string; error?: string; brainActivated?: string }>;
}) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId } = await routeParams;
  const workspaceAccess = await resolveCanonicalWorkspace(user.id, requestedWorkspaceId);

  if (!workspaceAccess.workspaceId || workspaceAccess.workspaceId !== requestedWorkspaceId) {
    console.error(
      JSON.stringify({
        event: "command_center.workspace_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        resolutionStatus: workspaceAccess.status,
      }),
    );
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-6">
          <p className="text-sm font-semibold text-slate-900">This workspace isn&apos;t available to you</p>
          <p className="mt-1 text-xs text-slate-600">
            The workspace in this link either does not exist or is not one you have access to. Nothing
            has been changed. If you followed an old link, open your own Command Center below.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={workspaceAccess.workspaceId ? workspaceCommandCenterPath(workspaceAccess.workspaceId) : "/workspaces"}
              className="inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {workspaceAccess.workspaceId ? "Go to your Command Center" : "Choose a workspace"}
            </a>
          </div>
        </div>
      </div>
    );
  }

  const workspace = { workspaceId: workspaceAccess.workspaceId };
  // Founder Circle onboarding evidence — flag-gated no-op for everyone else,
  // and internally fail-silent so it can never affect this page.
  await noteFounderCommandCenterVisit(user.id);
  const supabase = await createSupabaseServerClient();
  const params = await searchParams;
  const fromOnboarding = params.from === "onboarding";
  const subscription = await getCompanySubscription(user.companyId);
  const capabilities = getPlanCapabilities(subscription.plan);
  const briefGenerationFailed = params.briefGeneration === "failed";

  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id,name")
    .eq("workspace_id", workspace.workspaceId)
    .order("created_at", { ascending: false });

  // Loaded up front (not just in the populated branch below) so a user who
  // just activated a Command Center but hasn't created a project yet can
  // still see a real, honest "invite your team to {pmoName}" nudge in the
  // empty state instead of generic copy.
  //
  // Deliberately non-fatal. The PMO portfolio is contextual, not load-bearing:
  // this screen renders from `projects` alone. listPmosWithProjects throws on
  // any Supabase error (pmo-service.ts:35,48) and this call sits *before* the
  // empty-state guard below, so an unhandled failure here took down the whole
  // Command Center — including the empty state a brand-new account is meant
  // to land on. A failure now degrades this one strip and nothing else.
  //
  // Workspace isolation is unchanged: the query is still scoped to
  // workspace.workspaceId, and failing yields *less* data, never another
  // workspace's.
  let pmoPortfolio: PmoWithProjects[] | null = null;
  try {
    pmoPortfolio = await listPmosWithProjects(workspace.workspaceId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "command_center.pmo_portfolio_unavailable",
        workspaceId: workspace.workspaceId,
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  const portfolio = summarizePortfolio(pmoPortfolio);

  // A failed projects read is "we could not load your projects", not "you
  // have none". Falling through to the empty state would tell an established
  // workspace to create its first project — a false claim about their data.
  // Classified explicitly rather than silently swallowed, and recoverable:
  // retry plus safe navigation.
  if (projectsError) {
    console.error(
      JSON.stringify({
        event: "command_center.projects_unavailable",
        workspaceId: workspace.workspaceId,
        reason: projectsError.message,
      }),
    );
    return (
      <div className="space-y-4">
        <WorkspaceContextBanner lens="Command Center" />
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load your projects</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading your workspace, not a permissions issue. Nothing has
            been changed or lost. Please try again in a moment.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={workspaceCommandCenterPath(workspace.workspaceId)}
              className="inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Try again
            </a>
          </div>
        </div>
      </div>
    );
  }

  if ((projects ?? []).length === 0) {
    return (
      <div className="space-y-4">
        <WorkspaceContextBanner lens="Command Center" />
        <CommandCenterEmptyState
          activateAction={activateContextAction}
          errorMessage={params.error}
          fromOnboarding={fromOnboarding}
          pmoName={portfolio.status === "available" ? portfolio.firstPmoName : null}
        />
      </div>
    );
  }

  const projectList = (projects ?? []) as { id: string; name: string }[];
  const resolution = resolveActiveProject(projectList, params.projectId);

  if (resolution.invalidId) {
    return (
      <div className="space-y-4">
        <WorkspaceContextBanner lens="Command Center" />
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">Project not found in this workspace</p>
          <p className="mt-1 text-xs text-amber-700/80">
            The project referenced in the URL does not belong to your active workspace or you do not have
            access. Select a project below or navigate to the Command Center without a project filter.
          </p>
          <a
            href={workspaceCommandCenterPath(workspace.workspaceId)}
            className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Reset to default project
          </a>
        </div>
      </div>
    );
  }

  // Distinct from `fromOnboarding` above: this only fires when the wizard's
  // own redirect just activated *this exact* project's brain — not for the
  // PMO activation or invite-team flows, which also use `from=onboarding`
  // but never set `brainActivated` and often carry no projectId at all.
  const brainJustActivated = params.brainActivated === "1" && params.projectId === resolution.project!.id;

  const initialBrief = await loadLatestOperationalGovernanceBrief(resolution.project!.id, supabase);

  // Scoped by workspace_id in addition to id, matching the project list
  // query above — the active project id was already resolved against this
  // workspace's own project list, so this can never read another
  // workspace's project row.
  const { data: activeProjectRow } = await supabase
    .from("projects")
    .select("created_at,onboarding_payload")
    .eq("id", resolution.project!.id)
    .eq("workspace_id", workspace.workspaceId)
    .maybeSingle<{ created_at: string; onboarding_payload: unknown }>();
  const projectCreatedAt = activeProjectRow?.created_at ?? new Date(0).toISOString();
  const onboardingSnapshot = toProjectBrainOnboardingSnapshot(activeProjectRow?.onboarding_payload ?? null);

  // Which view this Command Center opens with, derived from DURABLE state on
  // the project row above (no extra query — onboarding_payload is already
  // selected). `brainJustActivated` is only an advisory hand-off hint now: it
  // can force the ingestion experience open, but a refresh or a later return
  // no longer loses the guided first experience, because the marker persists.
  const initialIngestionStatus = readInitialIngestionStatus(activeProjectRow?.onboarding_payload ?? null);
  const landingView = resolveCommandCenterLanding({
    ingestionStatus: initialIngestionStatus,
    activationHint: brainJustActivated,
  });

  // Operations strip: the Command Center is the workspace's operations
  // console, so it surfaces the full PMO portfolio, not just one project.
  // When the portfolio load failed the strip says so plainly — it must never
  // render "0 PMOs · 0 projects", which would assert a count we do not have.

  return (
    <div className="space-y-4">
      <WorkspaceContextBanner lens="Command Center" />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
        <p className="text-xs text-slate-600">
          {portfolio.status === "available" ? (
            <>
              Operating across <span className="font-semibold text-slate-900">{portfolio.pmoCount}</span> PMO{portfolio.pmoCount === 1 ? "" : "s"} ·{" "}
              <span className="font-semibold text-slate-900">{portfolio.projectCount}</span> project{portfolio.projectCount === 1 ? "" : "s"} ({portfolio.activeProjectCount} active)
            </>
          ) : (
            "Portfolio overview is temporarily unavailable. The projects below are unaffected."
          )}
        </p>
        <div className="flex gap-2 text-xs font-medium">
          <Link href="/pmos" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-slate-700 transition hover:bg-slate-50">Manage PMOs</Link>
          <Link href="/chat" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-slate-700 transition hover:bg-slate-50">Workspace Chat</Link>
        </div>
      </div>
      <CommandCenterClient
        key={resolution.project!.id}
        firstRun={landingView === "ingestion"}
        projectId={resolution.project!.id}
        projectName={resolution.project!.name}
        projectCreatedAt={projectCreatedAt}
        onboarding={onboardingSnapshot}
        workspaceId={workspace.workspaceId}
        projects={projectList}
        companyName={user.companyName}
        role={user.role}
        onboardingCompleted={user.onboardingCompleted}
        planTier={subscription.plan}
        canUseAdvancedAi={capabilities.advanced_ai_actions}
        canUsePortfolioMemory={capabilities.organizational_memory}
        canUseGovernanceDirectives={capabilities.governance_directives}
        initialBrief={initialBrief}
        briefGenerationFailed={briefGenerationFailed && !initialBrief}
      />
    </div>
  );
}
