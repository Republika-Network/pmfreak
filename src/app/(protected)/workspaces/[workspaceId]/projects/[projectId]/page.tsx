import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { resolveRoutedProject } from "@/lib/projects/routed-project";
import { ProjectArchivedNotice, ProjectNotAvailable } from "@/components/pmfreak/projects/project-route-states";
import { ProjectConversationView } from "@/components/pmfreak/conversation-shell/project-conversation-view";
import { parseProjectTool } from "@/components/pmfreak/conversation-shell/operational-tools";
import { projectBriefIndicators } from "@/components/pmfreak/conversation-shell/project-brief-indicators";
import { projectHomePath, projectOverviewPath } from "@/lib/projects/project-paths";
import { projectCommandCenterPath, resolveProjectPmoAncestry } from "@/lib/projects/project-command-center-paths";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";
import { workspaceCommandCenterPath, workspaceHomePath } from "@/lib/workspaces/workspace-paths";
import { loadLatestOperationalGovernanceBrief } from "@/lib/projects/first-insight";
import type { ProjectStatus } from "@/lib/db/database-contract";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type ProjectIdentityRow = {
  id: string;
  workspace_id: string;
  pmo_id: string | null;
  name: string;
  status: ProjectStatus;
  icon: string | null;
  color: string | null;
};

/**
 * The project, as a conversation — the canonical project route (CHAT-SHELL-01).
 *
 * `/workspaces/[workspaceId]/projects/[projectId]` is where every project link
 * lands: the context tree, breadcrumbs, `/projects/<id>` and `/projects/<id>/chat`
 * redirects, and the Workspace Command Center's hand-off. It renders the
 * project's ONE persisted Project Brain conversation as the primary surface of
 * the shell, with the Command Center's operational tools beside it.
 *
 * The screen that used to live here (identity, execution CRUD, PM assignment,
 * analyses) moved unchanged to `/overview`; the four-zone read-only projection
 * stays at `/command-center`. Neither embeds the conversation any more — there
 * is exactly one place a project's conversation is rendered, and it is here.
 *
 * AUTHORITY — identical to the screen this replaces
 * -------------------------------------------------
 * Both segments are untrusted. `resolveRoutedProject` authorizes the routed
 * `projectId` against real membership and refuses an ancestry claim that
 * disagrees with `projects.workspace_id` — with no fallback of any kind, and one
 * indistinguishable refusal for absent, deleted, unauthorized and mismatched
 * ids, so the route is not an existence oracle. `evaluateCapabilityAccess` then
 * applies policy (`project.read`) to the AUTHORIZED pair. Every read below is
 * scoped by the authoritative workspace AND the exact project, through the
 * caller's own RLS session.
 *
 * The conversation itself is a client island that loads and posts only through
 * `/api/projects/[id]/brain/turns`, which derives the workspace from the project
 * row and re-authorizes (`project_brain.converse`) on every call. This page
 * passes it an id, never data, and grants it nothing.
 *
 * `?tool=` may ask for an operational tool to start open. It is parsed against
 * a closed list — anything else opens nothing — and it only decides which panel
 * is visible, never what is read or who may read it.
 */
export default async function ProjectConversationPage({ params, searchParams }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, projectId: requestedProjectId } = await params;

  const access = await resolveRoutedProject(user.id, requestedWorkspaceId, requestedProjectId);
  if (access.access === "denied") {
    // Only what the caller already supplied — a refusal emits no derived facts.
    console.error(
      JSON.stringify({
        event: "project_conversation.project_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedProjectId,
      }),
    );
    return <ProjectNotAvailable />;
  }

  const { workspaceId, projectId } = access;
  await evaluateCapabilityAccess({ workspaceId, projectId, permission: "read" });

  const supabase = await createSupabaseServerClient();
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, workspace_id, pmo_id, name, status, icon, color")
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .maybeSingle<ProjectIdentityRow>();

  if (projectError) {
    console.error(
      JSON.stringify({ event: "project_conversation.project_unavailable", workspaceId, projectId, reason: projectError.message }),
    );
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load this project</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading your workspace, not a permissions issue. Nothing has been changed or
            lost. Please try again in a moment.
          </p>
          <a
            href={projectHomePath(workspaceId, projectId)}
            className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }

  // Authorized a moment ago but unreadable now: same refusal, same wording.
  if (!project) return <ProjectNotAvailable />;

  // Ancestry and header facts, in parallel. The PMO read is scoped by the
  // AUTHORIZED workspace as well as the id — `pmo_id`'s FK does not constrain it
  // to this workspace, and a header is not the place to discover cross-tenant
  // data. Its error is carried, never rendered as "no PMO".
  const [workspaceRead, pmoRead, brief] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", workspaceId).maybeSingle<{ id: string; name: string }>(),
    project.pmo_id
      ? supabase
          .from("pmos")
          .select("id, name")
          .eq("id", project.pmo_id)
          .eq("workspace_id", workspaceId)
          .maybeSingle<{ id: string; name: string }>()
      : Promise.resolve({ data: null, error: null }),
    loadLatestOperationalGovernanceBrief(project.id, supabase).catch(() => null),
  ]);

  const ancestry = resolveProjectPmoAncestry({
    pmoId: project.pmo_id,
    row: pmoRead.data,
    error: pmoRead.error ? { message: pmoRead.error.message } : null,
  });
  if (ancestry.state === "unavailable") {
    console.error(
      JSON.stringify({ event: "project_conversation.pmo_ancestry_unavailable", workspaceId, projectId, reason: pmoRead.error?.message }),
    );
  }

  // The role in the PROJECT'S workspace decides whether task controls are offered.
  // Server actions, `requireProjectAccess` and RLS remain the enforcement.
  const canCreateTask = access.role !== null && access.role !== "viewer";
  const initialTool = parseProjectTool((await searchParams).tool);

  const notice =
    access.access === "archived" || ancestry.state === "unavailable" ? (
      <div className="space-y-2">
        {access.access === "archived" ? <ProjectArchivedNotice archived={access.archived} /> : null}
        {ancestry.state === "unavailable" ? (
          <p className="text-[11px] text-amber-800">PMO ancestry is temporarily unavailable.</p>
        ) : null}
      </div>
    ) : null;

  return (
    <ProjectConversationView
      key={project.id}
      workspaceId={workspaceId}
      project={{ id: project.id, name: project.name, status: project.status, icon: project.icon, color: project.color }}
      workspaceName={workspaceRead.data?.name ?? "Workspace"}
      pmoName={ancestry.pmo?.name ?? null}
      initialTool={initialTool}
      hasBrief={brief !== null}
      indicators={projectBriefIndicators(brief)}
      canCreateTask={canCreateTask}
      notice={notice}
      links={{
        workspace: workspaceHomePath(workspaceId),
        pmo: ancestry.pmo ? pmoHomePath(workspaceId, ancestry.pmo.id) : null,
        overview: projectOverviewPath(workspaceId, project.id),
        operationalOverview: projectCommandCenterPath(workspaceId, project.id),
        guidedSetup: workspaceCommandCenterPath(workspaceId, { projectId: project.id, view: "inbox" }),
        documents: `/upload?projectId=${encodeURIComponent(project.id)}`,
        evidence: `/evidence?projectId=${encodeURIComponent(project.id)}`,
        settings: `/projects/${encodeURIComponent(project.id)}/settings`,
      }}
    />
  );
}
