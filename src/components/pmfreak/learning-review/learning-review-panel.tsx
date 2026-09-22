"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { LearningCandidateView } from "@/lib/learning-candidates/types";
import type { ProjectKnowledgeReviewView, ProjectKnowledgeView } from "@/lib/project-knowledge/types";

/**
 * P2-19 — Learning review and Project knowledge.
 *
 * Keeps four things visibly distinct: a Candidate (a proposed, non-authoritative pattern),
 * a Rejected candidate version, Ratified project knowledge (authoritative, this project only)
 * and Revoked/expired knowledge (history, not in effect). Only owners/admins see the terminal
 * controls; the governance runtime and the database decide regardless of what is rendered.
 */

export type LearningReviewLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "denied" }
  | {
      kind: "ready";
      candidates: LearningCandidateView[];
      /** Authoritative retrieval: active, unexpired, this project only. */
      knowledge: ProjectKnowledgeView[];
      /** Every knowledge record, revoked/expired included (history only). */
      records: ProjectKnowledgeView[];
      reviews: ProjectKnowledgeReviewView[];
      canGovern: boolean;
    };

export type LearningReviewFeedback =
  | { kind: "ratified" | "rejected" | "revoked" | "duplicate" | "already_revoked" }
  | { kind: "stale"; currentVersion: number | null }
  | { kind: "not_supported" | "already_finalized" | "already_ratified" }
  | { kind: "denied" }
  | { kind: "governance_unavailable" }
  | { kind: "validation"; message: string }
  | { kind: "error"; message: string };

export type RatifyRequest = {
  candidate: LearningCandidateView;
  rationale: string;
  validityMode: "until_revoked" | "until_date" | null;
  expiresOn: string;
};

const RESULT_LABEL: Record<string, string> = { achieved: "achieved", partial: "partial", failed: "failed" };
const TIER_LABEL: Record<string, string> = {
  single_lineage: "Single lineage",
  multiple_consistent_lineages: "Multiple consistent lineages",
  conflicting_lineages: "Conflicting lineages",
};

function Badge({ children, tone, testId }: { children: string; tone: "neutral" | "warn" | "danger" | "ok" | "info"; testId?: string }) {
  const tones = {
    neutral: "border-white/15 bg-white/[0.04] text-zinc-300",
    warn: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    danger: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    info: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  } as const;
  return <span data-testid={testId} className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function formatResults(counts: Record<string, number | undefined>): string {
  const parts = Object.entries(counts).filter(([, n]) => typeof n === "number").map(([k, n]) => `${n} ${RESULT_LABEL[k] ?? k}`);
  return parts.length ? parts.join(", ") : "none";
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "N/A";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.valueOf()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function PatternLine({ pattern }: { pattern: { signalType: string; recommendedActionType: string; actionClass: string } }) {
  return (
    <p className="text-sm text-zinc-100">
      Finding <span className="font-mono text-xs">{pattern.signalType}</span> → recommended action{" "}
      <span className="font-mono text-xs">{pattern.recommendedActionType}</span> → action class{" "}
      <span className="font-mono text-xs">{pattern.actionClass}</span>
    </p>
  );
}

function FeedbackMessage({ feedback }: { feedback: LearningReviewFeedback }) {
  const ok = (text: string) => <p role="status" data-testid={`learning-review-feedback-${feedback.kind}`} className="text-sm text-emerald-200">{text}</p>;
  const warn = (text: string) => <p role="alert" data-testid={`learning-review-feedback-${feedback.kind}`} className="text-sm text-amber-200">{text}</p>;
  const bad = (text: string) => <p role="alert" data-testid={`learning-review-feedback-${feedback.kind}`} className="text-sm text-rose-200">{text}</p>;
  switch (feedback.kind) {
    case "ratified": return ok("Ratified. It is now project knowledge for this project only. Ratification does not establish causation.");
    case "rejected": return ok("Rejected for this candidate version. No project knowledge was created.");
    case "revoked": return ok("Revoked. It no longer applies and is kept in history.");
    case "duplicate": return ok("Already recorded — nothing new was created.");
    case "already_revoked": return ok("Already revoked — nothing new was recorded.");
    case "stale": return warn(`The candidate changed since you opened it${feedback.currentVersion ? ` (now version ${feedback.currentVersion})` : ""}. Nothing was recorded. Review the current version.`);
    case "not_supported": return warn("The candidate's evidence is no longer current, so it cannot be ratified. Nothing was recorded.");
    case "already_finalized": return warn("A different decision was already recorded for this candidate version. Nothing was changed.");
    case "already_ratified": return warn("This candidate already has active project knowledge. Revoke it before ratifying a newer version.");
    case "denied": return bad("Only a workspace owner or admin can make this decision. Nothing was recorded.");
    case "governance_unavailable": return bad("Governance is unavailable, so nothing was recorded. Please try again.");
    case "validation": return bad(feedback.message);
    case "error": return bad(feedback.message);
  }
}

function CandidateCard({
  candidate,
  reviews,
  records,
  canGovern,
  busy,
  onRatify,
  onReject,
}: {
  candidate: LearningCandidateView;
  reviews: ProjectKnowledgeReviewView[];
  records: ProjectKnowledgeView[];
  canGovern: boolean;
  busy: boolean;
  onRatify?: (request: RatifyRequest) => void;
  onReject?: (candidate: LearningCandidateView, rationale: string) => void;
}) {
  const formId = useId();
  const [rationale, setRationale] = useState("");
  const [validityMode, setValidityMode] = useState<"until_revoked" | "until_date" | null>(null);
  const [expiresOn, setExpiresOn] = useState("");
  const current = reviews.find((r) => r.candidateVersion === candidate.version && r.candidateEvidenceDigest === candidate.evidenceDigest) ?? null;
  const earlier = reviews.filter((r) => r !== current);
  const supported = candidate.operationallySupported && candidate.summaryReflectsCurrentSources;
  // A ratified review stays ratified in history; say plainly when its knowledge no longer applies.
  const currentKnowledge = current?.outcome === "ratified" ? records.find((r) => r.reviewId === current.id) ?? null : null;

  return (
    <li data-testid="learning-review-candidate" data-candidate-id={candidate.id} data-candidate-version={candidate.version} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {current?.outcome === "rejected" ? (
          <Badge tone="danger" testId="learning-review-state-rejected">{`Rejected — version ${candidate.version}`}</Badge>
        ) : current?.outcome === "ratified" ? (
          <>
            <Badge tone="ok" testId="learning-review-state-ratified">{`Ratified — version ${candidate.version}`}</Badge>
            {currentKnowledge && currentKnowledge.effectiveState !== "active" && (
              <Badge tone="warn" testId="learning-review-state-knowledge-inactive">{`Knowledge ${currentKnowledge.effectiveState} — not in effect`}</Badge>
            )}
          </>
        ) : (
          <Badge tone="info" testId="learning-review-state-candidate">Candidate — not knowledge</Badge>
        )}
        <Badge tone="neutral">{`Version ${candidate.version}`}</Badge>
        {candidate.fixture && <Badge tone="warn">Demo data — not a live project record</Badge>}
        <Badge tone={supported ? "ok" : "warn"} testId={supported ? "learning-review-supported" : "learning-review-unsupported"}>
          {candidate.operationallySupported ? (candidate.summaryReflectsCurrentSources ? "Evidence current" : "Summary out of date") : "No current evidence"}
        </Badge>
      </div>
      <div className="mt-2"><PatternLine pattern={candidate.pattern} /></div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-zinc-300 sm:grid-cols-2">
        <div><dt className="inline text-zinc-500">Evidence tier: </dt><dd className="inline">{TIER_LABEL[candidate.evidenceTier] ?? candidate.evidenceTier}</dd></div>
        <div><dt className="inline text-zinc-500">Lineages: </dt><dd className="inline">{candidate.lineageCount} ({candidate.independentLineageCount} structurally independent)</dd></div>
        <div><dt className="inline text-zinc-500">Observed results: </dt><dd className="inline">{formatResults(candidate.resultCounts)}</dd></div>
        <div><dt className="inline text-zinc-500">Confidence: </dt><dd className="inline">{formatPercent(candidate.confidence.value)} <span className="text-zinc-500">({candidate.confidence.method})</span></dd></div>
        <div><dt className="inline text-zinc-500">Summary as of: </dt><dd className="inline">{formatDate(candidate.summaryAsOf)}</dd></div>
        <div><dt className="inline text-zinc-500">Summary reflects current sources: </dt><dd className="inline">{candidate.summaryReflectsCurrentSources ? "yes" : "no"} ({candidate.currentSourceCount} current)</dd></div>
        <div><dt className="inline text-zinc-500">Source project: </dt><dd className="inline">this project</dd></div>
        <div><dt className="inline text-zinc-500">Applicability: </dt><dd className="inline">this project only</dd></div>
      </dl>
      <p data-testid="learning-review-causality" className="mt-2 text-xs text-amber-100/90">
        Correlation only: these outcomes followed this pattern. That does not show the pattern caused them.
      </p>
      <details className="mt-1 text-xs text-zinc-400">
        <summary className="cursor-pointer text-zinc-300">Limitations ({candidate.limitations.length})</summary>
        <ul className="mt-1 list-disc pl-5">{candidate.limitations.map((l) => <li key={l.code}>{l.statement}</li>)}</ul>
      </details>

      {(current || earlier.length > 0) && (
        <ul className="mt-2 space-y-1 text-xs text-zinc-400" data-testid="learning-review-history">
          {[...(current ? [current] : []), ...earlier].map((r) => (
            <li key={r.id}>
              {r.outcome === "ratified" ? "Ratified" : "Rejected"} version {r.candidateVersion} by the workspace {r.reviewerRole} on {formatDate(r.reviewedAt)}
              {r.reviewerIsCandidateCreator ? " (the reviewer also created this candidate)" : ""}. Reason: {r.rationale}
            </li>
          ))}
        </ul>
      )}

      {!current && canGovern && (
        <form
          aria-labelledby={`${formId}-title`}
          className="mt-3 space-y-2 rounded-lg border border-white/10 p-2.5"
          onSubmit={(event) => event.preventDefault()}
        >
          <h3 id={`${formId}-title`} className="text-xs font-semibold text-zinc-300">{`Review version ${candidate.version}`}</h3>
          <label className="block text-xs text-zinc-400" htmlFor={`${formId}-rationale`}>Reason (required)</label>
          <textarea
            id={`${formId}-rationale`}
            data-testid="learning-review-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={2}
            maxLength={8000}
            className="w-full rounded-md border border-white/15 bg-black/20 px-2 py-1 text-sm text-zinc-100"
          />
          <fieldset className="space-y-1">
            <legend className="text-xs text-zinc-400">If ratified, how long does it apply? (required to ratify)</legend>
            <label className="flex items-center gap-2 text-xs text-zinc-200">
              <input type="radio" name={`${formId}-validity`} data-testid="learning-review-validity-until-revoked" checked={validityMode === "until_revoked"} onChange={() => setValidityMode("until_revoked")} />
              Until revoked
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-200">
              <input type="radio" name={`${formId}-validity`} data-testid="learning-review-validity-until-date" checked={validityMode === "until_date"} onChange={() => setValidityMode("until_date")} />
              Expires on date
            </label>
            {validityMode === "until_date" && (
              <label className="block text-xs text-zinc-400">
                Stops applying at the start of
                <input
                  type="date"
                  data-testid="learning-review-expires-on"
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                  className="ml-2 rounded-md border border-white/15 bg-black/20 px-2 py-0.5 text-xs text-zinc-100"
                />
              </label>
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="learning-review-ratify"
              disabled={busy}
              onClick={() => onRatify?.({ candidate, rationale, validityMode, expiresOn })}
              className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-400/20 disabled:opacity-50"
            >
              Ratify as project knowledge
            </button>
            <button
              type="button"
              data-testid="learning-review-reject"
              disabled={busy}
              onClick={() => onReject?.(candidate, rationale)}
              className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-xs font-medium text-rose-100 hover:bg-rose-400/20 disabled:opacity-50"
            >
              Reject this version
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function KnowledgeCard({
  record,
  review,
  canRevoke,
  busy,
  onRevoke,
}: {
  record: ProjectKnowledgeView;
  review: ProjectKnowledgeReviewView | undefined;
  canRevoke: boolean;
  busy: boolean;
  onRevoke?: (record: ProjectKnowledgeView, reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const inEffect = record.effectiveState === "active";
  return (
    <li
      data-testid={inEffect ? "learning-review-knowledge" : "learning-review-knowledge-inactive"}
      data-knowledge-id={record.id}
      className={`rounded-xl border px-3 py-3 ${inEffect ? "border-emerald-400/25 bg-emerald-400/[0.04]" : "border-white/10 bg-white/[0.02] opacity-80"}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {record.effectiveState === "active" && <Badge tone="ok">Ratified project knowledge</Badge>}
        {record.effectiveState === "revoked" && <Badge tone="danger" testId="learning-review-knowledge-revoked">Revoked — not in effect</Badge>}
        {record.effectiveState === "expired" && <Badge tone="warn" testId="learning-review-knowledge-expired">Expired — not in effect</Badge>}
        <Badge tone="neutral">This project only</Badge>
        <Badge tone="neutral">{`From candidate version ${record.candidateVersion}`}</Badge>
        {record.fixture && <Badge tone="warn" testId="learning-review-knowledge-fixture">Demo data — not a live project record</Badge>}
      </div>
      <p className="mt-2 text-sm text-zinc-100" data-testid="learning-review-knowledge-statement">{record.statement}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-zinc-300 sm:grid-cols-2">
        <div><dt className="inline text-zinc-500">Applies: </dt><dd className="inline">{record.validityMode === "until_revoked" ? "until revoked" : `until ${formatDate(record.effectiveUntil)}`}</dd></div>
        <div><dt className="inline text-zinc-500">Ratified: </dt><dd className="inline">{formatDate(record.ratifiedAt)}{review ? ` by the workspace ${review.reviewerRole}` : ""}</dd></div>
        <div><dt className="inline text-zinc-500">Confidence: </dt><dd className="inline">{formatPercent(record.confidence.value)} <span className="text-zinc-500">({record.confidence.method})</span></dd></div>
        <div><dt className="inline text-zinc-500">Causality: </dt><dd className="inline">{record.causalityClaim === "correlation_only" ? "correlation only" : record.causalityClaim}</dd></div>
        {record.revokedAt && <div className="sm:col-span-2"><dt className="inline text-zinc-500">Revoked: </dt><dd className="inline">{formatDate(record.revokedAt)} — {record.revocationReason}</dd></div>}
      </dl>
      <details className="mt-1 text-xs text-zinc-400">
        <summary className="cursor-pointer text-zinc-300">Limitations ({record.limitations.length})</summary>
        <ul className="mt-1 list-disc pl-5">{record.limitations.map((l) => <li key={l.code}>{l.statement}</li>)}</ul>
      </details>
      {record.status === "active" && canRevoke && (
        <form className="mt-2 space-y-1" onSubmit={(event) => event.preventDefault()} aria-label="Revoke this knowledge">
          <label className="block text-xs text-zinc-400" htmlFor={`${id}-reason`}>Revocation reason (required)</label>
          <textarea
            id={`${id}-reason`}
            data-testid="learning-review-revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={8000}
            className="w-full rounded-md border border-white/15 bg-black/20 px-2 py-1 text-sm text-zinc-100"
          />
          <button
            type="button"
            data-testid="learning-review-revoke"
            disabled={busy}
            onClick={() => onRevoke?.(record, reason)}
            className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-xs font-medium text-rose-100 hover:bg-rose-400/20 disabled:opacity-50"
          >
            Revoke
          </button>
        </form>
      )}
    </li>
  );
}

export function LearningReviewView({
  state,
  feedback = null,
  busy = false,
  onRatify,
  onReject,
  onRevoke,
  onRetry,
}: {
  state: LearningReviewLoadState;
  feedback?: LearningReviewFeedback | null;
  busy?: boolean;
  onRatify?: (request: RatifyRequest) => void;
  onReject?: (candidate: LearningCandidateView, rationale: string) => void;
  onRevoke?: (record: ProjectKnowledgeView, reason: string) => void;
  onRetry?: () => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="learning-review-panel" className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-4">
      <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Learning review &amp; project knowledge</h2>

      {state.kind === "loading" && <p role="status" aria-live="polite" className="mt-2 text-sm text-zinc-400">Loading learning candidates and project knowledge…</p>}
      {state.kind === "error" && (
        <div role="alert" data-testid="learning-review-error" className="mt-2 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3 py-3">
          <p className="text-sm text-rose-200">{state.message}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20">
              Try again
            </button>
          )}
        </div>
      )}
      {state.kind === "denied" && <p role="alert" data-testid="learning-review-denied" className="mt-2 text-sm text-rose-200">You do not have access to this project&apos;s learning review.</p>}

      {state.kind === "ready" && (
        <>
          {feedback && <div className="mt-2" aria-live="polite"><FeedbackMessage feedback={feedback} /></div>}

          <h3 className="mt-3 text-xs font-semibold text-zinc-400">Ratified project knowledge</h3>
          {state.knowledge.length === 0 ? (
            <p data-testid="learning-review-knowledge-empty" className="mt-1 text-sm text-zinc-400">No ratified knowledge applies to this project.</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {state.knowledge.map((record) => (
                <KnowledgeCard key={record.id} record={record} review={state.reviews.find((r) => r.id === record.reviewId)} canRevoke={state.canGovern} busy={busy} onRevoke={onRevoke} />
              ))}
            </ul>
          )}

          <h3 className="mt-4 text-xs font-semibold text-zinc-400">Learning candidates</h3>
          <p className="text-[11px] text-zinc-500">Proposed patterns from this project&apos;s outcomes. A candidate is not knowledge until an owner or admin ratifies it.</p>
          {state.candidates.length === 0 ? (
            <p data-testid="learning-review-candidates-empty" className="mt-1 text-sm text-zinc-400">No learning candidates for this project yet.</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {state.candidates.map((candidate) => (
                <CandidateCard
                  key={`${candidate.id}:${candidate.version}`}
                  candidate={candidate}
                  reviews={state.reviews.filter((r) => r.candidateId === candidate.id)}
                  records={state.records}
                  canGovern={state.canGovern}
                  busy={busy}
                  onRatify={onRatify}
                  onReject={onReject}
                />
              ))}
            </ul>
          )}
          {!state.canGovern && (
            <p data-testid="learning-review-read-only" className="mt-3 text-xs text-zinc-500">
              Only workspace owners and admins can ratify, reject or revoke. You can inspect candidates and their evidence.
            </p>
          )}

          {state.records.some((r) => r.effectiveState !== "active") && (
            <>
              <h3 className="mt-4 text-xs font-semibold text-zinc-400">Revoked or expired knowledge (history, not in effect)</h3>
              <ul className="mt-1 space-y-2">
                {state.records.filter((r) => r.effectiveState !== "active").map((record) => (
                  <KnowledgeCard key={record.id} record={record} review={state.reviews.find((r) => r.id === record.reviewId)} canRevoke={false} busy={busy} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Client-side validation mirrors the server's; the server re-validates everything. */
export function validateRatifyRequest(request: RatifyRequest, now: Date): { ok: true; effectiveUntil: string | null } | { ok: false; message: string } {
  if (!request.rationale.trim()) return { ok: false, message: "Give a reason for this decision." };
  if (request.validityMode === null) return { ok: false, message: "Choose how long this knowledge applies: until revoked, or until a date." };
  if (request.validityMode === "until_revoked") return { ok: true, effectiveUntil: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.expiresOn)) return { ok: false, message: "Choose the date this knowledge stops applying." };
  const until = new Date(`${request.expiresOn}T00:00:00`);
  if (Number.isNaN(until.valueOf()) || until.getTime() <= now.getTime()) return { ok: false, message: "The expiry date must be in the future." };
  return { ok: true, effectiveUntil: until.toISOString() };
}

type ApiBody = { ok?: boolean; disposition?: string; error?: string; currentVersion?: number };

function feedbackFromResponse(status: number, body: ApiBody): LearningReviewFeedback {
  if (status === 401) return { kind: "denied" };
  if (body.disposition === "governance_unavailable") return { kind: "governance_unavailable" };
  if (status === 403) return { kind: "denied" };
  switch (body.disposition) {
    case "ratified": return { kind: "ratified" };
    case "rejected": return { kind: "rejected" };
    case "revoked": return { kind: "revoked" };
    case "duplicate": return { kind: "duplicate" };
    case "already_revoked": return { kind: "already_revoked" };
    case "stale_review": return { kind: "stale", currentVersion: typeof body.currentVersion === "number" ? body.currentVersion : null };
    case "not_supported": return { kind: "not_supported" };
    case "already_finalized": return { kind: "already_finalized" };
    case "already_ratified": return { kind: "already_ratified" };
  }
  if (status === 400) return { kind: "validation", message: body.error ?? "The request is not valid." };
  return { kind: "error", message: body.error ?? "The decision could not be recorded. Please retry." };
}

export function LearningReviewPanel({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [state, setState] = useState<LearningReviewLoadState>({ kind: "loading" });
  const [feedback, setFeedback] = useState<LearningReviewFeedback | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchState = useCallback(async (): Promise<LearningReviewLoadState> => {
    try {
      const params = new URLSearchParams({ workspaceId, projectId });
      const [candidatesResponse, knowledgeResponse] = await Promise.all([
        fetch(`/api/learning-candidates?${params.toString()}`, { cache: "no-store" }),
        fetch(`/api/project-knowledge?${params.toString()}`, { cache: "no-store" }),
      ]);
      if ([candidatesResponse.status, knowledgeResponse.status].some((s) => s === 401 || s === 403)) return { kind: "denied" };
      const candidatesBody = (await candidatesResponse.json()) as { ok?: boolean; candidates?: LearningCandidateView[]; error?: string };
      const knowledgeBody = (await knowledgeResponse.json()) as {
        ok?: boolean; knowledge?: ProjectKnowledgeView[]; history?: { records?: ProjectKnowledgeView[]; reviews?: ProjectKnowledgeReviewView[] }; canGovern?: boolean; error?: string;
      };
      if (!candidatesResponse.ok || !candidatesBody.ok) return { kind: "error", message: candidatesBody.error ?? "Learning candidates could not be loaded." };
      if (!knowledgeResponse.ok || !knowledgeBody.ok) return { kind: "error", message: knowledgeBody.error ?? "Project knowledge could not be loaded." };
      return {
        kind: "ready",
        candidates: candidatesBody.candidates ?? [],
        knowledge: knowledgeBody.knowledge ?? [],
        records: knowledgeBody.history?.records ?? [],
        reviews: knowledgeBody.history?.reviews ?? [],
        canGovern: Boolean(knowledgeBody.canGovern),
      };
    } catch {
      return { kind: "error", message: "Learning review could not be loaded." };
    }
  }, [workspaceId, projectId]);

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    void fetchState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchState, workspaceId, projectId]);

  const reload = useCallback(async () => {
    setState(await fetchState());
  }, [fetchState]);

  const send = useCallback(async (url: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      let body: ApiBody = {};
      try {
        body = (await response.json()) as ApiBody;
      } catch {
        body = {};
      }
      setFeedback(feedbackFromResponse(response.status, body));
      await reload();
    } catch {
      setFeedback({ kind: "error", message: "The decision could not be recorded. Please retry." });
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const ratify = useCallback((request: RatifyRequest) => {
    const checked = validateRatifyRequest(request, new Date());
    if (!checked.ok) return setFeedback({ kind: "validation", message: checked.message });
    void send("/api/learning-candidates/review", {
      workspaceId, projectId, decision: "ratify",
      candidateId: request.candidate.id, candidateVersion: request.candidate.version, candidateEvidenceDigest: request.candidate.evidenceDigest,
      rationale: request.rationale, validityMode: request.validityMode, effectiveUntil: checked.effectiveUntil,
    });
  }, [send, workspaceId, projectId]);

  const reject = useCallback((candidate: LearningCandidateView, rationale: string) => {
    if (!rationale.trim()) return setFeedback({ kind: "validation", message: "Give a reason for this decision." });
    void send("/api/learning-candidates/review", {
      workspaceId, projectId, decision: "reject",
      candidateId: candidate.id, candidateVersion: candidate.version, candidateEvidenceDigest: candidate.evidenceDigest, rationale,
    });
  }, [send, workspaceId, projectId]);

  const revoke = useCallback((record: ProjectKnowledgeView, reason: string) => {
    if (!reason.trim()) return setFeedback({ kind: "validation", message: "Give a reason for revoking this knowledge." });
    void send("/api/project-knowledge/revoke", { workspaceId, projectId, knowledgeId: record.id, reason });
  }, [send, workspaceId, projectId]);

  return <LearningReviewView state={state} feedback={feedback} busy={busy} onRatify={ratify} onReject={reject} onRevoke={revoke} onRetry={() => void reload()} />;
}
