import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { isSafeContinuationRoute } from "@/lib/auth/validate-continuation-route";
import {
  getRouteAccessPolicy,
  isAuthRoute,
  isInternalDebugRoute,
  isProtectedPageRoute,
} from "@/lib/auth/route-policy-registry";

// ─── Policy table ────────────────────────────────────────────────────────────
// Public routes        → passthrough (no auth required)
// Auth routes          → redirect authenticated users to a safe continuation
//                         route or a neutral protected default
// Protected routes     → unauthenticated → /login?next=<path>
// /workspace            → always → /command-center (legacy shell quarantined)
// API routes           → passthrough (handled by route handlers)
// Assets/_next         → excluded by matcher; never reach this function
//
// Onboarding/activation-state-based redirects (needs_project, trial_blocked)
// are NOT decided here. Edge middleware cannot perform async DB calls, and a
// JWT-boolean shortcut is exactly the stale, non-authoritative signal PMF-002
// identified as a routing-layer gate that could diverge from real persisted
// state. (protected)/layout.tsx — which calls the DB-derived
// resolveOnboardingState on every request — is the single canonical
// authority for those redirects instead.
// ─────────────────────────────────────────────────────────────────────────────

const passthroughWithPathname = (request: NextRequest) => {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
};

// Every redirect must carry the cookies updateSession wrote to the passthrough
// response. Supabase ROTATES the refresh token server-side when it refreshes a
// session, so building a fresh redirect response silently drops the Set-Cookie
// headers holding the new token pair — the browser keeps the old, already
// consumed refresh token, and the session intermittently dies on the next
// refresh ("Invalid Refresh Token: Already Used" → protected-area error →
// bounce to /login).
const redirectPreservingSession = (destination: URL, sessionResponse: NextResponse) => {
  const redirect = NextResponse.redirect(destination);
  sessionResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
};

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const policy = getRouteAccessPolicy(pathname);

  // Public marketing/reset/callback surfaces must never depend on the auth
  // provider being reachable just to render. This is especially important for
  // preview deployments, where auth environment configuration may intentionally
  // differ from production. Preserve x-pathname for downstream server
  // components, but do not perform an unnecessary Supabase round trip.
  if (policy === "public") {
    return passthroughWithPathname(request);
  }

  // API routes own authentication inside their route handlers. Avoid making
  // every API request depend on an additional proxy-level auth round trip.
  if (policy === "api") {
    return passthroughWithPathname(request);
  }

  const { response, user } = await updateSession(request);

  // Debug routes blocked in production
  if (isInternalDebugRoute(pathname) && process.env.NODE_ENV === "production") {
    return redirectPreservingSession(new URL("/command-center", request.url), response);
  }

  // Unauthenticated access to protected route → /login?next=<path>
  if (isProtectedPageRoute(pathname) && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return redirectPreservingSession(loginUrl, response);
  }

  if (user) {
    // Authenticated user on auth route → send them to a safe continuation
    // route if one was requested, otherwise a neutral protected default.
    // No onboarding-state decision is made here (see file header) —
    // (protected)/layout.tsx re-evaluates real state on the landing route
    // and redirects further (e.g. to /projects/new) if needed.
    if (isAuthRoute(pathname)) {
      const requestedRoute = request.nextUrl.searchParams.get("next");
      const isRequestedRouteSafe = requestedRoute ? isSafeContinuationRoute(requestedRoute) : false;
      const destination = isRequestedRouteSafe ? (requestedRoute as string) : "/command-center";
      return redirectPreservingSession(new URL(destination, request.url), response);
    }

    // Quarantine the legacy dark /workspace shell — always bounce authenticated
    // users to the premium light Command Center instead of rendering it.
    if (pathname === "/workspace") {
      return redirectPreservingSession(new URL("/command-center", request.url), response);
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon.png|icon.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
