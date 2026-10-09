"use client";

import { useEffect, useState } from "react";
import type { CompanySubscriptionState } from "@/lib/billing";
import { billingRequestInit, clearPendingPlan, PAID_PLANS, readPendingPlan, type PaidPlanTier } from "@/lib/billing-plans";

type Props = {
  subscription: CompanySubscriptionState;
  workspaceId: string | null;
  /** Server-resolved owner/admin check; the billing routes enforce it again. */
  canManageBilling: boolean;
  /** Release control (src/lib/billing-release.ts). Off: the billing routes refuse; offer nothing. */
  checkoutEnabled: boolean;
  /** Plan from /billing?plan=…, validated server-side. */
  requestedPlan: PaidPlanTier | null;
};

const NO_WORKSPACE_MESSAGE = "We couldn't find a workspace for your account yet. Finish setting up your workspace, then try again.";

export default function BillingClient({ subscription, workspaceId, canManageBilling, checkoutEnabled, requestedPlan }: Props) {
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false);
  const [isCreatingPortal, setIsCreatingPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan a visitor chose on /pricing before signing in: from the URL when
  // it survived the redirects, otherwise from this browser (see billing-plans.ts).
  const [chosenPlan, setChosenPlan] = useState<PaidPlanTier | null>(requestedPlan);

  useEffect(() => {
    // Stripe returns here with ?success=true after payment: the choice is spent.
    if (new URLSearchParams(window.location.search).get("success") === "true") {
      clearPendingPlan(window.localStorage);
      return;
    }
    if (requestedPlan) return;
    const pending = readPendingPlan(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; reading it during render would break hydration.
    if (pending) setChosenPlan(pending);
  }, [requestedPlan]);

  const hasPaidPlan = subscription.plan !== "free";

  useEffect(() => {
    // A company that already pays switches plans in the Stripe portal (never a
    // second subscription), and a member who cannot manage billing cannot act on
    // the choice: in both cases the saved choice is spent once shown.
    if (hasPaidPlan || !canManageBilling) clearPendingPlan(window.localStorage);
  }, [hasPaidPlan, canManageBilling]);

  const dismissChosenPlan = () => {
    clearPendingPlan(window.localStorage);
    setChosenPlan(null);
  };

  const createCheckoutSession = async (plan: PaidPlanTier = "pro") => {
    if (!workspaceId) {
      setError(NO_WORKSPACE_MESSAGE);
      return;
    }
    setIsCreatingCheckout(true);
    setError(null);

    try {
      const response = await fetch("/api/billing/create-checkout-session", billingRequestInit(workspaceId, plan));

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        setError(payload.error ?? "Unable to create checkout session.");
        return;
      }

      // Keep the choice until payment succeeds: a canceled Stripe checkout
      // returns to /billing?canceled=true and should offer the same plan again.
      window.location.href = payload.url;
    } catch {
      setError("Unable to create checkout session.");
    } finally {
      setIsCreatingCheckout(false);
    }
  };

  const createPortalSession = async () => {
    if (!workspaceId) {
      setError(NO_WORKSPACE_MESSAGE);
      return;
    }
    setIsCreatingPortal(true);
    setError(null);

    try {
      const response = await fetch("/api/billing/create-portal-session", billingRequestInit(workspaceId));

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        setError(payload.error ?? "Unable to open Stripe billing portal.");
        return;
      }

      window.location.href = payload.url;
    } catch {
      setError("Unable to open Stripe billing portal.");
    } finally {
      setIsCreatingPortal(false);
    }
  };

  const onManageSubscription = async () => {
    if (subscription.stripeCustomerId) {
      await createPortalSession();
      return;
    }

    // No Stripe customer yet, so this is a first checkout: honour the tier the
    // user chose rather than silently defaulting to Pro.
    await createCheckoutSession(chosenPlan ?? "pro");
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h2 className="text-lg font-semibold text-cyan-900">Manage Subscription</h2>
      <p className="mt-2 text-sm text-slate-700">
        Use Stripe checkout and billing portal to upgrade, update payment methods, or cancel.
      </p>

      <div className="mt-4 grid gap-3 text-sm text-slate-800 md:grid-cols-2">
        <p>
          <span className="text-slate-600">Plan:</span> {subscription.plan}
        </p>
        <p>
          <span className="text-slate-600">Status:</span> {subscription.subscriptionStatus}
        </p>
        <p>
          <span className="text-slate-600">Stripe Customer ID:</span> {subscription.stripeCustomerId ?? "Not created"}
        </p>
        <p>
          <span className="text-slate-600">Current Period End:</span>{" "}
          {subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleString() : "N/A"}
        </p>
      </div>

      {chosenPlan ? (
        <div className="mt-5 rounded-xl border border-slate-300 bg-white p-4" aria-labelledby="chosen-plan-heading">
          <h3 id="chosen-plan-heading" className="text-sm font-semibold text-slate-900">
            {!checkoutEnabled ? "Paid plans aren\u2019t available yet" : !canManageBilling ? "Plan changes need a workspace owner or admin" : hasPaidPlan ? "You already have a paid plan" : `You chose ${PAID_PLANS[chosenPlan].name}`}
          </h3>
          {!checkoutEnabled ? (
            <p className="mt-1 text-sm text-slate-700">
              You chose {PAID_PLANS[chosenPlan].name}, but paid checkout isn&rsquo;t open yet, so nothing can be charged. Your workspace stays on its current plan.
            </p>
          ) : !canManageBilling ? (
            <p className="mt-1 text-sm text-slate-700">
              You chose {PAID_PLANS[chosenPlan].name}, but only workspace owners and admins can start a subscription. Ask one of them to upgrade from this page.
            </p>
          ) : hasPaidPlan ? (
            <p className="mt-1 text-sm text-slate-700">
              Your company is on the {subscription.plan} plan. To switch to {PAID_PLANS[chosenPlan].name}, use Manage Subscription.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-700">
                {PAID_PLANS[chosenPlan].name} &middot; {PAID_PLANS[chosenPlan].price} {PAID_PLANS[chosenPlan].period}. You&rsquo;ll confirm payment on Stripe.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void createCheckoutSession(chosenPlan)}
                  disabled={isCreatingCheckout || isCreatingPortal}
                  aria-busy={isCreatingCheckout}
                  className="inline-flex h-10 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:bg-slate-500"
                >
                  {isCreatingCheckout ? "Redirecting..." : `Continue to ${PAID_PLANS[chosenPlan].name} checkout`}
                </button>
                <button
                  type="button"
                  onClick={dismissChosenPlan}
                  className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-slate-700 underline underline-offset-4 hover:text-slate-900"
                >
                  Not now
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error ? <p role="alert" className="mt-4 text-sm text-rose-800">{error}</p> : null}

      {checkoutEnabled ? null : (
        <p className="mt-5 text-sm text-slate-700">Plan upgrades and subscription management aren&rsquo;t available in PMFreak yet.</p>
      )}

      {checkoutEnabled && !canManageBilling && !chosenPlan ? (
        <p className="mt-5 text-sm text-slate-700">Only workspace owners and admins can change the plan or manage the subscription.</p>
      ) : null}

      {checkoutEnabled && canManageBilling ? (
      <div className="mt-5 flex flex-wrap gap-3">
        {subscription.plan === "free" && !chosenPlan ? (
          <button
            type="button"
            onClick={() => void createCheckoutSession("pro")}
            disabled={isCreatingCheckout}
            className="inline-flex h-10 items-center justify-center rounded-full bg-cyan-300 px-5 text-sm font-semibold text-slate-100 transition hover:bg-cyan-200 disabled:bg-slate-500"
          >
            {isCreatingCheckout ? "Redirecting..." : "Upgrade to Pro"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={onManageSubscription}
          disabled={isCreatingPortal || isCreatingCheckout}
          className="inline-flex h-10 items-center justify-center rounded-full border border-cyan-300/70 px-5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-300/10 disabled:border-slate-500 disabled:text-slate-600"
        >
          {isCreatingPortal ? "Opening portal..." : "Manage Subscription"}
        </button>
      </div>
      ) : null}
    </section>
  );
}
