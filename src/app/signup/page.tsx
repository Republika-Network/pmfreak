import Link from "next/link";
import { signupAction } from "./actions";
import { AuthShell } from "@/components/auth/auth-shell";
import AuthSubmitButton from "@/components/auth-submit-button";
import { isCheckoutContinuation } from "@/lib/billing-plans";
import { isBillingCheckoutEnabled } from "@/lib/billing-release";
import { AuthField, AuthNotice, authLinkClass } from "@/ui-core";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <AuthShell
      title="Set up your PMFreak workspace"
      subtitle="Get project visibility and meeting prep support in minutes."
    >
      {params.error && (
        <div className="mb-5"><AuthNotice tone="error">{params.error}</AuthNotice></div>
      )}

      {isCheckoutContinuation(params.next) && isBillingCheckoutEnabled() ? (
        <p className="mb-5 text-sm text-charcoal/75">
          Your plan choice is saved in this browser. Once your workspace is set up, you&rsquo;ll find it on the Billing page.
        </p>
      ) : null}

      <form action={signupAction} className="space-y-5">
        {params.next ? <input type="hidden" name="next" value={params.next} /> : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <AuthField label="Full name" id="signup-full-name" name="fullName" autoComplete="name" required />

          <AuthField label="Company name" id="signup-company" name="companyName" autoComplete="organization" required />
        </div>

        <AuthField label="Email" id="signup-email" name="email" type="email" autoComplete="email" required />

        <AuthField label="Password" id="signup-password" name="password" type="password" autoComplete="new-password" required />

        <AuthSubmitButton idleLabel="Create free account" pendingLabel="Creating account..." />
      </form>

      <p className="mt-8 border-t border-charcoal/10! pt-6 text-sm text-charcoal/75">
        Already have an account?{" "}
        <Link href={params.next ? `/login?next=${encodeURIComponent(params.next)}` : "/login"} className={authLinkClass}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
