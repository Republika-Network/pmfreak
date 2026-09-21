/**
 * P2-17 — Qualified Portfolio Projection loader (server).
 *
 * Reads the canonical project state the PMO attention projection is built from, then hands it
 * to the pure builder in `./pmo-portfolio-attention`. Nothing is written.
 *
 * SCOPE AND CLIENT
 * ----------------
 * Every read runs on the CALLER'S request-scoped (RLS) client — the same one the PMO Command
 * Center already uses — and carries two filters: the authoritative workspace id and the exact
 * set of this PMO's own project ids. RLS keys on workspace membership, so it guarantees the
 * tenant boundary; the project-id filter is what keeps a sibling PMO's projects out, exactly as
 * `pmo-command-center-rollup.ts` does for RAID. No service-role client is used here: the
 * privileged read in this route family is `resolveRoutedPmo`'s ancestry lookup, and it happens
 * before this loader is reached.
 *
 * The P2-16 schedule contract is consumed through its own read functions
 * (`loadScheduleInputs`, `listScheduleExposures`, `computeScheduleSnapshot`) without change.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeScheduleSnapshot } from "@/lib/critical-path/schedule-exposure";
import { listScheduleExposures, loadScheduleInputs } from "@/lib/critical-path/schedule-exposure-service";
import { selectPmoProjects, type PmoProjectRow } from "./pmo-command-center-rollup";
import {
  PMO_ATTENTION_ROW_CAP,
  buildPmoPortfolioAttention,
  selectEvaluatedProjectIds,
  type PmoCollection,
  type PmoEvidenceRow,
  type PmoObservationRow,
  type PmoOutcomeRow,
  type PmoPortfolioAttention,
  type PmoProjectSignalInput,
  type PmoRecommendationRow,
  type PmoRiskRow,
  type PmoSignalRow,
} from "./pmo-portfolio-attention";

type Client = SupabaseClient;

export type PmoAttentionScope = {
  /** Authoritative workspace (from `resolveRoutedPmo`), never a routed claim. */
  workspaceId: string;
  pmoId: string;
  /** The PMO's projects as read by `pmoProjectsQuery`; re-guarded here by exact pmo_id. */
  projects: readonly PmoProjectRow[];
};

export type PmoAttentionLoaderDeps = {
  loadScheduleInputs: typeof loadScheduleInputs;
  listScheduleExposures: typeof listScheduleExposures;
};

const defaultDeps: PmoAttentionLoaderDeps = { loadScheduleInputs, listScheduleExposures };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNRESOLVED_RISK_STATUSES = ["open", "monitoring", "mitigated"];
const ATTENTION_RISK_SEVERITIES = ["high", "critical"];
const DIVERGENT_OUTCOME_STATES = ["not_achieved", "partially_achieved", "disputed"];
const PER_PROJECT_CONCURRENCY = 4;
const SCHEDULE_EXPOSURE_WINDOW = 20;

type Page = { data: unknown[] | null; error: { message: string } | null };

async function collection<T>(query: PromiseLike<Page>): Promise<PmoCollection<T>> {
  const { data, error } = await query;
  if (error) return { ok: false };
  const rows = (data ?? []) as T[];
  return { ok: true, rows: rows.slice(0, PMO_ATTENTION_ROW_CAP), truncated: rows.length > PMO_ATTENTION_ROW_CAP };
}

const EMPTY = <T>(): PmoCollection<T> => ({ ok: true, rows: [], truncated: false });

/**
 * Resolves a KNOWN, finite set of ids completely: one query per chunk of at most
 * PMO_ATTENTION_ROW_CAP ids, each limited to its own chunk size. An id-keyed provenance lookup
 * must never silently keep only the first page of ids it was asked for. Any failed chunk fails
 * the whole lookup, so a partial result is never mistaken for a complete one.
 */
async function lookupByIds<T extends { id: string }>(ids: readonly string[], query: (chunk: string[]) => PromiseLike<Page>): Promise<PmoCollection<T>> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += PMO_ATTENTION_ROW_CAP) {
    const chunk = ids.slice(start, start + PMO_ATTENTION_ROW_CAP);
    const { data, error } = await query(chunk);
    if (error) return { ok: false };
    rows.push(...((data ?? []) as T[]));
  }
  return { ok: true, rows: rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), truncated: false };
}

async function count(query: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number | null> {
  const { count: n, error } = await query;
  return error || n === null ? null : n;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadProjectSignals(client: Client, workspaceId: string, projectId: string, deps: PmoAttentionLoaderDeps): Promise<PmoProjectSignalInput> {
  const scope = { workspaceId, projectId };
  const evidenceCount = (liveOnly: boolean) => {
    let q = client.from("evidence_items").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("project_id", projectId)
      .not("normalized_event_id", "is", null);
    if (liveOnly) q = q.eq("fixture_state", "LIVE");
    return count(q);
  };
  const schedule = (async () => {
    try {
      const inputs = await deps.loadScheduleInputs(client, scope);
      const current = computeScheduleSnapshot(inputs.tasks, inputs.dependencies.filter((d) => d.status === "active"), inputs.milestones);
      const exposures = await deps.listScheduleExposures(client, scope, SCHEDULE_EXPOSURE_WINDOW);
      return { exposures, currentSnapshotDigest: current.digest };
    } catch {
      return null;
    }
  })();
  const [canonical, live, outcomeCount, scheduleResult] = await Promise.all([
    evidenceCount(false),
    evidenceCount(true),
    count(client.from("canonical_task_outcomes").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("project_id", projectId)),
    schedule,
  ]);
  return {
    evidenceBasis: canonical === null || live === null ? null : { canonical, live },
    outcomeCount,
    schedule: scheduleResult,
  };
}

export async function loadPmoPortfolioAttention(
  client: Client,
  scope: PmoAttentionScope,
  options: { evaluatedAt?: string; deps?: Partial<PmoAttentionLoaderDeps> } = {},
): Promise<PmoPortfolioAttention> {
  const deps: PmoAttentionLoaderDeps = { ...defaultDeps, ...options.deps };
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const { workspaceId, pmoId } = scope;
  // In-memory guard, as in the rollup: a row that is not exactly this PMO's never enters.
  const projects = selectPmoProjects(scope.projects, pmoId);
  const ids = selectEvaluatedProjectIds(projects);

  const cap = PMO_ATTENTION_ROW_CAP + 1;
  const [risks, recommendations, outcomes] = ids.length === 0
    ? [EMPTY<PmoRiskRow>(), EMPTY<PmoRecommendationRow>(), EMPTY<PmoOutcomeRow>()]
    : await Promise.all([
        collection<PmoRiskRow>(
          client.from("risk_issue_records").select("id,project_id,signal_id,type,title,severity,status,updated_at")
            .eq("workspace_id", workspaceId).in("project_id", ids)
            .in("status", UNRESOLVED_RISK_STATUSES).in("severity", ATTENTION_RISK_SEVERITIES)
            .order("id", { ascending: true }).limit(cap),
        ),
        collection<PmoRecommendationRow>(
          client.from("recommended_actions").select("id,project_id,title,recommendation,urgency,confidence_score,source_signal_id,created_at")
            .eq("workspace_id", workspaceId).in("project_id", ids)
            .eq("status", "proposed").not("governance_event_id", "is", null)
            .order("id", { ascending: true }).limit(cap),
        ),
        collection<PmoOutcomeRow>(
          client.from("canonical_task_outcomes").select("id,project_id,task_id,state,expected_result,updated_at,fixture_label")
            .eq("workspace_id", workspaceId).in("project_id", ids)
            .in("state", DIVERGENT_OUTCOME_STATES)
            .order("id", { ascending: true }).limit(cap),
        ),
      ]);

  const outcomeIds = outcomes.ok ? outcomes.rows.map((o) => o.id) : [];
  const signalIds = [
    ...new Set([
      ...(risks.ok ? risks.rows.map((r) => r.signal_id) : []),
      ...(recommendations.ok ? recommendations.rows.map((r) => r.source_signal_id ?? "") : []),
    ]),
  ].filter((id) => UUID_PATTERN.test(id)).sort();

  const [observations, signals] = await Promise.all([
    outcomeIds.length === 0
      ? EMPTY<PmoObservationRow>()
      : collection<PmoObservationRow>(
          client.from("canonical_outcome_observations")
            .select("id,project_id,outcome_id,observation_state,confidence_score,missing_data_state,observed_at,stale_at,recorded_at,fixture_label")
            .eq("workspace_id", workspaceId).in("project_id", ids).in("outcome_id", outcomeIds)
            .order("id", { ascending: true }).limit(cap),
        ),
    lookupByIds<PmoSignalRow>(signalIds, (chunk) =>
      client.from("operational_signals").select("id,project_id,evidence_item_id,confidence_score,signal_type")
        .eq("workspace_id", workspaceId).in("project_id", ids).in("id", chunk)
        .order("id", { ascending: true }).limit(chunk.length),
    ),
  ]);

  const evidenceIds = [...new Set(signals.ok ? signals.rows.map((s) => s.evidence_item_id) : [])].sort();
  const evidence = await lookupByIds<PmoEvidenceRow>(evidenceIds, (chunk) =>
    client.from("evidence_items").select("id,project_id,source_type,fixture_state,freshness_state,lifecycle,stale_at")
      .eq("workspace_id", workspaceId).in("project_id", ids).in("id", chunk)
      .order("id", { ascending: true }).limit(chunk.length),
  );

  const perProjectList = await mapLimited(ids, PER_PROJECT_CONCURRENCY, (projectId) => loadProjectSignals(client, workspaceId, projectId, deps));
  const perProject = Object.fromEntries(ids.map((id, index) => [id, perProjectList[index]]));

  return buildPmoPortfolioAttention({
    workspaceId,
    pmoId,
    projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    evaluatedAt,
    perProject,
    batch: { risks, recommendations, outcomes, observations, signals, evidence },
  });
}
