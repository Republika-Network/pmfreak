"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type {
  PMOGovernanceComplianceSnapshot,
  GovernanceViolation,
  GovernanceRecommendation,
  DomainAssessment,
} from "@/lib/pmo-governance-compliance";
import { PM_OPERATIONS_PATH } from "@/lib/pm-operations/pm-operations-paths";

// ─── Style maps ───────────────────────────────────────────────────────────────

const COMPLIANCE_STATUS_STYLES: Record<string, string> = {
  excellent:     "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  compliant:     "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  watch:         "bg-amber-500/20 text-amber-700 border-amber-500/30",
  non_compliant: "bg-orange-500/20 text-orange-700 border-orange-500/30",
  critical:      "bg-red-600/20 text-red-700 border-red-600/30",
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

const DOMAIN_LABELS: Record<string, string> = {
  pm_profile_completeness: "PM Profile Completeness",
  assignment_hygiene:      "Assignment Hygiene",
  capacity_governance:     "Capacity Governance",
  performance_governance:  "Performance Governance",
  evidence_readiness:      "Evidence Readiness",
  intervention_readiness:  "Intervention Readiness",
  dossier_completeness:    "Dossier Completeness",
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

function SummaryCard({ label, value, highlight, sub }: { label: string; value: string | number; highlight?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-zinc-600">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${highlight ?? "text-slate-900"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {count !== undefined && (
        <span className="rounded-full bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-zinc-700">{count}</span>
      )}
    </div>
  );
}

// ─── Domain card ──────────────────────────────────────────────────────────────

function DomainCard({ name, assessment }: { name: string; assessment: DomainAssessment }) {
  const topRec = assessment.recommendations[0]?.message ?? null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">{DOMAIN_LABELS[name] ?? name}</p>
        <span className="text-lg font-semibold text-slate-900">{assessment.score.toFixed(0)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge value={assessment.status} styles={COMPLIANCE_STATUS_STYLES} />
        <StatusBadge value={assessment.risk} styles={RISK_STYLES} />
        <span className="text-xs text-zinc-500">{assessment.violations_count} violation(s)</span>
      </div>
      {topRec && <p className="mt-2 text-xs text-zinc-600 leading-relaxed">{topRec}</p>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PMOGovernanceCompliancePage() {
  const [data, setData] = useState<PMOGovernanceComplianceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pmo-governance-compliance");
      const json = await res.json() as { ok: boolean; data?: PMOGovernanceComplianceSnapshot; error?: { message: string } };
      if (!json.ok) setError(json.error?.message ?? "Failed to load PMO Governance Compliance.");
      else setData(json.data ?? null);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const generateSnapshot = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/pmo-governance-compliance/snapshot", { method: "POST" });
      const json = await res.json() as { ok: boolean; data?: PMOGovernanceComplianceSnapshot; error?: { message: string } };
      if (!json.ok) setError(json.error?.message ?? "Failed to generate snapshot.");
      else setData(json.data ?? null);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setGenerating(false);
    }
  }, []);

  // fetchData is stable (useCallback with [] deps) — calling it here is intentional
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchData(); }, [fetchData]);

  const domainEntries: Array<[string, DomainAssessment | undefined]> = data
    ? [
        ["pm_profile_completeness", data.assessments.pm_profile_completeness],
        ["assignment_hygiene", data.assessments.assignment_hygiene],
        ["capacity_governance", data.assessments.capacity_governance],
        ["performance_governance", data.assessments.performance_governance],
        ["evidence_readiness", data.assessments.evidence_readiness],
        ["intervention_readiness", data.assessments.intervention_readiness],
        ["dossier_completeness", data.assessments.dossier_completeness],
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#08080c] px-6 py-10">
      <div className="mx-auto max-w-7xl space-y-10">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">PMO Governance Compliance</h1>
            <p className="mt-1 text-sm text-zinc-600">
              PMO operating discipline snapshot — profile, assignment hygiene, capacity, performance, evidence, and intervention readiness.
            </p>
            <div className="mt-2 flex gap-3 text-xs text-zinc-500">
              <Link href={PM_OPERATIONS_PATH} className="hover:text-zinc-700 hover:underline">PM Operations</Link>
              <Link href="/pm-registry" className="hover:text-zinc-700 hover:underline">PM Registry</Link>
              <Link href="/pm-capacity" className="hover:text-zinc-700 hover:underline">Capacity</Link>
              <Link href="/pm-performance" className="hover:text-zinc-700 hover:underline">Performance</Link>
            </div>
          </div>
          <button
            onClick={generateSnapshot}
            disabled={generating || loading}
            className="rounded-xl border border-indigo-500/40 bg-indigo-500/20 px-4 py-2 text-sm text-indigo-800 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate Snapshot"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600">{error}</div>
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
            <p className="text-sm text-zinc-600">No governance compliance data available.</p>
            <p className="mt-1 text-xs text-zinc-400">Register Project Managers and generate snapshots to assess operating discipline.</p>
          </div>
        )}

        {data && (
          <>
            {/* Risk banner */}
            {(data.compliance_risk === "critical" || data.compliance_risk === "high" || data.summary.critical_override_triggered) && (
              <div className={`rounded-xl border px-4 py-3 ${RISK_STYLES[data.compliance_risk] ?? "border-slate-200 bg-white"}`}>
                <p className="text-sm font-medium">
                  {data.summary.critical_override_triggered
                    ? "Critical governance override triggered."
                    : `Compliance risk is ${data.compliance_risk}.`}
                </p>
                {data.summary.critical_override_reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs opacity-90">
                    {data.summary.critical_override_reasons.map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                )}
                {data.recommendations[0] && (
                  <p className="mt-1 text-xs opacity-80">Top recommendation: {data.recommendations[0].message}</p>
                )}
              </div>
            )}

            {/* Executive cards */}
            <div>
              <SectionHeader title="Executive Compliance" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                <SummaryCard label="Compliance Score" value={data.compliance_score.toFixed(1)} highlight="text-indigo-700" />
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-xs text-zinc-600">Status</p>
                  <div className="mt-2"><StatusBadge value={data.compliance_status} styles={COMPLIANCE_STATUS_STYLES} /></div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-xs text-zinc-600">Risk</p>
                  <div className="mt-2"><StatusBadge value={data.compliance_risk} styles={RISK_STYLES} /></div>
                </div>
                <SummaryCard label="Total Violations" value={data.summary.total_violations} highlight={data.summary.total_violations > 0 ? "text-amber-700" : "text-slate-900"} />
                <SummaryCard label="Critical Violations" value={data.summary.critical_violations} highlight={data.summary.critical_violations > 0 ? "text-red-700" : "text-slate-900"} />
                <SummaryCard label="Active PMs Evaluated" value={data.summary.active_pms_evaluated} />
                <SummaryCard label="Evidence Readiness" value={data.assessments.evidence_readiness.score.toFixed(0)} />
                <SummaryCard label="Last Generated" value={new Date(data.generated_at).toLocaleDateString()} sub={new Date(data.generated_at).toLocaleTimeString()} />
              </div>
            </div>

            {/* Domain assessments */}
            <div>
              <SectionHeader title="Domain Assessments" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {domainEntries.map(([name, assessment]) =>
                  assessment ? <DomainCard key={name} name={name} assessment={assessment} /> : null
                )}
              </div>
            </div>

            {/* Violations table */}
            <div>
              <SectionHeader title="Violations" count={data.violations.length} />
              {data.violations.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center">
                  <p className="text-sm text-zinc-500">No governance violations detected.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Severity</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Domain</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Type</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">PM / Project</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Message</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Recommendation</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Detected</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.violations.slice(0, 100).map((v: GovernanceViolation) => (
                        <tr key={v.violation_id} className="hover:bg-white">
                          <td className="px-4 py-3"><StatusBadge value={v.severity} styles={SEVERITY_STYLES} /></td>
                          <td className="px-4 py-3 text-xs text-zinc-600">{DOMAIN_LABELS[v.domain] ?? v.domain}</td>
                          <td className="px-4 py-3 text-xs text-zinc-500">{v.violation_type.replace(/_/g, " ").toLowerCase()}</td>
                          <td className="px-4 py-3 text-xs text-zinc-700">
                            {v.pm_id ? (
                              <Link href={`/pm-registry/${v.pm_id}`} className="hover:underline">{v.pm_name ?? v.pm_id}</Link>
                            ) : v.project_name ?? v.project_id ?? "—"}
                          </td>
                          <td className="max-w-xs px-4 py-3 text-xs text-zinc-700 leading-relaxed">{v.message}</td>
                          <td className="max-w-xs px-4 py-3 text-xs text-zinc-600 leading-relaxed">{v.recommendation}</td>
                          <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">{new Date(v.detected_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recommendations */}
            {data.recommendations.length > 0 && (
              <div>
                <SectionHeader title="Recommendations" count={data.recommendations.length} />
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white text-left">
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Severity</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Domain</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Recommendation</th>
                        <th className="px-4 py-3 text-xs font-medium text-zinc-600">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.recommendations.slice(0, 60).map((rec: GovernanceRecommendation, i: number) => (
                        <tr key={i} className="hover:bg-white">
                          <td className="px-4 py-3"><StatusBadge value={rec.severity} styles={SEVERITY_STYLES} /></td>
                          <td className="px-4 py-3 text-xs text-zinc-600">{DOMAIN_LABELS[rec.domain] ?? rec.domain}</td>
                          <td className="max-w-md px-4 py-3 text-xs text-zinc-700 leading-relaxed">{rec.message}</td>
                          <td className="px-4 py-3 text-xs text-zinc-500">{rec.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Evidence summary */}
            <div>
              <SectionHeader title="Evidence Summary" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <SummaryCard label="Total PMs" value={data.evidence.counts.total_pms} />
                <SummaryCard label="Active PMs" value={data.evidence.counts.active_pms} highlight="text-emerald-700" />
                <SummaryCard label="Dossiers" value={data.evidence.counts.pm_dossiers_evaluated} />
                <SummaryCard label="Capacity Snapshots" value={data.evidence.counts.capacity_snapshots_present} />
                <SummaryCard label="Performance Snapshots" value={data.evidence.counts.performance_snapshots_present} />
                <SummaryCard label="Evidence Confidence" value={data.evidence.counts.evidence_confidence_present} />
                <SummaryCard label="Violations" value={data.evidence.counts.violations_detected} />
              </div>
            </div>

            <p className="text-xs text-zinc-400">
              Generated at {new Date(data.generated_at).toLocaleString()} — Read-only aggregation. No recalculation performed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
