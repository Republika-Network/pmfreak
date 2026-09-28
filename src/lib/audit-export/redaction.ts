/**
 * P2-20 audit-export redaction.
 *
 * Two mechanisms, applied in this order:
 *
 *  1. ENTITY FIELD ALLOWLIST (`ENTITY_FIELD_ALLOWLIST`). A canonical lineage step carries
 *     a whole database row in `LineageStepNode.entity`. Several of those rows hold
 *     free-form payload/metadata columns (`operational_raw_inputs.payload`,
 *     `operational_normalized_events.event_payload`, `evidence_items.content`/`metadata`,
 *     `material_action_proposals.proposal`, `material_action_governance_evaluations
 *     .authorization_evidence`, `operational_decision_records.authority_evaluation`, the
 *     `provenance` columns) whose contents are unbounded and may carry provider secrets or
 *     raw provider error objects. The export emits an explicit allowlist per step kind and
 *     names every column it withheld, so redaction is visible rather than silent.
 *
 *  2. BOUNDED RECURSIVE VALUE REDACTION. Everything that survives the allowlist — plus the
 *     audit-record payload/metadata, which ARE the audit evidence and cannot be dropped —
 *     is walked by `redactSecretLikeValues()` from src/lib/security/redaction.ts (the
 *     repository's existing Perilla 10 mechanism, depth-bounded at 8) after a boundary-aware
 *     export-specific key sweep for categories that module does not cover by name
 *     (credential/bearer/session/connection-string/raw provider error objects), and followed
 *     by an export-specific VALUE pass for credential-bearing URIs and provider credential
 *     shapes the shared walker does not recognize.
 *
 * Redaction never deletes audit metadata. Provenance, actor, timestamps, canonical IDs,
 * evidence references, governance references, relationship classification and material
 * state changes are all preserved — see PRESERVED_AUDIT_FIELDS.
 */

import { redactSecretLikeValues } from "@/lib/security/redaction";
import { EXPORT_SECRET_VALUE_PATTERNS } from "@/lib/security/credential-patterns";
import type { LineageStepKind } from "@/lib/operational-flow/types";
import { REDACTION_MARKER } from "./types";

/**
 * ── Sensitive key classification ────────────────────────────────────────────────────────
 *
 * Keys are classified on TOKEN BOUNDARIES, never by raw substring containment.
 *
 * Substring containment redacted legitimate structured audit evidence purely because a
 * sensitive fragment happened to appear inside an unrelated word: `session_type`,
 * `stack_rank` and `credentials_excluded` are audit FACTS, not secrets, and losing them
 * destroys evidence the export exists to carry. A key is therefore normalized into
 * lowercase tokens (separators AND camel-case boundaries) and matched by four deliberate,
 * enumerable rules:
 *
 *   1. SENSITIVE_KEY_TOKENS       — a token that is sensitive wherever it appears.
 *   2. SENSITIVE_TERMINAL_TOKENS  — a token that is sensitive only as the LAST token.
 *   3. SENSITIVE_EXACT_KEYS       — the whole normalized key, verbatim.
 *   4. QUALIFIED PAIRS            — `<qualifier> key`, `<qualifier> error`, `<qualifier> stack`.
 *
 * This preserves every name the previous fragment list protected. The only deliberate
 * narrowings are `session`, `stack` and `credential`, which now require either an exact
 * match or a sensitive qualifier/terminal position — the three fragments that were
 * destroying legitimate audit facts.
 */

/** Sensitive wherever the token appears in the key. */
const SENSITIVE_KEY_TOKENS = new Set([
  "secret", "secrets", "token", "password", "passwd", "passphrase",
  "authorization", "cookie", "cookies", "hmac", "jwt", "bearer", "webhook", "dsn",
  // Separator-less spellings, which normalize to a single token.
  "apikey", "privatekey", "servicerole", "connectionstring", "stacktrace", "authheader",
  "accesskey", "clientsecret", "signingkey", "encryptionkey", "rawerror", "providererror",
]);

/**
 * Sensitive only as the LAST token. `provider_credentials` is a secret;
 * `credentials_excluded` is an audit fact recording that credentials were NOT included.
 */
const SENSITIVE_TERMINAL_TOKENS = new Set(["credential", "credentials"]);

/** Sensitive as a whole key only. Each of these names a secret when it stands alone. */
const SENSITIVE_EXACT_KEYS = new Set([
  "session", "stack", "stack_trace", "auth_header", "service_role",
  "connection_string", "connection_uri", "connection_url", "database_url", "db_url",
  "raw_error", "provider_error",
]);

/**
 * Qualifiers that make a trailing `key` token sensitive. Deliberately excludes the many
 * legitimate `*_key` audit columns — `idempotency_key`, `source_key`, `rule_key`,
 * `normalizer_key`, `provider_key`, `derivation_idempotency_key` — which are canonical
 * identifiers, not credentials.
 */
const SENSITIVE_KEY_QUALIFIERS = new Set([
  "api", "private", "access", "secret", "signing", "encryption", "service", "role",
  "client", "session", "auth", "master", "shared",
]);

/** Qualifiers that make a trailing `error` token a RAW PROVIDER error object. */
const SENSITIVE_ERROR_QUALIFIERS = new Set(["raw", "provider", "upstream", "driver", "sdk"]);

/** Qualifiers that make a trailing `stack` token a stack trace. */
const SENSITIVE_STACK_QUALIFIERS = new Set(["error", "exception", "call", "raw", "provider"]);

/** Splits a key on separators AND camel-case boundaries into lowercase tokens. */
function normalizeKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/** Categories reported to the auditor as never emitted. */
export const REDACTED_CATEGORIES = [
  "access tokens",
  "refresh tokens",
  "API keys",
  "authorization headers",
  "cookies and session secrets",
  "service-role credentials",
  "provider secrets",
  "raw provider error objects",
  "connection strings",
  "unrestricted credential payloads",
  "raw source payload and free-text content columns",
] as const;

/** Audit-critical fields the export guarantees to preserve through redaction. */
export const PRESERVED_AUDIT_FIELDS = [
  "canonical entity ids",
  "correlationId",
  "causationId",
  "occurredAt",
  "recordedAt",
  "actorId",
  "actorType",
  "lineage step status and gapReason",
  "transition relationship classification",
  "evidence assertion type, confidence and missing-data state",
  "content and event digests",
  "AOC governance references and governance state",
  "material state changes (outcome state, observation state, task/execution status)",
] as const;

export function isExportRedactedKey(key: string): boolean {
  const tokens = normalizeKeyTokens(key);
  if (tokens.length === 0) return false;
  if (SENSITIVE_EXACT_KEYS.has(tokens.join("_"))) return true;
  if (tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token))) return true;

  const last = tokens[tokens.length - 1];
  if (SENSITIVE_TERMINAL_TOKENS.has(last)) return true;

  const qualifier = tokens.length > 1 ? tokens[tokens.length - 2] : null;
  if (!qualifier) return false;
  if (last === "key") return SENSITIVE_KEY_QUALIFIERS.has(qualifier);
  if (last === "error" || last === "errors") return SENSITIVE_ERROR_QUALIFIERS.has(qualifier);
  if (last === "stack") return SENSITIVE_STACK_QUALIFIERS.has(qualifier);
  return false;
}

/**
 * ── Value-based credential detection ────────────────────────────────────────────────────
 *
 * EXPORT_SECRET_VALUE_PATTERNS (credential-bearing URIs, PostgreSQL connection strings and
 * the provider credential shapes the shared walker does not recognize) lives, unchanged, in
 * src/lib/security/credential-patterns.ts so the PB-EXEC-01 Execution Brief credential guard
 * reuses the same data instead of copying it. It is still NOT a general secret detector.
 */
/** Applies the export's value-based credential patterns to one string. */
function redactExportSecretValues(value: string): string {
  let result = value;
  for (const pattern of EXPORT_SECRET_VALUE_PATTERNS) result = result.replace(pattern, REDACTION_MARKER);
  return result;
}

/** Bounded recursive walk applying `redactExportSecretValues` to every nested string. */
function redactExportSecretValuesDeep(input: unknown, depth: number): unknown {
  if (depth > 8) return "[max-depth]";
  if (typeof input === "string") return redactExportSecretValues(input);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((item) => redactExportSecretValuesDeep(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = redactExportSecretValuesDeep(value, depth + 1);
  }
  return output;
}

/**
 * Pass 1 — bounded recursive key sweep. Replaces the value of every sensitive-by-NAME key
 * and records that key so the redaction report can name it. Depth bound matches the shared
 * walker (8).
 */
function sweepSensitiveKeys(input: unknown, redactedKeys: Set<string>, depth: number): unknown {
  if (depth > 8) return "[max-depth]";
  if (Array.isArray(input)) return input.map((item) => sweepSensitiveKeys(item, redactedKeys, depth + 1));
  if (input === null || typeof input !== "object") return input;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isExportRedactedKey(key)) {
      redactedKeys.add(key);
      output[key] = REDACTION_MARKER;
      continue;
    }
    output[key] = sweepSensitiveKeys(value, redactedKeys, depth + 1);
  }
  return output;
}

/**
 * Redacts a JSON-like value that must keep its structure (audit payloads/metadata).
 *
 * Pass 1 removes sensitive-by-name keys and records them; pass 2 runs the repository's
 * existing `redactSecretLikeValues()` so secret-SHAPED values (JWTs, `sk_live_…`,
 * `Bearer …`, `service_role…`) are removed even when the key name is innocuous; pass 3
 * applies the export's value-based credential patterns, which catch a credential-bearing
 * connection string stored under a neutral key.
 */
export function redactAuditValue(
  input: unknown,
  redactedKeys: Set<string>,
  depth = 0,
): unknown {
  return redactExportSecretValuesDeep(
    redactSecretLikeValues(sweepSensitiveKeys(input, redactedKeys, depth), depth),
    depth,
  );
}

/**
 * Redacts a single human-readable string that is DERIVED from persisted free text.
 *
 * The verified projection composes presentation values out of canonical columns —
 * `Recommendation: ${recommendation.title}`, `Decision: ${decision.decision} — Rationale:
 * ${decision.rationale}`, `Task: ${task.title}`, `Expected Outcome (…): ${expected_result}`,
 * `Criteria: ${JSON.stringify(success_criteria)}`, `Observation (…): ${obs.summary}`. The
 * entity-field allowlist withholds the underlying columns, so without this a secret-shaped
 * value embedded in one of those strings would reach the export through the presentation
 * surface even though its raw column was withheld.
 *
 * Only secret-SHAPED substrings and credential-bearing URIs are replaced; ordinary business
 * prose — including an ordinary `https://` link — passes through unchanged, and
 * identifiers/timestamps are never structurally altered. `surface` names the field for the
 * redaction report so a redaction here is visible rather than silent.
 */
export function redactText<T extends string | null>(
  surface: string,
  value: T,
  redactedSurfaces: Set<string>,
): T {
  if (value === null || value === undefined) return value;
  const redacted = redactExportSecretValues(redactSecretLikeValues(value) as string);
  if (redacted !== value) redactedSurfaces.add(surface);
  return redacted as T;
}

/** Applies `redactText` across a string array, preserving order. */
export function redactTextArray(
  surface: string,
  values: readonly string[],
  redactedSurfaces: Set<string>,
): string[] {
  return values.map((value) => redactText(surface, value, redactedSurfaces));
}

export function redactAuditRecord(
  payload: Record<string, unknown>,
  redactedKeys: Set<string>,
): Record<string, unknown> {
  const result = redactAuditValue(payload, redactedKeys);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * Columns exported per lineage step kind. Derived from the migrations that own each table:
 *   source              -> operational_sources          (20260901000000)
 *   raw_input           -> operational_raw_inputs       (20260901000000)
 *   normalized_event    -> operational_normalized_events(20260901000000)
 *   evidence            -> evidence_items               (20260611000000 + 20260902000000)
 *   finding             -> operational_signals          (20260611000000)
 *   recommendation      -> recommended_actions          (20260605040000 + 20260611000000)
 *   decision            -> operational_decision_records (20260611000000)
 *   material_action     -> material_action_proposals    (20260903000000)
 *   task                -> execution_tasks              (20260904000000 lineage columns)
 *   internal_execution  -> internal_task_executions     (20260905000000)
 *   outcome             -> canonical_task_outcomes      (20260906000000)
 *   observation         -> canonical_outcome_observations (20260906000000)
 *
 * Free-text/payload columns are deliberately ABSENT from every list. Where a digest exists
 * it is exported instead, so provenance survives without the payload.
 */
export const ENTITY_FIELD_ALLOWLIST: Record<LineageStepKind, readonly string[]> = {
  source: [
    "id", "workspace_id", "project_id", "source_key", "source_kind", "display_name",
    "status", "is_fixture", "fixture_label", "fixture_expires_when", "created_by",
    "created_at", "updated_at",
  ],
  raw_input: [
    "id", "workspace_id", "project_id", "source_id", "external_id", "media_type",
    "content_digest", "status", "occurred_at", "captured_at", "actor_user_id",
    "correlation_id", "causation_id",
  ],
  normalized_event: [
    "id", "workspace_id", "project_id", "source_id", "raw_input_id", "event_type",
    "schema_version", "normalizer_key", "subject_type", "subject_id", "event_digest",
    "status", "occurred_at", "recorded_at", "actor_user_id", "correlation_id",
    "causation_id",
  ],
  evidence: [
    "id", "workspace_id", "project_id", "created_by", "source_type", "source_reference",
    "confidence_level", "status", "evidence_hash", "version",
    "supersedes_evidence_item_id", "frozen_at", "created_at", "updated_at",
    "normalized_event_id", "raw_input_id", "source_id", "derivation_idempotency_key",
    "digest_algorithm", "canonicalization_version", "assertion_type", "classification",
    "confidence_score", "missing_data_state", "freshness_state", "stale_at", "lifecycle",
    "occurred_at", "evaluated_at", "recorded_at", "correlation_id", "causation_id",
    "fixture_state", "degraded_reason",
  ],
  finding: [
    "id", "workspace_id", "project_id", "evidence_item_id", "signal_type", "severity",
    "confidence_score", "detected_by", "status", "created_at",
  ],
  governance: [
    "id", "workspace_id", "project_id", "related_entity_type", "related_entity_id",
    "protocol_reference", "rule_key", "authority_required", "evidence_required",
    "governance_status", "created_at",
  ],
  recommendation: [
    "id", "workspace_id", "project_id", "governance_event_id", "risk_issue_id",
    "signal_id", "raid_item_id", "status", "urgency", "suggested_owner_user_id",
    "created_at", "updated_at",
  ],
  decision: [
    "id", "workspace_id", "project_id", "recommendation_id", "governance_event_id",
    "decided_by", "decision_status", "authority_basis",
    "supersedes_decision_record_id", "created_at",
  ],
  material_action: [
    "id", "workspace_id", "project_id", "source_decision_id", "proposed_by",
    "schema_version", "digest_version", "proposal_digest", "idempotency_key",
    "action_class", "materiality", "correlation_id", "causation_id", "expires_at",
    "created_at", "persisted_at",
  ],
  task: [
    "id", "workspace_id", "project_id", "source_action_id", "status", "priority",
    "assignee_id", "created_by", "correlation_id", "causation_id", "created_at",
    "updated_at", "completed_at", "due_date",
  ],
  internal_execution: [
    "id", "workspace_id", "project_id", "task_id", "governance_evaluation_id", "status",
    "provider_key", "attempt_count", "idempotency_key", "correlation_id", "causation_id",
    "queued_at", "started_at", "completed_at", "created_at", "updated_at",
    "failure_reason_code",
  ],
  outcome: [
    "id", "workspace_id", "project_id", "task_id", "source_action_id", "state",
    "correlation_id", "causation_id", "fixture_label", "created_by", "created_at",
    "updated_at",
  ],
  observation: [
    "id", "workspace_id", "project_id", "outcome_id", "task_id", "observation_state",
    "evidence_reference_ids", "confidence_score", "missing_data_state", "observed_at",
    "recorded_at", "evaluated_at", "stale_at", "observed_by", "correlation_id",
    "causation_id", "idempotency_key", "fixture_label",
  ],
};

export type AllowlistResult = {
  fields: Record<string, unknown>;
  withheld: string[];
};

/**
 * Projects a canonical row down to its allowlisted columns, then runs bounded recursive
 * value redaction over what remains. Column names present on the row but absent from the
 * allowlist are returned so the export can name them.
 *
 * `extraWithheld` lets a caller declare a key it stripped before calling (the export
 * strips the projection-attached `evaluation` / `loadedEvidence` composites, which are not
 * database columns).
 */
export function applyEntityAllowlist(
  kind: LineageStepKind,
  entity: Record<string, unknown> | null,
  redactedKeys: Set<string>,
  extraWithheld: readonly string[] = [],
): AllowlistResult | null {
  if (!entity) return null;
  const allowed = ENTITY_FIELD_ALLOWLIST[kind] ?? [];
  const fields: Record<string, unknown> = {};
  const withheld = new Set<string>(extraWithheld);

  for (const key of Object.keys(entity).sort()) {
    if (!allowed.includes(key)) {
      withheld.add(key);
      continue;
    }
    if (isExportRedactedKey(key)) {
      redactedKeys.add(key);
      fields[key] = REDACTION_MARKER;
      continue;
    }
    fields[key] = redactAuditValue(entity[key], redactedKeys);
  }

  return { fields, withheld: [...withheld].sort() };
}
