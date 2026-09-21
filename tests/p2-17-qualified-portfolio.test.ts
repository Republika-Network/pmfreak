/**
 * P2-17 — Qualified Portfolio Projection and PMO Attention.
 *
 * Behavioural tests. The REAL loader (`loadPmoPortfolioAttention`), the REAL P2-16 read
 * contract it consumes (`loadScheduleInputs`, `listScheduleExposures`, `computeScheduleSnapshot`,
 * and schedule exposures produced by the real H9 adapter), the REAL route handler and the REAL
 * access decisions (`decideRoutedPmoAccess`, `decideRoutedProjectAccess`) run against a fake
 * Supabase client that genuinely FILTERS rows by the predicates it receives, seeded with two
 * workspaces, two PMOs and projects in materially different states. Rows the PMO must never see
 * (a sibling PMO's project, another workspace's project) carry deliberately alarming data, so a
 * scope leak would show up as content, not just as a filter assertion.
 *
 * Database-side enforcement (RLS on every table read here) is exercised by the authenticated
 * browser scenario tests/e2e/p2-17-pmo-attention.spec.ts against the local stack.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { ExecutionTaskDependencyRow, ExecutionTaskRow, ProjectMilestoneRow } from "@/lib/db/database-contract";
import { buildScheduleExposurePayload, evaluateScheduleExposure } from "@/lib/critical-path/schedule-exposure";
import type { PmoProjectRow } from "@/lib/pmos/pmo-command-center-rollup";
import { decideRoutedPmoAccess, type PmoAncestry } from "@/lib/pmos/routed-pmo";
import { decideRoutedProjectAccess } from "@/lib/projects/routed-project";
import type { RoutedWorkspaceAccess } from "@/lib/workspaces/routed-workspace";
import {
  CROSS_PROJECT_DEPENDENCY_SUPPORT,
  PMO_ATTENTION_ROW_CAP,
  PMO_ATTENTION_RULES,
  RESOURCE_CONFLICT_SUPPORT,
  buildPmoPortfolioAttention,
  computePmoMembershipSnapshot,
  type PmoPortfolioAttention,
} from "@/lib/pmos/pmo-portfolio-attention";
import { loadPmoPortfolioAttention } from "@/lib/pmos/pmo-portfolio-attention-loader";
import { handleGetPmoAttention } from "@/app/api/pmos/[id]/attention/route";

// ── Identities ──────────────────────────────────────────────────────────────────────────

const u = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
const WS_A = u("a1");
const WS_B = u("b1");
const PMO_1 = u("f1");
const PMO_2 = u("f2");
const PMO_B = u("fb");
const USER_A = u("ee1");
const ATLAS = u("101");
const ORION = u("102");
const QUIET = u("103");
const BARE = u("104");
const DONE = u("105");
const SIBLING = u("201");
const FOREIGN = u("301");
const EVAL = "2026-10-20T12:00:00.000Z";
const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
const OWNER = u("0e1");

// ── A fake Supabase client that FILTERS ──────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in" | "notnull"; column: string; value?: unknown };
type Query = { table: string; filters: Filter[]; head: boolean };

function fakeClient(tables: Record<string, Row[]>, options: { fail?: string[] } = {}) {
  const queries: Query[] = [];
  const from = (table: string) => {
    const q: Query & { limit: number; order: { column: string; asc: boolean } | null } = { table, filters: [], head: false, limit: Number.POSITIVE_INFINITY, order: null };
    queries.push(q);
    const run = () => {
      if (options.fail?.includes(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      let rows = (tables[table] ?? []).filter((row) =>
        q.filters.every((f) =>
          f.op === "eq" ? row[f.column] === f.value : f.op === "in" ? (f.value as unknown[]).includes(row[f.column]) : row[f.column] !== null && row[f.column] !== undefined,
        ),
      );
      if (q.order) {
        const { column, asc } = q.order;
        rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (asc ? 1 : -1));
      }
      const total = rows.length;
      rows = rows.slice(0, q.limit);
      return q.head ? { data: null, error: null, count: total } : { data: rows.map((r) => ({ ...r })), error: null, count: null };
    };
    const builder: Record<string, unknown> = {
      select: (_columns: string, opts?: { head?: boolean }) => { if (opts?.head) q.head = true; return builder; },
      eq: (column: string, value: unknown) => { q.filters.push({ op: "eq", column, value }); return builder; },
      in: (column: string, value: unknown[]) => { q.filters.push({ op: "in", column, value }); return builder; },
      not: (column: string, op: string, value: unknown) => { if (op === "is" && value === null) q.filters.push({ op: "notnull", column }); return builder; },
      order: (column: string, opts?: { ascending?: boolean }) => { q.order = { column, asc: opts?.ascending !== false }; return builder; },
      limit: (n: number) => { q.limit = n; return builder; },
      overrideTypes: () => builder,
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  };
  return { client: { from } as never, queries };
}

// ── The world ────────────────────────────────────────────────────────────────────────────

const task = (id: string, projectId: string, title: string, start: number, finish: number, milestoneId: string | null = null, workspaceId = WS_A) => ({
  id, workspace_id: workspaceId, project_id: projectId, title, status: "not_started", milestone_id: milestoneId,
  planned_start_date: day(start), planned_finish_date: day(finish), forecast_finish_date: null, owner_user_id: OWNER, updated_at: day(1),
}) as unknown as ExecutionTaskRow;

const T_DESIGN = u("7a1");
const T_BUILD = u("7a2");
const T_ORION = u("7b1");
const DEP_ATLAS = u("da1");
const MS_ATLAS = u("ea1");

function atlasSchedule(titleSuffix = "") {
  const tasks = [task(T_DESIGN, ATLAS, `Design${titleSuffix}`, 1, 6), task(T_BUILD, ATLAS, "Build", 6, 16, MS_ATLAS)];
  const dependencies = [{ id: DEP_ATLAS, workspace_id: WS_A, project_id: ATLAS, predecessor_task_id: T_DESIGN, successor_task_id: T_BUILD, dependency_type: "finish_to_start", status: "active", lag_days: 0, updated_at: day(3) }] as unknown as ExecutionTaskDependencyRow[];
  // Target on day 1 while the network finishes Build on day 16 → a 15-day slip → critical.
  const milestones = [{ id: MS_ATLAS, workspace_id: WS_A, project_id: ATLAS, title: "Go-live", status: "planned", target_date: day(1), forecast_date: null, baseline_date: day(1), updated_at: day(4) }] as unknown as ProjectMilestoneRow[];
  return { tasks, dependencies, milestones };
}

const ev = (id: string, projectId: string, extra: Row = {}, workspaceId = WS_A): Row => ({
  id, workspace_id: workspaceId, project_id: projectId, source_type: "manual_note", normalized_event_id: u(`${id.slice(-4)}e`),
  title: "Evidence", content: "Evidence", confidence_score: 0.8, missing_data_state: "COMPLETE", freshness_state: "CURRENT",
  lifecycle: "RECORDED", fixture_state: "LIVE", assertion_type: "OBSERVATION", stale_at: null,
  evaluated_at: day(5), occurred_at: day(5), recorded_at: day(5), correlation_id: `corr-${id}`, source_id: u("5c"), source_reference: null,
  raw_input_id: u("5d"), derivation_digest: `sha256:${"ab".repeat(32)}`,
  ...extra,
});

const signal = (id: string, projectId: string, evidenceId: string, confidence: number, extra: Row = {}, workspaceId = WS_A): Row => ({
  id, workspace_id: workspaceId, project_id: projectId, evidence_item_id: evidenceId, confidence_score: confidence, severity: "high",
  status: "open", detected_by: "system/deterministic:governance_signal_detector_v1", summary: "Signal", signal_type: "delivery_impediment", ...extra,
});

const risk = (id: string, projectId: string, signalId: string, severity: string, extra: Row = {}, workspaceId = WS_A): Row => ({
  id, workspace_id: workspaceId, project_id: projectId, signal_id: signalId, type: "risk", title: `Risk ${id.slice(-3)}`,
  severity, status: "open", updated_at: day(6), ...extra,
});

const rec = (id: string, projectId: string, signalId: string | null, urgency: string | null, extra: Row = {}, workspaceId = WS_A): Row => ({
  id, workspace_id: workspaceId, project_id: projectId, title: `Recommendation ${id.slice(-3)}`, recommendation: "Do the thing",
  urgency, confidence_score: null, source_signal_id: signalId, status: "proposed", governance_event_id: u("9e"),
  recommended_action_type: "escalate_issue", created_at: day(6), ...extra,
});

function world(options: { atlasTitleSuffixNow?: string } = {}) {
  const atlas = atlasSchedule();
  const evaluation = evaluateScheduleExposure({ ...atlas, trigger: {
    kind: "dependency_change", entityType: "execution_task_dependency", entityId: DEP_ATLAS, predecessorTaskId: T_DESIGN, successorTaskId: T_BUILD,
    dependencyType: "finish_to_start", status: "active", lagDays: 0, previousStatus: "proposed", changeEventId: null, changedAt: day(3),
  }, evaluatedAt: day(7) });
  assert.equal(evaluation.status, "qualified");
  assert.equal(evaluation.severity, "critical");
  const payload = buildScheduleExposurePayload(evaluation, atlas.tasks);
  // "Now" may differ from what was evaluated: a title edit supersedes the recorded snapshot.
  const atlasNow = atlasSchedule(options.atlasTitleSuffixNow ?? "");

  const EV_SCHED = u("e5a");
  const SIG_SCHED = u("15a");
  const tables: Record<string, Row[]> = {
    projects: [
      { id: ATLAS, workspace_id: WS_A, pmo_id: PMO_1, name: "Atlas", description: null, status: "active", icon: null, color: null },
      { id: ORION, workspace_id: WS_A, pmo_id: PMO_1, name: "Orion", description: null, status: "active", icon: null, color: null },
      { id: QUIET, workspace_id: WS_A, pmo_id: PMO_1, name: "Quiet", description: null, status: "active", icon: null, color: null },
      { id: BARE, workspace_id: WS_A, pmo_id: PMO_1, name: "Bare", description: null, status: "active", icon: null, color: null },
      { id: DONE, workspace_id: WS_A, pmo_id: PMO_1, name: "Done", description: null, status: "completed", icon: null, color: null },
      { id: SIBLING, workspace_id: WS_A, pmo_id: PMO_2, name: "Sibling Secret", description: null, status: "active", icon: null, color: null },
      { id: FOREIGN, workspace_id: WS_B, pmo_id: PMO_B, name: "Foreign Secret", description: null, status: "active", icon: null, color: null },
    ],
    execution_tasks: [...atlasNow.tasks, task(T_ORION, ORION, "Orion work", 2, 12)],
    execution_task_dependencies: [...atlasNow.dependencies],
    project_milestones: [...atlasNow.milestones],
    operational_normalized_events: [{ id: u("e5ae"), workspace_id: WS_A, project_id: ATLAS, event_payload: payload }],
    evidence_items: [
      ev(EV_SCHED, ATLAS, { source_type: "schedule_evaluation", normalized_event_id: u("e5ae"), confidence_score: evaluation.confidence, assertion_type: "INFERENCE", recorded_at: day(7), evaluated_at: day(7), title: String(payload.title), content: String(payload.content) }),
      ev(u("e1a"), ATLAS),
      ev(u("e1b"), ORION),
      ev(u("e1c"), QUIET),
      ev(u("e2a"), SIBLING),
      ev(u("e3a"), FOREIGN, {}, WS_B),
    ],
    operational_signals: [
      signal(SIG_SCHED, ATLAS, EV_SCHED, Math.round((evaluation.confidence ?? 0) * 10000) / 100, { signal_type: "schedule_risk", severity: "critical" }),
      signal(u("11a"), ATLAS, u("e1a"), 92),
      signal(u("11b"), ORION, u("e1b"), 60),
      signal(u("12a"), SIBLING, u("e2a"), 99),
      signal(u("13a"), FOREIGN, u("e3a"), 99, {}, WS_B),
    ],
    risk_issue_records: [
      // The schedule exposure's own Finding: the SAME fact as the schedule reason, so not repeated.
      risk(u("21a"), ATLAS, SIG_SCHED, "critical"),
      risk(u("22a"), ATLAS, u("11a"), "high", { status: "monitoring", title: "Vendor slip" }),
      risk(u("23a"), ATLAS, u("11a"), "high", { status: "resolved", title: "Old resolved risk" }),
      risk(u("24a"), SIBLING, u("12a"), "critical", { title: "SIBLING SECRET RISK" }),
      risk(u("25a"), FOREIGN, u("13a"), "critical", { title: "FOREIGN SECRET RISK" }, WS_B),
      risk(u("26a"), DONE, u("11a"), "critical", { title: "Completed project risk" }),
    ],
    recommended_actions: [
      rec(u("31a"), ATLAS, SIG_SCHED, "high", { recommendation: "Confirm the dependency", recommended_action_type: "confirm_dependency" }),
      rec(u("32b"), ORION, u("11b"), "immediate", { title: "Escalate supplier" }),
      rec(u("33b"), ORION, null, "low", { governance_event_id: null, title: "Legacy ungoverned recommendation" }),
      rec(u("34b"), ORION, u("11b"), "high", { status: "accepted", title: "Already decided" }),
      rec(u("35s"), SIBLING, u("12a"), "immediate", { title: "SIBLING SECRET REC" }),
    ],
    canonical_task_outcomes: [
      { id: u("41b"), workspace_id: WS_A, project_id: ORION, task_id: T_ORION, state: "partially_achieved", expected_result: "Supplier onboarded", updated_at: day(9), fixture_label: null },
      { id: u("42b"), workspace_id: WS_A, project_id: ORION, task_id: u("7b2"), state: "expected", expected_result: "Completed task awaiting observation", updated_at: day(9), fixture_label: null },
      { id: u("43c"), workspace_id: WS_A, project_id: QUIET, task_id: u("7c1"), state: "achieved", expected_result: "Delivered", updated_at: day(9), fixture_label: null },
      { id: u("44s"), workspace_id: WS_A, project_id: SIBLING, task_id: u("7s1"), state: "not_achieved", expected_result: "SIBLING SECRET OUTCOME", updated_at: day(9), fixture_label: null },
    ],
    canonical_outcome_observations: [
      { id: u("51b"), workspace_id: WS_A, project_id: ORION, outcome_id: u("41b"), observation_state: "partial", confidence_score: 0.7, missing_data_state: "COMPLETE", observed_at: day(10), stale_at: "2026-11-01T00:00:00.000Z", recorded_at: day(10), fixture_label: null },
    ],
  };
  const pmo1Projects = tables.projects.filter((p) => p.pmo_id === PMO_1) as unknown as PmoProjectRow[];
  return { tables, pmo1Projects, evaluation };
}

async function project(w = world(), options: { evaluatedAt?: string; fail?: string[] } = {}) {
  const fake = fakeClient(w.tables, { fail: options.fail });
  const attention = await loadPmoPortfolioAttention(fake.client, { workspaceId: WS_A, pmoId: PMO_1, projects: w.pmo1Projects }, { evaluatedAt: options.evaluatedAt ?? EVAL });
  return { attention, queries: fake.queries };
}

const withoutClock = (a: PmoPortfolioAttention) => ({ ...a, evaluatedAt: undefined });
const find = (a: PmoPortfolioAttention, id: string) => [...a.attention, ...a.quiet, ...a.notAssessed].find((p) => p.projectId === id);

// ── Positive: qualified, comparable, explicit coverage, safe drill-down ──────────────────

test("P2-17: multiple authorized projects yield a qualified, explicitly-covered, comparable projection", async () => {
  const { attention } = await project();
  assert.equal(attention.contract, "pmfreak/pmo-portfolio-attention:v1");
  assert.deepEqual(attention.scope, { workspaceId: WS_A, pmoId: PMO_1 });
  assert.equal(attention.evaluatedAt, EVAL);

  // Ordering is by the published rule table: Atlas (critical schedule) before Orion (high rec).
  assert.deepEqual(attention.attention.map((p) => p.projectName), ["Atlas", "Orion"]);
  const atlas = find(attention, ATLAS)!;
  assert.equal(atlas.attentionLevel, "critical");
  assert.deepEqual(atlas.reasons.map((r) => r.ruleId), ["schedule.severity.critical", "finding.unresolved.high"]);
  const schedule = atlas.reasons[0];
  assert.match(schedule.summary, /"Go-live" projected 15 days past target/);
  assert.match(schedule.summary, /Recommendation awaiting decision/);
  assert.equal(schedule.freshness.state, "current");
  assert.equal(schedule.assertion, "inference");
  assert.deepEqual(schedule.evidence.map((e) => e.entity), ["evidence_item", "operational_signal", "recommended_action"]);
  // The exposure's own Finding and Recommendation are the SAME fact; they are not repeated as reasons.
  assert.equal(atlas.reasons.filter((r) => r.evidence.some((e) => e.id === u("21a") || e.id === u("31a"))).length, 1);
  // Resolved risks are not attention.
  assert.ok(!JSON.stringify(atlas).includes("Old resolved risk"));

  const orion = find(attention, ORION)!;
  assert.equal(orion.attentionLevel, "high");
  assert.deepEqual(orion.reasons.map((r) => r.ruleId), ["recommendation.pending.immediate", "outcome.partially_achieved"]);
  // Ungoverned and already-decided recommendations are not "awaiting decision".
  assert.ok(!JSON.stringify(orion).includes("Legacy ungoverned recommendation"));
  assert.ok(!JSON.stringify(orion).includes("Already decided"));
  // Completed work with no Observation is unknown, never a divergence.
  assert.ok(!JSON.stringify(orion).includes("Completed task awaiting observation"));
  assert.ok(orion.missingInputs.some((m) => m.code === "schedule_not_evaluated"));

  assert.deepEqual(attention.quiet.map((p) => p.projectName), ["Quiet"]);
  assert.deepEqual(attention.notAssessed.map((p) => [p.projectName, p.evaluation]), [["Bare", "missing_inputs"], ["Done", "not_evaluated_lifecycle"]]);

  assert.deepEqual(
    { inScope: attention.coverage.projectsInScope, eligible: attention.coverage.eligible, evaluated: attention.coverage.evaluated, qualified: attention.coverage.qualified, missing: attention.coverage.missingInputs, lifecycle: attention.coverage.notEvaluatedLifecycle, complete: attention.coverage.complete },
    { inScope: 5, eligible: 4, evaluated: 4, qualified: 3, missing: 1, lifecycle: 1, complete: false },
  );
  assert.deepEqual(attention.coverage.withheld, { count: 0, basis: "workspace_membership" });

  // Drill-down targets are the canonical entity-qualified routes of the SAME workspace.
  assert.equal(atlas.drillDown.project, `/workspaces/${WS_A}/projects/${ATLAS}/command-center`);
  assert.equal(atlas.drillDown.execution, `/workspaces/${WS_A}/command-center?projectId=${ATLAS}`);
  for (const p of [...attention.attention, ...attention.quiet, ...attention.notAssessed]) {
    assert.ok(!p.drillDown.project.startsWith("/pmo-command-center") && !p.drillDown.project.startsWith("/projects/"), "never a compatibility route");
  }
});

test("P2-17: confidence is on the 0–1 scale, carries its source, and is kept apart from coverage", async () => {
  const { attention } = await project();
  const atlas = find(attention, ATLAS)!;
  const finding = atlas.reasons.find((r) => r.ruleId === "finding.unresolved.high")!;
  // Persisted Signal 92 (0–100) → 0.92 — never 9200%, never 92.
  assert.deepEqual(finding.confidence, { value: 0.92, scale: "unit_interval", source: "operational_signals.confidence_score ÷ 100" });
  const all = [...attention.attention].flatMap((p) => p.reasons).map((r) => r.confidence).filter(Boolean);
  assert.ok(all.every((c) => c!.value >= 0 && c!.value <= 1));
  // Portfolio confidence = the weakest recorded claim, and names it.
  const min = Math.min(...all.map((c) => c!.value));
  assert.equal(attention.confidence?.value, min);
  assert.equal(attention.confidence?.scale, "unit_interval");
  // Coverage is a separate structure; confidence is not a coverage ratio.
  assert.notEqual(attention.confidence?.value, attention.coverage.qualified / attention.coverage.eligible);
  assert.equal(typeof attention.coverage.qualified, "number");
});

test("P2-17: there is no opaque composite score — only published rules and ordering keys", async () => {
  const { attention } = await project();
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  walk(attention);
  for (const k of keys) assert.doesNotMatch(k, /score|health|priority|weight|rank/i, `unexpected metric key ${k}`);
  const ruleIds = new Set(PMO_ATTENTION_RULES.map((r) => r.id));
  for (const r of attention.attention.flatMap((p) => p.reasons)) assert.ok(ruleIds.has(r.ruleId));
  assert.equal(attention.method.rules, PMO_ATTENTION_RULES);
  assert.equal(attention.method.ordering.length, 4);
});

// ── Determinism / idempotency ────────────────────────────────────────────────────────────

test("P2-17: identical membership + state produce identical content independent of request time and row order", async () => {
  const a = await project();
  const b = await project();
  assert.deepEqual(a.attention, b.attention);

  // A later clock with no validity deadline in between: same material content, same digest.
  const later = await project(world(), { evaluatedAt: "2026-10-21T08:00:00.000Z" });
  assert.equal(later.attention.evaluatedAt, "2026-10-21T08:00:00.000Z");
  assert.equal(later.attention.assessmentDigest, a.attention.assessmentDigest);
  assert.deepEqual(withoutClock(later.attention), withoutClock(a.attention));

  // Rows arriving in a different order change nothing.
  const shuffled = world();
  for (const rows of Object.values(shuffled.tables)) rows.reverse();
  shuffled.pmo1Projects.reverse();
  const c = await project(shuffled);
  assert.equal(c.attention.assessmentDigest, a.attention.assessmentDigest);
  assert.equal(c.attention.membership.digest, a.attention.membership.digest);
});

// ── Membership snapshot ──────────────────────────────────────────────────────────────────

test("P2-17: membership snapshot identity is deterministic and changes when membership changes", async () => {
  const same1 = computePmoMembershipSnapshot(WS_A, PMO_1, [ATLAS, ORION, QUIET]);
  const same2 = computePmoMembershipSnapshot(WS_A, PMO_1, [QUIET, ATLAS, ORION]);
  assert.equal(same1.digest, same2.digest);
  assert.match(same1.digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(computePmoMembershipSnapshot(WS_A, PMO_1, [ATLAS, ORION, QUIET, BARE]).digest, same1.digest, "project added");
  assert.notEqual(computePmoMembershipSnapshot(WS_A, PMO_1, [ATLAS, ORION]).digest, same1.digest, "project removed");
  assert.notEqual(computePmoMembershipSnapshot(WS_A, PMO_2, [ATLAS, ORION, QUIET]).digest, same1.digest, "same projects, other PMO");

  const base = await project();
  // Reassign Orion to the sibling PMO: a different membership and a different coverage.
  const reassigned = world();
  (reassigned.tables.projects.find((p) => p.id === ORION) as Row).pmo_id = PMO_2;
  reassigned.pmo1Projects = reassigned.tables.projects.filter((p) => p.pmo_id === PMO_1) as unknown as PmoProjectRow[];
  const after = await project(reassigned);
  assert.notEqual(after.attention.membership.digest, base.attention.membership.digest);
  assert.equal(after.attention.membership.projectCount, 4);
  assert.equal(after.attention.coverage.projectsInScope, 4);
  assert.ok(!find(after.attention, ORION));
  assert.notEqual(after.attention.assessmentDigest, base.attention.assessmentDigest);

  // A lifecycle change is not a membership change, but it IS a different assessment.
  const lifecycle = world();
  (lifecycle.pmo1Projects.find((p) => p.id === QUIET) as Row).status = "archived";
  const archived = await project(lifecycle);
  assert.equal(archived.attention.membership.digest, base.attention.membership.digest);
  assert.notEqual(archived.attention.assessmentDigest, base.attention.assessmentDigest);
});

// ── Coverage ─────────────────────────────────────────────────────────────────────────────

test("P2-17: a project lacking supported inputs lowers coverage and the PMO never claims a complete assessment", async () => {
  const { attention } = await project();
  const bare = find(attention, BARE)!;
  assert.equal(bare.evaluation, "missing_inputs");
  assert.equal(bare.attentionLevel, null);
  assert.deepEqual(bare.missingInputs.map((m) => m.code).sort(), ["no_canonical_evidence", "no_canonical_outcomes", "schedule_not_evaluated"]);
  assert.equal(attention.coverage.complete, false);
  assert.ok(attention.qualifications.includes("partial_coverage"));
  assert.equal(attention.state, "partial");

  // Remove Bare: now every active project is qualified. Absence of signals is still not health:
  // Quiet stays "no supported attention signal", not "healthy".
  const w = world();
  w.pmo1Projects = w.pmo1Projects.filter((p) => p.id !== BARE);
  const complete = await project(w);
  assert.equal(complete.attention.coverage.qualified, complete.attention.coverage.eligible);
  assert.equal(complete.attention.coverage.complete, true);
  assert.ok(!complete.attention.qualifications.includes("partial_coverage"));
  assert.equal(find(complete.attention, QUIET)!.attentionLevel, null);
});

// ── Cross-project dependencies & resource conflicts ─────────────────────────────────────

test("P2-17: an inferred cross-project edge and a shared assignee produce no dependency or conflict claim", async () => {
  const w = world();
  // A raw cross-project edge row (Atlas task → Orion task). The canonical write path refuses
  // these, so it is not a supported relationship and must never surface.
  w.tables.execution_task_dependencies.push({ id: u("dx1"), workspace_id: WS_A, project_id: ORION, predecessor_task_id: T_BUILD, successor_task_id: T_ORION, dependency_type: "finish_to_start", status: "active", lag_days: 0, updated_at: day(3) });
  // Same owner on overlapping work in two projects (already true in the world): not a conflict.
  const tasks = w.tables.execution_tasks as Row[];
  assert.equal(new Set(tasks.filter((t) => t.project_id === ATLAS || t.project_id === ORION).map((t) => t.owner_user_id)).size, 1);

  const { attention, queries } = await project(w);
  assert.deepEqual(attention.crossProjectDependencies, CROSS_PROJECT_DEPENDENCY_SUPPORT);
  assert.equal(attention.crossProjectDependencies.support, "unsupported");
  assert.deepEqual(attention.crossProjectDependencies.relationships, []);
  assert.deepEqual(attention.resourceConflicts, RESOURCE_CONFLICT_SUPPORT);
  assert.equal(attention.resourceConflicts.support, "unavailable");
  assert.deepEqual(attention.resourceConflicts.conflicts, []);
  assert.ok(!JSON.stringify(attention.attention).includes(u("dx1")));
  // Dependencies are only ever read project-by-project (P2-16's own scoped read), never across projects.
  for (const q of queries.filter((x) => x.table === "execution_task_dependencies")) {
    assert.ok(q.filters.some((f) => f.op === "eq" && f.column === "project_id"));
  }
});

// ── Caller-trusted metrics ───────────────────────────────────────────────────────────────

function routeDeps(w = world(), overrides: Record<string, unknown> = {}) {
  const fake = fakeClient(w.tables);
  const ancestry: Record<string, PmoAncestry> = {
    [PMO_1]: { workspaceId: WS_A, status: "active" },
    [PMO_2]: { workspaceId: WS_A, status: "active" },
    [PMO_B]: { workspaceId: WS_B, status: "active" },
  };
  const memberships: Record<string, string[]> = { [USER_A]: [WS_A] };
  const loads: Array<{ workspaceId: string; pmoId: string; projectIds: string[] }> = [];
  const deps = {
    authenticate: async () => ({ userId: USER_A }),
    // The same composition as resolveRoutedPmo: read the PMO's REAL parent, authorize THAT
    // workspace against membership, then let the pure decision compare the routed claim.
    resolvePmo: async (userId: string, routedWorkspaceId: string, pmoId: string) => {
      const pmo = ancestry[pmoId] ?? null;
      const workspaceAccess: RoutedWorkspaceAccess | null = pmo
        ? memberships[userId]?.includes(pmo.workspaceId)
          ? { access: "granted", workspaceId: pmo.workspaceId, role: "viewer", readOnly: false }
          : { access: "denied", workspaceId: null, role: null, readOnly: true }
        : null;
      return decideRoutedPmoAccess({ routedWorkspaceId, pmoId, pmo, workspaceAccess });
    },
    createClient: async () => fake.client,
    loadAttention: ((client: never, scope: { workspaceId: string; pmoId: string; projects: PmoProjectRow[] }) => {
      loads.push({ workspaceId: scope.workspaceId, pmoId: scope.pmoId, projectIds: scope.projects.map((p) => p.id) });
      return loadPmoPortfolioAttention(client, scope, { evaluatedAt: EVAL });
    }) as never,
    ...overrides,
  };
  return { deps, loads, queries: fake.queries };
}

const get = (query: string) => new NextRequest(`http://localhost/api/pmos/${PMO_1}/attention?${query}`);

test("P2-17: a caller cannot inject or tamper with a PMO metric through the attention API", async () => {
  const clean = routeDeps();
  const cleanRes = await handleGetPmoAttention(get(`workspaceId=${WS_A}`), PMO_1, clean.deps);
  assert.equal(cleanRes.status, 200);
  const cleanBody = await cleanRes.json();
  assert.equal(cleanBody.ok, true);

  const tampered = routeDeps();
  const params = new URLSearchParams({
    workspaceId: WS_A, riskScore: "0", healthScore: "100", attentionScore: "0", priority: "low", progress: "100",
    complexity: "1", resourceConflict: "true", scheduleHealth: "green", confidence: "1", coverage: "10/10",
    projectId: FOREIGN, projectIds: `${FOREIGN},${SIBLING}`, pmoId: PMO_2,
  });
  const tamperedRes = await handleGetPmoAttention(get(params.toString()), PMO_1, tampered.deps);
  const tamperedBody = await tamperedRes.json();
  assert.equal(tamperedRes.status, 200);
  assert.deepEqual(tamperedBody.attention, cleanBody.attention, "caller-supplied values must not alter the server-derived projection");
  assert.equal(tamperedBody.attention.assessmentDigest, cleanBody.attention.assessmentDigest);
  assert.equal(tamperedRes.headers.get("cache-control"), "no-store");

  // The pure builder has no metric input either: extra fields are inert.
  const w = world();
  const fake = fakeClient(w.tables);
  const base = await loadPmoPortfolioAttention(fake.client, { workspaceId: WS_A, pmoId: PMO_1, projects: w.pmo1Projects }, { evaluatedAt: EVAL });
  const rows = w.pmo1Projects.map((p) => ({ ...p, healthScore: 100, riskScore: 0, priority: "low", attentionScore: 0 }));
  const injected = await loadPmoPortfolioAttention(fakeClient(w.tables).client, { workspaceId: WS_A, pmoId: PMO_1, projects: rows as never }, { evaluatedAt: EVAL });
  assert.equal(injected.assessmentDigest, base.assessmentDigest);
});

// ── Tenancy and PMO scope ────────────────────────────────────────────────────────────────

test("P2-17: only this PMO's projects in this workspace are read or disclosed", async () => {
  const { attention, queries } = await project();
  const text = JSON.stringify(attention);
  for (const secret of ["Sibling Secret", "Foreign Secret", "SIBLING SECRET", "FOREIGN SECRET", SIBLING, FOREIGN, "Completed project risk"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  const allowed = new Set([ATLAS, ORION, QUIET, BARE]);
  for (const q of queries) {
    assert.ok(q.filters.some((f) => f.op === "eq" && f.column === "workspace_id" && f.value === WS_A), `${q.table} read without the workspace boundary`);
    const scoped = q.filters.filter((f) => f.column === "project_id");
    assert.ok(scoped.length > 0, `${q.table} read without a project scope`);
    for (const f of scoped) {
      const values = f.op === "in" ? (f.value as string[]) : [f.value as string];
      for (const v of values) assert.ok(allowed.has(v), `${q.table} read project ${v} outside the PMO's evaluated scope`);
    }
  }
});

test("P2-17: rows for another PMO smuggled into the input are dropped by the in-memory guard", async () => {
  const w = world();
  const smuggled = [...w.pmo1Projects, w.tables.projects.find((p) => p.id === SIBLING) as unknown as PmoProjectRow];
  const fake = fakeClient(w.tables);
  const attention = await loadPmoPortfolioAttention(fake.client, { workspaceId: WS_A, pmoId: PMO_1, projects: smuggled }, { evaluatedAt: EVAL });
  assert.ok(!find(attention, SIBLING));
  assert.ok(!JSON.stringify(attention).includes("SIBLING SECRET"));
  assert.equal(attention.membership.projectCount, 5);
});

test("P2-17: a foreign PMO id, a mismatched workspace claim and a cross-tenant PMO are indistinguishable 404s", async () => {
  const cases = [
    { name: "cross-tenant PMO", pmoId: PMO_B, ws: WS_B },
    { name: "cross-tenant PMO under own workspace claim", pmoId: PMO_B, ws: WS_A },
    { name: "own PMO under foreign workspace claim", pmoId: PMO_1, ws: WS_B },
    { name: "unknown PMO", pmoId: u("dead"), ws: WS_A },
  ];
  const bodies = new Set<string>();
  for (const c of cases) {
    const r = routeDeps();
    const res = await handleGetPmoAttention(new NextRequest(`http://localhost/api/pmos/${c.pmoId}/attention?workspaceId=${c.ws}`), c.pmoId, r.deps);
    assert.equal(res.status, 404, c.name);
    const body = await res.text();
    bodies.add(body);
    assert.equal(r.loads.length, 0, `${c.name}: nothing may be loaded before authorization`);
    assert.equal(r.queries.length, 0, `${c.name}: no data read before authorization`);
    assert.ok(!body.includes("Foreign") && !body.includes(WS_B) && !body.includes(PMO_B));
  }
  assert.equal(bodies.size, 1, "every refusal must be byte-identical");

  const unauth = routeDeps(world(), { authenticate: async () => null });
  const res = await handleGetPmoAttention(get(`workspaceId=${WS_A}`), PMO_1, unauth.deps);
  assert.equal(res.status, 401);
  assert.equal(unauth.loads.length, 0);
});

test("P2-17: the authorized workspace — never the routed claim — scopes the load", async () => {
  const r = routeDeps();
  const res = await handleGetPmoAttention(get(`workspaceId=${WS_A}`), PMO_1, r.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(r.loads, [{ workspaceId: WS_A, pmoId: PMO_1, projectIds: [ATLAS, ORION, QUIET, BARE, DONE] }]);
  // The project list itself was read with workspace AND exact pmo_id filters.
  const projectsQuery = r.queries.find((q) => q.table === "projects")!;
  assert.deepEqual(projectsQuery.filters.map((f) => [f.column, f.value]), [["workspace_id", WS_A], ["pmo_id", PMO_1]]);
});

test("P2-17: drill-down into a cross-tenant project id is refused by the canonical project resolver", async () => {
  const granted: RoutedWorkspaceAccess = { access: "granted", workspaceId: WS_A, role: "viewer", readOnly: false };
  // A viewer of WS_A crafting /workspaces/WS_A/projects/FOREIGN/...: FOREIGN's real parent is WS_B.
  const foreign = decideRoutedProjectAccess({ routedWorkspaceId: WS_A, projectId: FOREIGN, project: { workspaceId: WS_B, status: "active" } as never, workspaceAccess: null });
  assert.equal(foreign.access, "denied");
  const mismatch = decideRoutedProjectAccess({ routedWorkspaceId: WS_A, projectId: FOREIGN, project: { workspaceId: WS_B, status: "active" } as never, workspaceAccess: granted });
  assert.equal(mismatch.access, "denied");
  // Every drill-down the projection emits resolves under its own workspace.
  const { attention } = await project();
  for (const p of [...attention.attention, ...attention.quiet, ...attention.notAssessed]) {
    const decision = decideRoutedProjectAccess({ routedWorkspaceId: WS_A, projectId: p.projectId, project: { workspaceId: WS_A, status: "active" } as never, workspaceAccess: granted });
    assert.equal(decision.access, "granted");
    assert.ok(p.drillDown.project.includes(`/workspaces/${WS_A}/projects/${p.projectId}/`));
  }
});

// ── Stale / degraded ─────────────────────────────────────────────────────────────────────

test("P2-17: a schedule changed after its exposure was recorded is superseded, never current", async () => {
  const { attention } = await project(world({ atlasTitleSuffixNow: " (renamed)" }));
  const atlas = find(attention, ATLAS)!;
  const schedule = atlas.reasons.find((r) => r.kind === "schedule_exposure")!;
  assert.equal(schedule.freshness.state, "stale");
  assert.match(schedule.freshness.basis, /superseded/);
  assert.ok(atlas.missingInputs.some((m) => m.code === "schedule_reevaluation_needed"));
  assert.equal(atlas.freshness, "stale");
  assert.ok(attention.qualifications.includes("stale_inputs"));
  assert.notEqual(attention.state, "current");
});

test("P2-17: stale Evidence, an elapsed validity window and unreadable support are labelled, not presented as current", async () => {
  const w = world();
  (w.tables.evidence_items.find((e) => e.id === u("e1a")) as Row).freshness_state = "STALE";
  const staleEvidence = await project(w);
  const finding = find(staleEvidence.attention, ATLAS)!.reasons.find((r) => r.kind === "open_finding")!;
  assert.equal(finding.freshness.state, "stale");
  assert.ok(staleEvidence.attention.qualifications.includes("stale_inputs"));

  // Evidence recorded CURRENT whose validity window has since elapsed is stale at evaluation
  // time (the repository's stale_at-against-server-clock convention), even though the frozen
  // freshness_state still reads CURRENT.
  const lapsed = world();
  (lapsed.tables.evidence_items.find((e) => e.id === u("e1a")) as Row).stale_at = "2026-10-19T00:00:00.000Z";
  const lapsedFinding = find((await project(lapsed)).attention, ATLAS)!.reasons.find((r) => r.kind === "open_finding")!;
  assert.equal(lapsedFinding.freshness.state, "stale");
  assert.match(lapsedFinding.freshness.basis, /validity ended 2026-10-19/);

  // The Observation's stale_at is 2026-11-01: current at EVAL, stale once the clock passes it.
  const before = await project();
  const orionOutcome = find(before.attention, ORION)!.reasons.find((r) => r.kind === "outcome_divergence")!;
  assert.equal(orionOutcome.freshness.state, "current");
  assert.deepEqual(orionOutcome.confidence, { value: 0.7, scale: "unit_interval", source: "canonical_outcome_observations.confidence_score" });
  assert.equal(before.attention.nextFreshnessDeadline, "2026-11-01T00:00:00.000Z");
  const after = await project(world(), { evaluatedAt: "2026-11-02T00:00:00.000Z" });
  assert.equal(find(after.attention, ORION)!.reasons.find((r) => r.kind === "outcome_divergence")!.freshness.state, "stale");
  assert.notEqual(after.attention.assessmentDigest, before.attention.assessmentDigest, "an elapsed validity window is a material change");

  // Supporting Signals unreadable → freshness unknown, never assumed current.
  const unknown = await project(world(), { fail: ["operational_signals"] });
  const findingUnknown = find(unknown.attention, ATLAS)!.reasons.find((r) => r.kind === "open_finding")!;
  assert.equal(findingUnknown.freshness.state, "unknown");
  assert.equal(findingUnknown.confidence, null);
  assert.ok(unknown.attention.qualifications.includes("stale_inputs"));
});

test("P2-17: a failed canonical read degrades the affected dimension and the portfolio conclusion", async () => {
  const { attention } = await project(world(), { fail: ["risk_issue_records"] });
  assert.equal(find(attention, ATLAS)!.dimensions.findings, "unavailable");
  assert.ok(!find(attention, ATLAS)!.reasons.some((r) => r.kind === "open_finding"));
  assert.equal(attention.coverage.dimensions.findings.unavailable, 3);
  assert.ok(attention.qualifications.includes("degraded_dimension"));
  assert.equal(attention.state, "partial");
  assert.equal(attention.coverage.complete, false);

  // Every per-project read failing leaves projects UNAVAILABLE — not "missing inputs", not quiet.
  const down = await project(world(), { fail: ["evidence_items", "canonical_task_outcomes", "execution_tasks"] });
  assert.equal(down.attention.coverage.qualified, 0);
  assert.equal(down.attention.coverage.unavailable, 4);
  assert.equal(down.attention.quiet.length, 0);
  assert.equal(down.attention.state, "partial");
});

test("P2-17: a full page of rows is reported as truncated, never as a complete count", () => {
  const rows = Array.from({ length: PMO_ATTENTION_ROW_CAP }, (_, i) => ({ id: u(`9${i}`), project_id: ATLAS, signal_id: u("11a"), type: "risk", title: `r${i}`, severity: "high", status: "open", updated_at: day(6) }));
  const attention = buildPmoPortfolioAttention({
    workspaceId: WS_A, pmoId: PMO_1, evaluatedAt: EVAL,
    projects: [{ id: ATLAS, name: "Atlas", status: "active" }],
    perProject: { [ATLAS]: { evidenceBasis: { canonical: 1, live: 1 }, outcomeCount: 0, schedule: { exposures: [], currentSnapshotDigest: "sha256:x" } } },
    batch: {
      risks: { ok: true, rows, truncated: true },
      recommendations: { ok: true, rows: [], truncated: false },
      outcomes: { ok: true, rows: [], truncated: false },
      observations: { ok: true, rows: [], truncated: false },
      signals: { ok: true, rows: [], truncated: false },
      evidence: { ok: true, rows: [], truncated: false },
    },
  });
  assert.equal(attention.attention[0].dimensions.findings, "truncated");
  assert.ok(attention.qualifications.includes("degraded_dimension"));
  assert.equal(attention.coverage.complete, false);
});

test("P2-17: DEMO / FIXTURE records are labelled wherever they surface", async () => {
  const w = world();
  (w.tables.evidence_items.find((e) => e.id === u("e1a")) as Row).fixture_state = "DEMO_FIXTURE";
  const { attention } = await project(w);
  const finding = find(attention, ATLAS)!.reasons.find((r) => r.kind === "open_finding")!;
  assert.equal(finding.fixture, true);
  assert.equal(find(attention, ATLAS)!.fixture, true);
  assert.equal(attention.fixture, true);
  assert.ok(attention.qualifications.includes("fixture_data"));
  const live = await project();
  assert.equal(live.attention.fixture, false);
});

test("P2-17: every published rule has a distinct id and a level from the fixed vocabulary", () => {
  const ids = PMO_ATTENTION_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of PMO_ATTENTION_RULES) assert.ok(["critical", "high", "medium", "low"].includes(r.level));
});
