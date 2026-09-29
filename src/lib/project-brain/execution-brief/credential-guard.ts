// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — credential guard (PB-EXEC-01, docs/project-brain-execution.md §9.5.1)
//
// Contract: an Execution Brief never contains a credential — not in the persisted
// brief, not in any rendered, displayed or copied text.
//
// Pure and isomorphic (no Node API, no I/O): the SAME module runs
//   1. on the parsed model output, before canonical assembly      (ground.ts)
//   2. on the complete canonical brief, before persistence         (assemble.ts / generate.ts)
//   3. on the exact rendered string, before display and before copy (the brief card)
//
// Layers, each named and independently tested — NOT one "universal secret regex":
//
//   reused_value      the repository's existing value patterns, SHARED (not copied)
//                     from src/lib/security/credential-patterns.ts: Perilla 10
//                     (Stripe-shaped, JWT, Bearer, service_role) and P2-20 (userinfo
//                     URIs, PostgreSQL URIs, sk-…, gh?_…, github_pat_…, Basic …)
//   sensitive_assignment  the repository's sensitive key fragments applied to
//                     assignment-shaped prose (password=…, api_key: …, token=…)
//   pem               any PEM armour; PRIVATE KEY blocks are their own category
//   provider          a reviewed, bounded list of provider token formats (below)
//   opaque            a bounded long-random-token rule with a false-positive corpus
//
// This is deliberately NOT presented as universal coverage. A credential in a format
// none of these layers knows can still pass; the brief is additionally told, in its
// policy constraints, never to carry credentials, and PB-EXEC-02 adds secret
// references so a brief never needs one.
//
// What a finding carries: the rule CATEGORY and the field PATH only. The matched
// value is never returned, so it cannot reach a log, an error, telemetry or the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { EXPORT_SECRET_VALUE_PATTERNS, REDACTED_KEY_FRAGMENTS, SECRET_VALUE_PATTERNS } from "@/lib/security/credential-patterns";

export type CredentialLayer = "reused_value" | "sensitive_assignment" | "pem" | "provider" | "opaque";

export type CredentialRule = {
  /** Stable category name — the ONLY thing about a hit that may be stored, counted or shown. */
  category: string;
  layer: CredentialLayer;
  pattern: RegExp;
  /**
   * Optional narrowing for a reused pattern whose raw shape also matches ordinary
   * prose. Receives the matched text (never exposed further); returns true when the
   * match is credential-like.
   */
  confirm?: (match: string) => boolean;
};

const hasDigit = (value: string) => /[0-9]/.test(value);

/** Categories for the reused Perilla 10 list, index-aligned (pinned by tests). */
const SECRET_VALUE_CATEGORIES = [
  "stripe_secret_key",
  "stripe_test_key",
  "stripe_publishable_key",
  "stripe_webhook_secret",
  "stripe_restricted_key",
  "jwt",
  "bearer_token",
  "service_role_key",
] as const;

/** Categories for the reused P2-20 export list, index-aligned (pinned by tests). */
const EXPORT_VALUE_CATEGORIES = [
  "credential_uri",
  "postgres_uri",
  "openai_style_key",
  "github_token",
  "github_pat",
  "basic_auth",
] as const;

/**
 * Brief-only narrowings of two reused Perilla 10 shapes that, in NARRATIVE text,
 * also match ordinary engineering prose. The patterns themselves are unchanged.
 *   bearer_token      "Bearer authentication" is prose; a bearer credential has a digit.
 *   service_role_key  "the service_role key" names a thing; a leaked value continues it
 *                     with a long digit-bearing token (the JWT layer catches the usual one).
 * credential_uri: `ssh://git@host/…` carries the conventional SSH user, not a credential.
 */
const REUSED_CONFIRM: Partial<Record<string, (match: string) => boolean>> = {
  bearer_token: (match) => hasDigit(match.replace(/^Bearer\s+/i, "")),
  service_role_key: (match) => {
    const rest = match.slice("service_role".length).replace(/^[._-]?key[._-]?/i, "");
    return rest.length >= 16 && hasDigit(rest);
  },
  credential_uri: (match) => !/^[a-z][a-z0-9+.-]*:\/\/git@/i.test(match),
};

function clone(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

const REUSED_RULES: CredentialRule[] = [
  ...SECRET_VALUE_PATTERNS.map((pattern, index) => ({ category: SECRET_VALUE_CATEGORIES[index] ?? `repository_secret_${index}`, layer: "reused_value" as const, pattern })),
  ...EXPORT_SECRET_VALUE_PATTERNS.map((pattern, index) => ({ category: EXPORT_VALUE_CATEGORIES[index] ?? `export_secret_${index}`, layer: "reused_value" as const, pattern })),
].map((rule) => ({ ...rule, confirm: REUSED_CONFIRM[rule.category] }));

export const REUSED_RULE_COUNT = { secretValue: SECRET_VALUE_CATEGORIES.length, exportValue: EXPORT_VALUE_CATEGORIES.length } as const;

/**
 * Provider credential formats — reviewed v1 list (versioned with this module).
 *
 * Provenance: each prefix/shape is the provider's own publicly documented token
 * format (AWS access key ids, Anthropic, Slack, Google API keys, GitLab, npm,
 * SendGrid, Twilio, Hugging Face, Supabase secret keys, Azure storage connection
 * strings). None is copied from a third-party ruleset; no maintained credential
 * ruleset is installed or vendored in this repository (audited for secretlint,
 * gitleaks, trufflehog and detect-secrets in PB-EXEC-01). Formats already covered
 * by the reused layer (Stripe, OpenAI `sk-`, GitHub) are not repeated here.
 *
 * Bounded, anchored shapes only. Adding a provider = adding a named row + a test.
 */
export const PROVIDER_CREDENTIAL_RULES: readonly CredentialRule[] = Object.freeze([
  { category: "aws_access_key_id", layer: "provider", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { category: "anthropic_api_key", layer: "provider", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { category: "slack_token", layer: "provider", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { category: "slack_webhook_url", layer: "provider", pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { category: "google_api_key", layer: "provider", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: "gitlab_token", layer: "provider", pattern: /\bgl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20,}/g },
  { category: "npm_token", layer: "provider", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { category: "sendgrid_api_key", layer: "provider", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { category: "twilio_api_key", layer: "provider", pattern: /\bSK[0-9a-fA-F]{32}\b/g },
  { category: "huggingface_token", layer: "provider", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { category: "supabase_secret_key", layer: "provider", pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { category: "azure_storage_key", layer: "provider", pattern: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/g },
]);

/** PEM armour. Any PRIVATE KEY block is its own category; any other armour still fails closed. */
export const PEM_RULES: readonly CredentialRule[] = Object.freeze([
  { category: "private_key_block", layer: "pem", pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g },
  { category: "pem_block", layer: "pem", pattern: /-----BEGIN [A-Z0-9 ]{2,40}-----/g },
]);

/**
 * Sensitive-key assignments in prose. The key vocabulary is the repository's own
 * REDACTED_KEY_FRAGMENTS (shared) plus the few spellings it has no fragment for.
 * The value must look like a value, not a placeholder or a word:
 *   ≥ 8 characters, and a digit or symbol — or ≥ 12 characters of anything.
 * Placeholders (`<your-token>`, `${TOKEN}`, `$TOKEN`, `{{token}}`, `process.env.X`,
 * `***`, `[redacted]`) are references to a secret, not a secret.
 */
const EXTRA_KEY_FRAGMENTS = ["passwd", "pwd", "passphrase", "access_key", "accesskey", "client_secret", "credential", "session_id", "sessionid"];
const KEY_FRAGMENTS = [...new Set([...REDACTED_KEY_FRAGMENTS, ...EXTRA_KEY_FRAGMENTS])].map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const ASSIGNMENT = new RegExp(`\\b[A-Za-z0-9_.-]*(?:${KEY_FRAGMENTS})[A-Za-z0-9_.-]*["']?\\s*(?:=|:|=>)\\s*["'\`]?([^\\s"'\`,;)]+)`, "gi");
const PLACEHOLDER = /^(?:<[^>]*>?|\$\{[^}]*\}?|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}?\}?|process\.env\.[A-Za-z0-9_]+|\*{3,}|\[redacted\]|x{4,}|\.{3,}|…)$/i;

function assignmentValueLooksSecret(value: string): boolean {
  if (PLACEHOLDER.test(value)) return false;
  if (value.length >= 12) return true;
  return value.length >= 8 && /[^A-Za-z]/.test(value);
}

export const SENSITIVE_ASSIGNMENT_RULE: CredentialRule = {
  category: "sensitive_assignment",
  layer: "sensitive_assignment",
  pattern: ASSIGNMENT,
  confirm: (match) => {
    const value = new RegExp(ASSIGNMENT.source, "i").exec(match)?.[1] ?? "";
    return assignmentValueLooksSecret(value);
  },
};

// ─── Opaque-token rule ───────────────────────────────────────────────────────

export const OPAQUE_TOKEN_LIMITS = {
  /** Shortest token the rule considers. */
  minLength: 32,
  /** Shannon entropy floor (bits per character) for a mixed-charset token. */
  minEntropy: 3.5,
  /** A hex-only token at or above this length is flagged (32/40/64-hex API secrets, legacy 40-hex tokens). */
  hexMinLength: 32,
  /** Share of digits that, with letters, makes a single-case token random-looking. */
  minDigitRatio: 0.25,
} as const;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOKEN_RUN = /[A-Za-z0-9+/=_-]+/g;

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function opaqueCategory(token: string): string | null {
  const t = token.replace(/^[-_=]+|[-_]+$/g, "");
  if (t.length < OPAQUE_TOKEN_LIMITS.minLength) return null;
  if (/^[0-9a-f]+$/i.test(t)) return t.length >= OPAQUE_TOKEN_LIMITS.hexMinLength ? "opaque_hex_token" : null;
  const upper = /[A-Z]/.test(t);
  const lower = /[a-z]/.test(t);
  const digits = (t.match(/[0-9]/g) ?? []).length;
  if (!upper && !lower) return null;
  const randomLooking = (upper && lower && digits > 0) || digits / t.length >= OPAQUE_TOKEN_LIMITS.minDigitRatio;
  if (!randomLooking) return null;
  return shannonEntropy(t) >= OPAQUE_TOKEN_LIMITS.minEntropy ? "opaque_token" : null;
}

/** Candidate opaque tokens: UUIDs removed; a run with `/` is a path unless it has base64 padding/plus. */
function opaqueFindings(text: string): string[] {
  const out: string[] = [];
  const withoutUuids = text.replace(UUID, " ");
  for (const match of withoutUuids.matchAll(TOKEN_RUN)) {
    const run = match[0];
    const pieces = run.includes("/") && !/[+=]/.test(run) ? run.split("/") : [run];
    for (const piece of pieces) {
      const category = opaqueCategory(piece);
      if (category) out.push(category);
    }
  }
  return out;
}

// ─── Scanning ────────────────────────────────────────────────────────────────

const PATTERN_RULES: readonly CredentialRule[] = [...PEM_RULES, ...PROVIDER_CREDENTIAL_RULES, ...REUSED_RULES, SENSITIVE_ASSIGNMENT_RULE];

export const CREDENTIAL_RULES: readonly CredentialRule[] = PATTERN_RULES;

/**
 * Categories of every credential-like hit in one string (deduplicated, in rule
 * order). Never the matched text. Throws only on a programming error — callers
 * treat a throw as a hit (fail closed).
 */
export function scanTextForCredentials(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found = new Set<string>();
  for (const rule of PATTERN_RULES) {
    for (const match of text.matchAll(clone(rule.pattern))) {
      if (!rule.confirm || rule.confirm(match[0])) {
        found.add(rule.category);
        break;
      }
    }
  }
  for (const category of opaqueFindings(text)) found.add(category);
  return [...found];
}

export function containsCredential(text: string): boolean {
  return scanTextForCredentials(text).length > 0;
}

/**
 * Fail-closed wrapper for a single narrative item: any hit OR any guard error is
 * reported as `credential`. Never returns the value.
 */
export function narrativeCredentialCategories(text: string): string[] {
  try {
    return scanTextForCredentials(text);
  } catch {
    return ["guard_error"];
  }
}

// ─── Whole-brief scan (boundary 2) and rendered-text guard (boundary 3) ──────

const SHA256_TAG = /^sha256:[0-9a-f]{64}$/;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[A-Za-z0-9._-]{1,24}$/;
const isTurnId = (v: string) => UUID_EXACT.test(v) || SHORT_ID.test(v);
const isStableSourceId = (v: string) => /^[a-z][a-z_-]*:[A-Za-z0-9:._-]{1,160}$/.test(v) && !/[A-Za-z0-9+/_-]{41,}/.test(v.replace(UUID, ""));

/**
 * Field + expected-shape exemptions. A value in one of these designated fields is
 * skipped ONLY when it has exactly the expected shape; anything else in that field
 * is scanned like narrative. Never a global "ignore every hex string".
 */
const FIELD_SHAPES: Array<{ path: RegExp; shape: (v: string) => boolean }> = [
  { path: /^identity\.(briefId|conversationId|requestTurnId|workspaceId|projectId)$/, shape: isTurnId },
  { path: /^identity\.(contextFingerprint|briefContentHash)$/, shape: (v) => SHA256_TAG.test(v) },
  { path: /^provenance\.sources\[\d+\]\.sourceContextDigest$/, shape: (v) => SHA256_TAG.test(v) },
  { path: /^provenance\.sources\[\d+\]\.(evidenceId)$/, shape: isStableSourceId },
  { path: /^provenance\.sources\[\d+\]\.(workspaceId|projectId)$/, shape: isTurnId },
  { path: /\.sourceIds\[\d+\]$/, shape: isStableSourceId },
  { path: /\.reportedTurnIds\[\d+\]$/, shape: isTurnId },
  { path: /^provenance\.reports\[\d+\]\.turnId$/, shape: isTurnId },
  { path: /^targetRef\.assistantTurnId$/, shape: isTurnId },
  { path: /^targetRef\.statementId$/, shape: (v) => /^[A-Za-z0-9._-]{1,40}:\d{1,3}$/.test(v) || (/^.+:\d{1,3}$/.test(v) && isTurnId(v.replace(/:\d{1,3}$/, ""))) },
  { path: /^repositoryContext\.baseSha$/, shape: (v) => /^[0-9a-f]{7,40}$/i.test(v) },
];

export type BriefCredentialFinding = { path: string; category: string };

/**
 * Boundary 2: every string in the JSON (keys excluded — they are the schema's own).
 * Returns path + category per hit. A throw is the caller's to treat as fail closed.
 */
export function scanBriefForCredentials(value: unknown): BriefCredentialFinding[] {
  const findings: BriefCredentialFinding[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 12) throw new Error("credential guard: structure too deep");
    if (typeof node === "string") {
      const exemption = FIELD_SHAPES.find((f) => f.path.test(path));
      if (exemption && exemption.shape(node)) return;
      for (const category of scanTextForCredentials(node)) findings.push({ path, category });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(value, "", 0);
  return findings;
}

export type RenderedTextGuard = { ok: true } | { ok: false; categories: string[] };

/**
 * The only values a RENDERED text may carry that the opaque rule would otherwise
 * flag: the brief's own server-owned identifiers and hashes, and a reported base
 * SHA — each taken from its typed field and included only when it has exactly that
 * field's shape. Field + shape, never "every hex string".
 */
export function renderedTextExemptions(brief: {
  identity: { briefId: string; contextFingerprint: string; briefContentHash: string };
  repositoryContext: { status: string; baseSha?: string | null };
}): string[] {
  const out: string[] = [];
  if (UUID_EXACT.test(brief.identity.briefId)) out.push(brief.identity.briefId);
  for (const hash of [brief.identity.contextFingerprint, brief.identity.briefContentHash]) {
    if (SHA256_TAG.test(hash)) out.push(hash, hash.slice("sha256:".length));
  }
  const sha = brief.repositoryContext.status === "reported" ? brief.repositoryContext.baseSha : null;
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) out.push(sha);
  return out;
}

/**
 * Boundary 3: the exact string about to be displayed or copied. Fail closed: a
 * guard error blocks. Categories only — never the matched text.
 */
export function guardRenderedText(text: string, exemptValues: readonly string[] = []): RenderedTextGuard {
  try {
    let scanned = text;
    // Exact values taken from designated typed fields (see renderedTextExemptions);
    // replaced before scanning, so nothing else in the text is ever exempted.
    for (const value of exemptValues) if (value) scanned = scanned.split(value).join(" ");
    const categories = scanTextForCredentials(scanned);
    return categories.length === 0 ? { ok: true } : { ok: false, categories };
  } catch {
    return { ok: false, categories: ["guard_error"] };
  }
}
