import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { authButtonClass } from "@/ui-core";

export default async function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const params = await searchParams;

  return (
    <AuthShell title="Check your email" subtitle="Confirm your account to start using PMFreak.">
      <div className="rounded-lg border border-calm-ink/25! bg-mint/15 p-5">
        <p className="text-base text-charcoal">
          We sent a confirmation link to <span className="font-bold break-all">{params.email ?? "your inbox"}</span>.
        </p>

        <p className="mt-2 text-sm text-charcoal/70">
          Check spam/promotions if you don’t see it.
        </p>
      </div>

      <div className="mt-6">
        <Link href="/login" className={authButtonClass}>
          Go to login
        </Link>
      </div>
    </AuthShell>
  );
}
