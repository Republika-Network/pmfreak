import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const WORKSPACE_ROLES = ["owner", "admin", "pm", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const roleRank: Record<WorkspaceRole, number> = { owner: 4, admin: 3, pm: 2, viewer: 1 };

export async function requireWorkspaceRole(workspaceId: string, minimumRole: WorkspaceRole) {
  const user = await requireAuthUser();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle<{ role: WorkspaceRole }>();

  if (!data?.role || roleRank[data.role] < roleRank[minimumRole]) {
    throw new Error("Insufficient workspace permissions.");
  }

  return { user, role: data.role };
}

export const canManageWorkspace = (role: WorkspaceRole) => role === "owner" || role === "admin";
export const canInviteMembers = (role: WorkspaceRole) => role === "owner" || role === "admin";
/** Create/update projects, tasks, milestones, RAID items (F21: also enforced by RLS). */
export const canWriteProjectData = (role: WorkspaceRole) => role === "owner" || role === "admin" || role === "pm";

/**
 * Safely coerces an untrusted value (client body/formData, invite record, historical
 * metadata) into a WorkspaceRole. Returns null instead of throwing so callers must
 * explicitly decide the fail-closed behavior. Trims and lowercases before matching
 * against the closed WORKSPACE_ROLES set, so "ADMIN" normalizes to "admin" but
 * "superadmin" / "__proto__" / anything outside the set is rejected, never coerced.
 */
export function normalizeWorkspaceRole(value: unknown): WorkspaceRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (WORKSPACE_ROLES as readonly string[]).includes(normalized) ? (normalized as WorkspaceRole) : null;
}

/**
 * Roles that may ever be assigned through an invite. "owner" is deliberately excluded:
 * no public/normal invite flow may grant workspace ownership (see
 * docs/security/invite-workspace-role-boundary.md). Owner is only ever assigned by the
 * workspace-creation bootstrap (ensureWorkspaceMembership in src/lib/workspaces.ts, which
 * hardcodes "owner" server-side for the creator of a brand-new workspace) — never through
 * this invite path.
 */
export const INVITABLE_WORKSPACE_ROLES: readonly WorkspaceRole[] = ["admin", "pm", "viewer"];

/**
 * Authorization policy for "can actorRole invite/assign targetRole": actor must already
 * be able to invite at all (owner/admin), and the target role must be one of the
 * invitable roles (never "owner", regardless of actor). This is the single source of
 * truth for invite-role policy — invite creation must call this instead of only
 * checking targetRole against the full WORKSPACE_ROLES set.
 */
export function canAssignWorkspaceRole(input: { actorRole: WorkspaceRole; targetRole: WorkspaceRole }): boolean {
  if (!canInviteMembers(input.actorRole)) return false;
  return (INVITABLE_WORKSPACE_ROLES as readonly string[]).includes(input.targetRole);
}

/**
 * Billing policy: owner and admin can manage billing (create checkout sessions,
 * open the billing portal, change plans). pm and viewer cannot. This is the
 * authorization boundary for the `billing.manage` action — see
 * `docs/security/billing-authorization-boundary.md`.
 */
export const canManageBilling = (role: WorkspaceRole) => role === "owner" || role === "admin";

export type BillingManageDenialReason = "workspace_missing" | "insufficient_role";

export class WorkspaceMembershipError extends Error {
  readonly reason: BillingManageDenialReason;

  constructor(reason: BillingManageDenialReason, message: string) {
    super(message);
    this.name = "WorkspaceMembershipError";
    this.reason = reason;
  }
}

export type BillingManageMembership = { userId: string; workspaceId: string; role: WorkspaceRole };

/**
 * Authoritative, server-side gate for `billing.manage` actions (checkout session
 * creation, billing portal access, plan changes). The role is read directly from
 * `workspace_memberships` — it is never taken from `AuthUserContext.role`,
 * `user_metadata.role`, or any client-supplied field, all of which are
 * client-influenced or historically untrustworthy. Fails closed: a missing
 * workspace, missing membership, or unrecognized/insufficient role is denied.
 *
 * `getSupabaseClient` defaults to the real server client; tests inject a fake
 * to exercise this function's real logic without a live database.
 */
export async function requireBillingManageMembership(
  input: { userId: string; workspaceId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<BillingManageMembership> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle<{ role: string }>();

  const role = data?.role;
  if (!role || !WORKSPACE_ROLES.includes(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("workspace_missing", "No active workspace membership found for this user.");
  }

  if (!canManageBilling(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("insufficient_role", `Workspace role "${role}" is not authorized to manage billing.`);
  }

  return { userId: input.userId, workspaceId: input.workspaceId, role: role as WorkspaceRole };
}

// ─────────────────────────────────────────────────────────────────────────────
// Role update / owner-safety boundary (Perilla 4).
//
// Once a `workspace_memberships` row exists, updating its `role` is at least as
// sensitive as creating it (Perilla 3). The functions below are the sole
// authoritative source for "may actorRole change a member's role", "who is
// actorRole/currentTargetRole", and "would this leave the workspace ownerless".
// See docs/security/workspace-role-update-boundary.md.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceRoleUpdateDecision =
  | "allow"
  | "deny_actor_insufficient_role"
  | "deny_target_role_not_assignable"
  | "deny_self_promotion"
  | "deny_self_role_update"
  | "deny_owner_assignment_requires_transfer"
  | "deny_owner_role_change_requires_transfer"
  | "deny_last_owner_protected"
  | "deny_target_not_member"
  | "deny_invalid_role";

/**
 * Numeric rank for privilege comparisons (higher = more privileged). Reuses the exact
 * ranking `requireWorkspaceRole` already enforces, so "is this a promotion" can never
 * diverge from the minimum-role gate above.
 */
export function compareWorkspaceRolePrivilege(role: WorkspaceRole): number {
  return roleRank[role];
}

export function isWorkspaceRolePromotion(input: { currentRole: WorkspaceRole; targetRole: WorkspaceRole }): boolean {
  return compareWorkspaceRolePrivilege(input.targetRole) > compareWorkspaceRolePrivilege(input.currentRole);
}

/**
 * Authoritative, server-side policy for "may actorRole change a member's role from
 * currentTargetRole to requestedTargetRole" — the single source of truth for every
 * workspace role-update decision. Pure and side-effect free: every input must already be
 * resolved server-side (actorRole/currentTargetRole from `workspace_memberships` via
 * `requireWorkspaceRoleUpdateActor`/`requireWorkspaceRoleUpdateTarget`, requestedTargetRole
 * from `normalizeWorkspaceRole`, isLastOwner from `countWorkspaceOwners`) — this function
 * never reads a client-supplied role, display role, or `user_metadata.role` directly.
 *
 * Policy, evaluated in this order:
 * 1. `owner` can never be the requested role through this decision — assigning ownership is
 *    reserved for workspace-creation bootstrap or an explicit (not implemented) transfer flow.
 * 2. A current owner's role can never be changed here: last-owner-protected if they're the
 *    workspace's only owner, otherwise still denied pending an explicit ownership-transfer
 *    flow (there is none yet — see docs/security/workspace-role-update-boundary.md).
 * 3. Self-targeted requests: promotions are always denied. Any other self-change (lateral or
 *    demotion) is denied too — this perilla ships no self-service role-change flow.
 * 4. `owner` actor: may set admin/pm/viewer on any non-owner, non-self target.
 * 5. `admin` actor: may only manage pm/viewer targets, and may only set pm/viewer — never
 *    `admin` (lateral admin management stays owner-only) or `owner`.
 * 6. `pm`/`viewer` actor: can never update any member's role.
 */
export function canUpdateWorkspaceMemberRole(input: {
  actorRole: WorkspaceRole;
  actorUserId: string;
  targetUserId: string;
  currentTargetRole: WorkspaceRole;
  requestedTargetRole: WorkspaceRole;
  isLastOwner: boolean;
}): WorkspaceRoleUpdateDecision {
  if (input.requestedTargetRole === "owner") return "deny_owner_assignment_requires_transfer";

  if (input.currentTargetRole === "owner") {
    return input.isLastOwner ? "deny_last_owner_protected" : "deny_owner_role_change_requires_transfer";
  }

  if (input.actorUserId === input.targetUserId) {
    return isWorkspaceRolePromotion({ currentRole: input.currentTargetRole, targetRole: input.requestedTargetRole })
      ? "deny_self_promotion"
      : "deny_self_role_update";
  }

  if (input.actorRole === "owner") return "allow";

  if (input.actorRole === "admin") {
    if (input.currentTargetRole === "admin") return "deny_actor_insufficient_role";
    if (input.requestedTargetRole === "admin") return "deny_target_role_not_assignable";
    return "allow";
  }

  return "deny_actor_insufficient_role";
}

export type WorkspaceRoleUpdateMembership = { userId: string; workspaceId: string; role: WorkspaceRole };

/**
 * Resolves the actor's own current role directly from `workspace_memberships` for a
 * role-update decision. Deliberately does not enforce a minimum role here — pm/viewer are
 * valid, resolvable actors whose insufficiency is decided by `canUpdateWorkspaceMemberRole`,
 * not by this lookup. Never reads `AuthUserContext.role`, `user_metadata.role`, or any
 * client-supplied `actorRole`/`isOwner`/`isAdmin` field. Fails closed
 * (`WorkspaceMembershipError`, reason `workspace_missing`) when there is no membership row,
 * or its stored role fails the closed `WORKSPACE_ROLES` set.
 */
export async function requireWorkspaceRoleUpdateActor(
  input: { userId: string; workspaceId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<WorkspaceRoleUpdateMembership> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle<{ role: string }>();

  const role = data?.role;
  if (!role || !WORKSPACE_ROLES.includes(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("workspace_missing", "No active workspace membership found for this user.");
  }

  return { userId: input.userId, workspaceId: input.workspaceId, role: role as WorkspaceRole };
}

/**
 * Resolves the target member's current role directly from `workspace_memberships`. This is
 * the sole source of `currentTargetRole` for role-update/owner-safety decisions — never a
 * client-supplied "currentRole"/"targetRole" field. Fails closed the same way as the actor
 * lookup above (missing membership or invalid stored role → `workspace_missing`).
 */
export async function requireWorkspaceRoleUpdateTarget(
  input: { workspaceId: string; targetUserId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<WorkspaceRoleUpdateMembership> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.targetUserId)
    .maybeSingle<{ role: string }>();

  const role = data?.role;
  if (!role || !WORKSPACE_ROLES.includes(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("workspace_missing", "Target user is not an active member of this workspace.");
  }

  return { userId: input.targetUserId, workspaceId: input.workspaceId, role: role as WorkspaceRole };
}

/**
 * Counts active owners in a workspace — used to compute `isLastOwner` before any operation
 * that could change or remove an owner's role, so a workspace can never be left ownerless.
 */
export async function countWorkspaceOwners(
  input: { workspaceId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<number> {
  const supabase = await getSupabaseClient();
  const { count } = await supabase
    .from("workspace_memberships")
    .select("user_id", { head: true, count: "exact" })
    .eq("workspace_id", input.workspaceId)
    .eq("role", "owner");
  return count ?? 0;
}

export type WorkspaceInviteActor = { userId: string; workspaceId: string; role: WorkspaceRole };

/**
 * Authoritative, server-side gate for "who may create a workspace invite": the actor's
 * role is read directly from `workspace_memberships` — never from `AuthUserContext.role`,
 * `user_metadata.role`, or any client-supplied field — and must satisfy `canInviteMembers`
 * (owner/admin only). Fails closed on a missing membership or insufficient role.
 *
 * This is deliberately a small, directly-testable DB lookup rather than a call through
 * the generic AOC governance pipeline (`requireGovernancePermission` in
 * src/lib/security/access-guards.ts): that pipeline's role vocabulary
 * (src/lib/security/rbac.ts) uses a different casing ("PM" vs the DB's "pm") than the
 * WORKSPACE_ROLES used here, so it cannot be relied on as the sole authority for this
 * decision. See docs/security/invite-workspace-role-boundary.md.
 *
 * `getSupabaseClient` defaults to the real server client; tests inject a fake to
 * exercise this function's real logic without a live database.
 */
export async function requireWorkspaceInviteActor(
  input: { userId: string; workspaceId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<WorkspaceInviteActor> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle<{ role: string }>();

  const role = data?.role;
  if (!role || !WORKSPACE_ROLES.includes(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("workspace_missing", "No active workspace membership found for this user.");
  }

  if (!canInviteMembers(role as WorkspaceRole)) {
    throw new WorkspaceMembershipError("insufficient_role", `Workspace role "${role}" is not authorized to invite members.`);
  }

  return { userId: input.userId, workspaceId: input.workspaceId, role: role as WorkspaceRole };
}

export type DelegationRevokeDenialReason = "delegation_not_found" | "insufficient_role";

export class DelegationRevokeError extends Error {
  readonly reason: DelegationRevokeDenialReason;

  constructor(reason: DelegationRevokeDenialReason, message: string) {
    super(message);
    this.name = "DelegationRevokeError";
    this.reason = reason;
  }
}

/**
 * Authoritative, server-side gate for "may this user revoke this delegation":
 * the delegation's real `workspace_id`/`delegator_user_id` are read from
 * `governance_delegations` by id — never trusted from the request body, which
 * previously let any authenticated caller revoke (and cascade-revoke) any
 * workspace's delegation chain by guessing/observing a delegation id. Only
 * the original delegator, or an owner/admin of the delegation's own
 * workspace (resolved via `requireWorkspaceRole`), may revoke it.
 *
 * `getSupabaseClient` defaults to the real server client; tests inject a fake
 * to exercise this function's real logic without a live database.
 */
export async function requireDelegationRevokeActor(
  input: { delegationId: string; userId: string },
  getSupabaseClient: () => Promise<Pick<Awaited<ReturnType<typeof createSupabaseServerClient>>, "from">> = createSupabaseServerClient,
): Promise<{ workspaceId: string }> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase
    .from("governance_delegations")
    .select("workspace_id, delegator_user_id")
    .eq("id", input.delegationId)
    .maybeSingle<{ workspace_id: string; delegator_user_id: string | null }>();

  if (!data?.workspace_id) {
    throw new DelegationRevokeError("delegation_not_found", "Delegation not found.");
  }

  if (data.delegator_user_id !== input.userId) {
    try {
      await requireWorkspaceRole(data.workspace_id, "admin");
    } catch {
      throw new DelegationRevokeError("insufficient_role", "Not authorized to revoke this delegation.");
    }
  }

  return { workspaceId: data.workspace_id };
}
