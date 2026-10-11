import { getAppBaseUrl } from "@/lib/security/origin-policy";

/**
 * Supabase email-confirmation link handling.
 *
 * Signup confirmation emails must land on this deployment's canonical
 * origin, never on a localhost fallback. The redirect target is derived from
 * getAppBaseUrl() (NEXT_PUBLIC_APP_URL first), which fails closed in
 * production instead of silently emitting http://localhost:3000.
 */

/** The `emailRedirectTo` passed to supabase.auth.signUp. */
export function buildSignupEmailRedirectTo(): string {
  return `${getAppBaseUrl()}/auth/callback`;
}

/**
 * OTP types /auth/confirm accepts. Deliberately narrow: only signup/email
 * confirmation. Recovery keeps its own /auth/reset-password flow.
 */
const CONFIRMABLE_TYPES = ["email", "signup"] as const;
export type ConfirmableOtpType = (typeof CONFIRMABLE_TYPES)[number];

export type ConfirmationParams = { tokenHash: string; type: ConfirmableOtpType; next: string | null };

/** Parses /auth/confirm query params; returns null for anything malformed. */
export function parseConfirmationParams(searchParams: URLSearchParams): ConfirmationParams | null {
  const tokenHash = searchParams.get("token_hash")?.trim();
  const type = searchParams.get("type");
  if (!tokenHash || !type) return null;
  if (!(CONFIRMABLE_TYPES as readonly string[]).includes(type)) return null;
  return { tokenHash, type: type as ConfirmableOtpType, next: searchParams.get("next") };
}

export const INVALID_CONFIRMATION_LINK_MESSAGE = "Your verification link is invalid or expired. Please log in again.";
