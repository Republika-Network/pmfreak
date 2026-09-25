import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { resolveRoutedPmo } from "@/lib/pmos/routed-pmo";
import { PMOS_NAV_HREF, pmoHomePath } from "@/lib/pmos/pmo-paths";
import { PmoArchivedNotice, PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";
import { ContextChatPanel } from "@/components/pmfreak/chat/context-chat-panel";
import { PmoTabNav } from "../pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string; pmoId: string }> };

/**
 * PMO Chat — the canonical, entity-qualified route.
 *
 * Conversational context limited to this PMO's projects only. Authority model is
 * PMO Home's; see that page for why the routed `pmoId` is authorized and the
 * routed `workspaceId` is only an ancestry claim.
 *
 * WHY THE CONVERSATION ITSELF NEEDED NO CHANGE
 * --------------------------------------------
 * The scope this screen mounts is `{ contextType: "pmo", pmoId }`, and the
 * mutation behind it — `POST /api/context-chat` — already derives a pmo scope's
 * `workspace_id` from `pmos.workspace_id` via `getPmoWorkspaceId`, never from the
 * caller's preferred-workspace cookie. That was fixed for its own reasons (a
 * mismatched `workspace_id` on a `context_conversations` row would, through the
 * workspace-membership read policy, expose a conversation to the WRONG
 * workspace's members — see
 * `tests/workspace-pmo-project-validation-sprint.test.mjs`), and it is exactly
 * the property this route family needs: one PMO, one conversation, whichever URL
 * the user arrived through. So the cutover moves the page and touches no chat
 * semantics: no new conversation is created, no existing thread is orphaned, and
 * a legacy `/pmos/P/chat` bookmark lands on the same thread as the canonical URL
 * because both resolve the same `pmoId`.
 */
export default async function PmoChatPage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, pmoId: requestedPmoId } = await params;

  const access = await resolveRoutedPmo(user.id, requestedWorkspaceId, requestedPmoId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "pmo_chat.pmo_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedPmoId,
      }),
    );
    return <PmoNotAvailable />;
  }

  const { workspaceId, pmoId } = access;

  const pmo = await getPmoById(workspaceId, pmoId);
  if (!pmo) return <PmoNotAvailable />;

  // CHAT-SHELL-01: the conversation is the page — a compact orientation header,
  // the PMO's section tabs, then the chat filling the shell's centre.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div>
          <p className="text-[11px] text-slate-500">
            <Link href={PMOS_NAV_HREF} className="hover:text-slate-800">PMOs</Link> /{" "}
            <Link href={pmoHomePath(workspaceId, pmo.id)} className="hover:text-slate-800">{pmo.name}</Link>
          </p>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">
            <span className="mr-1.5">{pmo.icon ?? "🏛️"}</span>
            {pmo.name} — PMO chat
          </h1>
          <p className="mt-0.5 text-xs text-slate-600">Sees only the projects inside this PMO. Never mixes with other PMOs, the workspace chat, or project chats.</p>
        </div>
        <PmoTabNav workspaceId={workspaceId} pmoId={pmo.id} active="chat" />
        {access.access === "archived" ? <PmoArchivedNotice archived={access.archived} /> : null}
      </header>

      <div className="min-h-0 flex-1">
        <ContextChatPanel
          contextType="pmo"
          pmoId={pmo.id}
          layout="surface"
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
      </div>
    </div>
  );
}
