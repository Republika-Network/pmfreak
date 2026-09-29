"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { guardRenderedText, renderedTextExemptions, scanBriefForCredentials } from "@/lib/project-brain/execution-brief/credential-guard";
import { renderExecutionBrief } from "@/lib/project-brain/execution-brief/render";
import { EXECUTION_BRIEF_RENDERERS, RENDERER_LABEL, type BriefOrigin, type ExecutionBriefRenderer, type ExecutionBriefV1 } from "@/lib/project-brain/execution-brief/types";

/**
 * PB-EXEC-01 — the Execution Brief card: display, renderer choice and copy.
 *
 * Reads only the validated canonical brief the transcript already holds. Choosing a
 * renderer or copying issues NO request, calls no model, writes nothing and never
 * changes the brief or its hash: rendering is a pure function in the browser.
 *
 * Credential boundary 3: before ANYTHING of the brief is displayed, every string it
 * holds and every renderer's exact output are guard-checked; a hit replaces the whole
 * card with a safe notice (no field, no preview, no copy). The exact string placed on
 * the clipboard is re-rendered and re-checked immediately before the copy. The UI never
 * shows the matched value.
 *
 * Deliberately absent: any control that executes, delegates, sends to an executor,
 * opens a PR, merges or deploys (PB-EXEC-02+). The only action is "Copy brief".
 */

type Variant = "dark" | "light";

const ORIGIN_LABEL: Record<BriefOrigin, string> = {
  project_record: "Project record",
  reported: "Reported in chat · not verified",
  suggested: "Suggested by Project Brain",
  policy: "PMFreak policy",
};

export const BRIEF_BANNER = "AI-generated · manual handoff · not an authorization to execute, merge or deploy";
export const CREDENTIAL_BLOCK_MESSAGE =
  "This brief contains credential-like content and cannot be displayed or copied safely. Remove or replace credentials with a secret reference and regenerate the brief.";

const CARD: Record<Variant, Record<string, string>> = {
  dark: {
    card: "border-white/10 bg-white/[0.02] text-zinc-200",
    muted: "text-zinc-400",
    chip: "border-white/15 text-zinc-300",
    ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    caution: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    seg: "border-white/15 text-zinc-300 peer-checked:bg-white/10 peer-checked:text-white",
    button: "border-white/20 bg-white/5 text-zinc-100 hover:bg-white/10",
    pre: "border-white/10 bg-black/30 text-zinc-200",
  },
  light: {
    card: "border-slate-200 bg-white text-slate-800",
    muted: "text-slate-500",
    chip: "border-slate-200 text-slate-600",
    ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
    caution: "border-amber-200 bg-amber-50 text-amber-900",
    seg: "border-slate-300 text-slate-700 peer-checked:bg-slate-900 peer-checked:text-white",
    button: "border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
    pre: "border-slate-200 bg-slate-50 text-slate-800",
  },
};

function Origin({ origin, styles }: { origin: BriefOrigin; styles: Record<string, string> }) {
  const cautious = origin === "reported" || origin === "suggested";
  return (
    <span className={`mr-1.5 inline-block rounded-full border px-1.5 text-[10px] font-medium ${cautious ? styles.caution : styles.chip}`} data-origin={origin}>
      {ORIGIN_LABEL[origin]}
    </span>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em]">{title}</p>
      <div className="mt-1 space-y-1 text-xs leading-relaxed">{children}</div>
    </div>
  );
}

type CopyStatus = { kind: "idle" } | { kind: "copied"; renderer: ExecutionBriefRenderer } | { kind: "blocked" } | { kind: "failed" };

export function ExecutionBriefCard({ brief, variant = "light", initialRenderer = "generic" }: { brief: ExecutionBriefV1; variant?: Variant; initialRenderer?: ExecutionBriefRenderer }) {
  const styles = CARD[variant];
  const groupName = useId();
  const [renderer, setRenderer] = useState<ExecutionBriefRenderer>(initialRenderer);
  const [status, setStatus] = useState<CopyStatus>({ kind: "idle" });
  const exemptions = useMemo(() => renderedTextExemptions(brief), [brief]);
  // What the card displays is the brief's own strings; what it copies is a renderer's
  // output. Both must pass, or nothing of the brief is shown. A guard error blocks.
  const displayable = useMemo(() => {
    try {
      if (scanBriefForCredentials(brief).length > 0) return false;
      return EXECUTION_BRIEF_RENDERERS.every((r) => guardRenderedText(renderExecutionBrief(brief, r), exemptions).ok);
    } catch {
      return false;
    }
  }, [brief, exemptions]);
  const preview = useMemo(() => {
    const text = renderExecutionBrief(brief, renderer);
    return guardRenderedText(text, exemptions).ok ? { ok: true as const, text } : { ok: false as const };
  }, [brief, renderer, exemptions]);

  const copy = async () => {
    // Re-render and re-check the EXACT string that goes on the clipboard.
    const text = renderExecutionBrief(brief, renderer);
    if (!guardRenderedText(text, exemptions).ok) {
      setStatus({ kind: "blocked" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "copied", renderer });
    } catch {
      setStatus({ kind: "failed" });
    }
  };

  if (!displayable) {
    return (
      <section className={`mt-3 min-w-0 max-w-full whitespace-normal rounded-xl border p-3 sm:p-4 ${styles.card}`} data-testid="execution-brief-card" data-blocked="true" aria-label="Execution brief">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">Execution brief</p>
        <p className={`text-[11px] ${styles.muted}`} data-testid="execution-brief-banner">
          <span data-testid="project-brain-synthesis-label">AI-generated</span> · manual handoff · not an authorization to execute, merge or deploy
        </p>
        <p className={`mt-2 rounded-md border px-2 py-1 text-xs ${styles.caution}`} role="alert" data-testid="execution-brief-credential-block">
          {CREDENTIAL_BLOCK_MESSAGE}
        </p>
      </section>
    );
  }

  const sensitive = brief.reportedContext.filter((r) => r.executionSensitive);
  const otherReported = brief.reportedContext.filter((r) => !r.executionSensitive);
  const ready = brief.readiness === "handoff_ready";
  const repo = brief.repositoryContext;
  const wrap = "min-w-0 [overflow-wrap:anywhere]";

  return (
    <section
      className={`mt-3 min-w-0 max-w-full whitespace-normal rounded-xl border p-3 sm:p-4 ${styles.card}`}
      data-testid="execution-brief-card"
      data-readiness={brief.readiness}
      data-brief-id={brief.identity.briefId}
      aria-label="Execution brief"
    >
      <header className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">Execution brief</p>
        <p className={`text-[11px] ${styles.muted}`} data-testid="execution-brief-banner">
          <span data-testid="project-brain-synthesis-label">AI-generated</span> · manual handoff · not an authorization to execute, merge or deploy
        </p>
        <h3 className={`text-sm font-semibold ${wrap}`} data-testid="execution-brief-title">
          {brief.target?.title ?? "Target not established"}
        </h3>
        <p className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${ready ? styles.ready : styles.caution}`} data-testid="execution-brief-readiness">
            {ready ? "Handoff ready" : "Needs input"}
          </span>
          <span className={`text-[11px] ${styles.muted}`}>Not executed · nothing was run, merged or deployed</span>
        </p>
      </header>

      {brief.provenance.groundingAdjusted ? (
        <p className={`mt-2 rounded-md border px-2 py-1 text-[11px] ${styles.caution}`} data-testid="execution-brief-grounding-notice">
          Some drafted items could not be linked to project records or this conversation and were removed or relabelled. See open inputs.
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {brief.target ? (
          <Section title="Target" testId="execution-brief-target">
            <p className={wrap}>
              {brief.targetRef.kind === "project_brain_recommendation" ? (
                <span className={`mr-1.5 inline-block rounded-full border px-1.5 text-[10px] font-medium ${styles.chip}`} data-origin="selected_recommendation">
                  Selected recommendation
                </span>
              ) : null}
              {brief.target.statement}
            </p>
          </Section>
        ) : null}
        <Section title="Objective" testId="execution-brief-objective">
          {brief.objective ? (
            <p className={wrap}>
              <Origin origin={brief.objective.origin} styles={styles} />
              {brief.objective.text}
            </p>
          ) : (
            <p className={styles.muted}>Not established — see open inputs.</p>
          )}
        </Section>
        {brief.knownContext.length > 0 ? (
          <Section title="Current state" testId="execution-brief-known">
            <ul className="space-y-1">
              {brief.knownContext.map((k, i) => (
                <li key={i} className={wrap}>
                  <Origin origin="project_record" styles={styles} />
                  {k.text}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {sensitive.length > 0 ? (
          <Section title="Verify before acting" testId="execution-brief-verify">
            <ul className="space-y-1">
              {sensitive.map((r, i) => (
                <li key={i} className={wrap}>
                  <Origin origin="reported" styles={styles} />
                  {r.text} <span className={styles.muted}>— if this is not true in the repository, stop.</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {otherReported.length > 0 ? (
          <Section title="Reported in chat" testId="execution-brief-reported">
            <ul className="space-y-1">
              {otherReported.map((r, i) => (
                <li key={i} className={wrap}>
                  <Origin origin="reported" styles={styles} />
                  {r.text}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title="Repository" testId="execution-brief-repository">
          {repo.status === "not_established" ? (
            <p className={wrap}>{repo.note}</p>
          ) : (
            <p className={wrap}>
              <Origin origin="reported" styles={styles} />
              {[repo.repository && `Repository ${repo.repository}`, repo.baseRef && `base branch ${repo.baseRef}`, repo.baseSha && `base commit ${repo.baseSha}`].filter(Boolean).join(" · ")}
              {" — verify locally before any change."}
            </p>
          )}
        </Section>
        {brief.scope.inScope.length + brief.scope.outOfScope.length > 0 ? (
          <Section title="Scope (suggested by Project Brain)" testId="execution-brief-scope">
            {brief.scope.inScope.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4">
                {brief.scope.inScope.map((x, i) => <li key={i} className={wrap}>{x}</li>)}
              </ul>
            ) : null}
            {brief.scope.outOfScope.length > 0 ? (
              <>
                <p className={`mt-1 font-medium ${styles.muted}`}>Out of scope</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {brief.scope.outOfScope.map((x, i) => <li key={i} className={wrap}>{x}</li>)}
                </ul>
              </>
            ) : null}
          </Section>
        ) : null}
        <Section title="Constraints" testId="execution-brief-constraints">
          <ul className="space-y-1">
            {brief.constraints.map((c, i) => (
              <li key={i} className={wrap}>
                <Origin origin={c.origin} styles={styles} />
                {c.text}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Acceptance criteria" testId="execution-brief-acceptance">
          {brief.acceptanceCriteria.length === 0 ? (
            <p className={styles.muted}>None established — see open inputs.</p>
          ) : (
            <ul className="space-y-1">
              {brief.acceptanceCriteria.map((c, i) => (
                <li key={i} className={wrap}>
                  <Origin origin={c.origin} styles={styles} />
                  {c.text}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {brief.verificationPlan.length > 0 ? (
          <Section title="Verification plan (suggested)" testId="execution-brief-verification">
            <ul className="space-y-1">
              {brief.verificationPlan.map((v, i) => (
                <li key={i} className={wrap}>
                  {v.step}
                  <span className={`block ${styles.muted}`}>
                    {v.command && v.commandBasis ? (
                      <>
                        <Origin origin={v.commandBasis} styles={styles} />
                        <code className={wrap}>{v.command}</code>
                      </>
                    ) : v.kind === "review" || v.kind === "manual_check" ? null : (
                      "Command: discover and confirm the project's actual command in the repository."
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {brief.unknowns.length > 0 ? (
          <Section title="Open inputs" testId="execution-brief-unknowns">
            <ul className="space-y-1">
              {brief.unknowns.map((u, i) => (
                <li key={i} className={wrap} data-blocking={u.blocking ? "true" : undefined}>
                  {u.blocking ? <span className={`mr-1.5 inline-block rounded-full border px-1.5 text-[10px] font-medium ${styles.caution}`}>Needed</span> : null}
                  <span className="font-medium">{u.fact}</span> <span className={styles.muted}>— {u.why}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {brief.assumptions.length > 0 ? (
          <Section title="Assumptions" testId="execution-brief-assumptions">
            <ul className="list-disc space-y-0.5 pl-4">
              {brief.assumptions.map((a, i) => <li key={i} className={wrap}>{a.text}</li>)}
            </ul>
          </Section>
        ) : null}
        <details className="group" data-testid="execution-brief-handoff-rules">
          <summary className={`cursor-pointer list-none text-[11px] font-medium ${styles.muted} [&::-webkit-details-marker]:hidden`}>
            Handoff rules included in every copy (git policy, forbidden operations, stop conditions, final report) <span aria-hidden className="group-open:hidden">▸</span><span aria-hidden className="hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-2 space-y-2 text-xs">
            <ul className="list-disc space-y-0.5 pl-4">{brief.handoff.gitPolicy.map((x, i) => <li key={`g${i}`}>{x}</li>)}</ul>
            <p className="font-medium">Never: {brief.handoff.forbiddenOperations.join("; ")}.</p>
            <ul className="list-disc space-y-0.5 pl-4">{brief.handoff.stopConditions.map((x, i) => <li key={`s${i}`}>Stop if: {x}</li>)}</ul>
            <p>Report back: {brief.handoff.finalReport.join("; ")}.</p>
          </div>
        </details>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <fieldset className="min-w-0" data-testid="execution-brief-renderer">
          <legend className={`mb-1 text-[11px] font-medium ${styles.muted}`}>Format for</legend>
          <div className="flex flex-wrap gap-1.5">
            {EXECUTION_BRIEF_RENDERERS.map((key) => (
              <label key={key} className="relative">
                <input
                  type="radio"
                  name={groupName}
                  value={key}
                  checked={renderer === key}
                  onChange={() => {
                    setRenderer(key);
                    setStatus({ kind: "idle" });
                  }}
                  className="peer sr-only"
                  data-testid={`execution-brief-renderer-${key}`}
                />
                <span className={`inline-block cursor-pointer rounded-full border px-2.5 py-1 text-xs transition peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-500 ${styles.seg}`}>
                  {RENDERER_LABEL[key]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          type="button"
          onClick={() => void copy()}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 sm:ml-auto ${styles.button}`}
          aria-label={`Copy brief formatted for ${RENDERER_LABEL[renderer]}`}
          data-testid="execution-brief-copy"
        >
          Copy brief
        </button>
      </div>
      <p className={`mt-1 min-h-[1rem] text-[11px] ${styles.muted}`} role="status" aria-live="polite" data-testid="execution-brief-copy-status">
        {status.kind === "copied"
          ? `Copied — formatted for ${RENDERER_LABEL[status.renderer]}. Paste it into your tool yourself; PMFreak has run nothing.`
          : status.kind === "blocked"
            ? CREDENTIAL_BLOCK_MESSAGE
            : status.kind === "failed"
              ? "Copy failed — your browser did not allow clipboard access. Select the preview text instead."
              : ""}
      </p>

      <details className="mt-2" data-testid="execution-brief-preview">
        <summary className={`cursor-pointer text-[11px] font-medium ${styles.muted}`}>Preview the text that will be copied</summary>
        {preview.ok ? (
          <pre className={`mt-2 max-h-96 max-w-full overflow-auto whitespace-pre-wrap rounded-md border p-2 text-[11px] leading-relaxed [overflow-wrap:anywhere] ${styles.pre}`} data-testid="execution-brief-preview-text">
            {preview.text}
          </pre>
        ) : (
          <p className={`mt-2 rounded-md border px-2 py-1 text-[11px] ${styles.caution}`} data-testid="execution-brief-credential-block">
            {CREDENTIAL_BLOCK_MESSAGE}
          </p>
        )}
      </details>
    </section>
  );
}
