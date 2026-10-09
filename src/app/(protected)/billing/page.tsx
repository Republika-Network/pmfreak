import { getCompanySubscription } from "@/lib/billing";
import { parsePaidPlanTier } from "@/lib/billing-plans";
import { requireAuthUser } from "@/lib/auth";
import { canManageBilling } from "@/lib/workspace-access";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import BillingClient from "./billing-client";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const user = await requireAuthUser();
  const subscription = await getCompanySubscription(user.companyId);
  // The billing routes authorize against a workspace membership and require its
  // id in x-pmf-workspace-id. Use the workspace the shell is showing (preferred
  // cookie, validated against real membership); the routes re-authorize it.
  const { workspaceId, role } = await resolvePreferredWorkspace(user.id);
  const canManage = Boolean(role && canManageBilling(role));
  const requestedPlan = parsePaidPlanTier((await searchParams).plan);

  return (
    <main className="rounded-3xl border border-slate-200 bg-white p-8 shadow-2xl backdrop-blur-xl md:p-10">
      <p className="text-xs uppercase tracking-[0.28em] text-cyan-700">Billing</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Subscription & Usage</h1>
      <p className="mt-2 text-sm text-slate-700">Manage your Stripe subscription for {user.companyName}.</p>

      <div className="mt-8">
        <BillingClient subscription={subscription} workspaceId={workspaceId} canManageBilling={canManage} requestedPlan={requestedPlan} />
      </div>
    </main>
  );
}
