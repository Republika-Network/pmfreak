"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type {
  PMOExecutiveReport,
  PMOAlertPayload,
  ReportType,
  ExecutiveReportSection,
} from "@/lib/pmo-executive-reporting";
import { PM_OPERATIONS_PATH } from "@/lib/pm-operations/pm-operations-paths";

// ─── Style maps ───────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  healthy:             "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  watch:               "bg-amber-500/20 text-amber-700 border-amber-500/30",
  attention_required:  "bg-orange-500/20 text-orange-700 border-orange-500/30",
  critical:            "bg-red-600/20 text-red-700 border-red-600/30",
  informational:       "bg-zinc-500/20 text-zinc-700 border-zinc-500/30",
};

const RISK_STYLES: Record<string, string> = {
  low:      "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  medium:   "bg-amber-500/20 text-amber-700 border-amber-500/30",
  high:     "bg-orange-500/20 text-orange-700 border-orange-500/30",
  critical: "bg-red-600/20 text-red-700 border-red-600/30",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-600/20 text-red-700 border-red-600/30",
  high:     "bg-orange-500/20 text-orange-700 border-orange-500/30",
  medium:   "bg-amber-500/20 text-amber-700 border-amber-500/30",
  low:      "bg-zinc-500/20 text-zinc-700 border-zinc-500/30",
};

const ALERT_STATUS_STYLES: Record<string, string> = {
  new:      "bg-blue-500/20 text-blue-700 border-blue-500/30",
  reviewed: "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  archived: "bg-zinc-600/20 text-zinc-600 border-zinc-600/30",
};

const SEVERITY_GROUPS = ["critical", "high", "medium", "low"] as const;

// ─── Shared components ────────────────────────────────────────────────────────

function Badge({ value, styles }: { value: string; styles: Record<string, string> }) {
  const cls = styles[value] ?? "bg-zinc-500/20 text-zinc-700 border-zinc-500/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function SummaryCard({ label, value, highlight, sub }: { label: string; value: string | number; highlight?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-zinc-600">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${highlight ?? "text-slate-900"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function SectionCard({ section }: { section: ExecutiveReportSection }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
        <Badge value={section.status} styles={STATUS_STYLES} />
      </div>
      <p className="text-xs text-zinc-600 mb-3">{section.summary}</p>
      {section.highlights.length > 0 && (
        <ul className="space-y-1">
          {section.highlights.map((h, i) => (
            <li key={i} className="text-xs text-zinc-700">• {h}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PMOExecutiveReportingPage() {
  const [reports, setReports] = useState<PMOExecutiveReport[]>([]);
  const [alerts, setAlerts] = useState<PMOAlertPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [generatingAlerts, setGeneratingAlerts] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportType, setReportType] = useState<ReportType>("daily_pmo_brief");

  const latest = reports[0] ?? null;

  const fetchAll = useCallback(async () => {
    try {
      const [reportsRes, alertsRes] = await Promise.all([
        fetch("/api/pmo-executive-reports?limit=20"),
        fetch("/api/pmo-alerts?limit=200"),
      ]);
      const reportsJson = await reportsRes.json();
      const alertsJson = await alertsRes.json();
      if (reportsJson.ok) setReports(reportsJson.data);
      else setError(reportsJson.error?.message ?? "Failed to load reports.");
      if (alertsJson.ok) setAlerts(alertsJson.data);
    } catch {
      setError("Network error loading data.");
    } finally {
      setLoading(false);
    }
  }, []);

  // fetchAll is stable (useCallback with [] deps) — calling it here is intentional
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchAll(); }, [fetchAll]);

  async function handleGenerateReport() {
    setGeneratingReport(true);
    setError(null);
    try {
      const res = await fetch("/api/pmo-executive-reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportType }),
      });
      const json = await res.json();
      if (json.ok) await fetchAll();
      else setError(json.error?.message ?? "Report generation failed.");
    } catch {
      setError("Network error during report generation.");
    } finally {
      setGeneratingReport(false);
    }
  }

  async function handleGenerateAlerts() {
    setGeneratingAlerts(true);
    setError(null);
    try {
      const res = await fetch("/api/pmo-alerts/generate", { method: "POST" });
      const json = await res.json();
      if (json.ok) await fetchAll();
      else setError(json.error?.message ?? "Alert generation failed.");
    } catch {
      setError("Network error during alert generation.");
    } finally {
      setGeneratingAlerts(false);
    }
  }

  async function handleReview(alertId: string) {
    setReviewing(true);
    try {
      const res = await fetch(`/api/pmo-alerts/${alertId}/review`, { method: "POST" });
      const json = await res.json();
      if (json.ok) setAlerts((prev) => prev.map((a) => (a.id === alertId ? json.data : a)));
      else setError(json.error?.message ?? "Review failed.");
    } catch {
      setError("Network error reviewing alert.");
    } finally {
      setReviewing(false);
    }
  }

  const metrics = latest?.keyMetrics ?? null;
  const newAlertCount = alerts.filter((a) => a.status === "new").length;
  const criticalAlertCount = alerts.filter((a) => a.severity === "critical").length;
  const highAlertCount = alerts.filter((a) => a.severity === "high").length;

  return (
    <div className="min-h-screen bg-zinc-950 text-slate-900 p-6 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">PMO Executive Reporting & Alerts</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Executive-facing PMO reports and alert payloads derived deterministically from PM Operations, governance compliance, and the intervention action loop. Read-only — no external notifications are sent.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-600">
            <Link href={PM_OPERATIONS_PATH} className="hover:text-slate-900">PM Operations</Link>
            <span>·</span>
            <Link href="/pmo-governance-compliance" className="hover:text-slate-900">Governance Compliance</Link>
            <span>·</span>
            <Link href="/pmo-interventions" className="hover:text-slate-900">Interventions</Link>
            <span>·</span>
            <Link href="/pm-registry" className="hover:text-slate-900">PM Registry</Link>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 shrink-0">
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="rounded-xl border border-slate-200 bg-zinc-900 px-3 py-2 text-sm text-zinc-700 focus:outline-none"
          >
            {([
              "daily_pmo_brief","weekly_pmo_review","executive_risk_summary",
              "governance_compliance_report","intervention_status_report","board_ready_summary",
            ] as ReportType[]).map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
            ))}
          </select>
          <button
            onClick={handleGenerateReport}
            disabled={generatingReport}
            className="rounded-xl border border-blue-500/30 bg-blue-600/20 px-4 py-2 text-sm text-blue-700 hover:bg-blue-600/30 disabled:opacity-50"
          >
            {generatingReport ? "Generating..." : "Generate Report"}
          </button>
          <button
            onClick={handleGenerateAlerts}
            disabled={generatingAlerts}
            className="rounded-xl border border-orange-500/30 bg-orange-600/20 px-4 py-2 text-sm text-orange-700 hover:bg-orange-600/30 disabled:opacity-50"
          >
            {generatingAlerts ? "Generating..." : "Generate Alerts"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-600/10 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Executive status cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-zinc-600">Executive Status</p>
          <div className="mt-2">{latest ? <Badge value={latest.executiveStatus} styles={STATUS_STYLES} /> : <span className="text-zinc-500 text-sm">—</span>}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-zinc-600">Executive Risk</p>
          <div className="mt-2">{latest ? <Badge value={latest.executiveRisk} styles={RISK_STYLES} /> : <span className="text-zinc-500 text-sm">—</span>}</div>
        </div>
        <SummaryCard label="Compliance Score" value={metrics?.compliance_score ?? "—"} sub={metrics?.compliance_status ?? undefined} />
        <SummaryCard label="Open Interventions" value={metrics?.open_interventions ?? 0} />
        <SummaryCard label="Pending Approvals" value={metrics?.pending_approval_interventions ?? 0} highlight="text-amber-700" />
        <SummaryCard label="Critical Alerts" value={criticalAlertCount} highlight="text-red-700" />
        <SummaryCard label="High Alerts" value={highAlertCount} highlight="text-orange-700" />
        <SummaryCard
          label="Last Report Generated"
          value={latest ? new Date(latest.generatedAt).toLocaleDateString() : "—"}
          sub={latest ? new Date(latest.generatedAt).toLocaleTimeString() : undefined}
        />
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500 text-center py-12">Loading...</div>
      ) : (
        <>
          {/* Executive summary */}
          {latest?.executiveSummary && (
            <section>
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Executive Summary</h2>
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
                <p className="text-base font-medium text-slate-900">{latest.executiveSummary.headline}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-zinc-700">
                  <p><span className="text-zinc-500">Status:</span> {latest.executiveSummary.status_summary}</p>
                  <p><span className="text-zinc-500">Risk:</span> {latest.executiveSummary.risk_summary}</p>
                  <p><span className="text-zinc-500">Governance:</span> {latest.executiveSummary.governance_summary}</p>
                  <p><span className="text-zinc-500">Interventions:</span> {latest.executiveSummary.intervention_summary}</p>
                  <p><span className="text-zinc-500">Evidence:</span> {latest.executiveSummary.evidence_summary}</p>
                </div>
                {latest.executiveSummary.leadership_attention.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Leadership Attention</p>
                    <ul className="space-y-1">
                      {latest.executiveSummary.leadership_attention.map((l, i) => (
                        <li key={i} className="text-sm text-zinc-800">• {l}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Report sections */}
          {latest && latest.sections.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Report Sections</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {latest.sections.map((s) => <SectionCard key={s.key} section={s} />)}
              </div>
            </section>
          )}

          {/* Alerts grouped by severity */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-slate-900">Alerts</h2>
              <span className="text-xs text-zinc-600">{newAlertCount} new</span>
            </div>
            {alerts.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
                <p className="text-zinc-600 text-sm">No alerts found.</p>
                <p className="text-zinc-500 text-xs mt-2">Use &ldquo;Generate Alerts&rdquo; to derive alerts from current PMO state.</p>
              </div>
            ) : (
              <div className="space-y-6">
                {SEVERITY_GROUPS.map((sev) => {
                  const group = alerts.filter((a) => a.severity === sev);
                  if (group.length === 0) return null;
                  return (
                    <div key={sev}>
                      <div className="mb-2 flex items-center gap-3">
                        <Badge value={sev} styles={SEVERITY_STYLES} />
                        <span className="rounded-full bg-slate-50 px-2 py-0.5 text-xs text-zinc-700">{group.length}</span>
                      </div>
                      <div className="space-y-2">
                        {group.map((a) => (
                          <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2 mb-1">
                                  <span className="text-xs text-zinc-600">{a.alertType.replace(/_/g, " ")}</span>
                                  <Badge value={a.status} styles={ALERT_STATUS_STYLES} />
                                </div>
                                <p className="text-sm font-medium text-slate-900">{a.title}</p>
                                <p className="text-xs text-zinc-600 mt-0.5">{a.message}</p>
                                {a.recommendedAction && (
                                  <p className="text-xs text-zinc-500 mt-1">Recommended: {a.recommendedAction}</p>
                                )}
                              </div>
                              {a.status === "new" && (
                                <button
                                  disabled={reviewing}
                                  onClick={() => handleReview(a.id)}
                                  className="shrink-0 rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-600/30 disabled:opacity-50"
                                >
                                  Mark Reviewed
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Report history */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">Report History</h2>
            {reports.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
                <p className="text-zinc-600 text-sm">No reports generated yet.</p>
                <p className="text-zinc-500 text-xs mt-2">Use &ldquo;Generate Report&rdquo; to create your first executive report.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {reports.map((r) => (
                  <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{r.reportTitle ?? r.reportType}</p>
                      <p className="text-xs text-zinc-600">{new Date(r.generatedAt).toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge value={r.executiveStatus} styles={STATUS_STYLES} />
                      <Badge value={r.executiveRisk} styles={RISK_STYLES} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
