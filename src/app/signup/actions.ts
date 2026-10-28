"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSafeContinuationRoute } from "@/lib/auth/validate-continuation-route";
import { resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";
import { buildAuthUserContext } from "@/lib/auth";
import { resolveOnboardingState } from "@/lib/auth/resolve-onboarding-state";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { buildSignupProfile } from "./build-signup-profile";
import { buildAbuseKey, enforceAbuseLimit, getClientIpFromHeaders } from "@/lib/security/abuse-protection";
import { logContinuityIssue } from "@/lib/auth/auth-continuity-diagnostics";
import { buildSignupEmailRedirectTo } from "@/lib/auth/email-confirmation";

export async function signupAction(formData: FormData) {
  const { email, password, fullName, companyName, requestedRoute, role } = buildSignupProfile(formData);

  if (!email || !password || !fullName || !companyName) {
    redirect("/signup?error=Please+complete+all+required+fields");
  }

  // Abuse protection is separate from authorization: signup is intentionally
  // public, but unlimited account creation still floods Supabase Auth and
  // workspace bootstrap. See docs/security/abuse-protection-boundary.md
  // ("signup.create_account").
  const headersList = await headers();
  const clientIp = getClientIpFromHeaders(headersList);
  const abuseDecision = await enforceAbuseLimit({
    scope: "signup.create_account",
    identifier: buildAbuseKey([clientIp, email]),
    limit: 8,
    windowSeconds: 3600,
  });
  if (!abuseDecision.allowed) {
    redirect("/signup?error=Too+many+signup+attempts.+Please+try+again+later.");
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: buildSignupEmailRedirectTo(),
      data: {
        full_name: fullName,
        company_name: companyName,
        role,
      },
    },
  });

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }

  if (!data.session) {
    redirect(`/signup/confirm-email?email=${encodeURIComponent(email)}`);
  }

  const safe = requestedRoute ? isSafeContinuationRoute(requestedRoute) : false;
  // Built directly from signUp's own response (data.user), never from a
  // subsequent getAuthUser()/cookie-backed session read: cookies() is
  // documented to share a mutable, request-scoped store across sequential
  // calls within one Server Action, but this destination decision doesn't
  // need to depend on that at all when the identity is already in hand —
  // see "Login/signup session-visibility verification" in
  // docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md.
  // resolveOnboardingState/resolveCanonicalWorkspace both use the
  // service-role client (keyed by userId), independent of session cookies.
  const authUser = data.user ? (buildAuthUserContext(data.user, { verifiedByAuthServer: true }) ?? { id: data.user.id, email: null }) : null;
  // signUp above already established the session (cookies were queued via
  // this request's cookies() adapter, and data.session is confirmed
  // present above). An uncaught exception anywhere after that point —
  // before this function's own redirect() call — would discard that
  // write entirely, same hazard as src/app/api/login/route.ts (see
  // docs/audits/remediation/release-gate-01-auth-session-persistence.md
  // §13a): resolveOnboardingState/resolveCanonicalWorkspace only pick
  // which authenticated page to land on, never establish or validate the
  // session itself, so a failure here must never be allowed to destroy an
  // already-established, genuinely valid signup. Fall back to the same
  // "state unknown" path already used when there's no authUser at all,
  // which resolvePostAuthDestination sends to /projects/new — never
  // claims onboarding is complete, never fabricates workspace/project
  // state.
  let onboardingState;
  if (authUser) {
    try {
      onboardingState = await resolveOnboardingState(authUser, (await resolveCanonicalWorkspace(authUser.id)).workspaceId);
    } catch (err) {
      logContinuityIssue(
        "auth",
        { code: "post_signup_onboarding_resolution_failed", severity: "warn", message: err instanceof Error ? err.message : String(err) },
        { userId: authUser.id },
      );
    }
  }
  const decision = resolvePostAuthDestination({
    isAuthenticated: Boolean(data.user),
    onboardingState,
    requestedRoute,
    isRequestedRouteSafe: safe,
  });
  redirect(decision.destination);
}
