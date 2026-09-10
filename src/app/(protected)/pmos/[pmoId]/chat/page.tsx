import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { ContextChatPanel } from "@/components/pmfreak/chat/context-chat-panel";
import { PmoTabNav } from "../pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * PMO Chat — conversational context limited to this PMO's projects only.
 */
export default async function PmoChatPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const resolution = await resolvePreferredWorkspace(user.id);
  if (!resolution.workspaceId) notFound();

  const pmo = await getPmoById(resolution.workspaceId, pmoId);
  if (!pmo) notFound();

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href="/pmos" className="hover:text-cyan-900">PMOs</Link> / <Link href={`/pmos/${pmo.id}`} className="hover:text-cyan-900">{pmo.name}</Link> / Chat
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
          {pmo.name} — Chat
        </h1>
        <div className="mt-4">
          <PmoTabNav workspaceId={resolution.workspaceId} pmoId={pmo.id} active="chat" />
        </div>
      </header>

      <ContextChatPanel
        contextType="pmo"
        pmoId={pmo.id}
        title="PMO Conversation"
        subtitle="Sees only the projects inside this PMO. Never mixes with other PMOs, the workspace chat, or project chats."
        placeholder="Which projects are behind? Which risks grew this week?"
        suggestions={[
          "Which projects are behind?",
          "Which risks grew this week?",
          "Which commitments are still open?",
          "Generate an executive report",
        ]}
      />
    </main>
  );
}
