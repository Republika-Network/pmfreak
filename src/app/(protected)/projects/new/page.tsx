import Link from "next/link";
import { CreateProjectWizard } from "@/components/pmfreak/projects/create-project-wizard";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPmoWorkspaceId } from "@/lib/pmos/pmo-service";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { firstQueryValue } from "@/lib/workspace/command-center-paths";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Create a project — in an EXPLICIT, server-authorized workspace (CHAT-SHELL-01 F1).
 *
 * The conversation shell shows whatever workspace the ROUTE names, and a canonical deep
 * link deliberately does not change the preferred-workspace cookie. So "New project"
 * carries the workspace being displayed (`?workspaceId=`), or a PMO whose own workspace
 * decides it (`?pmoId=`). Either is only a claim: it is authorized here with
 * `resolveRoutedWorkspace` (active membership, no fallback) before the form is shown,
 * and the save action authorizes it AGAIN, because a value that reaches the browser can
 * come back altered. A claim that does not authorize is refused on this page; it never
 * degrades into the cookie's workspace. With no claim at all the preferred workspace is
 * used exactly as before — and named on the page, so the target is never implicit.
 */
export default async function CreateProjectPage({ searchParams }: Props) {
  const user = await requireAuthUser();
  const raw = await searchParams;
  const pmoId = firstQueryValue(raw.pmoId);
  const requestedWorkspaceId = firstQueryValue(raw.workspaceId);
  const supabase = await createSupabaseServerClient();

  // The PMO's workspace comes from the PMO row (read through the caller's own RLS
  // session), never from the URL; an unreadable PMO yields no claim.
  const claim = requestedWorkspaceId ?? (pmoId ? await getPmoWorkspaceId(pmoId) : null);
  let targetWorkspaceId: string | null = null;
  if (claim) {
    const access = await resolveRoutedWorkspace(user.id, claim);
    if (access.access !== "granted") {
      return (
        <section className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6" data-testid="create-project-target-refused">
          <p className="text-sm font-semibold text-slate-900">You can&apos;t create a project in that workspace</p>
          <p className="mt-1 text-xs text-slate-600">
            The workspace in this link is not an active workspace you belong to. Nothing has been created.
          </p>
          <Link href="/workspaces" className="mt-3 inline-block rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Choose a workspace
          </Link>
        </section>
      );
    }
    targetWorkspaceId = access.workspaceId;
  }
  const displayedWorkspaceId = targetWorkspaceId ?? (await resolvePreferredWorkspace(user.id)).workspaceId;
  const { data: displayedWorkspace } = displayedWorkspaceId
    ? await supabase.from("workspaces").select("id, name").eq("id", displayedWorkspaceId).maybeSingle<{ id: string; name: string }>()
    : { data: null };

  return (
    <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-[#050507] p-6 shadow-[0_40px_120px_rgba(0,0,0,0.55)] md:p-10">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="pointer-events-none absolute -left-32 top-10 h-96 w-96 rounded-full bg-indigo-500/10 blur-[160px]" />
      <div className="pointer-events-none absolute right-[-8%] top-20 h-[28rem] w-[28rem] rounded-full bg-cyan-500/10 blur-[180px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/2 h-64 w-[60%] -translate-x-1/2 rounded-full bg-fuchsia-500/[0.06] blur-[120px]" />

      <div className="relative">
        <header className="mb-10">
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-400/60">PMFreak · Project Intelligence</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">
            Initialize Project Intelligence
          </h1>
          <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-zinc-500">
            Build the governance context that powers your AI project agents. Every risk signal, stakeholder insight, and delivery escalation traces back to this foundation.
          </p>
          {displayedWorkspace ? (
            <p className="mt-3 text-xs text-zinc-600" data-testid="create-project-target-workspace" data-workspace-id={displayedWorkspace.id}>
              Creating in workspace <span className="font-semibold text-slate-900">{displayedWorkspace.name}</span>
            </p>
          ) : null}
        </header>

        <CreateProjectWizard pmoId={pmoId} workspaceId={targetWorkspaceId ?? undefined} />
      </div>
    </section>
  );
}
