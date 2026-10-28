import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";
import { isSafeContinuationRoute } from "@/lib/auth/validate-continuation-route";
import { buildAuthUserContext } from "@/lib/auth";
import { resolveOnboardingState } from "@/lib/auth/resolve-onboarding-state";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { logContinuityIssue } from "@/lib/auth/auth-continuity-diagnostics";
import { INVALID_CONFIRMATION_LINK_MESSAGE, parseConfirmationParams } from "@/lib/auth/email-confirmation";

/**
 * Email confirmation via token_hash (Supabase "Confirm signup" template:
 * {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email).
 *
 * Unlike /auth/callback's PKCE code exchange, verifyOtp needs no
 * code_verifier cookie from the browser that submitted the signup form, so
 * the link works when opened on a different device or mail-app browser
 * (e.g. signup on desktop, confirm on iPhone).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = parseConfirmationParams(url.searchParams);
  const invalidLink = () =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(INVALID_CONFIRMATION_LINK_MESSAGE)}`, request.url));

  if (!params) {
    return invalidLink();
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({ type: params.type, token_hash: params.tokenHash });

  if (error || !data.user) {
    return invalidLink();
  }

  // Use verifyOtp's own user rather than re-reading the just-written
  // session cookies within the same request. Onboarding resolution only
  // picks the landing page; a failure there must not discard the session
  // verifyOtp just established (same rationale as src/app/signup/actions.ts).
  const authUser = buildAuthUserContext(data.user, { verifiedByAuthServer: true }) ?? { id: data.user.id, email: null };
  let onboardingState;
  try {
    onboardingState = await resolveOnboardingState(authUser, (await resolveCanonicalWorkspace(authUser.id)).workspaceId);
  } catch (err) {
    logContinuityIssue(
      "auth",
      { code: "post_confirm_onboarding_resolution_failed", severity: "warn", message: err instanceof Error ? err.message : String(err) },
      { userId: authUser.id },
    );
  }

  const decision = resolvePostAuthDestination({
    isAuthenticated: true,
    onboardingState,
    requestedRoute: params.next,
    isRequestedRouteSafe: Boolean(params.next && isSafeContinuationRoute(params.next)),
  });

  return NextResponse.redirect(new URL(decision.destination, request.url));
}
