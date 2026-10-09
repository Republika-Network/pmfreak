import { getAuthUser } from "@/lib/auth";
import { getCompanySubscription } from "@/lib/billing";
import { denyResponse } from "@/lib/security/deny-response";
import { requireBillingManageMembership, WorkspaceMembershipError } from "@/lib/workspace-access";
import { getStripeServerClient } from "@/lib/stripe";
import { BILLING_CHECKOUT_DISABLED_MESSAGE, isBillingCheckoutEnabled } from "@/lib/billing-release";
import { abuseDenyResponse, buildAbuseKey, enforceAbuseLimit } from "@/lib/security/abuse-protection";

const ROUTE_ID = "/api/billing/create-portal-session";

export type CreatePortalSessionDeps = {
  getAuthUser: typeof getAuthUser;
  requireBillingManageMembership: typeof requireBillingManageMembership;
  getCompanySubscription: typeof getCompanySubscription;
  getStripeServerClient: typeof getStripeServerClient;
  enforceAbuseLimit: typeof enforceAbuseLimit;
  isBillingCheckoutEnabled: () => boolean;
};

const defaultDeps: CreatePortalSessionDeps = {
  getAuthUser,
  requireBillingManageMembership,
  getCompanySubscription,
  getStripeServerClient,
  enforceAbuseLimit,
  isBillingCheckoutEnabled: () => isBillingCheckoutEnabled(),
};

/**
 * Testable core of the route handler. `deps` defaults to the real
 * implementations; tests inject fakes so this runs the real authorization and
 * request-handling logic end-to-end without a live Supabase/Stripe backend.
 * Partial overrides merge over the real implementations, so existing tests
 * that construct a deps object predating a new dependency keep working.
 */
export async function handleCreatePortalSession(request: Request, depsOverride: Partial<CreatePortalSessionDeps> = {}): Promise<Response> {
  const deps: CreatePortalSessionDeps = { ...defaultDeps, ...depsOverride };

  // Release control (src/lib/billing-release.ts): while paid checkout is not
  // released, no Stripe session is created — even with Stripe credentials set,
  // and before any auth, membership, abuse-limit or Stripe work runs.
  if (!deps.isBillingCheckoutEnabled()) {
    return Response.json({ error: BILLING_CHECKOUT_DISABLED_MESSAGE, code: "billing_checkout_disabled" }, { status: 503 });
  }

  const user = await deps.getAuthUser();

  if (!user) {
    return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
  }

  const workspaceId = request.headers.get("x-pmf-workspace-id");
  if (!workspaceId) {
    return denyResponse({ status: 403, routeId: ROUTE_ID, message: "Workspace context required.", reason: "workspace_missing", eventType: "billing_governance_denied", actorUserId: user.id });
  }

  // See docs/security/billing-authorization-boundary.md — billing.manage is
  // resolved exclusively from server-side workspace membership.
  try {
    await deps.requireBillingManageMembership({ userId: user.id, workspaceId });
  } catch (error) {
    const reason = error instanceof WorkspaceMembershipError ? error.reason : "workspace_missing";
    return denyResponse({
      status: 403,
      routeId: ROUTE_ID,
      message: "You do not have permission to manage billing for this workspace.",
      reason,
      eventType: "billing_governance_denied",
      actorUserId: user.id,
      workspaceId,
    });
  }

  // Abuse protection is a separate boundary from authorization above — see
  // src/lib/security/abuse-protection-registry.ts ("billing.create_portal_session").
  const abuseDecision = await deps.enforceAbuseLimit({
    scope: "billing.create_portal_session",
    identifier: buildAbuseKey([user.id, workspaceId]),
    limit: 5,
    windowSeconds: 60,
  });
  if (!abuseDecision.allowed) {
    return abuseDenyResponse(abuseDecision, "Too many billing portal attempts. Please wait a moment and try again.");
  }

  const subscription = await deps.getCompanySubscription(user.companyId);

  if (!subscription.stripeCustomerId) {
    return Response.json({ error: "No Stripe customer found for this company." }, { status: 400 });
  }

  try {
    const stripe = deps.getStripeServerClient();
    const origin = request.headers.get("origin") ?? "http://localhost:3000";

    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${origin}/billing`,
    });

    return Response.json({ url: session.url });
  } catch {
    return Response.json({ error: "Unable to create Stripe billing portal session." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  return handleCreatePortalSession(request);
}
