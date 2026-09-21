/**
 * P2-20 — Closed-Loop Audit Export Compatibility Gate.
 *
 * Behavioral proof for the canonical audit export composition layer
 * (src/lib/audit-export/). The mock Supabase client mirrors the strict client the verified
 * P2-10 suite uses: an unknown filter column throws instead of silently degrading to a
 * JavaScript property lookup, which is what PostgREST surfaces for undefined_column.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CANONICAL_AUDIT_EXPORT_FORMAT,
  DEFAULT_AUDIT_RECORD_LIMIT,
  ENTITY_FIELD_ALLOWLIST,
  LEGACY_DECISION_AUDIT_COMPATIBILITY_FORMAT,
  REDACTION_MARKER,
  buildCanonicalAuditExportPackage,
  isExportRedactedKey,
  normalizeAuditRecordLimit,
} from "../src/lib/audit-export";
import type { AuditExportLineage, AuditExportPackage } from "../src/lib/audit-export";
import { getCompleteLineageProjection } from "../src/lib/operational-flow/operational-flow-service";

const decisionGovernanceService = readFileSync("src/lib/decision-governance/service.ts", "utf8");
const decisionGovernanceTypes = readFileSync("src/lib/decision-governance/types.ts", "utf8");
const legacyCompatibility = readFileSync("src/lib/audit-export/legacy-compatibility.ts", "utf8");
const canonicalExport = readFileSync("src/lib/audit-export/canonical-audit-export.ts", "utf8");
const apiRoute = readFileSync("src/app/api/operational-flow/route.ts", "utf8");

// ─── strict mock client (same shape as tests/p2-10-outcome-review-lineage.test.ts) ──────

const DIRECT_TENANCY_TABLES = [
  "canonical_task_outcomes",
  "canonical_outcome_observations",
  "execution_tasks",
  "internal_task_executions",
  "material_action_proposals",
  "material_action_governance_evaluations",
  "operational_decision_records",
  "recommended_actions",
  "governance_events",
  "operational_signals",
  "evidence_items",
  "operational_normalized_events",
  "operational_raw_inputs",
  "operational_sources",
  "platform_events",
] as const;

const FILTERABLE_COLUMNS: Record<string, readonly string[]> = {
  ...Object.fromEntries(DIRECT_TENANCY_TABLES.map((t) => [t, ["id", "workspace_id", "project_id"]])),
  decision_evidence_links: ["id", "decision_record_id", "evidence_item_id"],
  canonical_outcome_observations: ["id", "workspace_id", "project_id", "correlation_id", "outcome_id"],
  platform_events: ["id", "workspace_id", "project_id", "correlation_id"],
};

type MockRow = Record<string, unknown>;
type MockResult = { data: MockRow[]; error: null };

interface MockQueryBuilder {
  select: () => MockQueryBuilder;
  eq: (col: string, val: unknown) => MockQueryBuilder;
  in: (col: string, vals: unknown[]) => MockQueryBuilder;
  order: (col?: string, opts?: { ascending?: boolean }) => MockQueryBuilder;
  limit: (count?: number) => MockQueryBuilder;
  then: (resolve: (result: MockResult) => unknown) => unknown;
}

const createStrictMockClient = (mockDb: Record<string, unknown[]>) =>
  ({
    from: (table: string) => {
      const allowed = FILTERABLE_COLUMNS[table];
      if (!allowed) throw new Error(`relation "public.${table}" does not exist`);
      let rows = [...(mockDb[table] ?? [])] as MockRow[];
      let orderColumn: string | null = null;
      let orderAscending = true;
      let rowLimit: number | null = null;
      const assertColumn = (col: string) => {
        if (!allowed.includes(col)) throw new Error(`column ${table}.${col} does not exist`);
      };
      const queryBuilder: MockQueryBuilder = {
        select: () => queryBuilder,
        eq: (col: string, val: unknown) => {
          assertColumn(col);
          rows = rows.filter((r) => r[col] === val);
          return queryBuilder;
        },
        in: (col: string, vals: unknown[]) => {
          assertColumn(col);
          rows = rows.filter((r) => vals.includes(r[col]));
          return queryBuilder;
        },
        order: (col?: string, opts?: { ascending?: boolean }) => {
          if (col) {
            orderColumn = col;
            orderAscending = opts?.ascending !== false;
          }
          return queryBuilder;
        },
        limit: (count?: number) => {
          if (typeof count === "number") rowLimit = count;
          return queryBuilder;
        },
        then: (resolve) => {
          let out = rows;
          if (orderColumn !== null) {
            const col: string = orderColumn;
            out = [...out].sort((a, b) => {
              const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
              return orderAscending ? cmp : -cmp;
            });
          }
          if (rowLimit !== null) out = out.slice(0, rowLimit);
          return resolve({ data: out, error: null });
        },
      };
      return queryBuilder;
    },
  }) as unknown as Parameters<typeof getCompleteLineageProjection>[0];

// ─── fixtures ───────────────────────────────────────────────────────────────────────────

const WS = "11111111-1111-4111-8111-111111111111";
const PRJ = "22222222-2222-4222-8222-222222222222";
const FOREIGN_WS = "99999999-9999-4999-8999-999999999999";
const FOREIGN_PRJ = "88888888-8888-4888-8888-888888888888";
const CORR = "33333333-3333-4333-8333-333333333333";

/**
 * Secret-shaped values seeded into representative payload/metadata columns.
 *
 * Every value here is fabricated and non-functional; the point is the SHAPE, because
 * src/lib/security/redaction.ts matches secret-shaped values regardless of key name.
 * The Stripe-live-shaped fixture is assembled at runtime rather than written as a literal
 * so this test file does not itself contain a string that credential scanners flag —
 * the runtime value, and therefore what the redactor sees, is unchanged.
 */
const STRIPE_LIVE_SHAPED = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

const SECRETS = {
  serviceRoleKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop",
  stripeLive: STRIPE_LIVE_SHAPED,
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz",
  connectionString: "postgresql://user:hunter2@db.internal:5432/pmfreak",
  apiKey: "provider-api-key-abcdefghijklmnop",
  refreshToken: "refresh-abcdefghijklmnopqrstuv",
};

type Row = Record<string, unknown>;

const emptyDb = (parts: Record<string, unknown[]> = {}): Record<string, unknown[]> => ({
  canonical_task_outcomes: [],
  canonical_outcome_observations: [],
  execution_tasks: [],
  internal_task_executions: [],
  material_action_proposals: [],
  material_action_governance_evaluations: [],
  operational_decision_records: [],
  decision_evidence_links: [],
  recommended_actions: [],
  governance_events: [],
  operational_signals: [],
  evidence_items: [],
  operational_normalized_events: [],
  operational_raw_inputs: [],
  operational_sources: [],
  platform_events: [],
  ...parts,
});

const source = (over: Row = {}): Row => ({
  id: "src-1", workspace_id: WS, project_id: PRJ, source_key: "manual-demo:v1",
  source_kind: "manual_demo", display_name: "Manual demo", status: "active",
  is_fixture: false, fixture_label: null, created_by: "user-1",
  created_at: "2026-08-10T07:00:00Z", updated_at: "2026-08-10T07:00:00Z", ...over,
});

const rawInput = (over: Row = {}): Row => ({
  id: "raw-1", workspace_id: WS, project_id: PRJ, source_id: "src-1", external_id: null,
  idempotency_key: "idem-raw-1", media_type: "application/json",
  // Seeded secret payload: this column is NOT on the export allowlist.
  payload: { body: "client asked for extra scope", authorization: SECRETS.bearer, apiKey: SECRETS.apiKey },
  provenance: { connectionString: SECRETS.connectionString },
  content_digest: `sha256:${"a".repeat(64)}`, status: "received",
  occurred_at: "2026-08-10T07:01:00Z", captured_at: "2026-08-10T07:02:00Z",
  actor_user_id: "user-1", correlation_id: CORR, causation_id: null, ...over,
});

const normalizedEvent = (over: Row = {}): Row => ({
  id: "norm-1", workspace_id: WS, project_id: PRJ, source_id: "src-1", raw_input_id: "raw-1",
  event_type: "project.scope_request", schema_version: 1, normalizer_key: "manual:v1",
  subject_type: "project", subject_id: PRJ,
  event_payload: { summary: "scope request", serviceRoleKey: SECRETS.serviceRoleKey },
  provenance: {}, event_digest: `sha256:${"b".repeat(64)}`, status: "accepted",
  occurred_at: "2026-08-10T07:03:00Z", recorded_at: "2026-08-10T07:04:00Z",
  actor_user_id: "user-1", correlation_id: CORR, causation_id: "raw-1", ...over,
});

const evidence = (over: Row = {}): Row => ({
  id: "ev-1", workspace_id: WS, project_id: PRJ, created_by: "user-1",
  source_type: "manual_note", title: "Scope request evidence",
  content: `raw client email containing ${SECRETS.stripeLive}`,
  metadata: { providerError: { message: SECRETS.stripeLive } },
  source_reference: "email:1", confidence_level: "high", status: "analyzed",
  evidence_hash: "c".repeat(64), version: 1, supersedes_evidence_item_id: null,
  frozen_at: "2026-08-10T07:06:00Z", created_at: "2026-08-10T07:05:00Z",
  updated_at: "2026-08-10T07:06:00Z", normalized_event_id: "norm-1", raw_input_id: "raw-1",
  source_id: "src-1", derivation_idempotency_key: "idem-ev-1", digest_algorithm: "sha256",
  canonicalization_version: "v1", assertion_type: "FACT", classification: "DECISION_CONTEXT",
  confidence_score: 0.9, missing_data_state: "COMPLETE", freshness_state: "CURRENT",
  stale_at: null, lifecycle: "active", occurred_at: "2026-08-10T07:03:00Z",
  evaluated_at: "2026-08-10T07:05:00Z", recorded_at: "2026-08-10T07:05:00Z",
  correlation_id: CORR, causation_id: "norm-1", fixture_state: "LIVE", degraded_reason: null, ...over,
});

const signal = (over: Row = {}): Row => ({
  id: "sig-1", workspace_id: WS, project_id: PRJ, evidence_item_id: "ev-1",
  signal_type: "scope_creep", severity: "high", confidence_score: 85,
  summary: "Scope creep detected", rationale: "Out-of-scope work requested",
  detected_by: "system/deterministic:governance_signal_detector_v1", status: "open",
  created_at: "2026-08-10T07:07:00Z", ...over,
});

const governanceEvent = (over: Row = {}): Row => ({
  id: "gov-1", workspace_id: WS, project_id: PRJ, related_entity_type: "risk_issue_record",
  related_entity_id: "risk-1", protocol_reference: "PMFreak operational governance rules v1",
  rule_key: "scope_change_requires_sponsor", authority_required: "sponsor or PMO",
  evidence_required: true, governance_status: "decision_required",
  created_at: "2026-08-10T07:08:00Z", ...over,
});

// Schema-truthful: `recommended_actions` reaches its Finding through `source_signal_id`,
// and owns no `signal_id`. These fixtures previously carried `signal_id`, which no table
// defines, so the suite stayed green while the live projection could not resolve a Finding.
const recommendation = (over: Row = {}): Row => ({
  id: "rec-1", workspace_id: WS, project_id: PRJ, governance_event_id: "gov-1",
  source_signal_id: "sig-1", risk_issue_id: "risk-1", title: "Raise a change request",
  proposed_action: "Raise CR", status: "accepted", urgency: "high",
  suggested_owner_user_id: "user-1", created_at: "2026-08-10T07:09:00Z",
  updated_at: "2026-08-10T07:09:00Z", ...over,
});

const decision = (over: Row = {}): Row => ({
  id: "dec-1", workspace_id: WS, project_id: PRJ, recommendation_id: "rec-1",
  governance_event_id: "gov-1", decided_by: "user-1", decision: "Proceed with CR",
  decision_status: "accepted", rationale: "Sponsor approved", authority_basis: "sponsor",
  authority_evaluation: { token: SECRETS.refreshToken }, manual_evidence_item_id: null,
  supersedes_decision_record_id: null, created_at: "2026-08-10T08:00:00Z", ...over,
});

const evidenceLink = (evidenceItemId: string, createdAt: string, over: Row = {}): Row => ({
  id: `link-${evidenceItemId}`, decision_record_id: "dec-1", evidence_item_id: evidenceItemId,
  link_reason: "supports_decision", evidence_hash_at_decision: "d".repeat(64),
  evidence_version_at_decision: 1, evidence_title_snapshot: evidenceItemId,
  created_at: createdAt, ...over,
});

const action = (over: Row = {}): Row => ({
  id: "act-1", workspace_id: WS, project_id: PRJ, source_decision_id: "dec-1",
  proposed_by: "user-1", schema_version: "pmfreak.material-action.v1",
  digest_version: "sha256:pmfreak-material-action:v1", proposal_digest: "e".repeat(64),
  idempotency_key: "idem-act-1", action_class: "ordinary_business_write",
  materiality: "material",
  proposal: { intendedEffect: "raise CR", serviceRoleKey: SECRETS.serviceRoleKey },
  correlation_id: CORR, causation_id: "dec-1", expires_at: "2026-08-11T08:00:00Z",
  created_at: "2026-08-10T08:10:00Z", persisted_at: "2026-08-10T08:11:00Z", ...over,
});

const evaluation = (over: Row = {}): Row => ({
  id: "eval-1", workspace_id: WS, project_id: PRJ, action_id: "act-1",
  proposal_digest: "e".repeat(64), contract_version: "pmfreak.aoc-e.in-process-governance.v1",
  evaluator_kind: "aoc_e_in_process", governance_state: "authorized",
  policy_decision_reference: "aoc-e:policy-decision:abc", grant_references: ["aoc-e:grant:g1"],
  obligation_references: ["aoc-e:obligation:o1"], approval_references: ["aoc-e:approval:a1"],
  reason_codes: ["policy_satisfied"], evaluated_at: "2026-08-10T08:12:00Z",
  valid_until: "2026-08-11T08:12:00Z", can_commit_action: true, can_execute: false,
  // Raw AOC-E response blob — must never be copied into the export.
  authorization_evidence: { state: "authorized", aocInternalAuthorityToken: SECRETS.serviceRoleKey },
  recorded_at: "2026-08-10T08:13:00Z", ...over,
});

const task = (over: Row = {}): Row => ({
  id: "task-1", workspace_id: WS, project_id: PRJ, source_action_id: "act-1",
  title: "Raise CR", status: "completed", priority: "high", assignee_id: "user-1",
  created_by: "user-1", correlation_id: CORR, causation_id: "act-1",
  created_at: "2026-08-10T09:00:00Z", updated_at: "2026-08-10T09:30:00Z",
  completed_at: "2026-08-10T09:30:00Z", ...over,
});

const execution = (over: Row = {}): Row => ({
  id: "exec-1", workspace_id: WS, project_id: PRJ, task_id: "task-1",
  governance_evaluation_id: "eval-1", status: "completed", attempt_count: 1,
  provider_key: "pmfreak/internal-state-machine:v1", idempotency_key: "idem-exec-1",
  correlation_id: CORR, causation_id: "task-1", queued_at: "2026-08-10T09:01:00Z",
  started_at: "2026-08-10T09:02:00Z", completed_at: "2026-08-10T09:29:00Z",
  created_at: "2026-08-10T09:01:00Z", updated_at: "2026-08-10T09:29:00Z", ...over,
});

const outcome = (over: Row = {}): Row => ({
  id: "out-1", workspace_id: WS, project_id: PRJ, task_id: "task-1",
  source_action_id: "act-1", state: "achieved", expected_result: "CR approved by sponsor",
  success_criteria: ["signed CR"], correlation_id: CORR, causation_id: "task-1",
  fixture_label: null, created_by: "user-1", created_at: "2026-08-10T09:31:00Z",
  updated_at: "2026-08-10T10:00:00Z", ...over,
});

const observation = (over: Row = {}): Row => ({
  id: "obs-1", workspace_id: WS, project_id: PRJ, outcome_id: "out-1", task_id: "task-1",
  observation_state: "achieved", summary: "Sponsor signed the CR",
  evidence_reference_ids: ["ev-1"], confidence_score: 0.95, missing_data_state: "COMPLETE",
  observed_at: "2026-08-10T09:50:00Z", recorded_at: "2026-08-10T09:55:00Z",
  evaluated_at: "2026-08-10T09:55:00Z", stale_at: null, observed_by: "user-1",
  correlation_id: CORR, causation_id: "task-1", idempotency_key: "idem-obs-1",
  fixture_label: null, ...over,
});

/** A complete, secret-seeded canonical chain: Source → … → Outcome → Observation. */
const completeDb = (over: Record<string, unknown[]> = {}) =>
  emptyDb({
    operational_sources: [source()],
    operational_raw_inputs: [rawInput()],
    operational_normalized_events: [normalizedEvent()],
    evidence_items: [evidence()],
    operational_signals: [signal()],
    governance_events: [governanceEvent()],
    recommended_actions: [recommendation()],
    operational_decision_records: [decision()],
    decision_evidence_links: [evidenceLink("ev-1", "2026-08-10T07:50:00Z")],
    material_action_proposals: [action()],
    material_action_governance_evaluations: [evaluation()],
    execution_tasks: [task()],
    internal_task_executions: [execution()],
    canonical_task_outcomes: [outcome()],
    canonical_outcome_observations: [observation()],
    ...over,
  });

const runExport = (db: Record<string, unknown[]>, options = {}): Promise<AuditExportPackage> =>
  buildCanonicalAuditExportPackage(createStrictMockClient(db), WS, PRJ, {
    generatedAt: "2026-08-16T00:00:00Z",
    ...options,
  });

const onlyLineage = (pkg: AuditExportPackage): AuditExportLineage => {
  assert.equal(pkg.lineages.length, 1, "fixture must produce exactly one lineage");
  return pkg.lineages[0];
};

const stepOf = (lineage: AuditExportLineage, kind: string) => {
  const step = lineage.steps.find((s) => s.kind === kind);
  assert.ok(step, `expected a ${kind} step`);
  return step;
};

/** Every secret-shaped literal seeded into the fixtures. */
const ALL_SECRET_VALUES = Object.values(SECRETS);

const assertNoSecrets = (value: unknown, label: string) => {
  const serialized = JSON.stringify(value);
  for (const secret of ALL_SECRET_VALUES) {
    assert.equal(serialized.includes(secret), false, `${label} must not contain ${secret.slice(0, 12)}…`);
  }
};

// ─── A. Complete canonical export ───────────────────────────────────────────────────────

test("P2-20 A: a complete canonical chain exports Source → … → Outcome → Observation with governance preserved", async () => {
  const pkg = await runExport(completeDb());
  assert.equal(pkg.exportFormat, CANONICAL_AUDIT_EXPORT_FORMAT);
  assert.equal(pkg.exportVersion, 1);
  assert.equal(pkg.generatedAt, "2026-08-16T00:00:00Z");
  assert.deepEqual(pkg.requestedScope, {
    workspaceId: WS, projectId: PRJ, outcomeId: null, taskId: null,
    correlationId: null, auditRecordLimit: 100,
  });

  const lineage = onlyLineage(pkg);
  assert.deepEqual(
    lineage.steps.map((s) => s.kind),
    ["source", "raw_input", "normalized_event", "evidence", "finding", "recommendation",
      "decision", "material_action", "task", "internal_execution", "outcome", "observation"],
  );
  for (const step of lineage.steps) {
    assert.notEqual(step.id, null, `${step.kind} must carry a canonical id`);
    assert.notEqual(step.status, "missing", `${step.kind} must not be a gap`);
    assert.ok(step.entityFields, `${step.kind} must expose allowlisted entity fields`);
  }
  assert.equal(lineage.lineageStatus, "complete");
  assert.deepEqual(lineage.gaps, []);
  assert.deepEqual(lineage.disputes, []);
  assert.equal(pkg.integrity.isComplete, true);
  assert.equal(pkg.integrity.overallStatus, "complete");

  // Governance: exported as an AOC-E reference projection attached to the material action.
  assert.equal(lineage.governanceReferences.length, 1);
  const governance = lineage.governanceReferences[0];
  assert.equal(governance.evaluationId, "eval-1");
  assert.equal(governance.governanceState, "authorized");
  assert.equal(governance.governanceIntegrity, "intact");
  assert.equal(governance.policyDecisionReference, "aoc-e:policy-decision:abc");
  assert.deepEqual(governance.grantReferences, ["aoc-e:grant:g1"]);

  // Canonical references are the stable IDs, never synthesised.
  assert.deepEqual(lineage.canonicalReferences, {
    sourceId: "src-1", rawInputId: "raw-1", normalizedEventId: "norm-1", evidenceId: "ev-1",
    findingId: "sig-1", recommendationId: "rec-1", decisionId: "dec-1",
    materialActionId: "act-1", taskId: "task-1", internalExecutionId: "exec-1",
    outcomeId: "out-1", observationIds: ["obs-1"], governanceEvaluationIds: ["eval-1"],
  });
});

// ─── B. Correlation is not causation ────────────────────────────────────────────────────

test("P2-20 B: a correlation-only transition stays correlation_only in the export", async () => {
  // Evidence keeps its stored correlation and a NULL causation; the shared correlation with
  // the normalized event is the only link, so the verified projection classifies it
  // correlation_only. The export must carry that through untouched.
  const db = completeDb({
    evidence_items: [evidence({ causation_id: null, correlation_id: CORR })],
  });
  const lineage = onlyLineage(await runExport(db));
  const transition = lineage.transitions.find((t) => t.fromKind === "normalized_event" && t.toKind === "evidence");
  assert.ok(transition);
  assert.equal(transition.relationship, "correlation_only");
  assert.equal(transition.isCausal, false);
  assert.match(transition.relationshipExplanation, /Correlation does NOT imply causation/);
  assert.equal(lineage.hasCorrelationOnly, true);
  assert.equal(stepOf(lineage, "evidence").causationId, null);
  // No transition anywhere in the export is upgraded to causation without a matching pointer.
  for (const t of lineage.transitions) {
    if (t.relationship === "causation") assert.equal(t.isCausal, true);
    if (!t.isCausal) assert.notEqual(t.relationship, "causation");
  }
});

test("P2-20 B: the export layer never re-derives a transition relationship", () => {
  // The relationship vocabulary is produced exclusively by the verified P2-10 projection.
  assert.doesNotMatch(canonicalExport, /relationship\s*[:=]\s*"causation"/);
  assert.match(canonicalExport, /transitions: projection\.transitions/);
});

// ─── C. Gap preservation ────────────────────────────────────────────────────────────────

test("P2-20 C: missing canonical provenance produces explicit gaps, never synthetic data", async () => {
  const db = completeDb({
    operational_sources: [],
    operational_raw_inputs: [],
    operational_normalized_events: [],
  });
  const pkg = await runExport(db);
  const lineage = onlyLineage(pkg);

  for (const kind of ["source", "raw_input", "normalized_event"]) {
    const step = stepOf(lineage, kind);
    assert.equal(step.id, null, `${kind} must not be invented`);
    assert.equal(step.status, "missing");
    assert.equal(step.entityFields, null);
    assert.ok(step.gapReason, `${kind} must state why it is missing`);
  }
  assert.ok(lineage.gaps.some((g) => /Source: missing/.test(g)));
  assert.ok(lineage.gaps.some((g) => /Raw Input: missing/.test(g)));
  assert.ok(lineage.gaps.some((g) => /Normalized Event: missing/.test(g)));
  assert.notEqual(lineage.lineageStatus, "complete");
  assert.equal(pkg.integrity.isComplete, false);
  assert.ok(pkg.integrity.gapCount >= 3);
  assert.deepEqual(lineage.canonicalReferences.sourceId, null);
});

test("P2-20 C: a missing governance evaluation is degraded with an explicit gap and no substitute", async () => {
  const pkg = await runExport(completeDb({
    material_action_governance_evaluations: [],
    internal_task_executions: [execution({ governance_evaluation_id: "eval-absent" })],
  }));
  const lineage = onlyLineage(pkg);
  assert.deepEqual(lineage.governanceReferences, []);
  assert.equal(stepOf(lineage, "material_action").status, "degraded");
  assert.ok(lineage.gaps.some((g) => /eval-absent/.test(g)), "the absent evaluation id must be named");
  assert.equal(pkg.integrity.isComplete, false);
  assert.equal(lineage.canonicalReferences.governanceEvaluationIds.length, 0);
});

test("P2-20 C: an empty requested scope exports honestly instead of inventing a lineage", async () => {
  const pkg = await runExport(emptyDb());
  assert.deepEqual(pkg.lineages, []);
  assert.equal(pkg.integrity.overallStatus, "incomplete");
  assert.equal(pkg.integrity.isComplete, false);
  assert.ok(pkg.integrity.notes.some((n) => /Nothing was synthesised/.test(n)));
});

// ─── D. Multiple evidence links ─────────────────────────────────────────────────────────

test("P2-20 D: every legitimate decision evidence link is represented or explicitly reported omitted", async () => {
  const db = completeDb({
    evidence_items: [
      evidence(),
      evidence({ id: "ev-2", metadata: {}, content: "second" }),
      evidence({ id: "ev-3", metadata: {}, content: "third" }),
    ],
    // The primary is chosen by the verified signal-first rule (signal.evidence_item_id = ev-1).
    decision_evidence_links: [
      evidenceLink("ev-3", "2026-08-10T07:55:00Z"),
      evidenceLink("ev-1", "2026-08-10T07:50:00Z"),
      evidenceLink("ev-2", "2026-08-10T07:52:00Z"),
    ],
  });
  const lineage = onlyLineage(await runExport(db));
  assert.equal(stepOf(lineage, "evidence").id, "ev-1");
  const omission = lineage.gaps.find((g) => /not represented/.test(g));
  assert.ok(omission, "omitted evidence links must be surfaced as an explicit gap");
  assert.match(omission, /ev-2/);
  assert.match(omission, /ev-3/);
  assert.doesNotMatch(omission, /ev-1,|, ev-1/);
});

// ─── E. Task completion is not Outcome achievement ─────────────────────────────────────

test("P2-20 E: a completed task with an inconclusive outcome never exports as achieved", async () => {
  const pkg = await runExport(completeDb({
    canonical_task_outcomes: [outcome({ state: "inconclusive" })],
    canonical_outcome_observations: [observation({ observation_state: "inconclusive" })],
    execution_tasks: [task({ status: "completed" })],
  }));
  const lineage = onlyLineage(pkg);
  assert.equal(lineage.outcomeAssessment.taskStatus, "completed");
  assert.equal(lineage.outcomeAssessment.isAchieved, false);
  assert.equal(lineage.outcomeAssessment.outcomeState, "inconclusive");
  assert.equal(lineage.outcomeAssessment.achievementBasis, "canonical_outcome_state_not_achieved");
  assert.equal(lineage.outcomeAssessment.taskCompletionImpliesOutcomeAchievement, false);
  assert.equal(lineage.lineageStatus, "disputed");
  assert.ok(lineage.disputes.some((d) => /inconclusive/.test(d)));
  assert.equal(pkg.integrity.isComplete, false);
});

test("P2-20 E: a completed task with no canonical observation exports as unobserved, not achieved", async () => {
  const lineage = onlyLineage(await runExport(completeDb({
    canonical_task_outcomes: [outcome({ state: "expected" })],
    canonical_outcome_observations: [],
  })));
  assert.equal(lineage.outcomeAssessment.taskStatus, "completed");
  assert.equal(lineage.outcomeAssessment.isAchieved, false);
  assert.equal(lineage.outcomeAssessment.observationsCount, 0);
  assert.equal(lineage.outcomeAssessment.achievementBasis, "unobserved_no_canonical_observation");
  assert.ok(lineage.gaps.some((g) => /unobserved/.test(g)));
  assert.equal(stepOf(lineage, "observation").status, "missing");
});

test("P2-20 E: a disputed outcome is exported as disputed", async () => {
  const lineage = onlyLineage(await runExport(completeDb({
    canonical_task_outcomes: [outcome({ state: "disputed" })],
  })));
  assert.equal(lineage.outcomeAssessment.isAchieved, false);
  assert.equal(lineage.lineageStatus, "disputed");
  assert.equal(stepOf(lineage, "outcome").status, "disputed");
});

// ─── F. Outcome observation reconstruction ──────────────────────────────────────────────

test("P2-20 F: a canonical observation absent from platform_events appears as a labelled reconstruction", async () => {
  const pkg = await runExport(completeDb(), { outcomeId: "out-1" });
  const reconstructed = pkg.auditRecords.find((r) => r.id === "canonical_outcome_observations:obs-1");
  assert.ok(reconstructed, "the canonical observation must reach the audit trail");
  assert.equal(reconstructed.isReconstructed, true);
  assert.equal(reconstructed.reconstructedFrom, "canonical_outcome_observations");
  assert.equal(reconstructed.associationBasis, "reconstruction");
  assert.match(reconstructed.associationExplanation, /NOT an emitted platform_event/);
  assert.equal(reconstructed.eventType, "CANONICAL_OUTCOME_OBSERVATION_RECORDED");
  assert.equal(reconstructed.occurredAt, "2026-08-10T09:50:00Z");
  assert.equal(reconstructed.recordedAt, "2026-08-10T09:55:00Z");
  assert.equal(reconstructed.metadata.reconstructed, true);
  // Not disguised as a platform_events row.
  assert.notEqual(reconstructed.id, "obs-1");
});

test("P2-20 F: an outcome-scoped platform event stays a correlation-only association", async () => {
  const platformEvent = {
    id: "pe-1", workspace_id: WS, project_id: PRJ, event_type: "TASK_COMPLETED",
    event_category: "task", actor_id: "user-1", actor_type: "user",
    occurred_at: "2026-08-10T09:30:00Z", created_at: "2026-08-10T09:30:00Z",
    correlation_id: CORR, causation_id: null, raw_reference_table: "execution_tasks",
    raw_reference_id: "task-x", event_payload: {}, metadata: {},
  };
  const pkg = await runExport(completeDb({ platform_events: [platformEvent] }), { outcomeId: "out-1" });
  const record = pkg.auditRecords.find((r) => r.id === "pe-1");
  assert.ok(record);
  assert.equal(record.associationBasis, "correlation_only");
  assert.equal(record.relationship, "correlation_only");
  assert.equal(record.metadata.outcomeAssociation, "correlation_only");
  assert.equal(record.metadata.outcomeAssociationComplete, false);
  assert.equal(pkg.integrity.eventAssociationComplete, false);
});

test("P2-20 F: a lineage event's association basis names the stored reference that selected it", async () => {
  const events = [
    { id: "pe-outcome", workspace_id: WS, project_id: PRJ, event_type: "OUTCOME_RECORDED",
      event_category: "outcome", actor_id: "user-1", actor_type: "user",
      occurred_at: "2026-08-10T09:32:00Z", created_at: "2026-08-10T09:32:00Z",
      correlation_id: "other-corr", causation_id: null,
      raw_reference_table: "canonical_task_outcomes", raw_reference_id: "out-1",
      event_payload: {}, metadata: {} },
    { id: "pe-corr", workspace_id: WS, project_id: PRJ, event_type: "DECISION_RECORDED",
      event_category: "decision", actor_id: "user-1", actor_type: "user",
      occurred_at: "2026-08-10T08:01:00Z", created_at: "2026-08-10T08:01:00Z",
      correlation_id: CORR, causation_id: null, raw_reference_table: "operational_decision_records",
      raw_reference_id: "dec-1", event_payload: {}, metadata: {} },
  ];
  const lineage = onlyLineage(await runExport(completeDb({ platform_events: events })));
  const byId = new Map(lineage.lineageEvents.map((e) => [e.id, e]));
  assert.equal(byId.get("pe-outcome")?.associationBasis, "direct_reference");
  assert.equal(byId.get("pe-corr")?.associationBasis, "correlation_only");
  assert.match(byId.get("pe-corr")?.associationExplanation ?? "", /Correlation does NOT imply causation/);
});

// ─── G. Redaction ───────────────────────────────────────────────────────────────────────

test("P2-20 G: seeded secrets never reach the exported package", async () => {
  const platformEvent = {
    id: "pe-secret", workspace_id: WS, project_id: PRJ, event_type: "PROVIDER_CALL_FAILED",
    event_category: "task", actor_id: "user-1", actor_type: "user",
    occurred_at: "2026-08-10T09:10:00Z", created_at: "2026-08-10T09:10:00Z",
    correlation_id: CORR, causation_id: null, raw_reference_table: "execution_tasks",
    raw_reference_id: "task-1",
    event_payload: {
      taskId: "task-1",
      accessToken: SECRETS.bearer,
      rawError: { detail: SECRETS.stripeLive },
      nested: { deeper: { apiKey: SECRETS.apiKey } },
    },
    metadata: { connectionString: SECRETS.connectionString, refreshToken: SECRETS.refreshToken },
  };
  const pkg = await runExport(completeDb({ platform_events: [platformEvent] }), { outcomeId: "out-1" });

  assertNoSecrets(pkg, "the exported package");

  const record = pkg.auditRecords.find((r) => r.id === "pe-secret");
  assert.ok(record);
  assert.equal(record.payload.accessToken, REDACTION_MARKER);
  assert.equal(record.payload.rawError, REDACTION_MARKER);
  assert.equal(record.metadata.connectionString, REDACTION_MARKER);
  assert.equal(record.metadata.refreshToken, REDACTION_MARKER);
  assert.deepEqual(record.payload.nested, { deeper: { apiKey: REDACTION_MARKER } });

  // Free-text/payload columns are withheld by the allowlist and NAMED, not silently dropped.
  const lineage = onlyLineage(pkg);
  assert.ok(stepOf(lineage, "raw_input").withheldEntityFields.includes("payload"));
  assert.ok(stepOf(lineage, "normalized_event").withheldEntityFields.includes("event_payload"));
  assert.ok(stepOf(lineage, "evidence").withheldEntityFields.includes("content"));
  assert.ok(stepOf(lineage, "material_action").withheldEntityFields.includes("proposal"));
  assert.ok(stepOf(lineage, "decision").withheldEntityFields.includes("authority_evaluation"));
  assert.ok(pkg.redaction.redactedPayloadKeys.length > 0);
  assert.equal(pkg.redaction.marker, REDACTION_MARKER);
});

test("P2-20 G: legitimate audit metadata survives redaction", async () => {
  const lineage = onlyLineage(await runExport(completeDb()));

  const rawStep = stepOf(lineage, "raw_input");
  assert.equal(rawStep.entityFields?.content_digest, `sha256:${"a".repeat(64)}`);
  assert.equal(rawStep.entityFields?.actor_user_id, "user-1");
  assert.equal(rawStep.occurredAt, "2026-08-10T07:01:00Z");
  assert.equal(rawStep.recordedAt, "2026-08-10T07:02:00Z");
  assert.notEqual(rawStep.occurredAt, rawStep.recordedAt);

  const evidenceStep = stepOf(lineage, "evidence");
  assert.equal(evidenceStep.entityFields?.evidence_hash, "c".repeat(64));
  assert.equal(evidenceStep.evidenceAssertionType, "FACT");
  assert.equal(evidenceStep.confidenceScore, 0.9);
  assert.equal(evidenceStep.missingDataState, "COMPLETE");
  assert.equal(evidenceStep.correlationId, CORR);
  assert.equal(evidenceStep.causationId, "norm-1");

  // The export carries `confidenceScore` verbatim, so the two persisted scales must already
  // be reconciled upstream: `operational_signals.confidence_score` is 0-100 (this fixture
  // persists 85, as the detector does), Evidence is a 0-1 fraction, and both arrive here on
  // the canonical 0-1 lineage scale. An un-normalized Finding would export 85 and render
  // 8500.0%.
  const findingStep = stepOf(lineage, "finding");
  assert.equal(findingStep.entityFields?.confidence_score, 85, "fixture keeps the persisted 0-100 scale");
  assert.equal(findingStep.confidenceScore, 0.85, "exported on the canonical 0-1 lineage scale");
  assert.match(findingStep.summary, /Confidence: 85\.0%/);
  assert.doesNotMatch(findingStep.summary, /8500\.0%/);

  const actionStep = stepOf(lineage, "material_action");
  assert.equal(actionStep.entityFields?.proposal_digest, "e".repeat(64));
  assert.equal(actionStep.entityFields?.action_class, "ordinary_business_write");
  assert.equal(stepOf(lineage, "internal_execution").entityFields?.governance_evaluation_id, "eval-1");
  assert.equal(stepOf(lineage, "outcome").entityFields?.state, "achieved");
  assert.equal(stepOf(lineage, "observation").entityFields?.observation_state, "achieved");
  assert.deepEqual(stepOf(lineage, "observation").entityFields?.evidence_reference_ids, ["ev-1"]);
});

test("P2-20 G: no allowlist admits a known payload or free-text column", () => {
  const forbidden = [
    "payload", "event_payload", "content", "proposal", "authorization_evidence",
    "authority_evaluation", "provenance", "metadata", "fixture_metadata",
    "redacted_payload", "rationale", "summary",
  ];
  for (const [kind, columns] of Object.entries(ENTITY_FIELD_ALLOWLIST)) {
    for (const column of forbidden) {
      assert.equal(columns.includes(column), false, `${kind} allowlist must not admit ${column}`);
    }
  }
});

// ─── H. Tenant isolation ────────────────────────────────────────────────────────────────

test("P2-20 H: no foreign-tenant evidence, event, observation or outcome can enter the package", async () => {
  const db = completeDb({
    // Foreign-tenant rows for every category the export can traverse.
    canonical_task_outcomes: [outcome(), outcome({ id: "out-foreign", workspace_id: FOREIGN_WS, project_id: FOREIGN_PRJ })],
    canonical_outcome_observations: [
      observation(),
      observation({ id: "obs-foreign", workspace_id: FOREIGN_WS, project_id: FOREIGN_PRJ, outcome_id: "out-1" }),
    ],
    evidence_items: [evidence(), evidence({ id: "ev-foreign", workspace_id: FOREIGN_WS, project_id: FOREIGN_PRJ })],
    platform_events: [
      { id: "pe-foreign", workspace_id: FOREIGN_WS, project_id: FOREIGN_PRJ, event_type: "X",
        event_category: "task", actor_id: "user-x", actor_type: "user",
        occurred_at: "2026-08-10T09:00:00Z", created_at: "2026-08-10T09:00:00Z",
        correlation_id: CORR, causation_id: null, raw_reference_table: "execution_tasks",
        raw_reference_id: "task-1", event_payload: {}, metadata: {} },
    ],
    decision_evidence_links: [
      evidenceLink("ev-1", "2026-08-10T07:50:00Z"),
      evidenceLink("ev-foreign", "2026-08-10T07:51:00Z", { decision_record_id: "dec-foreign" }),
    ],
    operational_decision_records: [decision(), decision({ id: "dec-foreign", workspace_id: FOREIGN_WS, project_id: FOREIGN_PRJ })],
  });

  const pkg = await runExport(db, { outcomeId: "out-1" });
  const serialized = JSON.stringify(pkg);
  for (const foreign of ["out-foreign", "obs-foreign", "ev-foreign", "pe-foreign", "dec-foreign", FOREIGN_WS, FOREIGN_PRJ]) {
    assert.equal(serialized.includes(foreign), false, `${foreign} must not appear in the export`);
  }
  // Positive same-tenant control: the caller's own chain IS present.
  const lineage = onlyLineage(pkg);
  assert.equal(lineage.outcomeId, "out-1");
  assert.equal(lineage.canonicalReferences.evidenceId, "ev-1");
  assert.deepEqual(lineage.canonicalReferences.observationIds, ["obs-1"]);
});

test("P2-20 H: the export layer issues no query of its own", () => {
  assert.doesNotMatch(canonicalExport, /client\.from\(|\.rpc\(/);
  assert.match(canonicalExport, /getCompleteLineageProjection\(client, workspaceId, projectId/);
  assert.match(canonicalExport, /reconstructAuditTrail\(client, workspaceId, projectId/);
});

test("P2-20 H: the API route gates audit_export behind the same authorization as every other view", () => {
  assert.match(apiRoute, /view === "audit_export"/);
  assert.match(apiRoute, /buildCanonicalAuditExportPackage\(authorized\.supabase, workspaceId, projectId/);
  // The export view sits AFTER the shared authorize() gate and uses the authorized client.
  const gateIndex = apiRoute.indexOf('const authorized = await authorize(projectId, workspaceId, "read")');
  const exportIndex = apiRoute.indexOf('view === "audit_export"');
  assert.ok(gateIndex > -1 && exportIndex > gateIndex);
  assert.doesNotMatch(apiRoute, /createSupabaseServiceRoleClient|SUPABASE_SERVICE_ROLE/);
});

// ─── I. AOC ownership ───────────────────────────────────────────────────────────────────

test("P2-20 I: only stored AOC references are exported; no authority or evidence object is manufactured", async () => {
  const pkg = await runExport(completeDb());
  const governance = onlyLineage(pkg).governanceReferences[0];

  assert.equal(governance.pmfreakOwnsGovernanceEvidence, false);
  assert.equal(governance.authorityOwner, "AOC-E");
  assert.equal(governance.canExecute, false);
  assert.deepEqual(Object.keys(governance).sort(), [
    "actionId", "approvalReferences", "authorityOwner", "canCommitAction", "canExecute",
    "contractVersion", "evaluatedAt", "evaluationId", "evaluatorKind", "governanceIntegrity",
    "governanceState", "grantReferences", "obligationReferences", "pmfreakOwnsGovernanceEvidence",
    "policyDecisionReference", "reasonCodes", "recordedAt", "validUntil",
  ]);

  // The raw AOC-E response blob is never copied.
  assert.equal(JSON.stringify(pkg).includes("aocInternalAuthorityToken"), false);
  assert.ok(stepOf(onlyLineage(pkg), "material_action").withheldEntityFields.includes("evaluation"));

  assert.deepEqual(pkg.aocBoundary, {
    identityIntegrityCapabilityOwner: "AOC-P",
    policyAuthorityObligationOwner: "AOC-E",
    pmBusinessObjectOwner: "PMFreak",
    allowDecisionWriteback: false,
    exportedArtifacts: "references_and_status_projections_only",
    note: pkg.aocBoundary.note,
  });
  assert.match(pkg.aocBoundary.note, /does not own, copy or manufacture AOC policy state/);
});

// ─── J. Determinism ─────────────────────────────────────────────────────────────────────

test("P2-20 J: shuffled fixture row order produces an identical canonical payload", async () => {
  const observations = [
    observation({ id: "obs-a", observed_at: "2026-08-10T09:40:00Z", recorded_at: "2026-08-10T09:41:00Z" }),
    observation({ id: "obs-b", observed_at: "2026-08-10T09:50:00Z", recorded_at: "2026-08-10T09:41:00Z" }),
    observation({ id: "obs-c", observed_at: "2026-08-10T09:45:00Z", recorded_at: "2026-08-10T09:41:00Z" }),
  ];
  const evaluations = [evaluation(), evaluation({ id: "eval-old", evaluated_at: "2026-08-09T08:12:00Z" })];
  const links = [
    evidenceLink("ev-1", "2026-08-10T07:50:00Z"),
    evidenceLink("ev-2", "2026-08-10T07:52:00Z"),
    evidenceLink("ev-3", "2026-08-10T07:55:00Z"),
  ];
  const outcomes = [outcome(), outcome({ id: "out-2", task_id: "task-1", created_at: "2026-08-10T09:31:00Z" })];
  const evidenceRows = [
    evidence(),
    evidence({ id: "ev-2", metadata: {}, content: "second" }),
    evidence({ id: "ev-3", metadata: {}, content: "third" }),
  ];

  const build = (reverse: boolean) => {
    const order = <T,>(rows: T[]) => (reverse ? [...rows].reverse() : rows);
    return completeDb({
      canonical_task_outcomes: order(outcomes),
      canonical_outcome_observations: order(observations),
      material_action_governance_evaluations: order(evaluations),
      decision_evidence_links: order(links),
      evidence_items: order(evidenceRows),
    });
  };

  const forward = await runExport(build(false));
  const reversed = await runExport(build(true));
  assert.deepEqual(reversed, forward);
  assert.equal(forward.lineages.length, 2);
  assert.deepEqual(forward.lineages.map((l) => l.outcomeId), ["out-1", "out-2"]);
  assert.deepEqual(forward.lineages[0].steps.filter((s) => s.kind === "observation").map((s) => s.id),
    ["obs-a", "obs-c", "obs-b"]);
});

test("P2-20 J: only generatedAt may vary between two exports of unchanged state", async () => {
  const db = completeDb();
  const first = await runExport(db, { generatedAt: "2026-08-16T00:00:00Z" });
  const second = await runExport(db, { generatedAt: "2026-08-17T12:00:00Z" });
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.deepEqual({ ...second, generatedAt: first.generatedAt }, first);
});

// ─── K. Legacy compatibility ────────────────────────────────────────────────────────────

test("P2-20 K: the legacy decision-governance export is preserved unchanged", () => {
  assert.match(decisionGovernanceService, /export async function buildDecisionLineage/);
  assert.match(decisionGovernanceService, /export async function exportDecisionAuditPackage/);
  assert.match(decisionGovernanceTypes, /export type DecisionLineage = \{/);
  assert.match(decisionGovernanceTypes, /export type DecisionAuditPackage = \{/);
  // The legacy model is not deleted, fused, or rewritten by P2-20.
  assert.match(decisionGovernanceService, /from\("project_decisions"\)/);
  assert.match(decisionGovernanceService, /from\("project_decision_evidence_links"\)/);
  assert.match(decisionGovernanceService, /from\("decision_outcomes"\)/);
});

test("P2-20 K: the legacy compatibility adapter marks canonical lineage unsupported instead of inventing it", () => {
  assert.match(legacyCompatibility, /canonicalLineageSupported: false/);
  assert.match(legacyCompatibility, /legacyDecisionId: legacy\.data\.decision\.id/);
  assert.match(legacyCompatibility, /LEGACY_COMPATIBILITY_GAPS/);
  // Composition only: it wraps the legacy export and writes nothing.
  assert.match(legacyCompatibility, /await exportDecisionAuditPackage\(decisionId\)/);
  assert.doesNotMatch(legacyCompatibility, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  // It never claims to be, or reconstructs, the canonical chain.
  assert.doesNotMatch(legacyCompatibility, /getCompleteLineageProjection|buildCanonicalAuditExportPackage/);
});

// ─── L. Presentation-surface redaction (REPAIR 1) ───────────────────────────────────────

/**
 * The verified projection builds `title`/`summary`/`expectedResult`/`gaps` by interpolating
 * persisted free text. Those columns are withheld by the entity allowlist, so without
 * presentation redaction a secret embedded in one of them would reach the export anyway.
 */
test("P2-20 L: secrets seeded into presentation-source free text never reach the package", async () => {
  const pkg = await runExport(completeDb({
    recommended_actions: [recommendation({
      title: `Raise a change request ${STRIPE_LIVE_SHAPED}`,
      proposed_action: `Raise CR using ${SECRETS.bearer}`,
    })],
    operational_decision_records: [decision({
      decision: `Proceed with CR ${SECRETS.serviceRoleKey}`,
      rationale: `Sponsor approved via ${SECRETS.bearer}`,
    })],
    execution_tasks: [task({ title: `Raise CR ${STRIPE_LIVE_SHAPED}` })],
    canonical_task_outcomes: [outcome({
      expected_result: `CR approved by sponsor ${SECRETS.serviceRoleKey}`,
      success_criteria: [`signed CR verified with ${STRIPE_LIVE_SHAPED}`],
    })],
    canonical_outcome_observations: [observation({
      summary: `Sponsor signed the CR, confirmation token ${SECRETS.serviceRoleKey}`,
    })],
    operational_sources: [source({ display_name: `Manual demo ${SECRETS.bearer}` })],
  }));

  assertNoSecrets(pkg, "the exported package");

  // The redaction is reported, not silent.
  assert.ok(pkg.redaction.redactedTextSurfaces.length > 0);
  for (const surface of [
    "step.recommendation.title", "step.decision.summary", "step.task.title",
    "step.outcome.title", "step.outcome.summary", "step.observation.title",
    "lineage.expectedResult", "step.source.title",
  ]) {
    assert.ok(
      pkg.redaction.redactedTextSurfaces.includes(surface),
      `${surface} must be reported as redacted`,
    );
  }
  // Deterministic ordering of the report.
  assert.deepEqual(pkg.redaction.redactedTextSurfaces, [...pkg.redaction.redactedTextSurfaces].sort());
});

test("P2-20 L: ordinary business text survives presentation redaction", async () => {
  const lineage = onlyLineage(await runExport(completeDb({
    operational_decision_records: [decision({ decision: `Proceed with CR ${SECRETS.serviceRoleKey}` })],
    canonical_task_outcomes: [outcome({ expected_result: `CR approved by sponsor ${SECRETS.serviceRoleKey}` })],
  })));

  // The secret is gone; the surrounding human-readable text is intact and still readable.
  assert.equal(lineage.expectedResult, "CR approved by sponsor [redacted]");
  assert.match(stepOf(lineage, "decision").title, /^Decision: Proceed with CR /);
  assert.match(stepOf(lineage, "recommendation").title, /Recommendation: Raise a change request/);
  assert.match(stepOf(lineage, "task").title, /Task: Raise CR/);
  assert.match(stepOf(lineage, "finding").title, /Finding: scope creep/);
  assert.match(stepOf(lineage, "evidence").summary, /Confidence: 90\.0%/);
  // Framework-generated explanatory strings are untouched.
  const transition = lineage.transitions.find((t) => t.fromKind === "task");
  assert.ok(transition && transition.relationshipExplanation.length > 0);
});

test("P2-20 L: a secret embedded in a gap or dispute string is redacted", async () => {
  const pkg = await runExport(completeDb({
    canonical_task_outcomes: [outcome({ state: "expected" })],
    canonical_outcome_observations: [observation({
      observation_state: "disputed",
      summary: `Disputed because ${STRIPE_LIVE_SHAPED} was used`,
      missing_data_state: "PARTIAL",
    })],
  }));
  assertNoSecrets(pkg, "the exported package");
  const lineage = onlyLineage(pkg);
  assert.ok(lineage.disputes.length > 0);
  assert.deepEqual(lineage.gaps, [...lineage.gaps].sort());
  assert.deepEqual(lineage.disputes, [...lineage.disputes].sort());
});

// ─── M. Requested-scope coherence (REPAIR 2) ────────────────────────────────────────────

const CORR_B = "44444444-4444-4444-8444-444444444444";

/** A second, fully independent chain on task-b / out-b with correlation CORR_B. */
const secondChainDb = () =>
  completeDb({
    execution_tasks: [task(), task({ id: "task-b", source_action_id: "act-b", correlation_id: CORR_B, causation_id: "act-b" })],
    internal_task_executions: [execution(), execution({ id: "exec-b", task_id: "task-b", correlation_id: CORR_B, causation_id: "task-b" })],
    material_action_proposals: [action(), action({ id: "act-b", correlation_id: CORR_B })],
    material_action_governance_evaluations: [evaluation(), evaluation({ id: "eval-b", action_id: "act-b" })],
    canonical_task_outcomes: [
      outcome(),
      outcome({ id: "out-b", task_id: "task-b", source_action_id: "act-b", correlation_id: CORR_B, causation_id: "task-b" }),
    ],
    canonical_outcome_observations: [
      observation(),
      observation({ id: "obs-b", outcome_id: "out-b", task_id: "task-b", correlation_id: CORR_B, summary: "Second chain observed" }),
    ],
    platform_events: [
      { id: "pe-a", workspace_id: WS, project_id: PRJ, event_type: "A_EVENT", event_category: "task",
        actor_id: "user-1", actor_type: "user", occurred_at: "2026-08-10T09:20:00Z",
        created_at: "2026-08-10T09:20:00Z", correlation_id: CORR, causation_id: null,
        raw_reference_table: "execution_tasks", raw_reference_id: "task-1", event_payload: {}, metadata: {} },
      { id: "pe-b", workspace_id: WS, project_id: PRJ, event_type: "B_EVENT", event_category: "task",
        actor_id: "user-1", actor_type: "user", occurred_at: "2026-08-10T09:21:00Z",
        created_at: "2026-08-10T09:21:00Z", correlation_id: CORR_B, causation_id: null,
        raw_reference_table: "execution_tasks", raw_reference_id: "task-b", event_payload: {}, metadata: {} },
    ],
  });

test("P2-20 M1: a taskId-scoped package excludes the other task's lineage AND audit records", async () => {
  const pkg = await runExport(secondChainDb(), { taskId: "task-1" });

  assert.deepEqual(pkg.lineages.map((l) => l.outcomeId), ["out-1"]);
  assert.equal(pkg.requestedScope.taskId, "task-1");
  assert.equal(pkg.requestedScope.outcomeId, null);

  const ids = pkg.auditRecords.map((r) => r.id);
  assert.ok(ids.includes("pe-a"), "the requested task's event must be present");
  assert.equal(ids.includes("pe-b"), false, "the other task's event must not leak in");
  assert.ok(ids.includes("canonical_outcome_observations:obs-1"));
  assert.equal(ids.includes("canonical_outcome_observations:obs-b"), false,
    "the other task's observation reconstruction must not leak in");
  assert.equal(JSON.stringify(pkg).includes("Second chain observed"), false);

  // Association names the canonical outcome AND the requested task.
  const event = pkg.auditRecords.find((r) => r.id === "pe-a");
  assert.equal(event?.associationBasis, "correlation_only");
  assert.match(event?.associationExplanation ?? "", /canonical outcome out-1/);
  assert.match(event?.associationExplanation ?? "", /requested task task-1/);
  assert.equal(event?.relationship, "correlation_only", "stored relationship is untouched");
});

test("P2-20 M2: a correlationId-scoped package excludes unrelated lineages and records", async () => {
  const pkg = await runExport(secondChainDb(), { correlationId: CORR_B });

  assert.deepEqual(pkg.lineages.map((l) => l.outcomeId), ["out-b"]);
  assert.equal(pkg.requestedScope.correlationId, CORR_B);

  const ids = pkg.auditRecords.map((r) => r.id);
  assert.ok(ids.includes("pe-b"));
  assert.equal(ids.includes("pe-a"), false);
  assert.equal(ids.includes("canonical_outcome_observations:obs-1"), false);

  const event = pkg.auditRecords.find((r) => r.id === "pe-b");
  assert.equal(event?.associationBasis, "correlation_only");
  assert.match(event?.associationExplanation ?? "", /no causal claim is made/);
  assert.ok(pkg.integrity.notes.some((n) => /Association is by correlation only/.test(n)));
});

test("P2-20 M2: a correlation matching no lineage yields an empty, honest package", async () => {
  const pkg = await runExport(secondChainDb(), { correlationId: "55555555-5555-4555-8555-555555555555" });
  assert.deepEqual(pkg.lineages, []);
  assert.equal(pkg.integrity.overallStatus, "incomplete");
  assert.equal(pkg.integrity.isComplete, false);
});

test("P2-20 M3: taskId + correlationId intersect; a contradicting correlation adds no events", async () => {
  const agreeing = await runExport(secondChainDb(), { taskId: "task-b", correlationId: CORR_B });
  assert.deepEqual(agreeing.lineages.map((l) => l.outcomeId), ["out-b"]);
  assert.ok(agreeing.auditRecords.some((r) => r.id === "pe-b"));
  assert.equal(agreeing.auditRecords.some((r) => r.id === "pe-a"), false);

  // task-b's OUTCOME carries CORR_B, so requesting task-b with CORR contradicts it at the
  // outcome. Its upstream provenance (raw_input/normalized_event/evidence) is shared with
  // chain A and genuinely stores CORR, so the lineage legitimately matches the correlation
  // filter — suppressing it would be dishonest about what the rows actually record. What
  // must NOT happen is unrelated events appearing, and they do not: the verified
  // reconstruction sees correlationId CORR against outcome correlation CORR_B, finds the
  // intersection empty, and contributes nothing.
  const contradicting = await runExport(secondChainDb(), { taskId: "task-b", correlationId: CORR });
  assert.deepEqual(contradicting.lineages.map((l) => l.outcomeId), ["out-b"]);
  assert.equal(contradicting.lineages[0].canonicalReferences.taskId, "task-b",
    "only the requested task's lineage is present");
  assert.equal(stepOf(contradicting.lineages[0], "outcome").correlationId, CORR_B,
    "the outcome's own correlation contradicts the requested one");
  assert.equal(stepOf(contradicting.lineages[0], "evidence").correlationId, CORR,
    "the match came from genuinely shared upstream provenance, by correlation only");
  assert.deepEqual(contradicting.auditRecords, [], "no unrelated events appear");
  // Correlation was never promoted into causation anywhere in the intersected package.
  for (const transition of contradicting.lineages[0].transitions) {
    if (!transition.isCausal) assert.notEqual(transition.relationship, "causation");
  }
});

test("P2-20 M4: an outcomeId that does not belong to the requested taskId returns nothing", async () => {
  const pkg = await runExport(secondChainDb(), { outcomeId: "out-b", taskId: "task-1" });
  assert.deepEqual(pkg.lineages, []);
  assert.deepEqual(pkg.auditRecords, [], "no project-wide fallback");
  assert.equal(pkg.integrity.lineageCount, 0);
  assert.equal(pkg.integrity.isComplete, false);
  assert.equal(pkg.integrity.overallStatus, "incomplete");
  assert.ok(pkg.integrity.notes.some((n) => /deliberately NOT used as a fallback/.test(n)));
  assert.equal(pkg.requestedScope.outcomeId, "out-b");
  assert.equal(pkg.requestedScope.taskId, "task-1");
});

test("P2-20 M5: a task with multiple outcomes merges, dedupes and applies ONE combined limit", async () => {
  // Both outcomes hang off task-1 and share CORR, so the same platform event is reachable
  // through each of them — the merge must emit it once.
  const db = completeDb({
    canonical_task_outcomes: [outcome(), outcome({ id: "out-2", task_id: "task-1" })],
    canonical_outcome_observations: [
      observation(),
      observation({ id: "obs-2", outcome_id: "out-2", observed_at: "2026-08-10T09:52:00Z" }),
    ],
    platform_events: [
      { id: "pe-shared", workspace_id: WS, project_id: PRJ, event_type: "SHARED", event_category: "task",
        actor_id: "user-1", actor_type: "user", occurred_at: "2026-08-10T09:20:00Z",
        created_at: "2026-08-10T09:20:00Z", correlation_id: CORR, causation_id: null,
        raw_reference_table: "execution_tasks", raw_reference_id: "task-1", event_payload: {}, metadata: {} },
    ],
  });

  const pkg = await runExport(db, { taskId: "task-1" });
  assert.deepEqual(pkg.lineages.map((l) => l.outcomeId), ["out-1", "out-2"], "both task outcomes represented");

  const ids = pkg.auditRecords.map((r) => r.id);
  assert.equal(ids.filter((id) => id === "pe-shared").length, 1, "the shared event appears exactly once");
  assert.ok(ids.includes("canonical_outcome_observations:obs-1"));
  assert.ok(ids.includes("canonical_outcome_observations:obs-2"));
  // Deterministic chronological order across the merged sources.
  assert.deepEqual(ids, ["pe-shared", "canonical_outcome_observations:obs-1", "canonical_outcome_observations:obs-2"]);
  // Attribution is deterministic: sorted outcome ids mean out-1 wins the shared record.
  assert.match(pkg.auditRecords.find((r) => r.id === "pe-shared")?.associationExplanation ?? "", /canonical outcome out-1/);

  // ONE combined limit applied after the merge, not per outcome.
  const limited = await runExport(db, { taskId: "task-1", auditRecordLimit: 2 });
  assert.equal(limited.auditRecords.length, 2);
  assert.deepEqual(limited.auditRecords.map((r) => r.id), ["pe-shared", "canonical_outcome_observations:obs-1"]);
  assert.ok(limited.integrity.notes.some((n) => /reached the requested limit of 2/.test(n)));
});

test("P2-20 M: an unscoped package keeps project-scope semantics and unlinked association", async () => {
  const pkg = await runExport(secondChainDb());
  assert.deepEqual(pkg.lineages.map((l) => l.outcomeId), ["out-1", "out-b"]);
  const event = pkg.auditRecords.find((r) => r.id === "pe-a");
  assert.equal(event?.associationBasis, "unlinked");
  assert.match(event?.associationExplanation ?? "", /workspace and project scope alone/);
});

// ─── N. Value-based credential redaction (F1) ───────────────────────────────────────────

/**
 * A credential stored under a NEUTRAL key escaped both mechanisms: the key sweep saw an
 * innocuous name, and the shared value walker does not recognize a connection string.
 * P2-20 claims connection strings and provider credentials are never emitted.
 */
const NEUTRAL_KEY_CREDENTIALS = {
  postgresUrl: "postgresql://user:password@db/pmfreak",
  postgresShortScheme: "postgres://svc:s3cr3t@db.internal:5432/pmfreak",
  mysqlUrl: "mysql://root:toor@db.internal:3306/app",
  openAiKey: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
  githubToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  basicHeader: "Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==",
};

/** Values that carry no credential and must survive verbatim. */
const PRESERVED_ORDINARY_VALUES = {
  ordinaryUrl: "https://example.com/reports/cr-2026-08.pdf",
  ordinaryUrlWithAt: "https://example.com/threads/reply@2026",
  prose: "We migrated the postgres database and the sponsor signed off.",
  identifier: "pmfreak/internal-state-machine:v1",
  // A long word after "Basic" is prose, not an encoded credential.
  basicProse: "Basic characterization of the sponsor's scope concern.",
};

const credentialEvent = (over: Row = {}): Row => ({
  id: "pe-credentials", workspace_id: WS, project_id: PRJ, event_type: "PROVIDER_CALL_FAILED",
  event_category: "task", actor_id: "user-1", actor_type: "user",
  occurred_at: "2026-08-10T09:12:00Z", created_at: "2026-08-10T09:12:00Z",
  correlation_id: CORR, causation_id: null, raw_reference_table: "execution_tasks",
  raw_reference_id: "task-1",
  event_payload: {
    // Neutral key names throughout: nothing here is sensitive BY NAME.
    value: NEUTRAL_KEY_CREDENTIALS.postgresUrl,
    detail: NEUTRAL_KEY_CREDENTIALS.postgresShortScheme,
    nested: { deeper: { note: NEUTRAL_KEY_CREDENTIALS.mysqlUrl } },
    ...PRESERVED_ORDINARY_VALUES,
  },
  metadata: {
    note: NEUTRAL_KEY_CREDENTIALS.openAiKey,
    reference: NEUTRAL_KEY_CREDENTIALS.githubToken,
    header: NEUTRAL_KEY_CREDENTIALS.basicHeader,
  },
  ...over,
});

test("P2-20 N: a credential-bearing connection string under a neutral key is redacted", async () => {
  const pkg = await runExport(completeDb({ platform_events: [credentialEvent()] }), { outcomeId: "out-1" });
  const record = pkg.auditRecords.find((r) => r.id === "pe-credentials");
  assert.ok(record);

  assert.equal(record.payload.value, REDACTION_MARKER);
  assert.equal(record.payload.detail, REDACTION_MARKER);
  // Nested under a neutral key, several levels down.
  assert.deepEqual(record.payload.nested, { deeper: { note: REDACTION_MARKER } });

  // Bounded provider credential shapes claimed by REDACTED_CATEGORIES.
  assert.equal(record.metadata.note, REDACTION_MARKER);
  assert.equal(record.metadata.reference, REDACTION_MARKER);
  assert.equal(record.metadata.header, REDACTION_MARKER);

  const serialized = JSON.stringify(pkg);
  for (const credential of Object.values(NEUTRAL_KEY_CREDENTIALS)) {
    assert.equal(serialized.includes(credential), false, `${credential.slice(0, 16)}… must not be emitted`);
  }
});

test("P2-20 N: ordinary URLs and business prose survive value-based redaction", async () => {
  const pkg = await runExport(completeDb({ platform_events: [credentialEvent()] }), { outcomeId: "out-1" });
  const record = pkg.auditRecords.find((r) => r.id === "pe-credentials");
  assert.ok(record);

  assert.equal(record.payload.ordinaryUrl, PRESERVED_ORDINARY_VALUES.ordinaryUrl);
  // An '@' in the PATH is not userinfo and must not make an ordinary URL look secret.
  assert.equal(record.payload.ordinaryUrlWithAt, PRESERVED_ORDINARY_VALUES.ordinaryUrlWithAt);
  // Prose containing the word "postgres" is not a connection string.
  assert.equal(record.payload.prose, PRESERVED_ORDINARY_VALUES.prose);
  assert.equal(record.payload.identifier, PRESERVED_ORDINARY_VALUES.identifier);
  assert.equal(record.payload.basicProse, PRESERVED_ORDINARY_VALUES.basicProse);
});

test("P2-20 N: a credential embedded in a presentation surface is redacted, not the whole string", async () => {
  const pkg = await runExport(completeDb({
    canonical_task_outcomes: [outcome({
      expected_result: `CR approved, evidence pulled from ${NEUTRAL_KEY_CREDENTIALS.postgresUrl} by the sponsor`,
    })],
  }));
  const lineage = onlyLineage(pkg);
  assert.equal(lineage.expectedResult, "CR approved, evidence pulled from [redacted] by the sponsor");
  assert.ok(pkg.redaction.redactedTextSurfaces.includes("lineage.expectedResult"));
  assert.equal(JSON.stringify(pkg).includes(NEUTRAL_KEY_CREDENTIALS.postgresUrl), false);
});

// ─── O. Boundary-aware sensitive key matching (F3) ──────────────────────────────────────

test("P2-20 O: sensitive key names are still redacted", () => {
  const mustRedact = [
    "accessToken", "refresh_token", "api_key", "apiKey", "serviceRoleKey", "service_role_key",
    "authorization", "auth_header", "authHeader", "clientSecret", "client_secret",
    "connection_string", "connectionString", "providerError", "raw_error", "rawError",
    "password", "passphrase", "cookie", "privateKey", "private_key", "signing_key",
    "encryption_key", "access_key", "webhook_url", "hmac", "dsn", "database_url",
    "session", "stack", "stack_trace", "stackTrace", "error_stack", "provider_credentials",
    "service_role", "bearer", "sessionSecret", "session_key",
  ];
  for (const key of mustRedact) {
    assert.equal(isExportRedactedKey(key), true, `${key} must be redacted`);
  }
});

test("P2-20 O: legitimate audit keys are NOT redacted by substring overlap", () => {
  const mustSurvive = [
    // The three negative controls from the finding.
    "session_type", "stack_rank", "credentials_excluded",
    // Canonical identifiers that merely end in "key".
    "idempotency_key", "derivation_idempotency_key", "source_key", "rule_key",
    "normalizer_key", "provider_key", "partition_key",
    // Ordinary audit facts that merely overlap a sensitive fragment.
    "sessionType", "stackRank", "credentialsExcluded", "tokenizer_version",
    "error_code", "failure_reason_code", "observation_state", "content_digest",
    "correlation_id", "causation_id", "actor_user_id", "evidence_reference_ids",
  ];
  for (const key of mustSurvive) {
    assert.equal(isExportRedactedKey(key), false, `${key} must NOT be redacted`);
  }
});

test("P2-20 O: boundary-aware matching preserves structured audit evidence in a real export", async () => {
  const platformEvent = {
    id: "pe-keys", workspace_id: WS, project_id: PRJ, event_type: "TASK_SESSION_RECORDED",
    event_category: "task", actor_id: "user-1", actor_type: "user",
    occurred_at: "2026-08-10T09:15:00Z", created_at: "2026-08-10T09:15:00Z",
    correlation_id: CORR, causation_id: null, raw_reference_table: "execution_tasks",
    raw_reference_id: "task-1",
    event_payload: {
      session_type: "interactive_review",
      stack_rank: 3,
      credentials_excluded: true,
      idempotency_key: "idem-pe-keys",
      accessToken: SECRETS.bearer,
    },
    metadata: { provider_key: "pmfreak/internal-state-machine:v1" },
  };
  const pkg = await runExport(completeDb({ platform_events: [platformEvent] }), { outcomeId: "out-1" });
  const record = pkg.auditRecords.find((r) => r.id === "pe-keys");
  assert.ok(record);

  assert.equal(record.payload.session_type, "interactive_review");
  assert.equal(record.payload.stack_rank, 3);
  assert.equal(record.payload.credentials_excluded, true);
  assert.equal(record.payload.idempotency_key, "idem-pe-keys");
  assert.equal(record.metadata.provider_key, "pmfreak/internal-state-machine:v1");
  // Actual secret protection is unchanged.
  assert.equal(record.payload.accessToken, REDACTION_MARKER);
  assert.equal(pkg.redaction.redactedPayloadKeys.includes("session_type"), false);
  assert.equal(pkg.redaction.redactedPayloadKeys.includes("accessToken"), true);

  // The canonical allowlisted columns survive too.
  const lineage = onlyLineage(pkg);
  assert.equal(stepOf(lineage, "internal_execution").entityFields?.provider_key,
    "pmfreak/internal-state-machine:v1");
  assert.equal(stepOf(lineage, "internal_execution").entityFields?.idempotency_key, "idem-exec-1");
  assert.equal(stepOf(lineage, "source").entityFields?.source_key, "manual-demo:v1");
});

// ─── P. Deterministic latest observation state (F2) ─────────────────────────────────────

test("P2-20 P: observations tied on recordedAt produce a deterministic latestObservationState", async () => {
  // Same recorded_at, different states, reversed database arrival order.
  const tied = [
    observation({ id: "obs-1", observation_state: "achieved", summary: "achieved reading",
      observed_at: "2026-08-10T09:50:00Z", recorded_at: "2026-08-10T09:55:00Z" }),
    observation({ id: "obs-2", observation_state: "inconclusive", summary: "inconclusive reading",
      observed_at: "2026-08-10T09:50:00Z", recorded_at: "2026-08-10T09:55:00Z" }),
  ];

  const forward = await runExport(completeDb({ canonical_outcome_observations: tied }));
  const reversed = await runExport(completeDb({ canonical_outcome_observations: [...tied].reverse() }));

  // Byte-equivalent payload, not merely an equal field.
  assert.deepEqual(JSON.stringify(reversed), JSON.stringify(forward));

  // Documented tie-breaker: recordedAt DESC, then occurredAt DESC, then step id DESC.
  // Both rows tie on both timestamps, so obs-2 wins on id DESC.
  assert.equal(onlyLineage(forward).outcomeAssessment.latestObservationState, "inconclusive");
  assert.equal(onlyLineage(reversed).outcomeAssessment.latestObservationState, "inconclusive");
  assert.equal(onlyLineage(forward).outcomeAssessment.observationsCount, 2);
});

test("P2-20 P: a strictly later recordedAt wins regardless of arrival order or id", async () => {
  const rows = [
    observation({ id: "obs-z", observation_state: "partial",
      observed_at: "2026-08-10T09:40:00Z", recorded_at: "2026-08-10T09:41:00Z" }),
    observation({ id: "obs-a", observation_state: "achieved",
      observed_at: "2026-08-10T09:50:00Z", recorded_at: "2026-08-10T09:59:00Z" }),
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const lineage = onlyLineage(await runExport(completeDb({ canonical_outcome_observations: order })));
    assert.equal(lineage.outcomeAssessment.latestObservationState, "achieved");
  }
});

test("P2-20 P: no observation still reports a null latest state", async () => {
  const lineage = onlyLineage(await runExport(completeDb({ canonical_outcome_observations: [] })));
  assert.equal(lineage.outcomeAssessment.latestObservationState, null);
  assert.equal(lineage.outcomeAssessment.observationsCount, 0);
});

test("P2-20 P: the export does not reach into P2-10 for the latest observation state", () => {
  assert.doesNotMatch(canonicalExport, /projection\.latestObservationState/);
  assert.match(canonicalExport, /latestObservationStateOf\(observationSteps\)/);
});

// ─── Q. Correlation scope for nested lineage events (F4) ────────────────────────────────

test("P2-20 Q: a correlation-scoped export excludes nested events of an unrelated correlation", async () => {
  // task-b's lineage enters through shared UPSTREAM provenance carrying CORR (chain A's
  // raw_input/normalized_event/evidence are genuinely shared), while its OUTCOME carries
  // CORR_B. pe-b is a CORR_B event that raw-references task-b.
  const pkg = await runExport(secondChainDb(), { taskId: "task-b", correlationId: CORR });

  // The lineage legitimately stays: stored upstream provenance really does carry CORR.
  assert.deepEqual(pkg.lineages.map((l) => l.outcomeId), ["out-b"]);
  assert.equal(stepOf(pkg.lineages[0], "evidence").correlationId, CORR);
  assert.equal(stepOf(pkg.lineages[0], "outcome").correlationId, CORR_B);

  // The unrelated correlation-B event must NOT ride along inside it.
  assert.deepEqual(pkg.lineages[0].lineageEvents.map((e) => e.id), []);
  assert.equal(JSON.stringify(pkg).includes("B_EVENT"), false);

  // Top-level records stay empty: the verified intersection is empty.
  assert.deepEqual(pkg.auditRecords, []);

  // The narrowing is reported, not silent.
  assert.ok(pkg.integrity.notes.some((n) => /nested lineage event\(s\)/.test(n)));
});

test("P2-20 Q: a raw reference alone does not prove the requested correlation", async () => {
  // pe-ref raw-references out-1 directly but carries a third correlation of its own, and
  // out-1's stored correlation is CORR_OTHER while the upstream chain carries CORR.
  const CORR_OTHER = "66666666-6666-4666-8666-666666666666";
  const db = completeDb({
    canonical_task_outcomes: [outcome({ correlation_id: CORR_OTHER })],
    platform_events: [
      { id: "pe-ref", workspace_id: WS, project_id: PRJ, event_type: "OUTCOME_TOUCHED",
        event_category: "outcome", actor_id: "user-1", actor_type: "user",
        occurred_at: "2026-08-10T09:33:00Z", created_at: "2026-08-10T09:33:00Z",
        correlation_id: "77777777-7777-4777-8777-777777777777", causation_id: null,
        raw_reference_table: "canonical_task_outcomes", raw_reference_id: "out-1",
        event_payload: {}, metadata: {} },
    ],
  });

  // Requesting the OUTCOME's correlation keeps it: the referenced canonical row carries it.
  const matching = await runExport(db, { correlationId: CORR_OTHER });
  assert.deepEqual(matching.lineages[0].lineageEvents.map((e) => e.id), ["pe-ref"]);
  assert.equal(matching.lineages[0].lineageEvents[0].associationBasis, "direct_reference");

  // Requesting a correlation the referenced row does not carry drops it.
  const other = await runExport(db, { correlationId: CORR });
  assert.deepEqual(other.lineages.map((l) => l.outcomeId), ["out-1"]);
  assert.deepEqual(other.lineages[0].lineageEvents.map((e) => e.id), []);
});

test("P2-20 Q: without a correlationId nested lineage events keep current behavior", async () => {
  const events = [
    { id: "pe-outcome", workspace_id: WS, project_id: PRJ, event_type: "OUTCOME_RECORDED",
      event_category: "outcome", actor_id: "user-1", actor_type: "user",
      occurred_at: "2026-08-10T09:32:00Z", created_at: "2026-08-10T09:32:00Z",
      correlation_id: "other-corr", causation_id: null,
      raw_reference_table: "canonical_task_outcomes", raw_reference_id: "out-1",
      event_payload: {}, metadata: {} },
    { id: "pe-corr", workspace_id: WS, project_id: PRJ, event_type: "DECISION_RECORDED",
      event_category: "decision", actor_id: "user-1", actor_type: "user",
      occurred_at: "2026-08-10T08:01:00Z", created_at: "2026-08-10T08:01:00Z",
      correlation_id: CORR, causation_id: null, raw_reference_table: "operational_decision_records",
      raw_reference_id: "dec-1", event_payload: {}, metadata: {} },
  ];
  const lineage = onlyLineage(await runExport(completeDb({ platform_events: events })));
  assert.deepEqual(lineage.lineageEvents.map((e) => e.id).sort(), ["pe-corr", "pe-outcome"]);
});

// ─── R. Audit limit normalization (F5) ──────────────────────────────────────────────────

test("P2-20 R: an audit-record limit below 1 falls back to the default instead of flooring to 0", () => {
  assert.equal(DEFAULT_AUDIT_RECORD_LIMIT, 100);
  assert.equal(normalizeAuditRecordLimit(undefined), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(0), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(-1), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(0.5), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(0.999), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(Number.NaN), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(Number.POSITIVE_INFINITY), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(Number.NEGATIVE_INFINITY), DEFAULT_AUDIT_RECORD_LIMIT);
  assert.equal(normalizeAuditRecordLimit(1), 1);
  assert.equal(normalizeAuditRecordLimit(100), 100);
  // Documented behavior for a positive non-integer >= 1: floored, and never 0.
  assert.equal(normalizeAuditRecordLimit(1.9), 1);
  assert.equal(normalizeAuditRecordLimit(2.5), 2);
});

test("P2-20 R: a fractional limit below 1 no longer empties the exported audit trail", async () => {
  const emptied = await runExport(completeDb(), { outcomeId: "out-1", auditRecordLimit: 0.5 });
  assert.equal(emptied.requestedScope.auditRecordLimit, DEFAULT_AUDIT_RECORD_LIMIT);
  assert.ok(emptied.auditRecords.length > 0, "a sub-1 limit must not silently empty the trail");

  const one = await runExport(completeDb(), { outcomeId: "out-1", auditRecordLimit: 1 });
  assert.equal(one.requestedScope.auditRecordLimit, 1);
  assert.equal(one.auditRecords.length, 1);
});

test("P2-20 K: the canonical package states plainly which legacy models it did NOT merge", async () => {
  const pkg = await runExport(completeDb());
  assert.deepEqual(pkg.compatibility.legacyModelsNotMerged.slice(0, 3), [
    "project_decisions", "project_decision_evidence_links", "decision_outcomes",
  ]);
  assert.equal(pkg.compatibility.legacyCompatibilityEntryPoint, LEGACY_DECISION_AUDIT_COMPATIBILITY_FORMAT);
  assert.match(pkg.compatibility.canonicalSource, /operational-flow-service/);
  assert.ok(pkg.compatibility.notes.some((n) => /Legacy decision-governance models remain bounded/.test(n)));
});
