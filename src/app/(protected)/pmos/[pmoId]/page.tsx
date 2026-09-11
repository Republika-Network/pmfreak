import { redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolveLegacyPmoRoute } from "@/lib/pmos/routed-pmo";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";
import { PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * Legacy PMO Home entry point — a resolver, not a screen.
 *
 * PMO Home moved to `/workspaces/[workspaceId]/pmos/[pmoId]`. This path stays
 * because bookmarks, pasted links and anything already in someone's notes
 * predate the move, and per ADR-PMF-068 a legacy route keeps serving until its
 * replacement is verified. What it does NOT keep is a copy of the screen: one
 * implementation, one destination, so the two cannot drift (ADR-PMF-068 rule 2).
 * That is the whole point of a strangler seam — if this file rendered a portfolio
 * of its own we would have two PMO Homes to fix every time one of them changed.
 *
 * WHERE `W` COMES FROM, AND WHERE IT MUST NOT
 * -------------------------------------------
 * A legacy URL names only a PMO, so the redirect has to discover its workspace.
 * `resolveLegacyPmoRoute` reads it from `pmos.workspace_id` — the authority — and
 * from nowhere else. Not from the preferred-workspace cookie, not from the
 * caller's first membership, not from the shell's current context, not from the
 * previous page. The consequence is the property the old route did not have:
 * `/pmos/P` resolves to ONE canonical URL, the same one for every caller and
 * every session, instead of following whichever workspace the user was last in.
 * A client-controlled cookie cannot steer where this redirect goes.
 *
 * MISSING AND UNAUTHORIZED ARE THE SAME ANSWER
 * --------------------------------------------
 * A PMO that does not exist, one that was deleted, and one the caller has no
 * membership for all arrive here as `denied` and render the identical refusal.
 * This route must not become an existence oracle: "redirect" versus "refusal" is
 * the only signal it emits, and it is the same signal the canonical route emits,
 * so nothing is learned by trying the legacy path instead.
 *
 * An ARCHIVED PMO redirects normally. Archival is a read-only state, not a
 * deletion (`07-route…` §7), so its identity stays routable and the canonical
 * screen is what explains the state.
 */
export default async function LegacyPmoHomeRedirectPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const access = await resolveLegacyPmoRoute(user.id, pmoId);
  if (access.access === "denied") {
    console.error(JSON.stringify({ event: "legacy_pmo_home.pmo_not_accessible", userId: user.id, requestedPmoId: pmoId }));
    return <PmoNotAvailable />;
  }

  redirect(pmoHomePath(access.workspaceId, access.pmoId));
}
