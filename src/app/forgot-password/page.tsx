"use client";

import { useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthButton, authLinkClass } from "@/ui-core/forms/auth-button";
import { AuthField, AuthNotice } from "@/ui-core/forms/auth-field";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });

      if (error) setErrorMessage(error.message);
      else {
        setSuccessMessage("Check your email for a password reset link.");
        setEmail("");
      }
    } catch {
      setErrorMessage("Unable to send reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Reset your access" subtitle="Enter your email and we’ll send you a reset link.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <AuthField label="Email" id="forgot-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />

        <AuthButton type="submit" disabled={loading} aria-busy={loading}>
          {loading ? "Sending..." : "Send reset link"}
        </AuthButton>
      </form>

      {successMessage ? <div className="mt-5"><AuthNotice tone="success">{successMessage}</AuthNotice></div> : null}
      {errorMessage ? <div className="mt-5"><AuthNotice tone="error">{errorMessage}</AuthNotice></div> : null}

      <p className="mt-8 border-t border-charcoal/10! pt-6 text-sm text-charcoal/75">
        Back to <Link href="/login" className={authLinkClass}>login</Link>
      </p>
    </AuthShell>
  );
}
