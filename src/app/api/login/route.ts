import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";
import { isSafeContinuationRoute } from "@/lib/auth/validate-continuation-route";
import { debugAuthDecision } from "@/lib/auth/auth-decision-debug";
import { buildAuthUserContext } from "@/lib/auth";
import { resolveOnboardingState } from "@/lib/auth/resolve-onboarding-state";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { logContinuityIssue } from "@/lib/auth/auth-continuity-diagnostics";

// POST/Redirect/GET: every outcome of this form POST is answered with 303 See
// Other so the browser follows it with a GET. NextResponse.redirect defaults to
// 307, which preserves the POST method and body — so landing on a page route
// (e.g. /login?error=…, /projects/new) re-POSTed to it and failed with 405.
// Session cookies written by signInWithPassword are merged onto whatever
// response this handler returns, independent of the status code.
function seeOther(path: string, request: Request) {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const requestedRouteFromForm = String(formData.get("next") ?? "").trim();
  const requestedRouteFromQuery = requestUrl.searchParams.get("next")?.trim() ?? "";
  const requestedRoute = requestedRouteFromForm || requestedRouteFromQuery || null;

  if (!email || !password) {
    return seeOther("/login?error=Email+and+password+are+required", request);
  }

  const supabase = await createSupabaseServerClient();
  const { error, data } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const isUnverified = error.message.toLowerCase().includes("email not confirmed");
    const message = isUnverified ? "Please verify your email before logging in." : error.message;
    return seeOther(`/login?error=${encodeURIComponent(message)}`, request);
  }

  const safe = requestedRoute ? isSafeContinuationRoute(requestedRoute) : false;
  // Built directly from signInWithPassword's own response (data.user), never
  // from a subsequent getAuthUser()/cookie-backed session read — see the
  // identical rationale in src/app/signup/actions.ts and "Login/signup
  // session-visibility verification" in
  // docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md.
  const authUser = data.user ? (buildAuthUserContext(data.user, { verifiedByAuthServer: true }) ?? { id: data.user.id, email: null }) : null;
  // signInWithPassword above already wrote the session cookie via this
  // request's cookies() adapter. An uncaught exception anywhere after that
  // point — before this function returns — discards that write entirely:
  // Next.js only merges queued cookie mutations onto a response the route
  // handler actually returns, never onto its own generated error response
  // (verified directly against this Next.js version). resolveOnboardingState/
  // resolveCanonicalWorkspace are non-critical routing enrichment (they only
  // pick which authenticated page to land on), so a failure here must never
  // be allowed to silently destroy an already-established, genuinely valid
  // session — fall back to the same "state unknown" path already used when
  // there's no authUser at all, which resolvePostAuthDestination sends to
  // /projects/new, a safe default for any authenticated user.
  let onboardingState;
  if (authUser) {
    try {
      onboardingState = await resolveOnboardingState(authUser, (await resolveCanonicalWorkspace(authUser.id)).workspaceId);
    } catch (err) {
      logContinuityIssue(
        "auth",
        { code: "post_login_onboarding_resolution_failed", severity: "warn", message: err instanceof Error ? err.message : String(err) },
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

  debugAuthDecision({ requestedRoute, onboardingCompleted: onboardingState != null && onboardingState === "active", decision });
  return seeOther(decision.destination, request);
}
