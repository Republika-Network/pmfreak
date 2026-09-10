import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

export type RoutedWorkspaceRole = "owner" | "admin" | "pm" | "viewer" | null;

/**
 * The outcome of authorizing a workspace id that came from a URL.
 *
 *   granted  — the caller is a member and the workspace is active.
 *   archived — the caller is a member and the workspace is archived. Per
 *              `07-route-layout-and-navigation-architecture.md` §7 this is a
 *              READ-ONLY state, not an access failure: the viewer must still see
 *              the entity's last-known data with mutations disabled and
 *              explained. Archival is a state transition, not a deletion.
 *   denied   — no membership, no such workspace, or the workspace is deleted.
 *              These are deliberately one outcome so the route cannot be used to
 *              probe which workspace ids exist (§7 "Not Found" leakage rule).
 */
export type RoutedWorkspaceAccess =
  | { access: "granted"; workspaceId: string; role: RoutedWorkspaceRole; readOnly: false }
  | { access: "archived"; workspaceId: string; role: RoutedWorkspaceRole; readOnly: true }
  | { access: "denied"; workspaceId: null; role: null; readOnly: true };

const DENIED: RoutedWorkspaceAccess = { access: "denied", workspaceId: null, role: null, readOnly: true };

/**
 * Authorizes a workspace id supplied by a ROUTE (or bound into a Server Action)
 * against real membership rows.
 *
 * WHY THIS EXISTS ALONGSIDE resolveCanonicalWorkspace
 * ---------------------------------------------------
 * `resolveCanonicalWorkspace` answers "which workspace should this user be in?"
 * and FALLS BACK to another membership when its hint is unusable. That is right
 * for a stale cookie and wrong for a URL or a bound action argument: falling
 * back means acting on workspace B while the caller named workspace A, which is
 * exactly how a deep link ends up creating a project in the wrong tenant.
 *
 * This function answers a different question — "may this user act in THIS
 * workspace?" — and has no fallback at all. It either authorizes the id it was
 * given or refuses.
 *
 * It runs on the SERVICE ROLE client because membership and workspace status are
 * what it must read in order to decide; RLS remains the backstop on the data
 * reads and writes that follow, which use the caller's own client.
 */
export async function resolveRoutedWorkspace(userId: string, workspaceId: string): Promise<RoutedWorkspaceAccess> {
  if (!userId || !workspaceId) return DENIED;

  const supabase = createSupabaseServiceRoleClient({
    routeId: "routed-workspace",
    operation: "authorize",
    reason: "route_scope",
    systemActor: "system",
    actorUserId: userId,
  });

  const { data: membership, error: membershipError } = await supabase
    .from("workspace_memberships")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<{ workspace_id: string; role: RoutedWorkspaceRole }>();

  // A failed membership read is not a membership. Fail closed.
  if (membershipError || !membership) return DENIED;

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, status")
    .eq("id", workspaceId)
    .maybeSingle<{ id: string; status: string | null }>();

  if (workspaceError || !workspace) return DENIED;

  // Deleted is indistinguishable from "never existed" on purpose (§7).
  if (workspace.status === "deleted") return DENIED;

  if (workspace.status === "archived") {
    return { access: "archived", workspaceId, role: membership.role, readOnly: true };
  }

  return { access: "granted", workspaceId, role: membership.role, readOnly: false };
}
