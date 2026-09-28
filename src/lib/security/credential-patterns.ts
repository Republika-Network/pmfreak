/**
 * Shared credential-shape pattern DATA (PB-EXEC-01 extraction).
 *
 * Before PB-EXEC-01 these lists were module-private to their two consumers:
 *
 *   SECRET_VALUE_PATTERNS / REDACTED_KEY_FRAGMENTS → src/lib/security/redaction.ts (Perilla 10)
 *   EXPORT_SECRET_VALUE_PATTERNS                   → src/lib/audit-export/redaction.ts (P2-20)
 *
 * They are moved here verbatim — same expressions, same flags, same order — so the
 * Execution Brief credential guard (src/lib/project-brain/execution-brief/credential-guard.ts)
 * can REUSE them instead of copying them into a third list that would drift. The two
 * original consumers import them from here and behave exactly as before.
 *
 * Pure data, no imports: safe on the server and in the browser bundle. The expressions
 * carry the `g` flag because both redactors use them with `String.prototype.replace`;
 * a caller that needs `test`/`exec` semantics must clone them (see credential-guard.ts).
 */

/** Perilla 10 — secret-SHAPED values, wherever they appear inside a string. */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk_live_[a-zA-Z0-9]{10,}/g,
  /sk_test_[a-zA-Z0-9]{10,}/g,
  /pk_live_[a-zA-Z0-9]{10,}/g,
  /whsec_[a-zA-Z0-9]{10,}/g,
  /rk_live_[a-zA-Z0-9]{10,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT-shaped
  /Bearer\s+[a-zA-Z0-9._-]{10,}/gi,
  /service_role[a-zA-Z0-9._-]{0,60}/gi,
]);

/** Perilla 10 — object keys whose VALUE is redacted whatever its shape (substring match). */
export const REDACTED_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "secret", "token", "password", "authorization", "cookie", "service_role", "servicerole", "webhook", "hmac", "apikey", "api_key", "privatekey", "private_key",
]);

/**
 * P2-20 — value-based credential detection for the audit export.
 *
 * `redactSecretLikeValues()` matches secret-SHAPED values (Stripe keys, JWTs, `Bearer …`,
 * `service_role…`) but does not recognize a credential-bearing URI. A credential stored
 * under a NEUTRAL key — `{ "value": "postgresql://user:password@db/pmfreak" }` — therefore
 * survived both the key sweep (the key is innocuous) and the shared walker (the value is
 * not a shape it knows), while REDACTED_CATEGORIES claims connection strings and provider
 * credentials are never emitted.
 *
 * These patterns close that gap and nothing wider. They are bounded, enumerable and
 * anchored on structure a credential must have, so ordinary URLs and business prose are
 * untouched: `https://example.com/report` has no userinfo, and prose mentioning "postgres"
 * is not a URI. This is NOT a general secret detector and must not grow into one.
 */
export const EXPORT_SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /**
   * Any URI carrying userinfo credentials: `scheme://user:password@host/…`. The userinfo
   * must sit before the first path/query/fragment separator, so a `@` inside a path does
   * not make an ordinary URL look like a credential. Mirrors the established
   * CONNECTION_STRING_WITH_CREDENTIALS_PATTERN in
   * src/features/pmfreak-integrations/aoc-governance-request-client/
   * pmfreak-aoc-evidence-requirement-handoff-redaction.ts, restated because that constant
   * is module-private to a feature the export layer does not depend on.
   */
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@"'()<>]+(?::[^\s/?#@"'()<>]*)?@[^\s"'()<>]+/gi,
  /**
   * PostgreSQL connection strings, credentials or not. These are the connection-string
   * schemes this repository actually uses (SUPABASE_DB_URL / FRESH_DB_URL in .env.example,
   * docs/release/database-bootstrap-runbook.md, tests/fresh-db-migrations-safety-guard);
   * no other scheme has repository evidence, and any other scheme carrying credentials is
   * already covered by the userinfo pattern above.
   */
  /\b(?:postgresql|postgres):\/\/[^\s"'()<>]+/gi,
  /**
   * Provider credential shapes claimed by REDACTED_CATEGORIES that the shared walker does
   * not match by value. Each is bounded to a provider this repository configures:
   * OPENAI_API_KEY (`sk-…`, which also covers `sk-ant-…`), GITHUB_TOKEN (`ghp_…`,
   * `github_pat_…`), and the Basic counterpart of the `Bearer …` authorization header.
   *
   * The Basic credential additionally requires a digit or base64 punctuation, so the phrase
   * "Basic characterization…" in ordinary prose is not mistaken for an encoded credential.
   */
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bBasic\s+(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/=]{20,}/g,
]);
