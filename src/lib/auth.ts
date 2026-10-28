import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/observability/logger";

export type UserRole = "owner" | "admin" | "pm" | "viewer";

export type AuthUserContext = {
  id: string;
  email: string;
  fullName: string;
  companyId: string;
  companyName: string;
  /**
   * DISPLAY role only — sourced from `user_metadata.role`, which is written at
   * signup and is informational, never authoritative. It is intentionally
   * clamped so it can never read back as "owner" or "admin": those values are
   * never written to metadata by any legitimate code path, so if one is ever
   * present (historical data, a tampered client, direct DB edits) it is
   * degraded to the minimum-privilege role rather than trusted.
   *
   * Never branch authorization logic on this field. The trustworthy sources
   * for elevated privilege are workspace membership (`workspace_memberships.role`,
   * see `@/lib/workspace-access`) and the server-configured operator user ids
   * (`isFounderOrInternalUser` below).
   */
  role: UserRole;
  /**
   * @deprecated Stale, non-authoritative. Reflects the legacy
   * `user_metadata.onboarding_completed` flag, which no production code path
   * writes as `true` anymore (see
   * docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md).
   * Never use this for routing or activation-state decisions — use
   * `resolveOnboardingState` (derives from real workspace/project rows)
   * instead. Retained only so existing display-only consumers keep
   * compiling; do not add new reads of this field.
   */
  onboardingCompleted: boolean;
};

/** Minimum-privilege role assigned to every publicly self-registered account. */
export const DEFAULT_SIGNUP_ROLE: UserRole = "viewer";

/**
 * Maps informational `user_metadata.role` to a display role. "owner" and
 * "admin" are excluded on purpose — they must never be derivable from
 * client-controlled metadata. See `AuthUserContext.role` for the trust
 * boundary this enforces.
 */
export const toDisplayRole = (role: unknown): UserRole => {
  if (role === "pm" || role === "viewer") {
    return role;
  }

  return DEFAULT_SIGNUP_ROLE;
};

// Minimal shape this needs from a Supabase auth user — deliberately not the
// full SDK `User` type, so callers that already resolved a user via their
// own `getUser()` call (e.g. assertRuntimeAuthContinuity) can build a full
// AuthUserContext from it directly, without a second `getUser()` round trip.
// A second, independent server-side `getUser()` call in the same request can
// itself trigger a Supabase token refresh; server COMPONENT contexts cannot
// persist a refreshed session (see src/lib/supabase/server.ts's setAll), so
// a redundant call risks silently consuming/rotating the refresh token a
// second time while the first rotation's replacement was never written back
// to cookies — see docs/audits/remediation/release-gate-01-auth-session-persistence.md.
//
// `verifiedByAuthServer: true` may only be passed for a user object GoTrue
// itself just returned (`auth.getUser()`, or the `user` of a successful
// sign-in / sign-up / verifyOtp response) — never for `getSession()`, whose
// user is decoded from the request cookie without server verification. Only
// such contexts can satisfy `isFounderOrInternalUser`.
export type MinimalSupabaseUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/**
 * Identity facts recorded at the moment a context is built from a GoTrue
 * user, keyed by the context object itself. The operator decision reads only
 * this record — never the context's (mutable, copyable) fields — so a plain
 * object literal, a spread copy, or a context whose `id` was reassigned after
 * construction is never an operator.
 */
type VerifiedIdentity = { readonly userId: string; readonly emailConfirmed: boolean };
const verifiedIdentities = new WeakMap<object, VerifiedIdentity>();

const isConfirmedAt = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

export const buildAuthUserContext = (
  user: MinimalSupabaseUser,
  options?: { verifiedByAuthServer?: boolean },
): AuthUserContext | null => {
  if (!user.email) {
    return null;
  }

  const metadata = user.user_metadata ?? {};

  const context: AuthUserContext = {
    id: user.id,
    email: user.email,
    fullName: typeof metadata.full_name === "string" ? metadata.full_name : user.email,
    // Tenant identity is the authenticated user id, never user_metadata.company_id:
    // user_metadata is user-editable via GoTrue (F1). Matches public.current_company_id().
    companyId: user.id,
    companyName: typeof metadata.company_name === "string" ? metadata.company_name : "Independent",
    role: toDisplayRole(metadata.role),
    onboardingCompleted: metadata.onboarding_completed === true,
  };
  if (options?.verifiedByAuthServer === true) {
    verifiedIdentities.set(context, { userId: user.id, emailConfirmed: isConfirmedAt(user.email_confirmed_at) });
  }
  return context;
};

export const getAuthUser = cache(async (): Promise<AuthUserContext | null> => {
  if (!hasSupabaseEnv) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (!user) {
    // P0-LAUNCH-04. An unreachable auth dependency and an ordinary
    // unauthenticated caller both resolve to "no principal", and both must
    // continue to — this function's contract is unchanged and a transport
    // failure MUST NEVER read as an authenticated user. But before this, the two
    // were indistinguishable to an operator: every protected route answered a
    // bare 401 and nothing was recorded, so "nobody is logged in" and "nobody
    // CAN log in" looked identical in production.
    //
    // The classification is on the error CLASS, not on its status code.
    // `AuthRetryableFetchError` (status 0) is auth-js's transport failure;
    // `AuthSessionMissingError` carries status *400*, so the widely-copied
    // "not 401/403 means network" test — which
    // src/lib/supabase/proxy.ts and src/lib/auth/runtime-auth-continuity.ts
    // both still use — treats every anonymous request as a network error and
    // therefore cannot make this distinction. Keying on the class makes this
    // signal QUIET: it appears only when the dependency is genuinely
    // unreachable, never on ordinary anonymous traffic.
    //
    // Only the error class and its status are recorded. The provider's message
    // is deliberately not logged, and the logger redacts regardless.
    if (error?.name === "AuthRetryableFetchError") {
      logger.error("auth_dependency_unavailable", {
        operation: "getAuthUser",
        error_code: error.name,
        status: error.status ?? 0,
      });
    }
    return null;
  }

  return buildAuthUserContext(user, { verifiedByAuthServer: true });
});

export const requireAuthUser = async () => {
  const user = await getAuthUser();
  if (!user) {
    const headersList = await headers();
    const currentPath = headersList.get("x-pathname") ?? "/command-center";
    const nextParam = encodeURIComponent(currentPath || "/command-center");
    redirect(`/login?next=${nextParam}`);
  }
  return user;
};

// Operator authority is granted to explicit, immutable auth user ids only —
// never to an email address or domain (F6). Server-only; never sent to clients.
const FOUNDER_OPERATOR_USER_IDS_ENV = "FOUNDER_OPERATOR_USER_IDS";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type OperatorConfig = { readonly status: "ok"; readonly userIds: ReadonlySet<string> } | { readonly status: "absent" | "invalid" };

/**
 * Parses FOUNDER_OPERATOR_USER_IDS (comma-separated auth.users ids). Unset or
 * empty is "absent"; any entry that is not a UUID makes the whole value
 * "invalid" — a typo (or a leftover email) must fail closed for everyone
 * rather than silently shrink or widen the operator set.
 */
const readOperatorConfig = (): OperatorConfig => {
  const entries = (process.env[FOUNDER_OPERATOR_USER_IDS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return { status: "absent" };
  if (!entries.every((entry) => UUID_PATTERN.test(entry))) return { status: "invalid" };
  return { status: "ok", userIds: new Set(entries) };
};

export type FounderAccessDecision =
  | "allow"
  | "deny_unverified_identity"
  | "deny_email_unconfirmed"
  | "deny_operators_not_configured"
  | "deny_operators_misconfigured"
  | "deny_not_operator";

export type FounderAccessResult = {
  allowed: boolean;
  decision: FounderAccessDecision;
};

/**
 * Centralized founder/internal operator decision. This is the ONLY function
 * that may authorize founder/internal-only surfaces (early access
 * administration, founder-program operator routes, trust/governance internal
 * routes, internal summaries, trial-expiry bypass).
 *
 * Allows only when, in order:
 *   1. `user` is a context `buildAuthUserContext` built from a user GoTrue
 *      verified (`getAuthUser()` / `requireAuthUser()`); anything else — a
 *      request body, a hand-built `{ email }` / `{ id }` object, a spread
 *      copy, a cookie-decoded `getSession()` user — is
 *      `deny_unverified_identity`;
 *   2. that GoTrue user had a confirmed email (`email_confirmed_at`) — defense
 *      in depth on top of the id allowlist;
 *   3. FOUNDER_OPERATOR_USER_IDS is configured and valid (fails closed when
 *      absent or malformed);
 *   4. the verified user id is listed in it (exact match).
 *
 * Email addresses and domains grant nothing: there is no internal-domain
 * list, FOUNDER_EMAIL_ALLOWLIST is no longer read, and `user_metadata`,
 * display role and request input are never consulted.
 */
export const evaluateFounderOrInternalAccess = (user: unknown): FounderAccessResult => {
  const identity = typeof user === "object" && user !== null ? verifiedIdentities.get(user) : undefined;
  if (!identity) return { allowed: false, decision: "deny_unverified_identity" };
  if (!identity.emailConfirmed) return { allowed: false, decision: "deny_email_unconfirmed" };

  const config = readOperatorConfig();
  if (config.status !== "ok") {
    return { allowed: false, decision: config.status === "absent" ? "deny_operators_not_configured" : "deny_operators_misconfigured" };
  }

  return config.userIds.has(identity.userId.toLowerCase())
    ? { allowed: true, decision: "allow" }
    : { allowed: false, decision: "deny_not_operator" };
};

/**
 * Gates founder/internal-only surfaces. Pass the context returned by
 * `getAuthUser()` / `requireAuthUser()` (or a server-verified
 * `buildAuthUserContext`) itself — see `evaluateFounderOrInternalAccess`.
 */
export const isFounderOrInternalUser = (user: object) => evaluateFounderOrInternalAccess(user).allowed;
