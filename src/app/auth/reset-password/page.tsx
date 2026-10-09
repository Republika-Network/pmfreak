"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthButton } from "@/ui-core/forms/auth-button";
import { AuthField, AuthNotice } from "@/ui-core/forms/auth-field";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({ password });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      router.replace("/login?success=Password+updated.+Please+sign+in.");
    } catch {
      setErrorMessage("Unable to update password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Set a new password" subtitle="Secure your account and continue.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <AuthField label="New password" id="reset-password" type="password" autoComplete="new-password" required minLength={8} hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} />
        <AuthField label="Confirm password" id="reset-password-confirm" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />

        <AuthButton type="submit" disabled={loading} aria-busy={loading}>
          {loading ? "Updating..." : "Update password"}
        </AuthButton>
      </form>

      {errorMessage ? <div className="mt-5"><AuthNotice tone="error">{errorMessage}</AuthNotice></div> : null}
    </AuthShell>
  );
}
