import { redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolveLegacyPmoRoute } from "@/lib/pmos/routed-pmo";
import { pmoChatPath } from "@/lib/pmos/pmo-paths";
import { PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * Legacy PMO Chat entry point — a resolver, not a screen.
 *
 * PMO Chat moved to `/workspaces/[workspaceId]/pmos/[pmoId]/chat`. This path
 * keeps working for old links and holds no copy of the screen; see
 * `../page.tsx` for the full account of why `W` may only come from
 * `pmos.workspace_id`, why a missing and an unauthorized PMO give the same
 * answer, and why an archived PMO still redirects.
 */
export default async function LegacyPmoChatRedirectPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const access = await resolveLegacyPmoRoute(user.id, pmoId);
  if (access.access === "denied") {
    console.error(JSON.stringify({ event: "legacy_pmo_chat.pmo_not_accessible", userId: user.id, requestedPmoId: pmoId }));
    return <PmoNotAvailable />;
  }

  redirect(pmoChatPath(access.workspaceId, access.pmoId));
}
