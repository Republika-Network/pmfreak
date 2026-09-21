import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ensureExpectedOutcome,
  getCompleteLineageProjection,
  reconstructAuditTrail,
  recordOutcomeObservation,
} from "../src/lib/operational-flow/operational-flow-service";
import type { CompleteLineageProjection } from "../src/lib/operational-flow/types";

const serviceCode = readFileSync("src/lib/operational-flow/operational-flow-service.ts", "utf8");
const apiRouteCode = readFileSync("src/app/api/operational-flow/route.ts", "utf8");
const typesCode = readFileSync("src/lib/operational-flow/types.ts", "utf8");

/**
 * Tables read by getCompleteLineageProjection that own workspace_id/project_id directly.
 * Verified against supabase/migrations — every one of these declares both columns.
 */
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

/**
 * Schema-truthful registry of columns runtime code may FILTER on (.eq/.in) for the
 * tables the lineage projection reads. Deliberately narrow: it covers filter columns
 * only, not every selectable column — this is a guard for the P2-10 queries, not a
 * general database emulator.
 *
 * decision_evidence_links intentionally has NO workspace_id/project_id. Its tenancy is
 * derived through operational_decision_records, mirroring the RLS policy
 * decision_evidence_links_scoped_select in
 * supabase/migrations/20260611000000_operational_evidence_decision_loop.sql.
 */
const FILTERABLE_COLUMNS: Record<string, readonly string[]> = {
  ...Object.fromEntries(DIRECT_TENANCY_TABLES.map((t) => [t, ["id", "workspace_id", "project_id"]])),
  decision_evidence_links: ["id", "decision_record_id", "evidence_item_id"],
  // reconstructAuditTrail additionally filters these. Both columns are declared in the
  // migrations: canonical_outcome_observations.correlation_id/outcome_id
  // (20260906000000_p2_09_outcome_observation_contract.sql) and
  // platform_events.correlation_id (20260616000000_platform_events_foundation.sql).
  canonical_outcome_observations: ["id", "workspace_id", "project_id", "correlation_id", "outcome_id"],
  platform_events: ["id", "workspace_id", "project_id", "correlation_id"],
};

/**
 * Mock Supabase client that fails loudly on an unknown filter column instead of
 * silently degrading to a JavaScript property lookup (which returns undefined and
 * quietly filters everything out). This approximates Postgres 42703 / undefined_column,
 * which is what the real database raises and what PostgREST surfaces as a query error.
 */
type FilterCall = { table: string; op: "eq" | "in"; col: string; values: unknown[] };

type MockRow = Record<string, unknown>;
type MockResult = { data: MockRow[]; error: null };

/**
 * Minimal PostgREST-shaped builder: only the surface the queries under test use.
 * `then` makes it awaitable — a callable `then` is all `await` requires at runtime.
 */
interface MockQueryBuilder {
  select: () => MockQueryBuilder;
  eq: (col: string, val: unknown) => MockQueryBuilder;
  in: (col: string, vals: unknown[]) => MockQueryBuilder;
  order: (col?: string, opts?: { ascending?: boolean }) => MockQueryBuilder;
  limit: (count?: number) => MockQueryBuilder;
  then: (resolve: (result: MockResult) => unknown) => unknown;
}

const createStrictMockClient = (mockDb: Record<string, unknown[]>, calls: FilterCall[] = []) =>
  ({
    from: (table: string) => {
      const allowed = FILTERABLE_COLUMNS[table];
      if (!allowed) throw new Error(`relation "public.${table}" does not exist`);
      let rows = [...(mockDb[table] ?? [])] as MockRow[];
      // ORDER BY / LIMIT columns are deliberately NOT validated against the registry: the
      // registry covers filter columns only, and order/limit are resolved at await time so
      // they follow SQL semantics (filter -> order -> limit) regardless of builder call order.
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
          calls.push({ table, op: "eq", col, values: [val] });
          rows = rows.filter((r) => r[col] === val);
          return queryBuilder;
        },
        in: (col: string, vals: unknown[]) => {
          assertColumn(col);
          calls.push({ table, op: "in", col, values: [...vals] });
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

test("P2-10: Type declarations define CompleteLineageProjection, LineageStepNode, LineageTransition, and AuditReconstructionItem", () => {
  assert.match(typesCode, /export type LineageStepKind\s*=/);
  for (const kind of [
    "source",
    "raw_input",
    "normalized_event",
    "evidence",
    "finding",
    "governance",
    "recommendation",
    "decision",
    "material_action",
    "task",
    "internal_execution",
    "outcome",
    "observation",
  ]) {
    assert.match(typesCode, new RegExp(`\\| "${kind}"`));
  }
  assert.match(typesCode, /export type LineageLinkRelationship\s*=/);
  for (const relationship of [
    "causation",
    "correlation_only",
    "direct_reference",
    "unlinked",
  ]) {
    assert.match(typesCode, new RegExp(`"${relationship}"`));
  }
  assert.match(typesCode, /export type LineageLinkStatus\s*=/);
  for (const status of [
    "intact",
    "missing",
    "disputed",
    "inconclusive",
    "degraded",
    "fixture",
  ]) {
    assert.match(typesCode, new RegExp(`"${status}"`));
  }
  assert.match(typesCode, /export type CompleteLineageProjection\s*=/);
  assert.match(typesCode, /hasCorrelationOnly:\s*boolean/);
  assert.match(typesCode, /gaps:\s*string\[\]/);
  assert.match(typesCode, /disputes:\s*string\[\]/);
  assert.match(typesCode, /export type AuditReconstructionItem\s*=/);
});

test("P2-10: Lineage reconstruction guarantees correlation is NEVER promoted to causation", () => {
  // Check the canonical relationship vocabulary and explicit semantic invariant.
  assert.match(typesCode, /"correlation_only"/);
  assert.match(typesCode, /"causation"/);
  assert.match(typesCode, /isCausal:\s*boolean/);
  assert.match(serviceCode, /Correlation does NOT imply causation/);
  assert.match(typesCode, /relationship:\s*LineageLinkRelationship/);
});

test("P2-10: Lineage projection does NOT swallow errors with catch-all fallbacks", () => {
  assert.doesNotMatch(serviceCode, /getCompleteLineageProjection[\s\S]*?\.catch\(\(\)\s*=>\s*\[\]\)/);
  assert.match(serviceCode, /const lineages = await getCompleteLineageProjection\(client, workspaceId, projectId\);/);
});

test("P2-10 contract: decision_evidence_links tenancy is DERIVED through operational_decision_records, never filtered directly", () => {
  // 1. Schema truth: the table owns no direct tenancy columns.
  const migration = readFileSync(
    "supabase/migrations/20260611000000_operational_evidence_decision_loop.sql",
    "utf8",
  );
  const ddl = migration.slice(
    migration.indexOf("create table if not exists public.decision_evidence_links"),
  );
  const createBlock = ddl.slice(0, ddl.indexOf("\n);"));
  assert.doesNotMatch(
    createBlock,
    /\bworkspace_id\b/,
    "decision_evidence_links must not declare workspace_id",
  );
  assert.doesNotMatch(
    createBlock,
    /\bproject_id\b/,
    "decision_evidence_links must not declare project_id",
  );

  // 2. Runtime code must never filter the table by a tenancy column it does not have.
  //    Regression guard for the 42703 defect in getCompleteLineageProjection.
  const walk = (dir: string, files: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, files);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full);
    }
    return files;
  };
  // Match .from("decision_evidence_links") up to the next .from( call, then look for a
  // tenancy filter inside that query chain.
  const chainRe = /\.from\(["']decision_evidence_links["']\)(?:(?!\.from\()[\s\S])*/g;
  const offenders: string[] = [];
  for (const file of walk("src")) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(chainRe)) {
      if (/\.(?:eq|in|neq|filter)\(\s*["'](?:workspace_id|project_id)["']/.test(match[0])) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `decision_evidence_links must not be filtered by workspace_id/project_id — it has neither. Scope it through operational_decision_records instead. Offending files: ${offenders.join(", ")}`,
  );

  // 3. The lineage projection uses the canonical derived pattern.
  assert.match(
    serviceCode,
    /\.from\("decision_evidence_links"\)\.select\("\*"\)\.in\("decision_record_id", decisionIds\)/,
    "getCompleteLineageProjection must load evidence links by decision_record_id",
  );
});

test("P2-10 tenancy: evidence links are scoped to the caller's decisions only, never another workspace's", async () => {
  const mockDb: Record<string, unknown[]> = {
    operational_decision_records: [
      { id: "dec-own", workspace_id: "ws-own", project_id: "proj-own" },
      { id: "dec-foreign", workspace_id: "ws-foreign", project_id: "proj-foreign" },
    ],
    decision_evidence_links: [
      { decision_record_id: "dec-own", evidence_item_id: "ev-own" },
      { decision_record_id: "dec-foreign", evidence_item_id: "ev-foreign" },
    ],
  };

  const calls: FilterCall[] = [];
  const client = createStrictMockClient(mockDb, calls);
  await getCompleteLineageProjection(client, "ws-own", "proj-own");

  const linkCalls = calls.filter((c) => c.table === "decision_evidence_links");
  assert.equal(linkCalls.length, 1, "evidence links must be loaded in exactly one scoped query");
  assert.equal(linkCalls[0].op, "in");
  assert.equal(linkCalls[0].col, "decision_record_id");
  // The foreign workspace's decision must never enter the scoping set.
  assert.deepEqual(linkCalls[0].values, ["dec-own"]);

  // The parent decision query must itself be scoped by BOTH tenancy columns.
  const decisionCols = calls
    .filter((c) => c.table === "operational_decision_records")
    .map((c) => c.col);
  assert.ok(decisionCols.includes("workspace_id"));
  assert.ok(decisionCols.includes("project_id"));
});

test("P2-10: Mocked complete lineage graph correctly traces Evidence → Finding → Recommendation → Decision → Action → Task → Observation", async () => {
  const workspaceId = "ws-p210-001";
  const projectId = "proj-p210-001";
  const outcomeId = "out-001";
  const taskId = "task-001";
  const actionId = "act-001";
  const decisionId = "dec-001";
  const recId = "rec-001";
  const signalId = "sig-001";
  const evidenceId = "ev-001";
  const normEventId = "norm-001";
  const rawInputId = "raw-001";
  const sourceId = "src-001";
  const obsId = "obs-001";
  const obsEvidenceId = "ev-obs-001";

  const mockDb: Record<string, unknown[]> = {
    canonical_task_outcomes: [
      {
        id: outcomeId,
        workspace_id: workspaceId,
        project_id: projectId,
        task_id: taskId,
        source_action_id: actionId,
        state: "achieved",
        expected_result: "Project plan approved by sponsor",
        success_criteria: ["signature_received", "budget_approved"],
        correlation_id: "corr-100",
        causation_id: taskId,
        fixture_label: null,
        created_by: "user-1",
        created_at: "2026-08-13T10:00:00Z",
      },
    ],
    canonical_outcome_observations: [
      {
        id: obsId,
        workspace_id: workspaceId,
        project_id: projectId,
        outcome_id: outcomeId,
        task_id: taskId,
        observation_state: "achieved",
        summary: "Verified signature on budget allocation document.",
        evidence_reference_ids: [obsEvidenceId],
        confidence_score: 0.98,
        missing_data_state: "COMPLETE",
        observed_by: "user-1",
        observed_at: "2026-08-13T12:00:00Z",
        evaluated_at: "2026-08-13T12:00:00Z",
        recorded_at: "2026-08-13T12:00:00Z",
        correlation_id: "corr-100",
        causation_id: outcomeId,
        fixture_label: null,
      },
    ],
    execution_tasks: [
      {
        id: taskId,
        workspace_id: workspaceId,
        project_id: projectId,
        source_action_id: actionId,
        title: "Obtain sponsor sign-off",
        status: "completed",
        priority: "high",
        correlation_id: "corr-100",
        causation_id: actionId,
        created_at: "2026-08-13T09:00:00Z",
      },
    ],
    internal_task_executions: [
      {
        id: "exec-001",
        workspace_id: workspaceId,
        project_id: projectId,
        task_id: taskId,
        status: "completed",
        attempt_count: 1,
        provider_key: "internal:state_machine",
        idempotency_key: "idem-exec-001",
        correlation_id: "corr-100",
        causation_id: taskId,
        started_at: "2026-08-13T09:01:00Z",
        completed_at: "2026-08-13T09:05:00Z",
      },
    ],
    material_action_proposals: [
      {
        id: actionId,
        workspace_id: workspaceId,
        project_id: projectId,
        source_decision_id: decisionId,
        action_class: "ordinary_business_write",
        materiality: "material",
        proposal: { decisionReferenceId: decisionId },
        proposal_digest: "digest-act-001",
        correlation_id: "corr-100",
        causation_id: decisionId,
        persisted_at: "2026-08-13T08:30:00Z",
      },
    ],
    material_action_governance_evaluations: [
      {
        id: "eval-001",
        workspace_id: workspaceId,
        project_id: projectId,
        action_id: actionId,
        governance_state: "authorized",
        recorded_at: "2026-08-13T08:31:00Z",
      },
    ],
    operational_decision_records: [
      {
        id: decisionId,
        workspace_id: workspaceId,
        project_id: projectId,
        recommendation_id: recId,
        governance_event_id: "gov-001",
        decision: "Proceed with sign-off request",
        decision_status: "accepted",
        rationale: "All risk criteria cleared",
        decided_by: "user-1",
        created_at: "2026-08-13T08:00:00Z",
      },
    ],
    // Schema-truthful: decision_evidence_links owns NO workspace_id/project_id.
    // Tenancy is derived through operational_decision_records.
    decision_evidence_links: [
      {
        decision_record_id: decisionId,
        evidence_item_id: evidenceId,
      },
    ],
    recommended_actions: [
      {
        id: recId,
        workspace_id: workspaceId,
        project_id: projectId,
        // Schema-truthful: the Finding reference `recommended_actions` actually owns.
        source_signal_id: signalId,
        governance_event_id: "gov-001",
        title: "Request sign-off",
        proposed_action: "Send sign-off packet",
        urgency: "medium",
        status: "accepted",
        created_at: "2026-08-13T07:30:00Z",
      },
    ],
    governance_events: [
      {
        id: "gov-001",
        workspace_id: workspaceId,
        project_id: projectId,
        // `governance_events` owns no signal column; it relates by entity type/id.
        related_entity_type: "operational_signal",
        related_entity_id: signalId,
        rule_key: "rule:sponsor_signoff_req",
        governance_status: "compliant",
        authority_required: "pm_lead",
        created_at: "2026-08-13T07:20:00Z",
      },
    ],
    operational_signals: [
      {
        id: signalId,
        workspace_id: workspaceId,
        project_id: projectId,
        evidence_item_id: evidenceId,
        signal_type: "readiness_clearance",
        severity: "low",
        // operational_signals.confidence_score is the 0-100 persisted scale.
        confidence_score: 95,
        summary: "Readiness criteria satisfied",
        created_at: "2026-08-13T07:10:00Z",
      },
    ],
    evidence_items: [
      {
        id: evidenceId,
        workspace_id: workspaceId,
        project_id: projectId,
        normalized_event_id: normEventId,
        classification: "DECISION_CONTEXT",
        assertion_type: "FACT",
        confidence_score: 0.95,
        missing_data_state: "COMPLETE",
        freshness_state: "CURRENT",
        fixture_state: "LIVE",
        degraded_reason: null,
        created_by: "user-1",
        evaluated_at: "2026-08-13T07:05:00Z",
        created_at: "2026-08-13T07:05:00Z",
      },
      {
        id: obsEvidenceId,
        workspace_id: workspaceId,
        project_id: projectId,
        normalized_event_id: "norm-obs-001",
        classification: "DELIVERY",
        assertion_type: "FACT",
        confidence_score: 0.98,
        missing_data_state: "COMPLETE",
        freshness_state: "CURRENT",
        fixture_state: "LIVE",
        degraded_reason: null,
        created_by: "user-1",
        evaluated_at: "2026-08-13T11:55:00Z",
        created_at: "2026-08-13T11:55:00Z",
      },
    ],
    operational_normalized_events: [
      {
        id: normEventId,
        workspace_id: workspaceId,
        project_id: projectId,
        raw_input_id: rawInputId,
        source_id: sourceId,
        event_type: "SPONSOR_PACKET_VALIDATED",
        schema_version: 1,
        event_digest: "digest-norm-001",
        correlation_id: "corr-100",
        causation_id: rawInputId,
        occurred_at: "2026-08-13T07:00:00Z",
        recorded_at: "2026-08-13T07:01:00Z",
        actor_user_id: "user-1",
      },
    ],
    operational_raw_inputs: [
      {
        id: rawInputId,
        workspace_id: workspaceId,
        project_id: projectId,
        source_id: sourceId,
        content_digest: "digest-raw-001",
        status: "intact",
        correlation_id: "corr-100",
        causation_id: null,
        occurred_at: "2026-08-13T06:55:00Z",
        captured_at: "2026-08-13T06:56:00Z",
        actor_user_id: "user-1",
      },
    ],
    operational_sources: [
      {
        id: sourceId,
        workspace_id: workspaceId,
        project_id: projectId,
        display_name: "Sponsor Document Ingestion",
        source_key: "src-sponsor-v1",
        source_kind: "api_webhook",
        status: "active",
        is_fixture: false,
        fixture_label: null,
        created_by: "user-1",
        created_at: "2026-08-13T06:00:00Z",
      },
    ],
    platform_events: [
      {
        id: "evt-001",
        workspace_id: workspaceId,
        project_id: projectId,
        event_type: "OUTCOME_OBSERVED",
        event_category: "operational_assurance",
        actor_id: "user-1",
        actor_type: "user",
        correlation_id: "corr-100",
        causation_id: outcomeId,
        raw_reference_table: "canonical_task_outcomes",
        raw_reference_id: outcomeId,
        event_payload: { outcomeId, state: "achieved" },
        metadata: {},
        occurred_at: "2026-08-13T12:00:00Z",
        created_at: "2026-08-13T12:00:00Z",
      },
    ],
  };

  const client = createStrictMockClient(mockDb);
  const projections = await getCompleteLineageProjection(client, workspaceId, projectId);

  assert.equal(projections.length, 1);
  const proj = projections[0];

  assert.equal(proj.outcomeId, outcomeId);
  assert.equal(proj.taskId, taskId);
  assert.equal(proj.outcomeState, "achieved");
  assert.equal(proj.lineageStatus, "complete");
  assert.equal(proj.gaps.length, 0);
  assert.equal(proj.disputes.length, 0);

  // Check step nodes
  const kinds = proj.steps.map((s) => s.kind);
  assert.ok(kinds.includes("source"));
  assert.ok(kinds.includes("raw_input"));
  assert.ok(kinds.includes("normalized_event"));
  assert.ok(kinds.includes("evidence"));
  assert.ok(kinds.includes("finding"));
  assert.ok(kinds.includes("recommendation"));
  assert.ok(kinds.includes("decision"));
  assert.ok(kinds.includes("material_action"));
  assert.ok(kinds.includes("task"));
  assert.ok(kinds.includes("internal_execution"));
  assert.ok(kinds.includes("outcome"));
  assert.ok(kinds.includes("observation"));

  // Check causal transitions
  const taskToOutcome = proj.transitions.find((t) => t.fromKind === "task" && t.toKind === "internal_execution");
  assert.ok(taskToOutcome);
  assert.equal(taskToOutcome.isCausal, true);
  assert.equal(taskToOutcome.relationship, "causation");

  // Check audit events attached
  assert.equal(proj.auditEvents.length, 1);
  assert.equal(proj.auditEvents[0].event_type, "OUTCOME_OBSERVED");
});

test("P2-10: Lineage projection detects gaps honestly when intermediate steps are missing", async () => {
  const workspaceId = "ws-p210-gap";
  const projectId = "proj-p210-gap";
  const outcomeId = "out-gap-001";
  const taskId = "task-gap-001";

  // Task and Outcome exist, but NO Governed Action, Decision, or Observations exist
  const mockDb: Record<string, unknown[]> = {
    canonical_task_outcomes: [
      {
        id: outcomeId,
        workspace_id: workspaceId,
        project_id: projectId,
        task_id: taskId,
        source_action_id: null,
        state: "expected",
        expected_result: "Direct task expected result",
        success_criteria: [],
        correlation_id: "corr-gap-100",
        causation_id: null,
        fixture_label: null,
        created_by: "user-1",
        created_at: "2026-08-13T10:00:00Z",
      },
    ],
    canonical_outcome_observations: [],
    execution_tasks: [
      {
        id: taskId,
        workspace_id: workspaceId,
        project_id: projectId,
        source_action_id: null,
        title: "Direct manual task",
        status: "completed",
        priority: "medium",
        correlation_id: "corr-gap-100",
        causation_id: null,
        created_at: "2026-08-13T09:00:00Z",
      },
    ],
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
  };

  const client = createStrictMockClient(mockDb);
  const projections = await getCompleteLineageProjection(client, workspaceId, projectId);

  assert.equal(projections.length, 1);
  const proj = projections[0];

  assert.equal(proj.lineageStatus, "incomplete");
  assert.ok(proj.gaps.length > 0);

  // Missing nodes must be explicitly marked missing
  const actionNode = proj.steps.find((s) => s.kind === "material_action");
  assert.equal(actionNode?.status, "missing");
  assert.equal(actionNode?.id, null);
  assert.ok(actionNode?.gapReason);

  const obsNode = proj.steps.find((s) => s.kind === "observation");
  assert.equal(obsNode?.status, "missing");
  assert.equal(obsNode?.id, null);
  assert.ok(obsNode?.gapReason?.includes("Awaiting authorized"));

  // Task completed does NOT mean achieved
  assert.equal(proj.outcomeState, "expected");
});

test("P2-10: Lineage projection detects disputed and inconclusive states honestly", async () => {
  const workspaceId = "ws-p210-disp";
  const projectId = "proj-p210-disp";
  const outcomeId = "out-disp-001";
  const taskId = "task-disp-001";
  const obsId = "obs-disp-001";

  const mockDb: Record<string, unknown[]> = {
    canonical_task_outcomes: [
      {
        id: outcomeId,
        workspace_id: workspaceId,
        project_id: projectId,
        task_id: taskId,
        source_action_id: null,
        state: "disputed",
        expected_result: "Disputed metric target",
        success_criteria: [],
        correlation_id: "corr-disp-100",
        causation_id: null,
        fixture_label: null,
        created_by: "user-1",
        created_at: "2026-08-13T10:00:00Z",
      },
    ],
    canonical_outcome_observations: [
      {
        id: obsId,
        workspace_id: workspaceId,
        project_id: projectId,
        outcome_id: outcomeId,
        task_id: taskId,
        observation_state: "disputed",
        summary: "Contradictory telemetry reported by external observer.",
        evidence_reference_ids: [],
        confidence_score: 0.5,
        missing_data_state: "PARTIAL",
        observed_by: "user-1",
        observed_at: "2026-08-13T12:00:00Z",
        evaluated_at: "2026-08-13T12:00:00Z",
        recorded_at: "2026-08-13T12:00:00Z",
        correlation_id: "corr-disp-100",
        causation_id: null,
        fixture_label: null,
      },
    ],
    execution_tasks: [
      {
        id: taskId,
        workspace_id: workspaceId,
        project_id: projectId,
        source_action_id: null,
        title: "Disputed task",
        status: "completed",
        priority: "medium",
        correlation_id: "corr-disp-100",
        causation_id: null,
        created_at: "2026-08-13T09:00:00Z",
      },
    ],
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
  };

  const client = createStrictMockClient(mockDb);
  const projections = await getCompleteLineageProjection(client, workspaceId, projectId);

  assert.equal(projections.length, 1);
  const proj = projections[0];

  assert.equal(proj.lineageStatus, "disputed");
  assert.ok(proj.disputes.length > 0);
  assert.ok(proj.disputes.some((d) => d.includes("disputed state")));
});

test("P2-10: Audit trail reconstruction preserves occurredAt vs recordedAt and distinguishes causation from correlation", async () => {
  const workspaceId = "ws-p210-audit";
  const projectId = "proj-p210-audit";

  const mockEvents = [
    {
      id: "evt-c-1",
      workspace_id: workspaceId,
      project_id: projectId,
      event_type: "MATERIAL_ACTION_DISPATCHED",
      event_category: "operational_flow",
      actor_id: "user-1",
      actor_type: "user",
      occurred_at: "2026-08-13T10:00:00Z",
      created_at: "2026-08-13T10:00:01Z",
      correlation_id: "corr-audit-1",
      causation_id: "dec-001",
      raw_reference_table: "material_action_proposals",
      raw_reference_id: "act-001",
      event_payload: { actionId: "act-001" },
      metadata: {},
    },
    {
      id: "evt-c-2",
      workspace_id: workspaceId,
      project_id: projectId,
      event_type: "SIGNAL_DETECTED",
      event_category: "operational_flow",
      actor_id: "system-1",
      actor_type: "agent",
      occurred_at: "2026-08-13T09:00:00Z",
      created_at: "2026-08-13T09:00:02Z",
      correlation_id: "corr-audit-1",
      causation_id: null,
      raw_reference_table: "operational_signals",
      raw_reference_id: "sig-001",
      event_payload: { signalType: "risk" },
      metadata: {},
    },
  ];

  const client = createStrictMockClient({
    platform_events: mockEvents,
    canonical_outcome_observations: [],
  }) as unknown as Parameters<typeof reconstructAuditTrail>[0];

  const trail = await reconstructAuditTrail(client, workspaceId, projectId);
  assert.equal(trail.length, 2);

  // Items are addressed by id, never by array position: the trail is chronologically merged
  // across sources, so position is a property of occurredAt, not of the source row order.
  const causal = trail.find((item) => item.id === "evt-c-1");
  const correlatedOnly = trail.find((item) => item.id === "evt-c-2");
  assert.ok(causal);
  assert.ok(correlatedOnly);

  // Explicit causation_id
  assert.equal(causal.relationship, "causation");
  assert.equal(causal.occurredAt, "2026-08-13T10:00:00Z");
  assert.equal(causal.recordedAt, "2026-08-13T10:00:01Z");

  // correlation_id only
  assert.equal(correlatedOnly.relationship, "correlation_only");

  // Oldest-first ordering across the merged trail.
  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-c-2", "evt-c-1"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-10 correctness repairs: T8 (evidence provenance), T3 (evaluation determinism),
// T4 (governance-state integrity), T10 (multi-link evidence), T7 (audit reconstruction).
// ─────────────────────────────────────────────────────────────────────────────

const WS = "ws-p210-repair";
const PRJ = "proj-p210-repair";

const repairDb = (parts: Record<string, unknown[]>): Record<string, unknown[]> => ({
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

type Row = Record<string, unknown>;

const repairOutcome = (over: Row = {}): Row => ({
  id: "out-r1",
  workspace_id: WS,
  project_id: PRJ,
  task_id: "task-r1",
  source_action_id: "act-r1",
  state: "expected",
  expected_result: "Repair outcome",
  success_criteria: [],
  correlation_id: "corr-r1",
  causation_id: null,
  fixture_label: null,
  created_by: "user-r1",
  created_at: "2026-08-13T10:00:00Z",
  ...over,
});

const repairAction = (over: Row = {}): Row => ({
  id: "act-r1",
  workspace_id: WS,
  project_id: PRJ,
  source_decision_id: "dec-r1",
  action_class: "ordinary_business_write",
  materiality: "material",
  proposal: {},
  proposal_digest: "digest-act-r1",
  correlation_id: "corr-r1",
  causation_id: "dec-r1",
  persisted_at: "2026-08-13T08:30:00Z",
  ...over,
});

const repairEvaluation = (over: Row = {}): Row => ({
  id: "eval-r1",
  workspace_id: WS,
  project_id: PRJ,
  action_id: "act-r1",
  governance_state: "authorized",
  evaluated_at: "2026-08-13T08:20:00Z",
  recorded_at: "2026-08-13T08:21:00Z",
  ...over,
});

const repairTask = (over: Row = {}): Row => ({
  id: "task-r1",
  workspace_id: WS,
  project_id: PRJ,
  source_action_id: "act-r1",
  title: "Repair task",
  status: "completed",
  priority: "high",
  correlation_id: "corr-r1",
  causation_id: "act-r1",
  created_at: "2026-08-13T09:00:00Z",
  ...over,
});

const repairExecution = (over: Row = {}): Row => ({
  id: "exec-r1",
  workspace_id: WS,
  project_id: PRJ,
  task_id: "task-r1",
  governance_evaluation_id: "eval-r1",
  status: "completed",
  attempt_count: 1,
  provider_key: "pmfreak/internal-state-machine:v1",
  idempotency_key: "idem-r1",
  correlation_id: "corr-r1",
  causation_id: "task-r1",
  started_at: "2026-08-13T09:01:00Z",
  completed_at: "2026-08-13T09:05:00Z",
  ...over,
});

const repairDecision = (over: Row = {}): Row => ({
  id: "dec-r1",
  workspace_id: WS,
  project_id: PRJ,
  recommendation_id: null,
  governance_event_id: null,
  decision: "Proceed",
  decision_status: "accepted",
  rationale: "Criteria cleared",
  decided_by: "user-r1",
  created_at: "2026-08-13T08:00:00Z",
  ...over,
});

const repairEvidence = (over: Row = {}): Row => ({
  id: "ev-r1",
  workspace_id: WS,
  project_id: PRJ,
  normalized_event_id: "norm-r1",
  classification: "DECISION_CONTEXT",
  assertion_type: "FACT",
  confidence_score: 0.9,
  missing_data_state: "COMPLETE",
  freshness_state: "CURRENT",
  fixture_state: "LIVE",
  degraded_reason: null,
  created_by: "user-r1",
  evaluated_at: "2026-08-13T07:05:00Z",
  created_at: "2026-08-13T07:05:00Z",
  correlation_id: null,
  causation_id: null,
  ...over,
});

const repairLink = (evidenceItemId: string, createdAt: string, over: Row = {}): Row => ({
  id: `link-${evidenceItemId}`,
  decision_record_id: "dec-r1",
  evidence_item_id: evidenceItemId,
  link_reason: "supports_decision",
  evidence_hash_at_decision: "a".repeat(64),
  evidence_version_at_decision: 1,
  evidence_title_snapshot: evidenceItemId,
  created_at: createdAt,
  ...over,
});

const runLineage = async (db: Record<string, unknown[]>): Promise<CompleteLineageProjection> => {
  const projections = await getCompleteLineageProjection(createStrictMockClient(db), WS, PRJ);
  assert.equal(projections.length, 1, "fixture must produce exactly one lineage projection");
  return projections[0];
};

const stepOf = (proj: CompleteLineageProjection, kind: string) => {
  const step = proj.steps.find((s) => s.kind === kind);
  assert.ok(step, `expected a ${kind} step`);
  return step;
};

const selectedEvaluationId = (proj: CompleteLineageProjection) => {
  const entity = stepOf(proj, "material_action").entity as { evaluation?: { id?: string } } | null;
  return entity?.evaluation?.id ?? null;
};

// ─── T8: evidence provenance ─────────────────────────────────────────────────

test("P2-10 T8: evidence step carries the stored correlation_id and causation_id verbatim", async () => {
  const proj = await runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: [repairEvaluation()],
      operational_decision_records: [repairDecision({ manual_evidence_item_id: "ev-r1" })],
      evidence_items: [repairEvidence({ correlation_id: "corr-ev-stored", causation_id: "cause-ev-stored" })],
    }),
  );

  const evidence = stepOf(proj, "evidence");
  assert.equal(evidence.id, "ev-r1");
  assert.equal(evidence.correlationId, "corr-ev-stored");
  assert.equal(evidence.causationId, "cause-ev-stored");
});

test("P2-10 T8: correlation-only evidence keeps a null causation and never infers it from normalized_event_id", async () => {
  const proj = await runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: [repairEvaluation()],
      operational_decision_records: [repairDecision({ manual_evidence_item_id: "ev-r1" })],
      evidence_items: [
        repairEvidence({ correlation_id: "corr-ev-stored", causation_id: null, normalized_event_id: "norm-r1" }),
      ],
    }),
  );

  const evidence = stepOf(proj, "evidence");
  assert.equal(evidence.correlationId, "corr-ev-stored");
  assert.equal(evidence.causationId, null);
  assert.notEqual(evidence.causationId, "norm-r1", "normalized_event_id must never become a causal claim");
});

// ─── T3: governance evaluation determinism ───────────────────────────────────

const twoEvaluations = [
  repairEvaluation({
    id: "eval-old",
    governance_state: "authorized",
    evaluated_at: "2026-08-13T08:00:00Z",
    recorded_at: "2026-08-13T08:01:00Z",
  }),
  repairEvaluation({
    id: "eval-new",
    governance_state: "revoked",
    evaluated_at: "2026-08-13T09:00:00Z",
    recorded_at: "2026-08-13T09:01:00Z",
  }),
];

test("P2-10 T3: evaluation selection is independent of database row order", async () => {
  const build = (evaluations: unknown[]) =>
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      execution_tasks: [repairTask()],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: evaluations,
    });

  const forward = await runLineage(build([...twoEvaluations]));
  const reversed = await runLineage(build([...twoEvaluations].reverse()));

  assert.equal(selectedEvaluationId(forward), "eval-new");
  assert.equal(selectedEvaluationId(reversed), "eval-new");
  assert.equal(stepOf(forward, "material_action").status, stepOf(reversed, "material_action").status);
});

test("P2-10 T3: an execution-linked evaluation wins over a newer evaluation for the same action", async () => {
  const proj = await runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      execution_tasks: [repairTask()],
      // The execution was authorized against eval-old; eval-new is newer but was never executed.
      internal_task_executions: [repairExecution({ governance_evaluation_id: "eval-old" })],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: [...twoEvaluations].reverse(),
    }),
  );

  assert.equal(selectedEvaluationId(proj), "eval-old");
  assert.equal(stepOf(proj, "material_action").status, "intact", "authorized history must not be rewritten by a newer revocation");
});

test("P2-10 T3: without an execution-linked evaluation, the deterministic latest evaluation is used", async () => {
  const proj = await runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      execution_tasks: [repairTask()],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: [...twoEvaluations],
    }),
  );

  assert.equal(selectedEvaluationId(proj), "eval-new");
  assert.equal(stepOf(proj, "material_action").status, "disputed");
});

test("P2-10 T3: an execution referencing an absent evaluation produces an explicit gap and NO substitution", async () => {
  const proj = await runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      execution_tasks: [repairTask()],
      internal_task_executions: [repairExecution({ governance_evaluation_id: "eval-absent" })],
      material_action_proposals: [repairAction()],
      // A perfectly good evaluation exists for the action; it must NOT be substituted.
      material_action_governance_evaluations: [repairEvaluation({ id: "eval-other" })],
    }),
  );

  assert.equal(selectedEvaluationId(proj), null, "no evaluation may be substituted for the absent referenced one");
  assert.equal(stepOf(proj, "material_action").status, "degraded");
  assert.ok(
    proj.gaps.some((gap) => gap.includes("eval-absent") && gap.includes("absent from project scope")),
    `expected an explicit missing-evaluation gap, got: ${JSON.stringify(proj.gaps)}`,
  );
  // The stored execution status is historical fact and is preserved.
  assert.equal(stepOf(proj, "internal_execution").status, "intact");
});

// ─── T4: governance-state integrity classification ───────────────────────────

const GOVERNANCE_STATE_EXPECTATIONS = [
  ["authorized", "intact"],
  ["not_required", "intact"],
  ["denied", "disputed"],
  ["revoked", "disputed"],
  ["requires_review", "degraded"],
  ["requires_approval", "degraded"],
  ["expired", "degraded"],
  ["stale", "degraded"],
  ["unavailable", "degraded"],
  ["degraded", "degraded"],
] as const;

test("P2-10 T4: the state table covers exactly the governance_state check constraint", () => {
  const migration = readFileSync(
    "supabase/migrations/20260903000000_p2_06_governed_decision_to_action.sql",
    "utf8",
  );
  const match = migration.match(/governance_state text not null check \(governance_state in \(([^)]*)\)\)/);
  assert.ok(match, "governance_state check constraint not found in the migration");
  const declared = match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, "")).sort();
  const covered = GOVERNANCE_STATE_EXPECTATIONS.map(([state]) => state).sort();
  assert.deepEqual(covered, declared, "every declared governance_state must have an explicit integrity classification");
});

const governanceStateProjection = (state: string | null) =>
  runLineage(
    repairDb({
      canonical_task_outcomes: [repairOutcome()],
      execution_tasks: [repairTask()],
      material_action_proposals: [repairAction()],
      material_action_governance_evaluations: state === null ? [] : [repairEvaluation({ governance_state: state })],
    }),
  );

for (const [state, expected] of GOVERNANCE_STATE_EXPECTATIONS) {
  test(`P2-10 T4: governance_state "${state}" classifies the governed action as ${expected}`, async () => {
    const proj = await governanceStateProjection(state);
    assert.equal(stepOf(proj, "material_action").status, expected);
  });
}

test("P2-10 T4: an absent governance evaluation is degraded, never intact, and adds an explicit gap", async () => {
  const proj = await governanceStateProjection(null);
  const action = stepOf(proj, "material_action");
  assert.equal(action.status, "degraded");
  assert.notEqual(action.status, "intact");
  assert.match(action.title, /no governance evaluation/);
  assert.ok(proj.gaps.some((gap) => gap.includes("no governance evaluation recorded")));
});

test("P2-10 T4: an unrecognized future governance_state fails safe to degraded", async () => {
  const proj = await governanceStateProjection("quantum_pending_review");
  const action = stepOf(proj, "material_action");
  assert.equal(action.status, "degraded");
  assert.notEqual(action.status, "intact");
});

// ─── T10: multiple decision evidence links ───────────────────────────────────

const threeLinkDb = (links: unknown[]) =>
  repairDb({
    canonical_task_outcomes: [repairOutcome()],
    material_action_proposals: [repairAction()],
    material_action_governance_evaluations: [repairEvaluation()],
    operational_decision_records: [repairDecision()],
    decision_evidence_links: links,
    evidence_items: [
      repairEvidence({ id: "ev-a" }),
      repairEvidence({ id: "ev-b" }),
      repairEvidence({ id: "ev-c" }),
    ],
  });

const THREE_LINKS = [
  repairLink("ev-b", "2026-08-13T07:30:00Z"),
  repairLink("ev-a", "2026-08-13T07:10:00Z"),
  repairLink("ev-c", "2026-08-13T07:50:00Z"),
];

const omissionGap = (proj: CompleteLineageProjection) =>
  proj.gaps.find((gap) => gap.includes("not represented"));

test("P2-10 T10: three links render one deterministic primary chain and name the two omitted evidence ids", async () => {
  const proj = await runLineage(threeLinkDb([...THREE_LINKS]));

  // Earliest-recorded link is primary: ev-a at 07:10.
  assert.equal(stepOf(proj, "evidence").id, "ev-a");

  const gap = omissionGap(proj);
  assert.ok(gap, `expected an omission gap, got: ${JSON.stringify(proj.gaps)}`);
  assert.match(gap, /decision has 3 linked evidence item\(s\)/);
  assert.match(gap, /2 linked evidence item\(s\) not represented: ev-b, ev-c\./);
  // The primary is named as the rendered chain; it must never appear in the omitted list.
  const omittedSegment = gap.split("not represented: ")[1];
  assert.ok(omittedSegment);
  assert.ok(!omittedSegment.includes("ev-a"), "the represented primary must not be reported as omitted");
});

test("P2-10 T10: the primary link and the omission gap are invariant under row order", async () => {
  const forward = await runLineage(threeLinkDb([...THREE_LINKS]));
  const reversed = await runLineage(threeLinkDb([...THREE_LINKS].reverse()));

  assert.equal(stepOf(forward, "evidence").id, stepOf(reversed, "evidence").id);
  assert.equal(omissionGap(forward), omissionGap(reversed));
});

test("P2-10 T10: a single link that IS the primary produces no omission gap", async () => {
  const proj = await runLineage(threeLinkDb([repairLink("ev-a", "2026-08-13T07:10:00Z")]));

  assert.equal(stepOf(proj, "evidence").id, "ev-a");
  assert.equal(omissionGap(proj), undefined);
});

test("P2-10 T10: when the primary evidence is not one of the links, all links are reported omitted (no +1 arithmetic)", async () => {
  const db = threeLinkDb([...THREE_LINKS]);
  db.operational_decision_records = [repairDecision({ recommendation_id: "rec-r1" })];
  db.recommended_actions = [
    {
      id: "rec-r1",
      workspace_id: WS,
      project_id: PRJ,
      source_signal_id: "sig-r1",
      governance_event_id: null,
      title: "Recommendation",
      proposed_action: "Act",
      urgency: "medium",
      status: "accepted",
      created_at: "2026-08-13T07:20:00Z",
    },
  ];
  db.operational_signals = [
    {
      id: "sig-r1",
      workspace_id: WS,
      project_id: PRJ,
      evidence_item_id: "ev-signal",
      signal_type: "readiness_clearance",
      severity: "low",
      confidence_score: 95,
      summary: "Signal evidence outside the link set",
      created_at: "2026-08-13T07:15:00Z",
    },
  ];
  db.evidence_items = [...(db.evidence_items as unknown[]), repairEvidence({ id: "ev-signal" })];

  const proj = await runLineage(db);

  assert.equal(stepOf(proj, "evidence").id, "ev-signal");
  const gap = omissionGap(proj);
  assert.ok(gap, `expected an omission gap, got: ${JSON.stringify(proj.gaps)}`);
  // Three links exist and NONE of them is represented. The total is read off the link set,
  // so it stays 3 — an `omitted.length + 1` formulation would have claimed 4.
  assert.match(gap, /decision has 3 linked evidence item\(s\)/);
  assert.match(gap, /3 linked evidence item\(s\) not represented: ev-a, ev-b, ev-c\./);
});

test("P2-10 T10: omission accounting never leaks another tenant's evidence links", async () => {
  const db = threeLinkDb([
    ...THREE_LINKS,
    repairLink("ev-foreign", "2026-08-13T07:05:00Z", { decision_record_id: "dec-foreign" }),
  ]);
  db.operational_decision_records = [
    repairDecision(),
    repairDecision({ id: "dec-foreign", workspace_id: "ws-foreign", project_id: "proj-foreign" }),
  ];

  const proj = await runLineage(db);

  assert.equal(stepOf(proj, "evidence").id, "ev-a");
  const gap = omissionGap(proj);
  assert.ok(gap);
  assert.ok(!gap.includes("ev-foreign"), "a foreign tenant's link must never appear in this lineage");
  assert.ok(!JSON.stringify(proj.gaps).includes("dec-foreign"));
});

// ─── T7: audit reconstruction across both sources ────────────────────────────

const CORR_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_CORR_UUID = "44444444-4444-4444-8444-444444444444";
const OUT_UUID = "22222222-2222-4222-8222-222222222222";
const OBS_UUID = "33333333-3333-4333-8333-333333333333";

const auditEvent = (over: Row = {}): Row => ({
  id: "evt-a1",
  workspace_id: WS,
  project_id: PRJ,
  event_type: "EVIDENCE_DERIVED_V1",
  event_category: "provenance",
  actor_id: "user-r1",
  actor_type: "user",
  occurred_at: "2026-08-13T11:00:00Z",
  created_at: "2026-08-13T11:00:01Z",
  correlation_id: CORR_UUID,
  causation_id: null,
  raw_reference_table: "evidence_items",
  raw_reference_id: "ev-r1",
  event_payload: { evidenceId: "ev-r1" },
  metadata: { existingKey: "preserved" },
  ...over,
});

const auditObservation = (over: Row = {}): Row => ({
  id: OBS_UUID,
  workspace_id: WS,
  project_id: PRJ,
  outcome_id: OUT_UUID,
  task_id: "task-r1",
  observation_state: "achieved",
  summary: "Sponsor signature verified",
  evidence_reference_ids: ["ev-r1"],
  confidence_score: 0.98,
  missing_data_state: "COMPLETE",
  observed_by: "user-r1",
  observed_at: "2026-08-13T12:00:00Z",
  evaluated_at: "2026-08-13T12:05:00Z",
  recorded_at: "2026-08-13T12:30:00Z",
  correlation_id: CORR_UUID,
  causation_id: OUT_UUID,
  fixture_label: null,
  ...over,
});

const auditOutcomeRow = (over: Row = {}): Row =>
  repairOutcome({ id: OUT_UUID, correlation_id: CORR_UUID, ...over });

const auditClient = (db: Record<string, unknown[]>) =>
  createStrictMockClient(db) as unknown as Parameters<typeof reconstructAuditTrail>[0];

const reconstructedId = `canonical_outcome_observations:${OBS_UUID}`;

test("P2-10 T7: a canonical outcome observation appears in the audit trail as an explicit reconstruction", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(repairDb({ canonical_outcome_observations: [auditObservation()] })),
    WS,
    PRJ,
  );

  assert.equal(trail.length, 1);
  const item = trail[0];
  assert.equal(item.id, reconstructedId);
  assert.equal(item.eventType, "CANONICAL_OUTCOME_OBSERVATION_RECORDED");
  assert.equal(item.rawReferenceTable, "canonical_outcome_observations");
  assert.equal(item.rawReferenceId, OBS_UUID);
  // Stored timestamps stay distinct — observed_at is not overwritten by recorded_at.
  assert.equal(item.occurredAt, "2026-08-13T12:00:00Z");
  assert.equal(item.recordedAt, "2026-08-13T12:30:00Z");
  assert.equal(item.correlationId, CORR_UUID);
  assert.equal(item.causationId, OUT_UUID);
  assert.equal(item.relationship, "causation");
  // The schema does not classify observed_by, so no actor type is asserted.
  assert.equal(item.actorType, "unknown");
  assert.equal(item.actorId, "user-r1");
  assert.equal(item.metadata.reconstructed, true);
  assert.equal(item.metadata.reconstructedFrom, "canonical_outcome_observations");
  assert.match(String(item.metadata.reconstructionReason), /NOT an emitted platform event/);
});

test("P2-10 T7: a correlation-only observation keeps a null causation", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(repairDb({ canonical_outcome_observations: [auditObservation({ causation_id: null })] })),
    WS,
    PRJ,
  );

  assert.equal(trail[0].causationId, null);
  assert.equal(trail[0].correlationId, CORR_UUID);
  assert.equal(trail[0].relationship, "correlation_only");
});

test("P2-10 T7: both sources are merged chronologically", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        platform_events: [
          auditEvent({ id: "evt-late", occurred_at: "2026-08-13T13:00:00Z" }),
          auditEvent({ id: "evt-early", occurred_at: "2026-08-13T11:00:00Z" }),
        ],
        canonical_outcome_observations: [auditObservation()],
      }),
    ),
    WS,
    PRJ,
  );

  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-early", reconstructedId, "evt-late"],
  );
});

test("P2-10 T7: a correlationId filter applies to both sources", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        platform_events: [auditEvent(), auditEvent({ id: "evt-other", correlation_id: OTHER_CORR_UUID })],
        canonical_outcome_observations: [
          auditObservation(),
          auditObservation({ id: "obs-other", correlation_id: OTHER_CORR_UUID }),
        ],
      }),
    ),
    WS,
    PRJ,
    { correlationId: CORR_UUID },
  );

  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-a1", reconstructedId],
  );
});

test("P2-10 T7: a non-uuid correlationId filters observations verbatim and yields zero platform events instead of throwing", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        // platform_events.correlation_id is uuid; this text value can never match it.
        platform_events: [auditEvent()],
        canonical_outcome_observations: [auditObservation({ correlation_id: "corr-text-not-a-uuid" })],
      }),
    ),
    WS,
    PRJ,
    { correlationId: "corr-text-not-a-uuid" },
  );

  assert.equal(trail.length, 1);
  assert.equal(trail[0].id, reconstructedId);
  assert.equal(trail[0].correlationId, "corr-text-not-a-uuid");
});

test("P2-10 T7: an outcomeId filter applies to both sources and marks platform events as correlation-only association", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        canonical_task_outcomes: [auditOutcomeRow(), repairOutcome({ id: "out-other", correlation_id: OTHER_CORR_UUID })],
        platform_events: [
          auditEvent({ causation_id: "ev-r1" }),
          auditEvent({ id: "evt-other", correlation_id: OTHER_CORR_UUID }),
        ],
        canonical_outcome_observations: [
          auditObservation(),
          auditObservation({ id: "obs-other", outcome_id: "out-other", correlation_id: OTHER_CORR_UUID }),
        ],
      }),
    ),
    WS,
    PRJ,
    { outcomeId: OUT_UUID },
  );

  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-a1", reconstructedId],
  );

  const event = trail[0];
  assert.equal(event.metadata.outcomeAssociation, "correlation_only");
  assert.equal(event.metadata.outcomeAssociationComplete, false);
  assert.equal(event.metadata.requestedOutcomeId, OUT_UUID);
  // Pre-existing event metadata is preserved, and the row's own causal relationship is a
  // separate concept from how it was selected for the requested outcome.
  assert.equal(event.metadata.existingKey, "preserved");
  assert.equal(event.relationship, "causation");

  // Observations have an exact stored outcome_id relationship and are never marked correlation-only.
  const observation = trail[1];
  assert.equal(observation.metadata.outcomeAssociation, undefined);
  assert.equal(observation.metadata.outcomeAssociationComplete, undefined);
  assert.equal(observation.metadata.requestedOutcomeId, undefined);
});

test("P2-10 T7: an audit request without outcomeId adds no outcome-association metadata", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(repairDb({ platform_events: [auditEvent()], canonical_outcome_observations: [auditObservation()] })),
    WS,
    PRJ,
  );

  for (const item of trail) {
    assert.equal(item.metadata.outcomeAssociation, undefined);
    assert.equal(item.metadata.outcomeAssociationComplete, undefined);
    assert.equal(item.metadata.requestedOutcomeId, undefined);
  }
  assert.equal(trail.find((item) => item.id === "evt-a1")?.metadata.existingKey, "preserved");
});

test("P2-10 T7: a foreign tenant's observation never enters the audit trail", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        canonical_outcome_observations: [
          auditObservation(),
          auditObservation({ id: "obs-foreign", workspace_id: "ws-foreign", project_id: "proj-foreign" }),
        ],
      }),
    ),
    WS,
    PRJ,
  );

  assert.deepEqual(
    trail.map((item) => item.id),
    [reconstructedId],
  );
});

test("P2-10 T7: an observation already represented by a platform event is not emitted twice", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        platform_events: [
          auditEvent({
            id: "evt-obs",
            raw_reference_table: "canonical_outcome_observations",
            raw_reference_id: OBS_UUID,
          }),
        ],
        canonical_outcome_observations: [auditObservation()],
      }),
    ),
    WS,
    PRJ,
  );

  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-obs"],
  );
  assert.ok(!trail.some((item) => item.metadata.reconstructed === true));
});

test("P2-10 T7: the requested limit bounds the COMBINED merged trail, not each source", async () => {
  const trail = await reconstructAuditTrail(
    auditClient(
      repairDb({
        platform_events: [
          auditEvent({ id: "evt-1", occurred_at: "2026-08-13T10:00:00Z" }),
          auditEvent({ id: "evt-2", occurred_at: "2026-08-13T14:00:00Z" }),
        ],
        canonical_outcome_observations: [
          auditObservation({ id: OBS_UUID, observed_at: "2026-08-13T12:00:00Z" }),
          auditObservation({ id: "obs-late", observed_at: "2026-08-13T16:00:00Z" }),
        ],
      }),
    ),
    WS,
    PRJ,
    { limit: 2 },
  );

  assert.equal(trail.length, 2);
  assert.deepEqual(
    trail.map((item) => item.id),
    ["evt-1", reconstructedId],
  );
});

test("P2-10: API route validates input, tenant scoping, and authorized roles for outcomes & observations", () => {
  assert.match(apiRouteCode, /ensure_expected_outcome/);
  assert.match(apiRouteCode, /record_outcome_observation/);
  assert.match(apiRouteCode, /view === "lineage"/);
  assert.match(apiRouteCode, /view === "audit"/);
  assert.match(apiRouteCode, /OBSERVATION_STATES\.has\(observationState\)/);
});

// ─── Finding resolution: the canonical Recommendation → Signal reference ─────
//
// Regression cover for `P2-10-LINEAGE-FINDING-UNRESOLVED`. The projection used to read
// `recommendation.signal_id || governance.signal_id`, and no table defines either column:
// `recommended_actions` owns `source_signal_id` (written by `materialize_operational_chain`
// as the detected Signal's id) and `governance_events` relates by entity type/id. Every
// governed chain therefore reported a Finding gap that did not exist. These tests bind to
// the real column, so reintroducing the stale one fails here instead of only in production.

const findingSignal = (over: Row = {}): Row => ({
  id: "sig-r1",
  workspace_id: WS,
  project_id: PRJ,
  evidence_item_id: "ev-r1",
  signal_type: "scope_creep",
  severity: "high",
  confidence_score: 92,
  summary: "Work outside the agreed scope was requested.",
  created_at: "2026-08-13T07:15:00Z",
  ...over,
});

const findingRecommendation = (over: Row = {}): Row => ({
  id: "rec-r1",
  workspace_id: WS,
  project_id: PRJ,
  source_signal_id: "sig-r1",
  governance_event_id: null,
  title: "Request formal scope confirmation",
  proposed_action: "Raise a change request",
  urgency: "high",
  status: "accepted",
  created_at: "2026-08-13T07:20:00Z",
  ...over,
});

const findingDb = (recommendationOver: Row = {}, signals: unknown[] = [findingSignal()]) =>
  repairDb({
    canonical_task_outcomes: [repairOutcome()],
    material_action_proposals: [repairAction()],
    material_action_governance_evaluations: [repairEvaluation()],
    operational_decision_records: [repairDecision({ recommendation_id: "rec-r1" })],
    recommended_actions: [findingRecommendation(recommendationOver)],
    operational_signals: signals,
    evidence_items: [repairEvidence()],
  });

const FINDING_GAP = "Finding: no operational finding linked.";

test("P2-10 finding: recommended_actions.source_signal_id resolves the Finding node, with no false gap", async () => {
  const proj = await runLineage(findingDb());

  const finding = stepOf(proj, "finding");
  assert.equal(finding.id, "sig-r1", "the Finding is the Signal the Recommendation references");
  assert.notEqual(finding.status, "missing");
  assert.equal(finding.gapReason, null);
  assert.match(finding.title, /scope creep/);
  assert.equal((finding.entity as Row | null)?.id, "sig-r1", "the Finding carries the persisted Signal row");
  assert.ok(!proj.gaps.includes(FINDING_GAP), `unexpected Finding gap: ${JSON.stringify(proj.gaps)}`);

  // The chain is continuous across the Finding rather than broken on both sides of it.
  for (const [fromKind, toKind] of [["evidence", "finding"], ["finding", "recommendation"]]) {
    const transition = proj.transitions.find((t) => t.fromKind === fromKind && t.toKind === toKind);
    assert.ok(transition, `expected a ${fromKind} -> ${toKind} transition`);
    assert.notEqual(transition.relationship, "unlinked", `${fromKind} -> ${toKind} must not be a lineage gap`);
  }
});

test("P2-10 finding: a legacy-shaped `signal_id` is NOT a Finding reference", async () => {
  // The exact drift that hid the defect: only the non-existent column is present. Resolving
  // a Finding from it would mean the projection reads a field the schema never persists.
  const proj = await runLineage(
    findingDb({ source_signal_id: null, signal_id: "sig-r1" } as Row),
  );

  const finding = stepOf(proj, "finding");
  assert.equal(finding.id, null);
  assert.equal(finding.status, "missing");
  assert.equal((stepOf(proj, "finding").entity as Row | null) ?? null, null, "no Signal row is attached");
  assert.ok(proj.gaps.includes(FINDING_GAP), "an unresolvable Finding is still reported as a gap");
});

test("P2-10 finding: a Recommendation with no source_signal_id reports the gap honestly", async () => {
  const proj = await runLineage(findingDb({ source_signal_id: null }));

  assert.equal(stepOf(proj, "finding").status, "missing");
  assert.equal((stepOf(proj, "finding").entity as Row | null) ?? null, null, "no Signal row is attached");
  assert.ok(proj.gaps.includes(FINDING_GAP));
  assert.notEqual(proj.lineageStatus, "complete");
});

test("P2-10 finding: a source_signal_id with no in-scope Signal is a gap, never a fabricated node", async () => {
  const proj = await runLineage(findingDb({ source_signal_id: "sig-not-in-scope" }, []));

  const finding = stepOf(proj, "finding");
  assert.equal(finding.status, "missing");
  assert.equal(finding.id, null, "an unresolvable reference must not be echoed as a canonical id");
  assert.equal((stepOf(proj, "finding").entity as Row | null) ?? null, null, "no Signal row is attached");
  assert.ok(proj.gaps.includes(FINDING_GAP));
});

// ─── Confidence scale: one normalization boundary, not two contracts ─────────
//
// `operational_signals.confidence_score` is `numeric(5,2)` on a 0-100 scale (the detector
// writes 92, and the risk derivation compares `>= 85`), while `evidence_items` and
// `canonical_outcome_observations` are `numeric(5,4)` fractions. Every consumer of a
// `LineageStepNode.confidenceScore` multiplies by 100 — the review panel's `formatPct` and
// the P2-20 export, which carries the value verbatim. The projection therefore normalizes
// the Signal at that boundary. Before it did, a Finding of 92 rendered as `9200.0%`; that
// was unreachable until `source_signal_id` made the Finding resolve at all.

test("P2-10 confidence: a Signal persisted as 92 projects 0.92 and renders 92.0%", async () => {
  const proj = await runLineage(findingDb());
  const finding = stepOf(proj, "finding");

  assert.equal((finding.entity as Row).confidence_score, 92, "fixture uses the persisted 0-100 scale");
  assert.equal(finding.confidenceScore, 0.92, "projected onto the canonical 0-1 lineage scale");
  assert.match(finding.summary, /Confidence: 92\.0%/);
  assert.doesNotMatch(finding.summary, /9200\.0%/, "the percentage must not be multiplied twice");
  // What `formatPct` (and any other consumer) will render from the projected value.
  assert.equal(`${(Number(finding.confidenceScore) * 100).toFixed(1)}%`, "92.0%");
});

test("P2-10 confidence: the 0-100 Signal scale is normalized across its range", async () => {
  for (const [persisted, projected] of [[0, 0], [80, 0.8], [95, 0.95], [100, 1]] as const) {
    const proj = await runLineage(findingDb({}, [findingSignal({ confidence_score: persisted })]));
    const finding = stepOf(proj, "finding");
    assert.equal(finding.confidenceScore, projected, `${persisted} must project to ${projected}`);
    assert.match(finding.summary, new RegExp(`Confidence: ${projected * 100}\\.0%`));
  }
});

test("P2-10 confidence: Evidence keeps its own 0-1 persisted contract, undivided", async () => {
  // The repair must distinguish the two persisted scales rather than normalizing everything.
  const proj = await runLineage(findingDb());
  const evidence = stepOf(proj, "evidence");

  assert.equal((evidence.entity as Row).confidence_score, 0.9, "evidence_items persists a fraction");
  assert.equal(evidence.confidenceScore, 0.9, "evidence confidence is passed through unchanged");
  assert.match(evidence.summary, /Confidence: 90\.0%/);
  assert.doesNotMatch(evidence.summary, /0\.9%/, "evidence confidence must not be divided by 100");
});
