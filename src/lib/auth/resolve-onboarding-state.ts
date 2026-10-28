import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { isFounderOrInternalUser } from "@/lib/auth";
import { collectWorkspaceActivationEvidence } from "@/lib/workspace-activation/evaluate-workspace-activation";

export type OnboardingState =
  | "no_workspace"
  | "needs_project"
  | "needs_task"
  | "execution_started"
  | "active"
  | "trial_blocked";

/**
 * Minimal identity resolveOnboardingState actually depends on — not the
 * full AuthUserContext. This lets a caller resolving destination immediately
 * after a fresh sign-in/sign-up build the input directly from that
 * operation's own response (`data.user.id`/`data.user.email`), with no
 * dependency on a subsequent cookie-backed session read succeeding in the
 * same request. See "Login/signup session-visibility verification" in
 * docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md.
 *
 * The internal-user trial bypass applies only when this is a server-verified
 * context (`getAuthUser()` or `buildAuthUserContext(..., { verifiedByAuthServer:
 * true })`) of a configured operator; a plain `{ id, email }` never bypasses.
 */
export type OnboardingStateUser = { id: string; email: string | null };

type OnboardingStateQueryClient = Pick<ReturnType<typeof createSupabaseServiceRoleClient>, "from">;

/**
 * Canonical resolver for onboarding/activation state. This is the single
 * source of truth for all routing decisions related to onboarding/access
 * gating — including Edge middleware (src/proxy.ts performs no
 * onboarding-state redirects of its own; (protected)/layout.tsx is the sole
 * caller that redirects on state).
 *
 * State is derived exclusively from real persisted entities, and — critically
 * — from the SAME evidence source the PR #547 workspace-activation engine
 * uses (`collectWorkspaceActivationEvidence`), not a second, independently-
 * queried state machine with its own overlapping semantics:
 *   - "no_workspace": no resolvable workspace for this user (defensive —
 *     resolveWriteWorkspace/ensureUserWorkspace bootstrap a workspace before
 *     this is normally called, so this is effectively unreachable in the
 *     (protected) layout, but is handled honestly rather than assumed away).
 *   - "needs_project": a workspace exists but has zero real, non-archived
 *     Projects.
 *   - "needs_task": a real Project exists but zero real execution tasks do.
 *   - "execution_started": a real Project AND a real execution task exist,
 *     but Command Center is not yet active (no PMF-004-backed default PMO).
 *   - "active": Command Center is active — a real `pmos` row exists,
 *     produced by PMF-004's idempotent `ensure_default_pmo`/`savePmoTenant`
 *     path. This is deliberately independent of task existence: Command
 *     Center activation (`activateContextAction`) can create a Project and
 *     PMO together without a task ever existing first, and once Command
 *     Center is active that is the terminal onboarding state regardless.
 *   - "trial_blocked": an expired/revoked trial license blocks access.
 *
 * A PMO/Command Center is explicitly NOT a precondition for reaching
 * "needs_task"/"execution_started" — ADR-PMF-006 Rule 11 requires that no
 * onboarding flow gate Project (or task) creation behind creation of a level
 * above Project. "active" specifically means Command Center is active, never
 * merely "a Project exists" — see `isOnboardingComplete` vs
 * `hasWorkspaceAccess` in `onboarding-route-map.ts` for how this distinction
 * is used by two different callers (persistent route gate vs. post-auth
 * landing) without duplicating vocabulary.
 *
 * There is no persisted "onboardingComplete"-style flag anywhere in this
 * resolution: every branch reads real rows.
 *
 * NOTE: This function uses service-role DB access exclusively (both for its
 * own trial/workspace queries and, by passing the same client through to
 * `collectWorkspaceActivationEvidence`, for evidence collection) — never the
 * cookie/RLS-scoped client that function defaults to. This resolver must be
 * reliable in every calling context, including immediately after a fresh
 * sign-in/sign-up in the same request (see `OnboardingStateUser` above), so
 * it never depends on a session cookie having propagated. It is intended for
 * server-side surfaces only (Server Components, Route Handlers, Server
 * Actions). Do NOT use this in Edge middleware (proxy.ts), which cannot
 * perform async DB calls.
 */
export async function resolveOnboardingState(
  user: OnboardingStateUser,
  workspaceId: string | null,
  opts?: { isRecovered?: boolean; getClient?: () => OnboardingStateQueryClient }
): Promise<OnboardingState> {
  if (!workspaceId) return "no_workspace";

  const supabase =
    opts?.getClient?.() ??
    createSupabaseServiceRoleClient({
      routeId: "auth/resolve-onboarding-state",
      operation: "select",
      reason: "onboarding_state_resolution",
      workspaceId,
      systemActor: "system",
      actorUserId: user.id,
    });

  // Entitlement check — skipped for newly-bootstrapped workspaces and internal
  // users. See `resolveTrialEntitlement` for the policy.
  if (!isFounderOrInternalUser(user) && !opts?.isRecovered) {
    if ((await resolveTrialEntitlement(supabase, user.id)) === "blocked") {
      return "trial_blocked";
    }
  }

  // Post-workspace-existence state reuses the exact evidence probes the PR
  // #547 engine uses — the service-role client already constructed above is
  // passed through so this never depends on the cookie/RLS-scoped default.
  // `role: "viewer"` is a functionally inert placeholder: it is only
  // threaded into `evidence.role` (used for per-step `actionAllowed` display
  // logic and activation-mode derivation), neither of which this routing
  // resolver reads — it consumes only projectExists/taskExists/pmoExists.
  const evidence = await collectWorkspaceActivationEvidence({
    workspaceId,
    userId: user.id,
    role: "viewer",
    getClient: async () => supabase,
  });

  if (!evidence.projectExists) return "needs_project";
  if (evidence.pmoExists) return "active";
  if (!evidence.taskExists) return "needs_task";
  return "execution_started";
}

export type TrialEntitlement = "entitled" | "blocked";

/**
 * Access-entitlement policy behind "trial_blocked".
 *
 * Two kinds of account reach the protected app:
 *
 *   - Early-access/invited accounts. Accepting an invite provisions a
 *     `trial_licenses` row on the workspace (src/lib/early-access.ts). Those
 *     accounts are governed by that license: "active"/"pending" grant access;
 *     "expired" (including one that has just passed `trial_end_at`, which is
 *     persisted here) and "revoked" block it.
 *   - Self-serve accounts from public /signup. Nothing ever provisions a trial
 *     license for them — they are on the Free plan, which is the default
 *     company plan (`getCompanySubscription` with no row) and has no expiry.
 *     Paid plans are layered on top of Free via Stripe, never via a trial
 *     license.
 *
 * So "no trial license on any of the user's workspaces" means Free, not
 * "expired". Before this was distinguished, every self-serve account was sent
 * to /trial-inactive on every request after the one that bootstrapped its
 * workspace (that request alone passes via `isRecovered`).
 *
 * What stays blocked:
 *   - the user's most recent trial license (across ALL their memberships, so
 *     switching workspace cannot dodge an expired trial) is expired/revoked,
 *     or is "active" but past `trial_end_at`;
 *   - the user holds no workspace membership at all;
 *   - entitlement cannot be established — any read fails or returns
 *     malformed data. Absence of a trial license only means Free when the
 *     license lookup covered EVERY membership (see `findLatestTrialLicense`,
 *     a single server-side statement); a failed read is never "no trial".
 *
 * "Most recent" is a deliberate choice and is unchanged from the original
 * gate: a re-invited user gets a new license that supersedes an older expired
 * one, and a newer expired/revoked license supersedes an older active one.
 * Postgres orders on full-precision `created_at` and breaks ties by id, so
 * the decision never depends on row order.
 *
 * Invite accounts are only distinguishable from self-serve accounts once
 * activation has linked their license to a workspace: an invitee signs up
 * through the same public /signup (and is a Free account) before opening the
 * invite. Activation (`accept_early_access_invite`) therefore creates the
 * workspace, the membership and the license link in ONE transaction — a
 * failed activation leaves no membership behind to be read as Free.
 */
export async function resolveTrialEntitlement(
  supabase: OnboardingStateQueryClient,
  userId: string,
): Promise<TrialEntitlement> {
  const membership = await hasAnyMembership(supabase, userId);
  if (membership !== true) return "blocked";

  const latestTrial = await findLatestTrialLicense(supabase, userId);
  if (latestTrial === "unavailable") return "blocked";

  // Self-serve Free-plan account: no trial license on any of its workspaces.
  if (latestTrial === null) return "entitled";

  // Expire this trial if it has passed trial_end_at.
  await supabase
    .from("trial_licenses")
    .update({ trial_status: "expired" })
    .eq("id", latestTrial.id)
    .eq("trial_status", "active")
    .lt("trial_end_at", new Date().toISOString());

  const { data: refreshedTrial, error: refreshError } = await supabase
    .from("trial_licenses")
    .select("id, invite_id, workspace_id, trial_status")
    .eq("id", latestTrial.id)
    .maybeSingle();

  if (refreshError || !refreshedTrial) return "blocked";
  if (refreshedTrial.trial_status === "revoked" || refreshedTrial.trial_status === "expired") return "blocked";
  // Past its end date but the expiry write above did not land — still expired.
  if (refreshedTrial.trial_status === "active" && latestTrial.trial_end_at && Date.parse(latestTrial.trial_end_at) < Date.now()) {
    return "blocked";
  }
  return "entitled";
}

/**
 * Whether the user holds at least one workspace membership: `true`, `false`,
 * or "unavailable" when the read fails.
 */
async function hasAnyMembership(supabase: OnboardingStateQueryClient, userId: string): Promise<boolean | "unavailable"> {
  const { data, error } = await supabase.from("workspace_memberships").select("workspace_id").eq("user_id", userId).limit(1);
  if (error || !Array.isArray(data)) return "unavailable";
  return data.length > 0;
}

type LatestTrial = { id: string; trial_end_at: string | null };

/**
 * The most recently created trial license on ANY workspace the user is a
 * member of — `null` when there is none, "unavailable" when it cannot be read.
 *
 * This is ONE statement: trial_licenses inner-joined through workspaces to the
 * user's memberships, ordered and limited server-side. That is what makes the
 * answer complete and consistent:
 *   - there is no client-side list of membership ids to truncate, page or
 *     chunk, so no PostgREST row cap, page boundary or concurrent membership
 *     change between requests can drop the workspace holding the license —
 *     the whole evaluation reads one database snapshot;
 *   - "most recent" is decided by Postgres on the full-precision
 *     `created_at` (ties broken by id), never by a JavaScript Date, which
 *     would truncate microseconds.
 * The `!inner` embeds make the membership filter restrict the license rows
 * themselves, not just the embedded payload.
 */
async function findLatestTrialLicense(
  supabase: OnboardingStateQueryClient,
  userId: string,
): Promise<LatestTrial | null | "unavailable"> {
  const { data, error } = await supabase
    .from("trial_licenses")
    .select("id, trial_status, trial_end_at, created_at, workspaces!inner(workspace_memberships!inner(user_id))")
    .eq("workspaces.workspace_memberships.user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  if (error || !Array.isArray(data)) return "unavailable";
  const row = data[0] as { id?: unknown; trial_end_at?: unknown } | undefined;
  if (!row) return null;
  if (typeof row.id !== "string" || row.id.length === 0) return "unavailable";
  return { id: row.id, trial_end_at: typeof row.trial_end_at === "string" ? row.trial_end_at : null };
}
