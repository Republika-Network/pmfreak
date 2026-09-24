import { notFound, redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { projectCommandCenterPath } from "@/lib/projects/project-command-center-paths";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * Legacy Project Chat — now a COMPATIBILITY REDIRECT (PB-CHAT-01).
 *
 * This screen used to render its own deterministic `ContextChatPanel`, a second
 * project chat competing with the Command Center's. PB-CHAT-01 unified both into
 * ONE persisted Project Brain conversation that lives in the Project Command
 * Center. Bookmarks and external links to `/projects/[id]/chat` keep working:
 * they land on the canonical Project Command Center for the same project, whose
 * Project Brain panel shows the same (preserved) thread.
 *
 * The workspace segment comes from the project's OWN row (`projects.workspace_id`,
 * read with the caller's RLS client) — never from a cookie — and the canonical
 * route re-authorizes on arrival. An unreadable project is a 404, exactly as
 * before, so the redirect is not an existence oracle.
 */
export default async function ProjectChatPage({ params }: Props) {
  await requireAuthUser();
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id")
    .eq("id", id)
    .maybeSingle<{ id: string; workspace_id: string }>();
  if (!project) notFound();

  await evaluateCapabilityAccess({ workspaceId: project.workspace_id, projectId: project.id, permission: "read" });

  redirect(projectCommandCenterPath(project.workspace_id, project.id));
}
