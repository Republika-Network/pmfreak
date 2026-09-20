import { requireSeatAvailability } from "@/lib/feature-gates";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { requireGovernancePermission } from "@/lib/security/access-guards";
import { requireWorkspaceMember } from "@/lib/security/server-authorization";
import { createWorkspaceInviteToken, hashWorkspaceInviteToken, resolveInviteTtlHours } from "@/lib/security/invite-tokens";
import {
  canAssignWorkspaceRole,
  canUpdateWorkspaceMemberRole,
  countWorkspaceOwners,
  normalizeWorkspaceRole,
  requireWorkspaceInviteActor,
  requireWorkspaceRoleUpdateActor,
  requireWorkspaceRoleUpdateTarget,
  type WorkspaceRole,
  type WorkspaceRoleUpdateDecision,
} from "@/lib/workspace-access";

type MinimalSupabaseClient = {
  from: ReturnType<typeof createSupabaseServiceRoleClient>["from"];
};

export type WorkspaceInviteDenialReason =
  | "invalid_token"
  | "invalid_role"
  | "email_mismatch"
  | "expired"
  | "revoked"
  | "already_used";

export class WorkspaceInviteError extends Error {
  readonly reason: WorkspaceInviteDenialReason;

  constructor(reason: WorkspaceInviteDenialReason, message: string) {
    super(message);
    this.name = "WorkspaceInviteError";
    this.reason = reason;
  }
}

export async function getWorkspaceSeatSnapshot(input: { workspaceId: string; companyId: string; actorUserId: string; routeId: string }) {
  await requireGovernancePermission(input.workspaceId, "manage_members");
  // SCOPED_CLIENT: RLS policy added in 20260515100000_rls_governance_fixes.sql
  const supabase = await createSupabaseServerClient();
  const [{ count: activeSeats }, { count: pendingInvites }] = await Promise.all([
    supabase.from("workspace_memberships").select("user_id", { head: true, count: "exact" }).eq("workspace_id", input.workspaceId),
    supabase
      .from("workspace_invitations")
      .select("id", { head: true, count: "exact" })
      .eq("workspace_id", input.workspaceId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString()),
  ]);

  const usedSeats = (activeSeats ?? 0) + (pendingInvites ?? 0);
  const seatGate = await requireSeatAvailability(input.companyId, usedSeats);
  return { activeSeats: activeSeats ?? 0, pendingInvites: pendingInvites ?? 0, usedSeats, seatGate };
}

export async function inviteWorkspaceMember(input: {
  workspaceId: string;
  companyId: string;
  inviterUserId: string;
  email: string;
  role: unknown;
  routeId: string;
}): Promise<{ acceptPath: string; expiresAt: string }> {
  const actor = await requireWorkspaceInviteActor({ userId: input.inviterUserId, workspaceId: input.workspaceId });
  assertAssignableWorkspaceRole(actor.role, input.role);

  // Additional governance pipeline check (audit trail + seat accounting side effects).
  // Not the authoritative actor gate — requireWorkspaceInviteActor above is.
  // Both this and the seat snapshot resolve the AUTHENTICATED request user, so
  // they belong to the request path only; see createWorkspaceInvitationRecord.
  await requireGovernancePermission(input.workspaceId, "manage_members");

  return createWorkspaceInvitationRecord(
    { workspaceId: input.workspaceId, companyId: input.companyId, inviterUserId: input.inviterUserId, actorRole: actor.role, email: input.email, role: input.role },
    // SCOPED_CLIENT: RLS policy added in 20260515100000_rls_governance_fixes.sql
    async () => (await createSupabaseServerClient()) as unknown as MinimalSupabaseClient,
    // Seat accounting is request-scoped so it stays on this path, but it is
    // passed as a post-duplicate precondition rather than run ahead of the
    // domain: a duplicate invite must be refused AS a duplicate, exactly as it
    // was before the invitation domain was extracted.
    async () => {
      const snapshot = await getWorkspaceSeatSnapshot({ workspaceId: input.workspaceId, companyId: input.companyId, actorUserId: input.inviterUserId, routeId: input.routeId });
      if (!snapshot.seatGate.ok) throw new Error(`Seat limit reached (${snapshot.seatGate.seatLimit}).`);
    },
  );
}

/** The one role gate for invitation creation, shared by every caller. */
export function assertAssignableWorkspaceRole(actorRole: WorkspaceRole, requestedRole: unknown): WorkspaceRole {
  const targetRole = normalizeWorkspaceRole(requestedRole);
  if (!targetRole || !canAssignWorkspaceRole({ actorRole, targetRole })) {
    throw new Error("You are not authorized to invite a member at that role.");
  }
  return targetRole;
}

/**
 * The invitation-creation DOMAIN, with an injectable client.
 *
 * Extracted so the supported operator boundary (`npm run beta:invite-participant`)
 * creates invitations through the SAME duplicate refusal, role gate, token/hash
 * semantics, expiry and audit event as the request path — rather than a second
 * implementation, or hand-written SQL, which could drift from the product.
 *
 * It deliberately does NOT run `requireGovernancePermission` or the seat
 * snapshot: both resolve the authenticated REQUEST user and cannot execute
 * outside one. A caller that has a request runs the permission check before
 * calling in and supplies the seat check as `assertRequestScopedPreconditions`
 * (see `inviteWorkspaceMember`), which keeps that state out of this domain
 * while preserving the duplicate-before-seat precedence. The operator boundary
 * authorises through the workspace actor role instead and passes no
 * preconditions, and that difference is documented, not implied.
 */
/**
 * The one path family that accepts a WORKSPACE invitation: `/accept-invite/<token>`.
 *
 * It is declared here, beside the link this module mints, so the route and the predicate
 * that recognises it cannot drift into two spellings. It is deliberately NOT the bare
 * `/accept-invite`, which is the separate EARLY-ACCESS surface
 * (`src/app/(protected)/accept-invite/page.tsx`, `?token=`): that route keeps its existing
 * behaviour untouched.
 */
export const WORKSPACE_INVITE_ACCEPT_PATH_PREFIX = "/accept-invite/";

export function buildWorkspaceInviteAcceptPath(token: string): string {
  return `${WORKSPACE_INVITE_ACCEPT_PATH_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * True only for `/accept-invite/<single non-empty segment>`.
 *
 * Exact by construction: a nested path, the bare early-access route, and any other route
 * all answer false, so this can never widen into a general `/accept-invite*` exemption.
 */
export function isWorkspaceInviteAcceptancePath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== "string") return false;
  const path = pathname.split("?")[0]!.split("#")[0]!;
  if (!path.startsWith(WORKSPACE_INVITE_ACCEPT_PATH_PREFIX)) return false;
  const token = path.slice(WORKSPACE_INVITE_ACCEPT_PATH_PREFIX.length);
  return token.length > 0 && !token.includes("/");
}

export async function createWorkspaceInvitationRecord(
  input: { workspaceId: string; companyId: string; inviterUserId: string; actorRole: WorkspaceRole; email: string; role: unknown },
  getSupabaseClient: () => Promise<MinimalSupabaseClient>,
  /**
   * Request-scoped preconditions, evaluated only AFTER duplicate rejection.
   *
   * This preserves the product's pre-existing error precedence: an invite that
   * duplicates an active one is refused as a duplicate, and request-scoped
   * accounting is never consulted for it - so no `exceeded_seat_limit` gate
   * event is emitted for an invite that was never admissible in the first place.
   * The domain does not know what these preconditions are; the operator
   * boundary passes none and therefore runs none.
   */
  assertRequestScopedPreconditions: () => Promise<void> = async () => {},
): Promise<{ acceptPath: string; expiresAt: string }> {
  const targetRole = assertAssignableWorkspaceRole(input.actorRole, input.role);
  const supabase = await getSupabaseClient();
  const normalizedEmail = input.email.trim().toLowerCase();

  const { data: duplicate } = await supabase
    .from("workspace_invitations")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("email", normalizedEmail)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<{ id: string }>();
  if (duplicate?.id) throw new Error("An active invitation already exists for this email.");

  await assertRequestScopedPreconditions();

  const token = createWorkspaceInviteToken();
  const expiresAt = new Date(Date.now() + resolveInviteTtlHours() * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("workspace_invitations").insert({
    workspace_id: input.workspaceId,
    company_id: input.companyId,
    email: normalizedEmail,
    role: targetRole,
    token_hash: hashWorkspaceInviteToken(token),
    invited_by_user_id: input.inviterUserId,
    expires_at: expiresAt,
    status: "pending",
  });
  if (error) throw new Error(error.message);

  await supabase.from("workspace_audit_events").insert({
    workspace_id: input.workspaceId,
    actor_user_id: input.inviterUserId,
    event_type: "invitation_sent",
    payload: { email: normalizedEmail, role: targetRole, expiresAt },
  });

  return { acceptPath: buildWorkspaceInviteAcceptPath(token), expiresAt };
}

type ResolvedWorkspaceInvite = {
  inviteId: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
};

async function resolveValidWorkspaceInvite(token: string, supabase: MinimalSupabaseClient): Promise<ResolvedWorkspaceInvite> {
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new WorkspaceInviteError("invalid_token", "Invite token is required.");

  // Lookup is by sha256(token) — the table stores only `token_hash`, never the
  // plaintext. Legacy plaintext-token rows (pre-hashing) have no token_hash and
  // were revoked by 20260820000000_workspace_invite_token_hashing.sql, so a
  // legacy plaintext token can never resolve to an invite again.
  const { data: invite } = await supabase
    .from("workspace_invitations")
    .select("id, workspace_id, email, role, status, expires_at")
    .eq("token_hash", hashWorkspaceInviteToken(trimmedToken))
    .maybeSingle<{ id: string; workspace_id: string; email: string; role: string; status: string; expires_at: string }>();

  if (!invite) throw new WorkspaceInviteError("invalid_token", "Invite not found.");

  const role = normalizeWorkspaceRole(invite.role);
  if (!role) throw new WorkspaceInviteError("invalid_role", "Invite has an invalid role.");

  if (invite.status === "revoked") throw new WorkspaceInviteError("revoked", "Invitation has been revoked.");
  if (invite.status === "accepted") throw new WorkspaceInviteError("already_used", "Invitation has already been accepted.");
  if (invite.status !== "pending") throw new WorkspaceInviteError("expired", "Invitation is no longer active.");

  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await supabase.from("workspace_invitations").update({ status: "expired" }).eq("id", invite.id).eq("status", "pending");
    throw new WorkspaceInviteError("expired", "Invitation has expired.");
  }

  return { inviteId: invite.id, workspaceId: invite.workspace_id, email: invite.email, role };
}

function assertInviteBelongsToAuthenticatedEmail(input: { inviteEmail: string; userEmail: string }) {
  const inviteEmail = input.inviteEmail.trim().toLowerCase();
  const userEmail = input.userEmail.trim().toLowerCase();
  if (!userEmail || inviteEmail !== userEmail) {
    throw new WorkspaceInviteError("email_mismatch", "This invitation was issued to a different email address.");
  }
}

export type AcceptedWorkspaceInvite = { workspaceId: string; role: WorkspaceRole; inviteId: string };

/**
 * Accepts a workspace invitation. This is the sole path by which a `workspace_memberships`
 * row is created from an invite, and it deliberately accepts only `token`, `userId`, and
 * `userEmail` — there is no `role`/`workspaceId`/`workspaceRole` parameter, so a caller
 * cannot smuggle an elevated role or a different target workspace in even by accident.
 * The assigned role and workspace always come from the server-side invite record
 * resolved by `resolveValidWorkspaceInvite`.
 *
 * Fails closed on: invalid/unknown token, invalid stored role, email mismatch, revoked,
 * expired, or already-used invites. The pending→accepted transition is a single
 * conditional UPDATE (`.eq("status", "pending")`) whose result is checked before any
 * membership write, so a concurrent replay of the same token can win the race at most
 * once — the loser gets `already_used` and never reaches the membership upsert.
 */
export async function acceptWorkspaceInvite(
  input: { token: string; userId: string; userEmail: string },
  getSupabaseClient: () => Promise<MinimalSupabaseClient> = async () =>
    createSupabaseServiceRoleClient({
      routeId: "lib.workspace-team.acceptWorkspaceInvite",
      operation: "accept_invite",
      reason: "existing_privileged_flow",
      systemActor: "system",
      actorUserId: input.userId,
    }),
): Promise<AcceptedWorkspaceInvite> {
  const supabase = await getSupabaseClient();
  const invite = await resolveValidWorkspaceInvite(input.token, supabase);

  assertInviteBelongsToAuthenticatedEmail({ inviteEmail: invite.email, userEmail: input.userEmail });

  const { data: claimed } = await supabase
    .from("workspace_invitations")
    .update({ status: "accepted", accepted_by_user_id: input.userId, accepted_at: new Date().toISOString() })
    .eq("id", invite.inviteId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!claimed?.id) throw new WorkspaceInviteError("already_used", "Invitation has already been used.");

  const { error: memberError } = await supabase
    .from("workspace_memberships")
    .upsert({ workspace_id: invite.workspaceId, user_id: input.userId, role: invite.role }, { onConflict: "workspace_id,user_id" });
  if (memberError) throw new Error(memberError.message);

  await supabase.from("workspace_audit_events").insert({
    workspace_id: invite.workspaceId,
    actor_user_id: input.userId,
    event_type: "invitation_accepted",
    payload: { invitationId: invite.inviteId },
  });

  return { workspaceId: invite.workspaceId, role: invite.role, inviteId: invite.inviteId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace member role update (Perilla 4).
// ─────────────────────────────────────────────────────────────────────────────

export class WorkspaceRoleUpdateError extends Error {
  readonly reason: WorkspaceRoleUpdateDecision;

  constructor(reason: WorkspaceRoleUpdateDecision, message: string) {
    super(message);
    this.name = "WorkspaceRoleUpdateError";
    this.reason = reason;
  }
}

export type UpdatedWorkspaceMemberRole = { workspaceId: string; targetUserId: string; role: WorkspaceRole };

export class WorkspaceMembershipRemovalError extends Error {
  constructor(
    readonly reason:
      | "deny_actor_insufficient_role"
      | "deny_target_not_member"
      | "deny_self_removal"
      | "deny_last_owner"
      | "deny_owner_removal_requires_transfer",
  ) {
    super(`Membership removal denied: ${reason}`);
    this.name = "WorkspaceMembershipRemovalError";
  }
}

/** Membership was deleted but its audit event was not recorded — a partial state. */
export class WorkspaceMembershipAuditError extends Error {
  constructor(readonly detail: { workspaceId: string; targetUserId: string; cause: string }) {
    super(
      `Membership was removed for user ${detail.targetUserId} in workspace ${detail.workspaceId}, but the member_removed audit event FAILED to persist: ${detail.cause}. The removal is not auditable and must be recorded manually.`,
    );
    this.name = "WorkspaceMembershipAuditError";
  }
}

/**
 * Authoritative policy for "may actorRole REMOVE this member", deliberately kept
 * as conservative as `canUpdateWorkspaceMemberRole` in `workspace-access.ts`.
 *
 * Removing a membership is at least as privilege-sensitive as changing its role,
 * so this must not be weaker than the role-update boundary. An earlier revision
 * WAS weaker — it allowed an admin to remove another admin, an admin to remove an
 * owner, and an owner to remove a co-owner, in every case where a second owner
 * existed. Last-owner protection was the ONLY owner-target protection, which left
 * co-owner removal wide open. That is corrected here.
 *
 * Policy, evaluated in this order:
 * 1. Self-removal is denied outright — no self-service offboarding flow ships.
 * 2. An owner target can never be removed here: last-owner-protected when they are
 *    the only owner, otherwise still denied pending an explicit ownership-transfer
 *    /removal contract. This mirrors the role-update boundary's rule 2, so an owner's
 *    authority cannot be stripped by removal when it could not be stripped by demotion.
 * 3. `owner` actor: may remove any non-owner, non-self member.
 * 4. `admin` actor: may remove pm/viewer only — never another admin (lateral admin
 *    management stays owner-only) and never an owner (already denied by rule 2).
 * 5. `pm`/`viewer` actor: may never remove anyone.
 *
 * Reasons are kept distinct rather than collapsed, so operator evidence can tell a
 * last-owner refusal from a co-owner refusal from an insufficient-role refusal.
 */
export function evaluateWorkspaceMembershipRemoval(input: {
  actorRole: WorkspaceRole;
  actorUserId: string;
  targetUserId: string;
  targetRole: WorkspaceRole;
  ownerCount: number;
}): "allow" | WorkspaceMembershipRemovalError["reason"] {
  if (input.actorUserId === input.targetUserId) return "deny_self_removal";

  if (input.targetRole === "owner") {
    return input.ownerCount <= 1 ? "deny_last_owner" : "deny_owner_removal_requires_transfer";
  }

  if (input.actorRole === "owner") return "allow";

  if (input.actorRole === "admin") {
    if (input.targetRole === "admin") return "deny_actor_insufficient_role";
    return "allow";
  }

  return "deny_actor_insufficient_role";
}

/**
 * Acceptance-only fault seam for the offboarding AUDIT write.
 *
 * Exists so `OFFBOARD_AUDIT_FAILURE_SURFACED` can be proven at runtime rather
 * than asserted from source. It is deliberately tiny and deliberately hostile to
 * accidental use:
 *
 * - It is server-side only: an environment variable, never a route, header,
 *   request field or anything a client can influence.
 * - When unset it costs one string comparison and changes nothing.
 * - If it is set anywhere that is not a LOCAL, isolated Supabase target, it
 *   THROWS instead of quietly disabling itself. A production process that
 *   somehow carried this variable fails closed and loudly, rather than silently
 *   running with a fault seam armed.
 *
 * It injects no data and repairs nothing; it only forces the audit insert to
 * report failure so the surfacing path can be exercised.
 */
const AUDIT_FAULT_ENV = "PMFREAK_ACCEPTANCE_OFFBOARD_AUDIT_FAULT";

function offboardAuditFaultArmed(): boolean {
  if (process.env[AUDIT_FAULT_ENV] !== "1") return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isLocalIsolated = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url);
  if (process.env.NODE_ENV === "production" && !isLocalIsolated) {
    throw new Error(
      `${AUDIT_FAULT_ENV} is set in a non-local production environment. This is an acceptance-only fault seam and must never be armed against a real target.`,
    );
  }
  if (!isLocalIsolated) {
    throw new Error(`${AUDIT_FAULT_ENV} is set but ${url || "NEXT_PUBLIC_SUPABASE_URL"} is not a local isolated target.`);
  }
  return true;
}

/** Supported offboarding boundary: removes tenant authority, not identity. */
export async function removeWorkspaceMember(
  input: { workspaceId: string; actorUserId: string; targetUserId: string },
  getSupabaseClient: () => Promise<MinimalSupabaseClient> = async () =>
    createSupabaseServiceRoleClient({
      routeId: "lib.workspace-team.removeWorkspaceMember",
      operation: "remove_workspace_member",
      // NOT "existing_privileged_flow": this offboarding flow is NEW in
      // P0-LAUNCH-05 and is registered under its own reason in
      // privileged-access-registry.ts rather than borrowing a pre-existing one.
      reason: "workspace_member_offboarding",
      systemActor: "system",
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    }),
): Promise<{ workspaceId: string; targetUserId: string; removed: true }> {
  const supabase = await getSupabaseClient();
  const getClient = async () => supabase;
  const actor = await requireWorkspaceRoleUpdateActor({ userId: input.actorUserId, workspaceId: input.workspaceId }, getClient).catch(() => null);
  if (!actor) throw new WorkspaceMembershipRemovalError("deny_actor_insufficient_role");
  const target = await requireWorkspaceRoleUpdateTarget({ workspaceId: input.workspaceId, targetUserId: input.targetUserId }, getClient).catch(() => null);
  if (!target) throw new WorkspaceMembershipRemovalError("deny_target_not_member");
  const ownerCount = target.role === "owner" ? await countWorkspaceOwners({ workspaceId: input.workspaceId }, getClient) : 0;
  const decision = evaluateWorkspaceMembershipRemoval({ actorRole: actor.role, actorUserId: input.actorUserId, targetUserId: input.targetUserId, targetRole: target.role, ownerCount });
  if (decision !== "allow") throw new WorkspaceMembershipRemovalError(decision);
  const { error } = await supabase.from("workspace_memberships").delete().eq("workspace_id", input.workspaceId).eq("user_id", input.targetUserId);
  if (error) throw new Error(error.message);

  // The membership delete and this audit insert are two separate operations
  // against two tables with no enclosing transaction, so a failure here leaves a
  // real partial state: authority is already gone, but the removal is not
  // recorded. That window is NOT closed by this code — see RR-OFFBOARDING-AUDIT-NONATOMIC.
  // What IS closed is silence: the insert result is inspected and a failure is
  // raised naming the partial state, instead of being discarded so that a
  // successful-looking removal could carry no audit trail at all.
  const { error: auditError } = offboardAuditFaultArmed()
    ? { error: { message: "acceptance fault seam: forced audit write failure" } }
    : await supabase.from("workspace_audit_events").insert({
        workspace_id: input.workspaceId,
        actor_user_id: input.actorUserId,
        event_type: "member_removed",
        payload: { targetUserId: input.targetUserId, previousRole: target.role },
      });
  if (auditError) {
    throw new WorkspaceMembershipAuditError({
      workspaceId: input.workspaceId,
      targetUserId: input.targetUserId,
      cause: auditError.message,
    });
  }

  return { workspaceId: input.workspaceId, targetUserId: input.targetUserId, removed: true };
}

/**
 * Updates an existing workspace member's role. This is the sole authorized path to change
 * `workspace_memberships.role` for a member who already has a row — as opposed to creating
 * one, which is `ensureWorkspaceMembership` (workspace-creation bootstrap) or
 * `acceptWorkspaceInvite` (invite acceptance) above. Every decision-relevant value is
 * resolved server-side, never trusted from a client-supplied field:
 *
 *  - `requestedTargetRole` — `normalizeWorkspaceRole(input.requestedRole)`; fails closed
 *    (`deny_invalid_role`) on anything outside the closed `WORKSPACE_ROLES` set, before any
 *    database call.
 *  - `actorRole` — `requireWorkspaceRoleUpdateActor` reads the caller's OWN row from
 *    `workspace_memberships`. Callers must pass the authenticated session user's id as
 *    `actorUserId`; this function has no `body.actorRole`/`isOwner`/`isAdmin` parameter for
 *    anything else to smuggle a role through.
 *  - `currentTargetRole` — `requireWorkspaceRoleUpdateTarget` reads the target's row; fails
 *    closed (`deny_target_not_member`) if the target has no membership in this workspace.
 *  - `isLastOwner` — `countWorkspaceOwners`, only queried when the target currently holds
 *    `"owner"` (avoids an unnecessary query for the common non-owner case).
 *
 * `canUpdateWorkspaceMemberRole` (src/lib/workspace-access.ts) is the sole policy gate — the
 * `UPDATE` only runs when it returns `"allow"`. See
 * docs/security/workspace-role-update-boundary.md.
 *
 * A single privileged client is used for the whole operation (actor lookup, target lookup,
 * owner count, and the update itself): `workspace_memberships` has no RLS policy permitting
 * client-side UPDATEs at all (see 20260515100000_rls_governance_fixes.sql — read-only SELECT
 * policies), so the write must go through the service role regardless of actor role, and using
 * one privileged client for every read in this flow avoids a visibility mismatch where an
 * RLS-scoped client could resolve "target not found" for a real member simply because the
 * *actor* lacks read visibility into other members' rows.
 */
export async function updateWorkspaceMemberRole(
  input: { workspaceId: string; actorUserId: string; targetUserId: string; requestedRole: unknown },
  getSupabaseClient: () => Promise<MinimalSupabaseClient> = async () =>
    createSupabaseServiceRoleClient({
      routeId: "lib.workspace-team.updateWorkspaceMemberRole",
      operation: "update_member_role",
      reason: "existing_privileged_flow",
      systemActor: "system",
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    }),
): Promise<UpdatedWorkspaceMemberRole> {
  const requestedTargetRole = normalizeWorkspaceRole(input.requestedRole);
  if (!requestedTargetRole) {
    throw new WorkspaceRoleUpdateError("deny_invalid_role", "Requested role is not a recognized workspace role.");
  }

  const supabase = await getSupabaseClient();
  const asSupabaseClient = async () => supabase;

  const actor = await requireWorkspaceRoleUpdateActor({ userId: input.actorUserId, workspaceId: input.workspaceId }, asSupabaseClient).catch(
    () => null,
  );
  if (!actor) {
    throw new WorkspaceRoleUpdateError("deny_actor_insufficient_role", "No active workspace membership found for the requesting user.");
  }

  const target = await requireWorkspaceRoleUpdateTarget(
    { workspaceId: input.workspaceId, targetUserId: input.targetUserId },
    asSupabaseClient,
  ).catch(() => null);
  if (!target) {
    throw new WorkspaceRoleUpdateError("deny_target_not_member", "Target user is not an active member of this workspace.");
  }

  let isLastOwner = false;
  if (target.role === "owner") {
    const ownerCount = await countWorkspaceOwners({ workspaceId: input.workspaceId }, asSupabaseClient);
    isLastOwner = ownerCount <= 1;
  }

  const decision = canUpdateWorkspaceMemberRole({
    actorRole: actor.role,
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    currentTargetRole: target.role,
    requestedTargetRole,
    isLastOwner,
  });

  if (decision !== "allow") throw new WorkspaceRoleUpdateError(decision, `Role update denied: ${decision}`);

  const { error } = await supabase
    .from("workspace_memberships")
    .update({ role: requestedTargetRole })
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.targetUserId);
  if (error) throw new Error(error.message);

  await supabase.from("workspace_audit_events").insert({
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    event_type: "member_role_updated",
    payload: { targetUserId: input.targetUserId, previousRole: target.role, newRole: requestedTargetRole },
  });

  return { workspaceId: input.workspaceId, targetUserId: input.targetUserId, role: requestedTargetRole };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace member listing for assignment (Quick Add Task assignee selector).
// ─────────────────────────────────────────────────────────────────────────────

export type AssignableWorkspaceMember = {
  userId: string;
  displayName: string;
  email: string | null;
  role: WorkspaceRole;
};

/**
 * Lists real members of a workspace for use in an assignee selector — never
 * a fabricated directory. Requires the caller to already be a member of the
 * workspace being listed (requireWorkspaceMember), then resolves each
 * member's display name/email via the service-role client's
 * auth.admin.getUserById — the only source for another user's auth
 * metadata, since this codebase has no `profiles` table (see
 * getCompanyIdByUserId in feature-gates.ts for the same pattern).
 */
export async function listWorkspaceMembersForAssignment(workspaceId: string): Promise<AssignableWorkspaceMember[]> {
  await requireWorkspaceMember(workspaceId);

  const supabase = await createSupabaseServerClient();
  const { data: memberships, error } = await supabase
    .from("workspace_memberships")
    .select("user_id, role")
    .eq("workspace_id", workspaceId);
  if (error || !memberships) return [];

  const admin = createSupabaseServiceRoleClient({
    routeId: "lib.workspace-team.listWorkspaceMembersForAssignment",
    operation: "resolve_member_display_names",
    reason: "assignee_selector",
    systemActor: "system",
    workspaceId,
  });

  const resolved = await Promise.all(
    memberships.map(async (membership) => {
      const role = normalizeWorkspaceRole(membership.role);
      if (!role) return null;
      const { data, error: userError } = await admin.auth.admin.getUserById(membership.user_id);
      if (userError || !data.user) return null;
      const metadata = data.user.user_metadata ?? {};
      const displayName = typeof metadata.full_name === "string" && metadata.full_name.trim() ? metadata.full_name : (data.user.email ?? "Workspace member");
      return { userId: membership.user_id, displayName, email: data.user.email ?? null, role } satisfies AssignableWorkspaceMember;
    }),
  );

  return resolved.filter((member): member is AssignableWorkspaceMember => member !== null);
}
