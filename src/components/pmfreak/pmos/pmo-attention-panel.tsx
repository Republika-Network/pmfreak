import Link from "next/link";
import type {
  PmoAttentionLevel,
  PmoAttentionReason,
  PmoConfidence,
  PmoDimensionKey,
  PmoFreshnessState,
  PmoPortfolioAttention,
  PmoProjectAssessment,
  PmoProjectEvaluation,
} from "@/lib/pmos/pmo-portfolio-attention";

/**
 * P2-17 — PMO Attention, as rendered on the PMO Command Center.
 *
 * A pure view over `PmoPortfolioAttention`. It renders what the projection says and adds no
 * judgement of its own: no health adjective, no generated narrative, no number the projection
 * did not compute. Coverage and confidence are shown side by side and never merged; stale and
 * unknown freshness are labelled on the reason they apply to; fixture (demo) records are
 * labelled wherever they appear, in the same customer wording as the P2-16 schedule panel.
 */

export type PmoAttentionViewState =
  | { kind: "loading" }
  | { kind: "error"; retryHref: string }
  | { kind: "denied" }
  | { kind: "ready"; attention: PmoPortfolioAttention };

const HEADING_ID = "pmo-attention-heading";

const LEVEL_LABEL: Record<PmoAttentionLevel, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const LEVEL_TONE: Record<PmoAttentionLevel, string> = {
  critical: "border-rose-300 bg-rose-50 text-rose-900",
  high: "border-orange-300 bg-orange-50 text-orange-900",
  medium: "border-amber-300 bg-amber-50 text-amber-900",
  low: "border-slate-300 bg-slate-50 text-slate-700",
};
const FRESHNESS_LABEL: Record<PmoFreshnessState, string> = { current: "Current", stale: "Stale", unknown: "Freshness unknown" };
const FRESHNESS_TONE: Record<PmoFreshnessState, string> = {
  current: "border-emerald-300 bg-emerald-50 text-emerald-900",
  stale: "border-amber-300 bg-amber-50 text-amber-900",
  unknown: "border-slate-300 bg-slate-50 text-slate-700",
};
const DIMENSION_LABEL: Record<PmoDimensionKey, string> = {
  schedule: "Schedule exposure",
  findings: "Open high/critical findings",
  recommendations: "Recommendations awaiting decision",
  outcomes: "Outcome divergence",
};
const EVALUATION_LABEL: Record<PmoProjectEvaluation, string> = {
  qualified: "Assessed",
  missing_inputs: "Missing inputs",
  unavailable: "Unavailable",
  not_evaluated_lifecycle: "Not evaluated (not active)",
  not_evaluated_limit: "Not evaluated (view limit)",
};

/** Deterministic UTC rendering — no locale, so server and browser always agree. */
export function formatEvaluatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "unknown time";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Confidence is carried on the 0–1 scale; it is shown as a whole percentage of that scale. */
export function formatConfidence(confidence: PmoConfidence | null): string {
  return confidence ? `${Math.round(confidence.value * 100)}%` : "Not recorded";
}

function Pill({ children, tone, testId }: { children: React.ReactNode; tone: string; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {children}
    </span>
  );
}

function FixtureLabel() {
  return <Pill tone="border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900" testId="pmo-attention-fixture">Demo data — not a live project record</Pill>;
}

function Frame({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <section aria-labelledby={HEADING_ID} aria-busy={busy || undefined} data-testid="pmo-attention" className="rounded-3xl border border-slate-200 bg-white p-5">
      <h2 id={HEADING_ID} className="text-lg font-semibold text-slate-900">PMO Attention</h2>
      {children}
    </section>
  );
}

function Reason({ reason, executionHref }: { reason: PmoAttentionReason; executionHref: string }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3" data-testid="pmo-attention-reason" data-rule={reason.ruleId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={LEVEL_TONE[reason.level]}>{LEVEL_LABEL[reason.level]}</Pill>
        <Pill tone={FRESHNESS_TONE[reason.freshness.state]} testId="pmo-attention-freshness">{FRESHNESS_LABEL[reason.freshness.state]}</Pill>
        <Pill tone="border-slate-300 bg-white text-slate-600">{reason.assertion === "inference" ? "Inference" : "Observed"}</Pill>
        {reason.fixture ? <FixtureLabel /> : null}
      </div>
      <p className="mt-1.5 text-sm text-slate-800">{reason.summary}</p>
      <p className="mt-1 text-xs text-slate-600">
        Confidence {formatConfidence(reason.confidence)}
        {reason.confidence ? <span className="text-slate-500"> · {reason.confidence.source}</span> : null}
        <span className="text-slate-500"> · {reason.freshness.basis}</span>
      </p>
      <p className="mt-1 text-[11px] text-slate-500">
        Rule <code className="font-mono">{reason.ruleId}</code> · {reason.evidence.length} canonical record{reason.evidence.length === 1 ? "" : "s"}
        {" · "}
        <Link href={executionHref} className="font-medium text-cyan-800 underline-offset-2 hover:underline">
          View supporting detail
        </Link>
      </p>
    </li>
  );
}

function ProjectCard({ project }: { project: PmoProjectAssessment }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="pmo-attention-project" data-project-id={project.projectId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-base font-semibold text-slate-900">{project.projectName}</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {project.attentionLevel ? <Pill tone={LEVEL_TONE[project.attentionLevel]}>{LEVEL_LABEL[project.attentionLevel]} attention</Pill> : null}
          {project.fixture ? <FixtureLabel /> : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {project.reasons.length} reason{project.reasons.length === 1 ? "" : "s"} · Confidence {formatConfidence(project.confidence)} (weakest recorded)
        {project.freshness === "stale" || project.freshness === "unknown" ? ` · ${FRESHNESS_LABEL[project.freshness]} inputs` : ""}
      </p>
      <ul className="mt-3 space-y-2">
        {project.reasons.map((reason) => (
          <Reason key={`${reason.ruleId}:${reason.evidence[0]?.id ?? ""}`} reason={reason} executionHref={project.drillDown.execution} />
        ))}
      </ul>
      {project.missingInputs.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
          {project.missingInputs.map((m) => <li key={m.code}>{m.message}</li>)}
        </ul>
      ) : null}
      <Link
        href={project.drillDown.project}
        aria-label={`Open project: ${project.projectName}`}
        className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
      >
        Open project
      </Link>
    </li>
  );
}

function StateBanner({ attention }: { attention: PmoPortfolioAttention }) {
  const { coverage } = attention;
  if (attention.state === "empty") {
    return <p className="mt-2 text-sm text-slate-700">This PMO has no projects, so there is nothing to assess.</p>;
  }
  if (attention.state === "no_eligible_projects") {
    return (
      <p className="mt-2 text-sm text-slate-700">
        None of this PMO&apos;s {coverage.projectsInScope} project{coverage.projectsInScope === 1 ? " is" : "s are"} active. Attention is assessed for active projects only.
      </p>
    );
  }
  const notes: string[] = [];
  if (attention.qualifications.includes("partial_coverage")) {
    notes.push(`Partial assessment: PMFreak could assess ${coverage.qualified} of ${coverage.eligible} active project${coverage.eligible === 1 ? "" : "s"}. This is not a complete PMO assessment.`);
  }
  if (attention.qualifications.includes("degraded_dimension")) notes.push("Some canonical signals could not be read in full; affected dimensions are marked unavailable or truncated below.");
  if (attention.qualifications.includes("stale_inputs")) notes.push("Some inputs are stale or superseded. They are labelled on each reason and are not presented as current.");
  if (notes.length === 0) {
    return (
      <p className="mt-2 text-sm text-emerald-900" data-testid="pmo-attention-state" data-state={attention.state}>
        Assessment covers all {coverage.eligible} active project{coverage.eligible === 1 ? "" : "s"} with current inputs.
      </p>
    );
  }
  return (
    <div role="note" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-4" data-testid="pmo-attention-state" data-state={attention.state}>
      {notes.map((note) => <p key={note} className="text-sm text-amber-900">{note}</p>)}
    </div>
  );
}

function Coverage({ attention }: { attention: PmoPortfolioAttention }) {
  const { coverage } = attention;
  return (
    <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="pmo-attention-coverage-detail">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">How complete is this view?</summary>
      <dl className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
        <div><dt className="inline font-medium">Projects in this PMO: </dt><dd className="inline">{coverage.projectsInScope}</dd></div>
        <div><dt className="inline font-medium">Active (eligible): </dt><dd className="inline">{coverage.eligible}</dd></div>
        <div><dt className="inline font-medium">Assessed with canonical signals: </dt><dd className="inline">{coverage.qualified}</dd></div>
        <div><dt className="inline font-medium">Missing inputs: </dt><dd className="inline">{coverage.missingInputs}</dd></div>
        <div><dt className="inline font-medium">Unavailable: </dt><dd className="inline">{coverage.unavailable}</dd></div>
        <div><dt className="inline font-medium">Not evaluated (not active / view limit): </dt><dd className="inline">{coverage.notEvaluatedLifecycle} / {coverage.notEvaluatedLimit}</dd></div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium">Withheld from you: </dt>
          <dd className="inline">0 — project access follows workspace membership, so every project in this PMO is visible to anyone who can open it.</dd>
        </div>
      </dl>
      <table className="mt-3 w-full text-left text-xs text-slate-700">
        <caption className="sr-only">Coverage by signal dimension (active projects evaluated)</caption>
        <thead>
          <tr className="text-slate-500">
            <th scope="col" className="py-1 font-medium">Dimension</th>
            <th scope="col" className="py-1 font-medium">Assessed</th>
            <th scope="col" className="py-1 font-medium">No basis</th>
            <th scope="col" className="py-1 font-medium">Unavailable</th>
            <th scope="col" className="py-1 font-medium">Truncated</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(DIMENSION_LABEL) as PmoDimensionKey[]).map((d) => (
            <tr key={d} className="border-t border-slate-200">
              <th scope="row" className="py-1 font-medium">{DIMENSION_LABEL[d]}</th>
              <td className="py-1">{coverage.dimensions[d].assessed}</td>
              <td className="py-1">{coverage.dimensions[d].no_basis}</td>
              <td className="py-1">{coverage.dimensions[d].unavailable}</td>
              <td className="py-1">{coverage.dimensions[d].truncated}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-slate-500">
        Method <code className="font-mono">{attention.method.id}</code>: each reason is one canonical record placed by a published rule; projects are ordered by
        highest level, then number of reasons at that level, then number of current reasons, then name. No composite score is computed.
      </p>
    </details>
  );
}

function ProjectList({ title, projects, testId }: { title: string; projects: PmoProjectAssessment[]; testId: string }) {
  if (projects.length === 0) return null;
  return (
    <div className="mt-4" data-testid={testId}>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <ul className="mt-2 grid gap-2 md:grid-cols-2">
        {projects.map((p) => (
          <li key={p.projectId} className="rounded-xl border border-slate-200 bg-white p-3 text-sm" data-project-id={p.projectId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">{p.projectName}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                {p.fixture ? <FixtureLabel /> : null}
                <span className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{EVALUATION_LABEL[p.evaluation]}</span>
              </span>
            </div>
            {p.missingInputs.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                {p.missingInputs.map((m) => <li key={m.code}>{m.message}</li>)}
              </ul>
            ) : null}
            <Link href={p.drillDown.project} aria-label={`Open project: ${p.projectName}`} className="mt-1 inline-block text-xs font-medium text-cyan-800 underline-offset-2 hover:underline">
              Open project
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PmoAttentionView({ state }: { state: PmoAttentionViewState }) {
  if (state.kind === "loading") {
    return (
      <Frame busy>
        <p role="status" className="mt-2 text-sm text-slate-600">Loading PMO attention…</p>
      </Frame>
    );
  }
  if (state.kind === "denied") {
    return (
      <Frame>
        <p role="alert" className="mt-2 text-sm text-slate-700">You do not have access to this PMO&apos;s attention view.</p>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <Frame>
        <div role="alert" className="mt-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
          <p className="text-sm font-semibold text-amber-900">PMO attention couldn&apos;t be evaluated</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading project signals, not a permissions issue, and no assessment is shown rather than a partial one presented as complete.
          </p>
          <a href={state.retryHref} className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50">
            Try again
          </a>
        </div>
      </Frame>
    );
  }

  const { attention } = state;
  const { coverage } = attention;
  const byLevel = (level: PmoAttentionLevel) => attention.attention.filter((p) => p.attentionLevel === level);
  return (
    <Frame>
      <p className="mt-1 text-xs text-slate-500" data-testid="pmo-attention-meta">
        Evaluated {formatEvaluatedAt(attention.evaluatedAt)} · membership{" "}
        <code className="font-mono" title={attention.membership.digest}>{attention.membership.digest.slice(7, 19)}</code> ({attention.membership.projectCount} project
        {attention.membership.projectCount === 1 ? "" : "s"})
        {attention.nextFreshnessDeadline ? ` · inputs may lapse ${formatEvaluatedAt(attention.nextFreshnessDeadline)}` : ""}
        {attention.fixture ? " · " : ""}
        {attention.fixture ? <FixtureLabel /> : null}
      </p>

      <StateBanner attention={attention} />

      {attention.state === "empty" || attention.state === "no_eligible_projects" ? null : (
        <>
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Need attention</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900" data-testid="pmo-attention-count">{attention.attention.length}</dd>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Coverage</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900" data-testid="pmo-attention-coverage">
                {coverage.qualified} / {coverage.eligible} active projects
              </dd>
              <dd className="text-[11px] text-slate-500">{coverage.complete ? "Complete" : "Incomplete"} · of {coverage.projectsInScope} in this PMO</dd>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Confidence</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900" data-testid="pmo-attention-confidence">{formatConfidence(attention.confidence)}</dd>
              <dd className="text-[11px] text-slate-500">Weakest recorded claim shown · separate from coverage</dd>
            </div>
          </dl>

          {attention.attention.length === 0 ? (
            <p className="mt-4 text-sm text-slate-700" data-testid="pmo-attention-none">
              No supported attention signal was found in the {coverage.qualified} assessed project{coverage.qualified === 1 ? "" : "s"}. This is not a health rating
              {coverage.complete ? "." : " and does not cover the projects listed as not assessed."}
            </p>
          ) : (
            (["critical", "high", "medium", "low"] as const).map((level) => {
              const projects = byLevel(level);
              if (projects.length === 0) return null;
              return (
                <div key={level} className="mt-4" data-testid={`pmo-attention-group-${level}`}>
                  <h3 className="text-sm font-semibold text-slate-900">{LEVEL_LABEL[level]} attention</h3>
                  <ol className="mt-2 space-y-3">
                    {projects.map((p) => <ProjectCard key={p.projectId} project={p} />)}
                  </ol>
                </div>
              );
            })
          )}

          <ProjectList title="Assessed, no supported attention signal" projects={attention.quiet} testId="pmo-attention-quiet" />
          <ProjectList title="Not assessed" projects={attention.notAssessed} testId="pmo-attention-not-assessed" />
        </>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="pmo-attention-dependencies" data-support={attention.crossProjectDependencies.support}>
          <p className="text-sm font-semibold text-slate-900">Cross-project dependencies: unsupported</p>
          <p className="mt-1 text-xs text-slate-600">{attention.crossProjectDependencies.reason}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="pmo-attention-resources" data-support={attention.resourceConflicts.support}>
          <p className="text-sm font-semibold text-slate-900">Resource conflict analysis unavailable</p>
          <p className="mt-1 text-xs text-slate-600">{attention.resourceConflicts.reason}</p>
        </div>
      </div>

      {attention.state === "empty" ? null : <Coverage attention={attention} />}
    </Frame>
  );
}
