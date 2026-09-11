import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { canInviteMembers, type WorkspaceRole } from "@/lib/workspace-access";
import { WORKSPACES_NAV_HREF, workspaceHomePath } from "@/lib/workspaces/workspace-paths";
import { WorkspaceArchivedNotice, WorkspaceNotAvailable } from "@/components/pmfreak/workspace/workspace-route-states";
import { WorkspaceTabNav } from "../workspace-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string }> };

/**
 * Workspace Settings — the canonical, entity-qualified route.
 *
 * WHAT THIS SCREEN HONESTLY IS, AND WHY IT IS SMALLER THAN THE CATALOG
 * -------------------------------------------------------------------
 * `03-screen-catalog.md` §4 names four future tabs (General, Members,
 * Integrations, Billing) and two future modals (Rename Workspace, archive-
 * Workspace confirmation). Only part of that exists in this product today, and
 * this screen shows only the part that does. A tab that names a capability the
 * code cannot perform is worse than an absent tab: the catalog is a plan, and
 * rendering a plan as if it were a feature is how a screen starts lying.
 *
 * What the repository actually supports at workspace scope, verified rather than
 * assumed:
 *
 *   - Workspace identity — `workspaces.name`, read-only. There is NO rename
 *     mutation anywhere in `src/`: `createWorkspace` inserts, and nothing ever
 *     updates the row's name. So no rename control is offered.
 *   - Archival — `workspaces.status` is read by `resolveRoutedWorkspace` and
 *     drives the §7 read-only state, but nothing in the product WRITES it. So
 *     the state is reported and no archive/restore control is offered.
 *   - Membership — `workspace_memberships` is real, and the caller's own role in
 *     THIS workspace comes from the resolver that authorized the route.
 *   - Invitations — `workspace_invitations` is real, and `/team` owns the invite
 *     mutation with its role gate (`requireWorkspaceRole(workspaceId, "admin")`),
 *     its abuse limits, and its `canAssignWorkspaceRole` policy.
 *   - Billing — `/billing` owns it, gated by `canManageBilling`.
 *
 * THIS SCREEN ADDS NO MUTATIONS AT ALL
 * ------------------------------------
 * It reads, and it links out to the surfaces that already own each change. That
 * is a deliberate boundary, not an oversight: every workspace-scoped mutation in
 * this product already has an authorization story (role gate, abuse limit, audit
 * path), and re-hosting one behind a new route means re-implementing that story
 * or importing it half-way. Moving `/team` here wholesale would be redesigning
 * administration, which this slice does not do. The canonical route now exists,
 * is authorized correctly, and is where the next slice can land real controls.
 *
 * AUTHORITY
 * ---------
 * Identical to Workspace Home's, and for the same reason: the routed segment is
 * untrusted input, `resolveRoutedWorkspace` authorizes the exact id or refuses
 * with no fallback, and the preferred-workspace cookie is never consulted. Every
 * read below is scoped by the AUTHORIZED id, so a caller who edits the URL reads
 * nothing they could not already read — and the role that gates the invitations
 * panel is their role in THIS workspace, not in whichever workspace they were
 * last in.
 */
export default async function WorkspaceSettingsPage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId } = await params;

  const access = await resolveRoutedWorkspace(user.id, requestedWorkspaceId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "workspace_settings.workspace_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
      }),
    );
    return <WorkspaceNotAvailable />;
  }

  const { workspaceId, role } = access;
  const isArchived = access.access === "archived";

  const supabase = await createSupabaseServerClient();
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle<{ id: string; name: string }>();

  if (!workspace) return <WorkspaceNotAvailable />;

  const { data: memberRows } = await supabase
    .from("workspace_memberships")
    .select("user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  // Pending invitations carry other people's email addresses, so they are shown
  // only to the roles that may act on them — the same owner/admin boundary
  // `canInviteMembers` already enforces for creating one. This NARROWS what a pm
  // or viewer can see relative to `/team`, which shows the list to any member; it
  // widens nothing, and it changes no gate `/team` enforces.
  const canInvite = role ? canInviteMembers(role as WorkspaceRole) : false;
  const { data: inviteRows, error: invitesError } = canInvite
    ? await supabase
        .from("workspace_invitations")
        .select("email, role, status, expires_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
    : { data: null, error: null };

  const members = memberRows ?? [];
  const invites = inviteRows ?? [];
  // A failed read is not an empty list. "No pending invitations" would tell an
  // admin nobody is waiting on them, which is a claim about their workspace we
  // did not actually make.
  const invitesUnavailable = Boolean(invitesError);

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href={WORKSPACES_NAV_HREF} className="hover:text-cyan-900">Workspaces</Link> /{" "}
          <Link href={workspaceHomePath(workspaceId)} className="hover:text-cyan-900">{workspace.name}</Link> / Settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{workspace.name} — Settings</h1>
        <div className="mt-4">
          <WorkspaceTabNav workspaceId={workspaceId} active="settings" />
        </div>
      </header>

      {isArchived ? <WorkspaceArchivedNotice /> : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">General</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Workspace name</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900">{workspace.name}</dd>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Your role here</dt>
            <dd className="mt-1 text-sm font-semibold uppercase text-cyan-800">{role ?? "member"}</dd>
          </div>
        </dl>
        {/* Said plainly rather than implied by an absent button. A settings screen
            with nothing to change reads as broken unless it says why. */}
        <p className="mt-3 text-xs text-slate-600">
          Renaming and archiving a workspace aren&apos;t available in the product yet, so there&apos;s
          nothing to change here today.
        </p>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Members</h2>
        <p className="mt-1 text-sm text-slate-600">Everyone with access to this workspace, and their role.</p>
        {members.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No members could be listed for this workspace.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {members.map((member) => (
              <li
                key={member.user_id}
                className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2"
              >
                {/* The same truncated identifier `/team` shows. This screen adds no
                    new way to read who someone is — surfacing names or emails here
                    would be a new disclosure, not a route migration. */}
                <span className="text-slate-800">
                  {member.user_id.slice(0, 8)}…
                  {member.user_id === user.id ? <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">You</span> : null}
                </span>
                <span className="uppercase text-cyan-800">{member.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canInvite ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">Pending invitations</h2>
          {invitesUnavailable ? (
            <p className="mt-2 text-sm text-slate-600">
              We couldn&apos;t load this workspace&apos;s pending invitations. This is a temporary
              problem, not a permissions issue, and nothing has been changed.
            </p>
          ) : invites.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No pending invitations.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {invites.map((invite) => (
                <li
                  key={`${invite.email}-${invite.expires_at}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2"
                >
                  <span className="text-slate-800">{invite.email}</span>
                  <span className="text-xs text-zinc-600">
                    {invite.role} · {invite.status} · expires {new Date(invite.expires_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Administration</h2>
        <p className="mt-1 text-sm text-slate-600">
          These changes are made on the surfaces that own them, with their existing permissions.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Link href="/team" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">
            Invite &amp; manage members
          </Link>
          <Link href="/billing" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">
            Billing
          </Link>
        </div>
      </section>
    </main>
  );
}
