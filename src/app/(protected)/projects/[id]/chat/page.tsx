import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { ContextChatPanel } from "@/components/pmfreak/chat/context-chat-panel";
import { ProjectTabNav } from "@/components/pmfreak/projects/project-tab-nav";
import { projectHomePath } from "@/lib/projects/project-paths";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * Project Chat — this project's own isolated conversation. History, memory,
 * and grounding never cross into any other project, PMO, or the workspace.
 *
 * DELIBERATELY NOT MIGRATED BY THIS SLICE.
 * `07-route-layout-and-navigation-architecture.md` §2's ratified Project family
 * has no `chat` member, so there is no canonical `/workspaces/W/projects/P/chat`
 * to move to and no architecture evidence authorizing one; §9 does not classify
 * this path at all. What DID change is where its two Project-Home links point:
 * the breadcrumb and the tab strip now lead to canonical Project Home, which is
 * safe because `projects.workspace_id` is read right here on this page. That is a
 * link correction, not a route migration — this screen still lives at
 * `/projects/[id]/chat` and still renders itself.
 */
export default async function ProjectChatPage({ params }: Props) {
  await requireAuthUser();
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id, name, icon")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  await evaluateCapabilityAccess({ workspaceId: project.workspace_id, projectId: project.id, permission: "read" });

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href={projectHomePath(project.workspace_id, project.id)} className="hover:text-cyan-900">{project.name}</Link> / Chat
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {project.icon ? <span className="mr-2">{project.icon}</span> : null}
          {project.name} — Chat
        </h1>
        <div className="mt-4">
          <ProjectTabNav workspaceId={project.workspace_id} projectId={project.id} active="chat" />
        </div>
      </header>

      <ContextChatPanel
        contextType="project"
        projectId={project.id}
        title="Project Conversation"
        subtitle="Private to this project. Other projects, PMOs, and the workspace chat can never see or reuse this thread."
        placeholder="What changed this week? Which risks are open?"
        suggestions={[
          "Summarize this project's status",
          "Which risks are open?",
          "What is overdue?",
        ]}
      />
    </main>
  );
}
