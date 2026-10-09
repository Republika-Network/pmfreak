import Link from "next/link";
import { isCheckoutContinuation } from "@/lib/billing-plans";
import { isBillingCheckoutEnabled } from "@/lib/billing-release";
import { AuthButton, AuthField, AuthNotice, AuthShell, authLinkClass } from "@/ui-core";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <AuthShell title="Welcome back" subtitle="Continue where you left off and stay ahead this week.">
      {params.error ? <div className="mb-5"><AuthNotice tone="error">{params.error}</AuthNotice></div> : null}
      {!params.error && params.success ? <div className="mb-5"><AuthNotice tone="success">{params.success}</AuthNotice></div> : null}
      {isCheckoutContinuation(params.next) && isBillingCheckoutEnabled() ? (
        <p className="mb-5 text-sm text-charcoal/75">Sign in to continue to checkout. Your plan choice is saved in this browser.</p>
      ) : null}

      <form action="/api/login" method="post" className="space-y-5">
        {params.next ? <input type="hidden" name="next" value={params.next} /> : null}
        <AuthField label="Email" id="login-email" name="email" type="email" autoComplete="email" required />
        <div>
          <AuthField label="Password" id="login-password" name="password" type="password" autoComplete="current-password" required />
          <p className="mt-2 text-right text-sm">
            <Link href="/forgot-password" className={authLinkClass}>Forgot password?</Link>
          </p>
        </div>

        <AuthButton type="submit">Continue</AuthButton>
      </form>

      <p className="mt-8 border-t border-charcoal/10! pt-6 text-sm text-charcoal/75">
        No account? <Link href={params.next ? `/signup?next=${encodeURIComponent(params.next)}` : "/signup"} className={authLinkClass}>Create a free account</Link>
      </p>
    </AuthShell>
  );
}
