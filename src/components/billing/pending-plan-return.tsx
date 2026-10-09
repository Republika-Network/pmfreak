"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clearPendingPlan, PAID_PLANS, readPendingPlan, type PaidPlanTier } from "@/lib/billing-plans";

/**
 * Optional "return to Billing" for a plan chosen on /pricing before signing up.
 * Rendered by (protected)/layout.tsx only when isEligibleForPlanReturn() holds
 * (onboarding complete + billing role). Renders nothing unless this browser holds
 * a valid, unexpired choice; it only links to /billing — it never starts checkout.
 */
export function PendingPlanReturn() {
  const [plan, setPlan] = useState<PaidPlanTier | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; reading it during render would break hydration.
    setPlan(readPendingPlan(window.localStorage));
  }, []);

  if (!plan) return null;
  const { name, price, period } = PAID_PLANS[plan];

  const dismiss = () => {
    clearPendingPlan(window.localStorage);
    setPlan(null);
  };

  return (
    <section
      aria-label="Plan you chose before signing up"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm"
    >
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-slate-900">You chose {name} before signing up.</span>{" "}
        {price} {period}. Review it in Billing whenever you&rsquo;re ready.
      </p>
      <div className="flex items-center gap-3">
        <Link
          href={`/billing?plan=${plan}`}
          className="inline-flex h-9 items-center justify-center rounded-full bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Go to Billing
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-semibold text-slate-700 underline underline-offset-4 hover:text-slate-900"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
