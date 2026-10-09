import type { OnboardingState } from "@/lib/auth/resolve-onboarding-state";
import { isOnboardingComplete } from "@/lib/auth/onboarding-route-map";
import { canManageBilling, type WorkspaceRole } from "@/lib/workspace-access";

/**
 * Whether the app shell may offer "return to Billing with the plan you chose
 * before signing up" (see PendingPlanReturn and src/lib/billing-plans.ts).
 *
 * Server-side and fail-closed. All four must hold:
 *   - paid checkout is released (src/lib/billing-release.ts) — otherwise there
 *     is nothing to return to;
 *   - onboarding is COMPLETE ("active"), so mandatory onboarding is never
 *     interrupted — earlier states keep their own next-step surfaces;
 *   - the workspace role can actually manage billing (owner/admin, the same
 *     policy create-checkout-session enforces), so nobody is sent to a
 *     checkout that would only refuse them;
 *   - the user is not already on /billing, which presents the plan itself.
 *
 * Eligibility only allows an optional link; it never starts a payment, and
 * /billing plus the checkout route re-check everything server-side.
 */
export function isEligibleForPlanReturn(input: {
  checkoutEnabled: boolean;
  onboardingState: OnboardingState;
  role: WorkspaceRole | null;
  pathname: string | null;
}): boolean {
  if (!input.checkoutEnabled) return false;
  if (!isOnboardingComplete(input.onboardingState)) return false;
  if (!input.role || !canManageBilling(input.role)) return false;
  const path = input.pathname ?? "";
  return path !== "/billing" && !path.startsWith("/billing/");
}
