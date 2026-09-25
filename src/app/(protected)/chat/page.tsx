import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listPmosWithProjects } from "@/lib/pmos/pmo-service";
import { ContextChatPanel } from "@/components/pmfreak/chat/context-chat-panel";

export const dynamic = "force-dynamic";

/**
 * Workspace Chat — the workspace-level conversational console.
 * Context: every PMO in the workspace (and nothing outside it).
 */
export default async function WorkspaceChatPage() {
  const user = await requireAuthUser();
  const resolution = await resolvePreferredWorkspace(user.id);
  if (!resolution.workspaceId) {
    return <main className="m-6 rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-700">No active workspace. Create one to start.</main>;
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: workspace }, pmos] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", resolution.workspaceId).maybeSingle<{ id: string; name: string }>(),
    listPmosWithProjects(resolution.workspaceId),
  ]);

  const totalProjects = pmos.reduce((sum, pmo) => sum + pmo.projects.length, 0);
  const activeProjects = pmos.reduce((sum, pmo) => sum + pmo.projects.filter((p) => p.status === "active").length, 0);

  // CHAT-SHELL-01: the conversation is the page. A one-line orientation header,
  // then the chat filling the shell's centre — not a card beneath a dashboard.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <p className="text-[11px] text-slate-500">
          {pmos.length} PMO{pmos.length === 1 ? "" : "s"} · {totalProjects} project{totalProjects === 1 ? "" : "s"} · {activeProjects} active
        </p>
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">{workspace?.name ?? "Workspace"} — Workspace chat</h1>
        <p className="mt-0.5 text-xs text-slate-600">
          Global questions about your whole operation. This conversation sees every PMO in this workspace — and nothing beyond it.
          {pmos.length === 0 ? (
            <>
              {" "}No PMOs yet. <Link href="/pmos" className="text-cyan-800 underline-offset-2 hover:underline">Create your first PMO</Link> to organize projects.
            </>
          ) : null}
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <ContextChatPanel
          contextType="workspace"
          layout="surface"
          title="Workspace Conversation"
          subtitle="Aggregates every PMO in this workspace. Never mixes with PMO or project chats."
          placeholder="How many projects do I have? Which PMOs carry the most risk?"
          suggestions={[
            "How many projects do I have?",
            "Which projects need attention today?",
            "Which risks are open across the workspace?",
            "Generate an executive summary",
          ]}
        />
      </div>
    </div>
  );
}
