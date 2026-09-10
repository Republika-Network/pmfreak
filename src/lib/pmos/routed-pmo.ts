import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { resolveRoutedWorkspace, type RoutedWorkspaceAccess } from "@/lib/workspaces/routed-workspace";
import type { PmoStatus } from "@/lib/db/database-contract";

/**
 * The outcome of authorizing a PMO id that came from a URL.
 *
 *   granted  — the caller may act in this PMO's workspace, and both the PMO and
 *              that workspace are active.
 *   archived — the caller is authorized, but the PMO and/or its parent workspace
 *              is archived. Per `07-route-layout-and-navigation-architecture.md`
 *              §7 this is a READ-ONLY state, NOT an access failure: the viewer
 *              must still see last-known data with mutations disabled and
 *              explained, because archival is a state transition, not a
 *              deletion. `archived` reports which of the two is archived so the
 *              screen can say something true rather than something generic.
 *   denied   — no such PMO, no membership in its workspace, a deleted or
 *              unreachable workspace, or a routed workspace id that disagrees
 *              with the PMO's real parent. These are deliberately ONE outcome so
 *              the route cannot be used to probe which PMO ids exist (§7's
 *              leakage rule).
 *
 * A PMO has no `deleted` status — `PmoStatus` is `active | archived` and
 * `deletePmo` issues a hard DELETE — so a deleted PMO is genuinely absent and
 * needs no special case: it simply fails the lookup and lands in `denied`.
 *
 * Nothing here carries PMO row content. The verdict plus the two ids the caller
 * already holds is the entire payload, so an unauthorized request cannot learn a
 * PMO's name, type, or status from this resolver.
 */
export type RoutedPmoAccess =
  | { access: "granted"; pmoId: string; workspaceId: string; readOnly: false }
  | {
      access: "archived";
      pmoId: string;
      workspaceId: string;
      readOnly: true;
      archived: { pmo: boolean; workspace: boolean };
    }
  | { access: "denied"; pmoId: null; workspaceId: null; readOnly: true };

const DENIED: RoutedPmoAccess = { access: "denied", pmoId: null, workspaceId: null, readOnly: true };

/**
 * What the privileged lookup is allowed to learn about a PMO: its parent
 * workspace and its status, and nothing else. Deliberately not `PmoRow` — a
 * wider shape here is how row content leaks into a refusal path.
 */
export type PmoAncestry = { workspaceId: string; status: PmoStatus };

/**
 * The access decision, as a pure function.
 *
 * Split out from the I/O below so every rule in the route contract is provable
 * without a database: ancestry mismatch, archived-vs-denied, and the absence of
 * any fallback are all decided here.
 *
 * `pmo` is `null` when no PMO resolved for the requested id (absent, or the
 * lookup failed — both fail closed). `workspaceAccess` is `null` when we never
 * got far enough to ask, which is the same refusal.
 */
export function decideRoutedPmoAccess(input: {
  routedWorkspaceId: string;
  pmoId: string;
  pmo: PmoAncestry | null;
  workspaceAccess: RoutedWorkspaceAccess | null;
}): RoutedPmoAccess {
  const { routedWorkspaceId, pmoId, pmo, workspaceAccess } = input;

  if (!routedWorkspaceId || !pmoId) return DENIED;
  if (!pmo) return DENIED;
  if (!workspaceAccess || workspaceAccess.access === "denied") return DENIED;

  // Defensive: the workspace that was authorized must be the PMO's own. This
  // can only fail if a caller passes a workspaceAccess resolved for some other
  // id, which is precisely the substitution this whole module exists to stop.
  if (workspaceAccess.workspaceId !== pmo.workspaceId) return DENIED;

  // The ancestry claim in the URL must match reality. `pmos.workspace_id` is
  // the authority for a PMO's parent; the routed segment is only an assertion
  // about it. Refusing — rather than "helpfully" correcting to the real
  // workspace — is the point: a corrected render would serve PMO P under a
  // workspace id that does not own it, which is the exact confusion an
  // entity-qualified route exists to prevent, and it would let a caller
  // discover a PMO's true workspace by watching the URL change.
  if (routedWorkspaceId !== pmo.workspaceId) return DENIED;

  const workspaceArchived = workspaceAccess.access === "archived";
  const pmoArchived = pmo.status === "archived";

  if (workspaceArchived || pmoArchived) {
    return {
      access: "archived",
      pmoId,
      workspaceId: pmo.workspaceId,
      readOnly: true,
      archived: { pmo: pmoArchived, workspace: workspaceArchived },
    };
  }

  return { access: "granted", pmoId, workspaceId: pmo.workspaceId, readOnly: false };
}

/**
 * Authorizes a PMO id supplied by a ROUTE.
 *
 * WHY THIS EXISTS ALONGSIDE resolveRoutedWorkspace
 * ------------------------------------------------
 * `resolveRoutedWorkspace` answers "may this user act in THIS workspace?" — but
 * a PMO route does not name a workspace it can trust. It names a PMO, and the
 * workspace segment beside it is a claim, not an authority. This function
 * answers "may this user act in THIS PMO, and is the URL telling the truth
 * about where it lives?", by deriving the parent workspace from the PMO row
 * itself and then delegating the membership question to the existing resolver.
 *
 * It has no fallback at all. There is no "preferred PMO", no "first PMO in the
 * workspace", and no preferred-workspace cookie anywhere in this path: a
 * requested PMO either resolves as authorized or is refused.
 *
 * It runs on the SERVICE ROLE client for the minimum lookup required to
 * discover what must be authorized — `pmos.workspace_id` and `pmos.status`, two
 * columns, by id. That read cannot be done with the caller's own client without
 * assuming the answer, since RLS would filter the row using the very membership
 * this function is trying to establish. Every subsequent DATA read on the screen
 * uses the caller's own client, so RLS remains the tenant-isolation boundary;
 * PMO scoping on top of it is an application-layer concern, because RLS keys on
 * workspace membership and structurally cannot tell PMO A from PMO B inside one
 * workspace.
 *
 * No PMO membership model is consulted, because none exists: there is no
 * `pmo_members` table anywhere in the schema, `pmo_team_invites` is
 * workspace-scoped and predates the `pmos` table, and the `pmos` RLS policies
 * read `workspace_memberships`. PMO access is inherited through workspace
 * membership, and inventing anything else here would be inventing domain
 * semantics (ADR-PMF-003 ratifies no PMO-level role).
 */
export async function resolveRoutedPmo(
  userId: string,
  routedWorkspaceId: string,
  pmoId: string,
): Promise<RoutedPmoAccess> {
  if (!userId || !routedWorkspaceId || !pmoId) return DENIED;

  const supabase = createSupabaseServiceRoleClient({
    routeId: "routed-pmo",
    operation: "authorize",
    reason: "route_scope",
    systemActor: "system",
    actorUserId: userId,
  });

  const { data: pmo, error: pmoError } = await supabase
    .from("pmos")
    .select("workspace_id, status")
    .eq("id", pmoId)
    .maybeSingle<{ workspace_id: string; status: PmoStatus }>();

  // A failed lookup is not a PMO. Fail closed.
  if (pmoError || !pmo) return DENIED;

  // Authorize the PMO's REAL workspace, not the one the URL asserted. Checking
  // the claim afterwards (in the pure decision above) rather than short-circuiting
  // on it keeps this path from behaving observably differently for a mismatched
  // id than for an unauthorized one.
  const workspaceAccess = await resolveRoutedWorkspace(userId, pmo.workspace_id);

  return decideRoutedPmoAccess({
    routedWorkspaceId,
    pmoId,
    pmo: { workspaceId: pmo.workspace_id, status: pmo.status },
    workspaceAccess,
  });
}
