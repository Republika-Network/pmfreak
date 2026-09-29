/**
 * Secret redaction / safe error messages — Perilla 10 (Production Secrets /
 * Env / CORS / Deployment Boundary Hardening).
 *
 * This repo already redacts known-sensitive object *keys* in several
 * places (telemetry.ts, abuse-protection.ts, the agent-*-validation.ts
 * modules). This module adds the piece those don't cover: redacting
 * secret-*shaped values* wherever they appear (including inside a plain
 * string, e.g. a raw provider error message that happened to interpolate a
 * key), and a single helper for turning any caught `error` into a
 * production-safe string with no stack trace.
 */

import { REDACTED_KEY_FRAGMENTS, SECRET_VALUE_PATTERNS } from "./credential-patterns";

// Pattern data lives in ./credential-patterns (shared with the audit export and the
// PB-EXEC-01 Execution Brief credential guard); behaviour here is unchanged.

function isSecretLikeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

/**
 * Deep-walks an arbitrary value (object/array/string/etc.), replacing
 * secret-shaped values wherever found and redacting the *value* of any key
 * that looks sensitive by name, regardless of its own value's shape. Safe to
 * call on untrusted/circular-free JSON-like data before logging.
 */
export function redactSecretLikeValues(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[max-depth]";

  if (typeof input === "string") return redactString(input);
  if (input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactSecretLikeValues(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = isSecretLikeKey(key) ? "[redacted]" : redactSecretLikeValues(value, depth + 1);
  }
  return output;
}

/**
 * Converts any caught `error` into a short, production-safe message: no
 * stack trace, no raw provider error object, secret-shaped substrings
 * redacted. Use this at any boundary that turns a caught error into a
 * logged line or an HTTP response body.
 */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown_error";
  const redacted = redactString(raw);
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
}
