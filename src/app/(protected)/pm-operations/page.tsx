"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type {
  PMOCommandCenterView,
  PMOAttentionItem,
  PMODossierRow,
  PMORecommendation,
  PMOEventTimelineItem,
} from "@/lib/pmo-command-center";

// ─── Style maps ───────────────────────────────────────────────────────────────

const PMO_STATUS_STYLES: Record<string, string> = {
  healthy:              "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  watch:                "bg-amber-500/20 text-amber-700 border-amber-500/30",
  capacity_pressure:    "bg-orange-500/20 text-orange-700 border-orange-500/30",
  performance_pressure: "bg-red-500/20 text-red-700 border-red-500/30",
  evidence_gap:         "bg-sky-500/20 text-sky-700 border-sky-500/30",
  critical:             "bg-red-600/20 text-red-700 border-red-600/30",
};

const OPERATIONAL_STATUS_STYLES: Record<string, string> = {
  healthy:               "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  watch:                 "bg-amber-500/20 text-amber-700 border-amber-500/30",
  capacity_risk:         "bg-orange-500/20 text-orange-700 border-orange-500/30",
  performance_risk:      "bg-red-500/20 text-red-700 border-red-500/30",
  insufficient_evidence: "bg-sky-500/20 text-sky-700 border-sky-500/30",
  critical:              "bg-red-600/20 text-red-700 border-red-600/30",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-600/20 text-red-700 border-red-600/30",
  high:     "bg-orange-500/20 text-orange-700 border-orange-500/30",
  medium:   "bg-amber-500/20 text-amber-700 border-amber-500/30",
  low:      "bg-zinc-500/20 text-zinc-700 border-zinc-500/30",
};

const CAPACITY_STATUS_STYLES: Record<string, string> = {
  underutilized: "bg-sky-500/20 text-sky-700 border-sky-500/30",
  healthy:       "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  near_capacity: "bg-amber-500/20 text-amber-700 border-amber-500/30",
  at_capacity:   "bg-orange-500/20 text-orange-700 border-orange-500/30",
  overloaded:    "bg-red-500/20 text-red-700 border-red-500/30",
  busy:          "bg-amber-500/20 text-amber-700 border-amber-500/30",
  critical:      "bg-red-500/20 text-red-700 border-red-500/30",
};

// ─── Shared components ────────────────────────────────────────────────────────

function StatusBadge({ value, styles }: { value: string; styles: Record<string, string> }) {
  const cls = styles[value] ?? "bg-zinc-500/20 text-zinc-700 border-zinc-500/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
  sub,
}: {
  label: string;
  value: string | number;
  highlight?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-zinc-600">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${highlight ?? "text-slate-900"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Attention Item component ─────────────────────────────────────────────────

function AttentionItemRow({ item }: { item: PMOAttentionItem }) {
  return (
    <tr className="hover:bg-white">
      <td className="px-4 py-3 font-medium text-slate-900">
        <Link href={item.dossier_url} className="hover:underline">{item.display_name}</Link>
      </td>
      <td className="px-4 py-3 text-zinc-600 text-xs">{item.email}</td>
      <td className="px-4 py-3">
        <StatusBadge value={item.operational_status} styles={OPERATIONAL_STATUS_STYLES} />
      </td>
      <td className="px-4 py-3">
        {item.capacity_status ? (
          <StatusBadge value={item.capacity_status} styles={CAPACITY_STATUS_STYLES} />
        ) : (
          <span className="text-zinc-400 text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {item.performance_status ? (
          <StatusBadge value={item.performance_status} styles={OPERATIONAL_STATUS_STYLES} />
        ) : (
          <span className="text-zinc-400 text-xs">—</span>
        )}
      </td>
      <td className="max-w-xs px-4 py-3 text-xs text-zinc-600 leading-relaxed">
        {item.top_recommendation ?? "—"}
      </td>
    </tr>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {count !== undefined && (
        <span className="rounded-full bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
          {count}
        </span>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type ActiveTab = "critical" | "capacity" | "performance" | "evidence" | "underutilized" | "high_performers";

/**
 * PM Operations — internal ops dashboard over a workspace's project managers.
 *
 * Renamed from `/pmo-command-center` per ADR-PMF-014 Rule 6: an internal surface
 * must not carry the same unqualified phrase as the user-facing PMO Command
 * Center, which is a different screen over a different entity. This screen's own
 * data says which it is — `PMOCommandCenterView` is keyed by `workspace_id` and
 * aggregates per-PM dossiers; there is no `pmos` row anywhere in it. The imported
 * type and API names keep their internal spelling, which ADR-PMF-014 Rule 5
 * expressly permits for internal identifiers while forbidding it in copy.
 *
 * See `@/lib/pm-operations/pm-operations-paths` for the full reasoning.
 */
export default function PmOperationsPage() {
  const [data, setData] = useState<PMOCommandCenterView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("critical");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pmo-command-center");
      const json = await res.json() as { ok: boolean; data?: PMOCommandCenterView; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Failed to load PM Operations.");
      } else {
        setData(json.data ?? null);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // fetchData is stable (useCallback with [] deps) — calling it here is intentional
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchData(); }, [fetchData]);

  const tabItems: Array<{ id: ActiveTab; label: string; count: number }> = data
    ? [
        { id: "critical",       label: "Critical",       count: data.attention_queues.critical_attention.length },
        { id: "capacity",       label: "Capacity",        count: data.attention_queues.capacity_attention.length },
        { id: "performance",    label: "Performance",     count: data.attention_queues.performance_attention.length },
        { id: "evidence",       label: "Evidence Gaps",   count: data.attention_queues.evidence_attention.length },
        { id: "underutilized",  label: "Underutilized",   count: data.attention_queues.underutilized_capacity.length },
        { id: "high_performers",label: "Top Performers",  count: data.attention_queues.high_performers.length },
      ]
    : [];

  const activeItems: PMOAttentionItem[] = data
    ? (
        activeTab === "critical"        ? data.attention_queues.critical_attention :
        activeTab === "capacity"        ? data.attention_queues.capacity_attention :
        activeTab === "performance"     ? data.attention_queues.performance_attention :
        activeTab === "evidence"        ? data.attention_queues.evidence_attention :
        activeTab === "underutilized"   ? data.attention_queues.underutilized_capacity :
        data.attention_queues.high_performers
      )
    : [];

  return (
    <div className="min-h-screen bg-[#08080c] px-6 py-10">
      <div className="mx-auto max-w-7xl space-y-10">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">PM Operations</h1>
            <p className="mt-1 text-sm text-zinc-600">
              Executive visibility into your Project Manager portfolio — capacity, performance, and evidence confidence.
            </p>
            <div className="mt-2 flex gap-3 text-xs text-zinc-500">
              <Link href="/pm-registry" className="hover:text-zinc-700 hover:underline">PM Registry</Link>
              <Link href="/pm-capacity" className="hover:text-zinc-700 hover:underline">Capacity</Link>
              <Link href="/pm-performance" className="hover:text-zinc-700 hover:underline">Performance</Link>
            </div>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-zinc-700 hover:bg-white disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !data && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-center">
            <p className="text-sm text-zinc-600">No PMO data available.</p>
            <p className="mt-1 text-xs text-zinc-400">Register Project Managers and generate capacity/performance snapshots to get started.</p>
          </div>
        )}

        {data && (
          <>
            {/* PMO Status banner */}
            {data.executive_summary.top_pmo_risk && (
              <div className={`rounded-xl border px-4 py-3 ${PMO_STATUS_STYLES[data.pmo_operational_status] ?? "border-slate-200 bg-white"}`}>
                <p className="text-sm font-medium">{data.executive_summary.top_pmo_risk}</p>
                {data.executive_summary.top_recommendation && (
                  <p className="mt-1 text-xs opacity-80">Recommendation: {data.executive_summary.top_recommendation}</p>
                )}
              </div>
            )}

            {/* Executive Summary Cards */}
            <div>
              <SectionHeader title="Executive Summary" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                <div className="rounded-xl border border-slate-200 bg-white p-4 col-span-2 sm:col-span-1">
                  <p className="text-xs text-zinc-600">PMO Status</p>
                  <div className="mt-2">
                    <StatusBadge
                      value={data.pmo_operational_status}
                      styles={PMO_STATUS_STYLES}
                    />
                  </div>
                </div>
                <SummaryCard label="Total PMs" value={data.executive_summary.total_pms} />
                <SummaryCard label="Active PMs" value={data.executive_summary.active_pms} highlight="text-emerald-700" />
                <SummaryCard label="Critical" value={data.executive_summary.critical_pms} highlight={data.executive_summary.critical_pms > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard label="Capacity Risk" value={data.executive_summary.capacity_risk_pms} highlight={data.executive_summary.capacity_risk_pms > 0 ? "text-orange-700" : "text-slate-900"} />
                <SummaryCard label="Perf Risk" value={data.executive_summary.performance_risk_pms} highlight={data.executive_summary.performance_risk_pms > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard
                  label="Avg Performance"
                  value={data.performance_overview.average_performance_score !== null
                    ? data.performance_overview.average_performance_score.toFixed(1)
                    : "—"}
                />
                <SummaryCard
                  label="Avg Capacity"
                  value={data.capacity_overview.average_capacity_utilization !== null
                    ? (data.capacity_overview.average_capacity_utilization * 100).toFixed(1) + "%"
                    : "—"}
                />
              </div>
            </div>

            {/* Attention Queues */}
            <div>
              <SectionHeader title="Attention Queues" />
              {/* Tabs */}
              <div className="mb-4 flex flex-wrap gap-2">
                {tabItems.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition-colors ${
                      activeTab === tab.id
                        ? "border-indigo-500/50 bg-indigo-500/20 text-indigo-700"
                        : "border-slate-200 bg-white text-zinc-600 hover:bg-slate-50"
                    }`}
                  >
                    {tab.label}
                    {tab.count > 0 && (
                      <span className="rounded-full bg-slate-50 px-1.5 py-0.5 text-xs">
                        {tab.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {activeItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center">
                  <p className="text-sm text-zinc-500">No items in this queue.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Project Manager</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Email</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Status</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Capacity</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Performance</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Top Recommendation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {activeItems.map((item) => (
                        <AttentionItemRow key={item.pm_id} item={item} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Capacity Overview */}
            <div>
              <SectionHeader title="Capacity Overview" count={data.capacity_overview.pms_with_capacity_snapshot} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 mb-4">
                <SummaryCard label="With Snapshot" value={data.capacity_overview.pms_with_capacity_snapshot} />
                <SummaryCard label="Underutilized" value={data.capacity_overview.underutilized_count} highlight="text-sky-700" />
                <SummaryCard label="Healthy" value={data.capacity_overview.healthy_capacity_count} highlight="text-emerald-700" />
                <SummaryCard label="Near Capacity" value={data.capacity_overview.near_capacity_count} highlight="text-amber-700" />
                <SummaryCard label="At Capacity" value={data.capacity_overview.at_capacity_count} highlight="text-orange-700" />
                <SummaryCard label="Overloaded" value={data.capacity_overview.overloaded_count} highlight={data.capacity_overview.overloaded_count > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard label="Missing" value={data.capacity_overview.pms_missing_capacity_snapshot} highlight={data.capacity_overview.pms_missing_capacity_snapshot > 0 ? "text-zinc-600" : "text-slate-900"} />
              </div>
              {data.capacity_overview.capacity_recommendations.length > 0 && (
                <ul className="space-y-1">
                  {data.capacity_overview.capacity_recommendations.map((r, i) => (
                    <li key={i} className="text-xs text-zinc-600">• {r}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* Performance Overview */}
            <div>
              <SectionHeader title="Performance Overview" count={data.performance_overview.pms_with_performance_snapshot} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 mb-4">
                <SummaryCard label="With Snapshot" value={data.performance_overview.pms_with_performance_snapshot} />
                <SummaryCard label="Excellent" value={data.performance_overview.excellent_count} highlight="text-emerald-700" />
                <SummaryCard label="Strong" value={data.performance_overview.strong_count} highlight="text-emerald-600" />
                <SummaryCard label="Stable" value={data.performance_overview.stable_count} />
                <SummaryCard label="Warning" value={data.performance_overview.warning_count} highlight={data.performance_overview.warning_count > 0 ? "text-amber-700" : "text-slate-900"} />
                <SummaryCard label="Critical" value={data.performance_overview.critical_count} highlight={data.performance_overview.critical_count > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard
                  label="Avg Score"
                  value={data.performance_overview.average_performance_score !== null
                    ? data.performance_overview.average_performance_score.toFixed(1)
                    : "—"}
                />
              </div>
              {data.performance_overview.performance_recommendations.length > 0 && (
                <ul className="space-y-1">
                  {data.performance_overview.performance_recommendations.map((r, i) => (
                    <li key={i} className="text-xs text-zinc-600">• {r}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* Evidence Confidence Overview */}
            <div>
              <SectionHeader title="Evidence Confidence" count={data.evidence_confidence_overview.pms_with_evidence_confidence} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 mb-4">
                <SummaryCard label="With Evidence" value={data.evidence_confidence_overview.pms_with_evidence_confidence} />
                <SummaryCard label="High Confidence" value={data.evidence_confidence_overview.high_confidence_count} highlight="text-emerald-700" />
                <SummaryCard label="Medium" value={data.evidence_confidence_overview.medium_confidence_count} highlight="text-amber-700" />
                <SummaryCard label="Low" value={data.evidence_confidence_overview.low_confidence_count} highlight={data.evidence_confidence_overview.low_confidence_count > 0 ? "text-orange-700" : "text-slate-900"} />
                <SummaryCard label="Very Low" value={data.evidence_confidence_overview.very_low_confidence_count} highlight={data.evidence_confidence_overview.very_low_confidence_count > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard label="Missing" value={data.evidence_confidence_overview.pms_missing_evidence_confidence} />
              </div>
              {data.evidence_confidence_overview.common_missing_sources.length > 0 && (
                <div className="mb-2">
                  <p className="text-xs text-zinc-500 mb-1">Common missing sources:</p>
                  <div className="flex flex-wrap gap-1">
                    {data.evidence_confidence_overview.common_missing_sources.map((s) => (
                      <span key={s.source} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-zinc-600">
                        {s.source} ({s.missing_count})
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {data.evidence_confidence_overview.evidence_recommendations.length > 0 && (
                <ul className="space-y-1">
                  {data.evidence_confidence_overview.evidence_recommendations.map((r, i) => (
                    <li key={i} className="text-xs text-zinc-600">• {r}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* Recommendation Queue */}
            {data.recommendation_queue.length > 0 && (
              <div>
                <SectionHeader title="Recommendation Queue" count={data.recommendation_queue.length} />
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Severity</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">PM</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Status</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Type</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Recommendation</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.recommendation_queue.slice(0, 50).map((rec: PMORecommendation, i: number) => (
                        <tr key={i} className="hover:bg-white">
                          <td className="px-4 py-3">
                            <StatusBadge value={rec.severity} styles={SEVERITY_STYLES} />
                          </td>
                          <td className="px-4 py-3 text-zinc-700">
                            {rec.pm_id ? (
                              <Link href={`/pm-registry/${rec.pm_id}`} className="hover:underline">
                                {rec.pm_name ?? rec.pm_id}
                              </Link>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-3">
                            {rec.operational_status ? (
                              <StatusBadge value={rec.operational_status} styles={OPERATIONAL_STATUS_STYLES} />
                            ) : (
                              <span className="text-zinc-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-500">{rec.type.replace(/_/g, " ")}</td>
                          <td className="max-w-sm px-4 py-3 text-xs text-zinc-700 leading-relaxed">{rec.message}</td>
                          <td className="px-4 py-3 text-xs text-zinc-500">{rec.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* PM Dossier Table */}
            <div>
              <SectionHeader title="PM Dossier Overview" count={data.pm_dossiers.length} />
              {data.pm_dossiers.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center">
                  <p className="text-sm text-zinc-500">No Project Managers found.</p>
                  <Link href="/pm-registry" className="mt-2 inline-block text-xs text-indigo-600 hover:underline">
                    Go to PM Registry
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">PM</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Status</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Operational</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Capacity</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Utilization</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Performance</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Score</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Evidence</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Assignments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.pm_dossiers.map((row: PMODossierRow) => (
                        <tr key={row.pm_id} className="hover:bg-white">
                          <td className="px-4 py-3">
                            <Link href={row.dossier_url} className="font-medium text-slate-900 hover:underline">
                              {row.display_name}
                            </Link>
                            <p className="text-xs text-zinc-500">{row.email}</p>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge value={row.pm_status} styles={OPERATIONAL_STATUS_STYLES} />
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge value={row.operational_status} styles={OPERATIONAL_STATUS_STYLES} />
                          </td>
                          <td className="px-4 py-3">
                            {row.capacity_status ? (
                              <StatusBadge value={row.capacity_status} styles={CAPACITY_STATUS_STYLES} />
                            ) : (
                              <span className="text-zinc-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-zinc-700 text-xs">
                            {row.capacity_utilization !== null
                              ? `${(row.capacity_utilization * 100).toFixed(1)}%`
                              : "—"}
                          </td>
                          <td className="px-4 py-3">
                            {row.performance_status ? (
                              <StatusBadge value={row.performance_status} styles={OPERATIONAL_STATUS_STYLES} />
                            ) : (
                              <span className="text-zinc-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-zinc-700 text-xs">
                            {row.overall_performance_score !== null
                              ? row.overall_performance_score.toFixed(1)
                              : "—"}
                          </td>
                          <td className="px-4 py-3">
                            {row.evidence_confidence_level ? (
                              <StatusBadge value={row.evidence_confidence_level} styles={CAPACITY_STATUS_STYLES} />
                            ) : (
                              <span className="text-zinc-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-zinc-600 text-xs">
                            {row.counted_assignment_count} counted / {row.active_assignment_count} active
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Event Timeline */}
            {data.event_timeline.length > 0 && (
              <div>
                <SectionHeader title="Event Timeline" count={data.event_timeline.length} />
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">When</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">PM</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Event</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Summary</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.event_timeline.map((ev: PMOEventTimelineItem, i: number) => (
                        <tr key={i} className="hover:bg-white">
                          <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap" title={new Date(ev.occurred_at).toLocaleString()}>
                            {timeAgo(ev.occurred_at)}
                          </td>
                          <td className="px-4 py-3 text-zinc-700 text-xs">
                            {ev.pm_id ? (
                              <Link href={`/pm-registry/${ev.pm_id}`} className="hover:underline">
                                {ev.pm_name ?? ev.pm_id}
                              </Link>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-500">
                            {ev.event_type.replace(/_/g, " ").toLowerCase()}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-600">{ev.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <p className="text-xs text-zinc-400">
              Generated at {new Date(data.generated_at).toLocaleString()} — Read-only aggregation. No recalculation performed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
