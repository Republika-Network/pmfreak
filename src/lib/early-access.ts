import crypto from "node:crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/provider";
import { buildEarlyAccessInviteEmail } from "@/lib/email/templates/early-access-invite";
import { logFirstUserTelemetryEvent } from "@/lib/first-user-telemetry";

const TRIAL_DAYS = 90;
export const MAX_TRIAL_EXTENSION_DAYS = 60;
const MAX_AUDIT_REASON_LENGTH = 500;
const EARLY_ACCESS_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TrialStatus = "pending" | "active" | "expired" | "revoked";

export const hashInviteToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export const createInviteToken = () => crypto.randomBytes(24).toString("base64url");

/**
 * Every founder-action target id (inviteId/trialId) is validated with this
 * before any query is built — an empty/missing/non-string id must never
 * reach a service-role `.eq("id", ...)` filter. Throws a `code::message`
 * error the API routes split on to produce a clean 400 with no mutation.
 */
export function requireNonEmptyId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing_target::${label} is required.`);
  }
  return value.trim();
}

/** Whole number of days, 1..MAX_TRIAL_EXTENSION_DAYS. Rejects NaN/Infinity/non-integers, not just <=0. */
export function isValidTrialExtensionDays(days: unknown): days is number {
  return typeof days === "number" && Number.isInteger(days) && days > 0 && days <= MAX_TRIAL_EXTENSION_DAYS;
}

/** Optional actor-supplied reason for an audit trail entry: trimmed, capped, never required to authorize anything. */
export function sanitizeAuditReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_AUDIT_REASON_LENGTH) : null;
}

export function isValidInviteEmail(value: unknown): value is string {
  return typeof value === "string" && EARLY_ACCESS_EMAIL_SHAPE.test(value.trim());
}

export const computeRemainingTrialDays = (trialEndAt: string | null) => {
  if (!trialEndAt) return 0;
  const end = new Date(trialEndAt).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};



function buildEarlyAccessActivationLink(token: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) {
    console.warn("[early-access] NEXT_PUBLIC_APP_URL not configured. Falling back to localhost activation link.");
  }
  const appUrl = configured && /^https?:\/\//.test(configured) ? configured : "http://localhost:3000";
  return `${appUrl.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`;
}

async function sendEarlyAccessInviteEmail(input: { inviteId: string; inviteEmail: string; inviteNote?: string | null; expiresAt: string; inviteToken: string; }) {
  const activationLink = buildEarlyAccessActivationLink(input.inviteToken);
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system" });

  await supabase.from("early_access_events").insert({
    invite_id: input.inviteId,
    event_type: "invite_email_send_attempted",
    event_payload: { inviteId: input.inviteId, recipient: input.inviteEmail, attemptedAt: new Date().toISOString() },
  });

  const template = buildEarlyAccessInviteEmail({
    recipientEmail: input.inviteEmail,
    founderNote: input.inviteNote,
    activationLink,
    expiresAt: input.expiresAt,
  });

  const delivery = await sendEmail({ to: input.inviteEmail, subject: template.subject, html: template.html, text: template.text });

  if (delivery.ok) {
    await supabase.from("early_access_events").insert({
      invite_id: input.inviteId,
      event_type: "invite_email_sent",
      event_payload: { recipient: input.inviteEmail, provider: delivery.provider, messageId: delivery.messageId ?? null, attemptedAt: delivery.attemptedAt, sentAt: delivery.sentAt ?? null },
    });
    return { delivery, activationLink: null };
  }

  await supabase.from("early_access_events").insert([
    {
      invite_id: input.inviteId,
      event_type: "invite_email_failed",
      event_payload: { recipient: input.inviteEmail, provider: delivery.provider, attemptedAt: delivery.attemptedAt, failedAt: delivery.failedAt ?? null, reason: delivery.error ?? "unknown" },
    },
    {
      invite_id: input.inviteId,
      event_type: "invite_manual_link_generated",
      event_payload: { recipient: input.inviteEmail, generatedAt: new Date().toISOString() },
    },
  ]);

  return { delivery, activationLink };
}
export async function createEarlyAccessInvite(input: { inviteEmail: string; inviterUserId: string; inviteNote?: string; expiresInDays?: number; requiresApproval?: boolean; }) {
  if (!isValidInviteEmail(input.inviteEmail)) {
    throw new Error("invalid_email::A valid invite email is required.");
  }
  const inviteEmail = input.inviteEmail.trim().toLowerCase();
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId: input.inviterUserId });
  const token = createInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * (input.expiresInDays ?? 14)).toISOString();

  const { data: invite, error: inviteError } = await supabase
    .from("early_access_invites")
    .insert({
      invite_email: inviteEmail,
      invite_token_hash: tokenHash,
      invite_note: input.inviteNote ?? null,
      inviter_user_id: input.inviterUserId,
      expires_at: expiresAt,
      requires_approval: input.requiresApproval ?? false,
    })
    .select("id, invite_email, expires_at")
    .single();

  if (inviteError || !invite) throw new Error(`Unable to create invite: ${inviteError?.message}`);

  const { error: trialError } = await supabase.from("trial_licenses").insert({ invite_id: invite.id, trial_status: "pending" });
  if (trialError) throw new Error(`Unable to create trial license: ${trialError.message}`);

  await supabase.from("early_access_events").insert({
    invite_id: invite.id,
    event_type: "invite_created",
    event_payload: { inviteEmail: invite.invite_email, expiresAt: invite.expires_at },
  });

  const emailOutcome = await sendEarlyAccessInviteEmail({ inviteId: invite.id, inviteEmail: invite.invite_email, inviteNote: input.inviteNote, expiresAt: invite.expires_at, inviteToken: token });

  return { inviteId: invite.id, expiresAt: invite.expires_at, emailDelivery: emailOutcome.delivery, manualInviteLink: emailOutcome.activationLink };
}

export async function acceptEarlyAccessInvite(input: { inviteToken: string; userId: string; userEmail: string; workspaceName?: string; }) {
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId: input.userId });
  const tokenHash = hashInviteToken(input.inviteToken);

  const { data: invite, error } = await supabase
    .from("early_access_invites")
    .select("id, invite_email, expires_at, accepted_at, revoked_at, requires_approval, approved_at")
    .eq("invite_token_hash", tokenHash)
    .maybeSingle();

  if (error) throw new Error(`Unable to validate invite: ${error.message}`);
  if (!invite) throw new Error("invalid_token::Invalid invite token.");
  if (invite.revoked_at) throw new Error("revoked_token::Invite access is no longer active.");
  if (invite.accepted_at) throw new Error("reused_token::Invite has already been used.");
  if (new Date(invite.expires_at).getTime() < Date.now()) throw new Error("expired_token::Invite has expired.");
  if (invite.requires_approval && !invite.approved_at) throw new Error("pending_approval::Founder approval is required before activation.");

  // The invite is addressed to a specific email; the authenticated user accepting it must
  // be that same person. Without this check, anyone holding a leaked/guessed token could
  // activate someone else's early-access trial under their own account. See
  // docs/security/invite-workspace-role-boundary.md.
  const normalizedInviteEmail = String(invite.invite_email ?? "").trim().toLowerCase();
  const normalizedUserEmail = input.userEmail.trim().toLowerCase();
  if (!normalizedUserEmail || normalizedInviteEmail !== normalizedUserEmail) {
    throw new Error("email_mismatch::This invite was issued to a different email address.");
  }

  await logFirstUserTelemetryEvent({ eventType: "invite_activation_attempted", userId: input.userId, inviteId: invite.id });

  // Every write of the activation — workspace, owner membership, trial license
  // link, invite acceptance and the activation record — happens in ONE
  // transaction inside accept_early_access_invite (migration
  // 20261011000000_atomic_early_access_activation.sql), which re-checks all of
  // the preconditions above under a row lock. A failure at any step leaves no
  // workspace or membership behind; previously a failed license update left a
  // membership with no linked trial, which the entitlement resolver reads as a
  // self-serve Free account. Concurrent acceptances serialize on the invite row
  // and every one after the first fails with reused_token.
  const { data: activation, error: activationError } = await supabase.rpc("accept_early_access_invite", {
    p_invite_id: invite.id,
    p_invite_token_hash: tokenHash,
    p_user_id: input.userId,
    p_user_email: normalizedUserEmail,
    p_workspace_name: input.workspaceName ?? null,
    p_trial_days: TRIAL_DAYS,
  });

  const activated = parseActivationResult(activation);
  if (activationError || !activated) {
    const reason = activationError?.message ?? "Activation returned no result.";
    await supabase.from("early_access_events").insert({
      invite_id: invite.id,
      event_type: "invite_activation_failed",
      event_payload: { reason: ACTIVATION_ERROR_CODE.exec(reason)?.[1] ?? "internal_error" },
    });
    await logFirstUserTelemetryEvent({ eventType: "invite_activation_failed", userId: input.userId, inviteId: invite.id });
    // Only the function's own `code::message` errors are user-facing; anything
    // else (driver text, a missing function) stays server-side.
    if (activationError && ACTIVATION_ERROR_CODE.test(activationError.message)) throw new Error(activationError.message);
    await logFirstUserTelemetryEvent({ eventType: "runtime_initialization_issue", userId: input.userId, inviteId: invite.id, metadata: { reason } });
    throw new Error(`Unable to activate invite: ${reason}`);
  }

  const { workspaceId, trialLicenseId, trialEndsAt } = activated;
  const activationPayload = {
    runtimeAuthorityVersion: "v1",
    explainabilityMode: "founder-guided",
    machineGovernanceMode: "safety-default",
  };

  await supabase.from("early_access_events").insert([
    { invite_id: invite.id, trial_license_id: trialLicenseId, workspace_id: workspaceId, event_type: "invite_accepted", event_payload: { inviteEmail: invite.invite_email } },
    { invite_id: invite.id, trial_license_id: trialLicenseId, workspace_id: workspaceId, event_type: "workspace_activated", event_payload: activationPayload },
    { invite_id: invite.id, trial_license_id: trialLicenseId, workspace_id: workspaceId, event_type: "workspace_initialized", event_payload: { memoryNamespace: `workspace:${workspaceId}` } },
  ]);

  await logFirstUserTelemetryEvent({ eventType: "invite_activation_completed", userId: input.userId, workspaceId, inviteId: invite.id, metadata: { trialEndsAt } });

  return { workspaceId, trialEndsAt };
}

const ACTIVATION_ERROR_CODE = /^(invalid_token|revoked_token|reused_token|expired_token|pending_approval|email_mismatch|activation_unavailable|invalid_request)::/;

function parseActivationResult(value: unknown): { workspaceId: string; trialLicenseId: string; trialEndsAt: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.workspace_id !== "string" || typeof row.trial_license_id !== "string" || typeof row.trial_end_at !== "string") return null;
  const end = Date.parse(row.trial_end_at);
  if (Number.isNaN(end)) return null;
  return { workspaceId: row.workspace_id, trialLicenseId: row.trial_license_id, trialEndsAt: new Date(end).toISOString() };
}

export async function approveEarlyAccessInvite(inviteId: string, actorUserId: string) {
  const targetId = requireNonEmptyId(inviteId, "Invite id");
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId });
  const approvedAt = new Date().toISOString();
  const { data: invite, error } = await supabase
    .from("early_access_invites")
    .update({ approved_at: approvedAt })
    .eq("id", targetId)
    .is("revoked_at", null)
    .is("accepted_at", null)
    .select("id")
    .single();
  if (error || !invite) throw new Error("Unable to approve invite.");
  await supabase.from("early_access_events").insert({ invite_id: targetId, event_type: "invite_approved", event_payload: { actorUserId } });
}

export async function revokeEarlyAccessInvite(inviteId: string, actorUserId: string, reason?: string) {
  const targetId = requireNonEmptyId(inviteId, "Invite id");
  const sanitizedReason = sanitizeAuditReason(reason);
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId });
  const revokedAt = new Date().toISOString();
  const { data: invite, error } = await supabase
    .from("early_access_invites")
    .update({ revoked_at: revokedAt })
    .eq("id", targetId)
    .is("accepted_at", null)
    .select("id")
    .single();
  if (error || !invite) throw new Error("Unable to revoke invite.");
  await supabase.from("early_access_events").insert({ invite_id: targetId, event_type: "invite_revoked", event_payload: { actorUserId, reason: sanitizedReason } });
}

export async function revokeTrialLicense(trialId: string, actorUserId: string, reason?: string) {
  const targetId = requireNonEmptyId(trialId, "Trial id");
  const sanitizedReason = sanitizeAuditReason(reason);
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId });
  const { data: trial, error } = await supabase
    .from("trial_licenses")
    .update({ trial_status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", targetId)
    .neq("trial_status", "revoked")
    .select("id, invite_id, workspace_id")
    .single();
  if (error || !trial) throw new Error("Unable to revoke trial.");
  await supabase.from("early_access_events").insert({ invite_id: trial.invite_id, trial_license_id: trial.id, workspace_id: trial.workspace_id, event_type: "trial_revoked", event_payload: { actorUserId, reason: sanitizedReason } });
}

export async function extendTrialLicense(trialId: string, extensionDays: number, actorUserId: string, reason?: string) {
  const targetId = requireNonEmptyId(trialId, "Trial id");
  if (!isValidTrialExtensionDays(extensionDays)) {
    throw new Error(`invalid_duration::Trial extension must be a whole number of days between 1 and ${MAX_TRIAL_EXTENSION_DAYS}.`);
  }
  const sanitizedReason = sanitizeAuditReason(reason);
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId });
  const { data: trial, error: trialError } = await supabase.from("trial_licenses").select("id, invite_id, workspace_id, trial_end_at, trial_status").eq("id", targetId).single();
  if (trialError || !trial) throw new Error("Unable to load trial.");
  if (trial.trial_status === "revoked") throw new Error("Trial is no longer active.");

  const currentEnd = trial.trial_end_at ? new Date(trial.trial_end_at).getTime() : Date.now();
  const baseEnd = Math.max(currentEnd, Date.now());
  const nextEnd = new Date(baseEnd + extensionDays * 24 * 60 * 60 * 1000).toISOString();
  const nextStatus: TrialStatus = trial.trial_status === "expired" ? "active" : trial.trial_status;

  const { error } = await supabase.from("trial_licenses").update({ trial_end_at: nextEnd, trial_status: nextStatus }).eq("id", targetId);
  if (error) throw new Error("Unable to extend trial.");
  await supabase.from("early_access_events").insert({ invite_id: trial.invite_id, trial_license_id: trial.id, workspace_id: trial.workspace_id, event_type: "trial_extended", event_payload: { actorUserId, extensionDays, trialEndAt: nextEnd, reason: sanitizedReason } });
}


export async function resendEarlyAccessInviteEmail(inviteId: string, actorUserId: string) {
  const targetId = requireNonEmptyId(inviteId, "Invite id");
  const supabase = createSupabaseServiceRoleClient({ routeId: "lib.early-access", operation: "service_role_query", reason: "existing_privileged_flow", systemActor: "system", actorUserId });
  const { data: invite, error } = await supabase
    .from("early_access_invites")
    .select("id, invite_email, invite_note, expires_at, accepted_at, revoked_at")
    .eq("id", targetId)
    .single();

  if (error || !invite) throw new Error("Unable to load invite.");
  if (invite.accepted_at) throw new Error("Invite has already been accepted.");
  if (invite.revoked_at) throw new Error("Invite has been revoked.");
  if (new Date(invite.expires_at).getTime() < Date.now()) throw new Error("Invite has expired.");

  const nextToken = createInviteToken();
  const nextTokenHash = hashInviteToken(nextToken);

  const { error: rotateError } = await supabase.from("early_access_invites").update({ invite_token_hash: nextTokenHash }).eq("id", invite.id);
  if (rotateError) throw new Error("Unable to rotate invite token for resend.");

  await supabase.from("early_access_events").insert({
    invite_id: invite.id,
    event_type: "invite_token_rotated_for_resend",
    event_payload: { actorUserId, rotatedAt: new Date().toISOString() },
  });

  const emailOutcome = await sendEarlyAccessInviteEmail({
    inviteId: invite.id,
    inviteEmail: invite.invite_email,
    inviteNote: invite.invite_note,
    expiresAt: invite.expires_at,
    inviteToken: nextToken,
  });

  return { inviteId: invite.id, emailDelivery: emailOutcome.delivery, manualInviteLink: emailOutcome.activationLink };
}
