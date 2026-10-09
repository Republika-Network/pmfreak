import { getAuthUser } from "@/lib/auth";
import { getCompanySubscription, updateCompanySubscription } from "@/lib/billing";
import { denyResponse } from "@/lib/security/deny-response";
import { requireBillingManageMembership, WorkspaceMembershipError } from "@/lib/workspace-access";
import { getStripeServerClient } from "@/lib/stripe";
import { BILLING_CHECKOUT_DISABLED_MESSAGE, isBillingCheckoutEnabled } from "@/lib/billing-release";
import { abuseDenyResponse, buildAbuseKey, enforceAbuseLimit } from "@/lib/security/abuse-protection";
import { resolveTrustedOrigin } from "@/lib/security/origin-policy";
import { safeErrorMessage } from "@/lib/security/redaction";

type CheckoutPayload = {
  plan?: "pro" | "pmo";
};

const ROUTE_ID = "/api/billing/create-checkout-session";

export type CreateCheckoutSessionDeps = {
  getAuthUser: typeof getAuthUser;
  requireBillingManageMembership: typeof requireBillingManageMembership;
  getCompanySubscription: typeof getCompanySubscription;
  updateCompanySubscription: typeof updateCompanySubscription;
  getStripeServerClient: typeof getStripeServerClient;
  enforceAbuseLimit: typeof enforceAbuseLimit;
  isBillingCheckoutEnabled: () => boolean;
};

const defaultDeps: CreateCheckoutSessionDeps = {
  getAuthUser,
  requireBillingManageMembership,
  getCompanySubscription,
  updateCompanySubscription,
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
export async function handleCreateCheckoutSession(request: Request, depsOverride: Partial<CreateCheckoutSessionDeps> = {}): Promise<Response> {
  const deps: CreateCheckoutSessionDeps = { ...defaultDeps, ...depsOverride };

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

  // Authorization for billing.manage is resolved exclusively from server-side
  // workspace membership (workspace_memberships.role). Display role,
  // user_metadata.role, and any client-supplied role/actorRole/billingRole
  // fields on the request body are never consulted — see
  // docs/security/billing-authorization-boundary.md.
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

  // Abuse protection is a separate boundary from authorization above: a
  // legitimately-authorized owner/admin can still spam Stripe session
  // creation. See docs/security/abuse-protection-boundary.md and
  // src/lib/security/abuse-protection-registry.ts ("billing.create_checkout_session").
  const abuseDecision = await deps.enforceAbuseLimit({
    scope: "billing.create_checkout_session",
    identifier: buildAbuseKey([user.id, workspaceId]),
    limit: 5,
    windowSeconds: 60,
  });
  if (!abuseDecision.allowed) {
    return abuseDenyResponse(abuseDecision, "Too many checkout attempts. Please wait a moment and try again.");
  }

  let payload: CheckoutPayload;

  try {
    payload = (await request.json()) as CheckoutPayload;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const plan = payload.plan ?? "pro";

  if (plan !== "pro" && plan !== "pmo") {
    return Response.json({ error: "Unsupported plan." }, { status: 400 });
  }

  const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

  if (!stripeEnabled) {
    return Response.json({ error: "Billing is not configured yet. Please contact support to upgrade." }, { status: 503 });
  }

  const priceId = plan === "pmo" ? process.env.STRIPE_PMO_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) {
    return Response.json({ error: `Missing price ID for ${plan} plan on the server.` }, { status: 500 });
  }

  try {
    const stripe = deps.getStripeServerClient();
    const subscription = await deps.getCompanySubscription(user.companyId);

    const customerId = subscription.stripeCustomerId
      ? subscription.stripeCustomerId
      : (
          await stripe.customers.create({
            email: user.email,
            name: user.companyName,
            metadata: {
              companyId: user.companyId,
              companyName: user.companyName,
              requestedByUserId: user.id,
            },
          })
        ).id;

    if (!subscription.stripeCustomerId) {
      // company_subscriptions has no authenticated write policy (Perilla 7) —
      // this is one of the two approved writers (checkout route + billing
      // webhook lifecycle), gated on the requireBillingManageMembership check
      // above, not on Stripe metadata or any client-supplied field.
      await deps.updateCompanySubscription(
        user.companyId,
        { stripeCustomerId: customerId },
        {
          useServiceRole: true,
          privilegedContext: {
            routeId: ROUTE_ID,
            operation: "bootstrap_stripe_customer_id",
            reason: "First-time Stripe customer id persisted after workspace billing-manage membership check.",
            actorUserId: user.id,
            workspaceId,
          },
        },
      );
    }

    // The Origin request header is attacker-controlled — trusting it
    // directly would let anyone redirect the post-checkout Stripe success/
    // cancel flow to an arbitrary domain. resolveTrustedOrigin() only uses
    // it if it's on the allowlist, otherwise falls back to the canonical
    // app origin (see docs/security/production-deployment-boundary.md).
    const origin = resolveTrustedOrigin(request.headers.get("origin"));

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/billing?success=true`,
      cancel_url: `${origin}/billing?canceled=true`,
      metadata: {
        companyId: user.companyId,
        plan,
      },
      subscription_data: {
        metadata: {
          companyId: user.companyId,
          plan,
        },
      },
    }, {
      idempotencyKey: `checkout:${user.companyId}:${plan}`,
    });

    console.info("[billing] checkout session created", { companyId: user.companyId, customerId, plan, sessionId: session.id });

    return Response.json({ url: session.url });
  } catch (error) {
    console.error("[billing] checkout session creation failed", { companyId: user.companyId, plan, error: safeErrorMessage(error) });
    return Response.json({ error: "Unable to create Stripe checkout session." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  return handleCreateCheckoutSession(request);
}
