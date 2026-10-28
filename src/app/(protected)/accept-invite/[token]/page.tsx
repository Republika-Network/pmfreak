import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { requireAuthUser } from "@/lib/auth";
import { acceptWorkspaceInvite, WorkspaceInviteError, type AcceptedWorkspaceInvite } from "@/lib/workspace-team";
import { getUserWorkspaces } from "@/lib/workspaces";
import { OpenInvitedWorkspace } from "./open-invited-workspace";
import { buildAbuseKey, enforceAbuseLimit, getClientIpFromHeaders } from "@/lib/security/abuse-protection";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_token: "This invite link is invalid.",
  invalid_role: "This invite is misconfigured and cannot be accepted.",
  email_mismatch: "This invitation was issued to a different email address.",
  expired: "This invitation has expired.",
  revoked: "This invitation has been revoked.",
  already_used: "This invitation has already been used.",
  inviter_not_authorized: "This invitation is no longer valid. Ask a workspace admin for a new one.",
  already_member: "You are already a member of this workspace. Ask a workspace admin to change your role.",
  email_unverified: "Confirm your email address, then open this invitation link again.",
};

export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const user = await requireAuthUser();
  const { token } = await params;

  // Brute-force / replay protection, separate from the token validation
  // itself: an IP-wide limit slows down guessing many tokens, and a
  // per-token limit slows down hammering one specific token. The raw token
  // is never persisted — enforceAbuseLimit hashes it before use. See
  // docs/security/abuse-protection-boundary.md ("workspace.invite_accept").
  const headersList = await headers();
  const clientIp = getClientIpFromHeaders(headersList);
  const ipDecision = await enforceAbuseLimit({
    scope: "workspace.invite_accept",
    identifier: clientIp,
    limit: 20,
    windowSeconds: 3600,
  });
  const tokenDecision = ipDecision.allowed
    ? await enforceAbuseLimit({
        scope: "workspace.invite_accept",
        action: "per_token",
        identifier: buildAbuseKey([clientIp, token]),
        limit: 10,
        windowSeconds: 3600,
      })
    : ipDecision;
  if (!ipDecision.allowed || !tokenDecision.allowed) {
    throw new Error("Too many attempts. Please wait a moment and try again.");
  }

  let accepted: AcceptedWorkspaceInvite;
  try {
    accepted = await acceptWorkspaceInvite({ token, userId: user.id, userEmail: user.email });
  } catch (error) {
    if (error instanceof WorkspaceInviteError) {
      if (error.reason === "invalid_token") notFound();
      throw new Error(ERROR_MESSAGES[error.reason] ?? "Unable to accept this invitation.");
    }
    throw error;
  }

  // PD-9: the invitee continues INTO the workspace they were invited to. Redirecting
  // to an unscoped page left them in whatever the preferred-workspace cookie (or, with
  // none, their oldest membership — usually the empty personal workspace bootstrapped
  // at signup) named, which the onboarding gate then locked. The id comes from the
  // invitation record, never from the request.
  const workspaceName = (await getUserWorkspaces(user.id)).find((w) => w.id === accepted.workspaceId)?.name ?? "workspace";
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6">
      <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">Invitation accepted</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">You joined {workspaceName}</h1>
      <p className="mt-2 text-sm text-slate-700">Your role: {accepted.role}. Opening the workspace…</p>
      <div className="mt-4">
        <OpenInvitedWorkspace workspaceId={accepted.workspaceId} workspaceName={workspaceName} />
      </div>
    </section>
  );
}
