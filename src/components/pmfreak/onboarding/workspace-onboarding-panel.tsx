"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { AddTaskCta } from "@/components/pmfreak/empty-states/add-task-cta";
import type {
  WorkspaceActivationPhase,
  WorkspaceActivationResult,
  WorkspaceActivationStep,
  WorkspaceOnboardingPreferences,
} from "@/lib/workspace-activation/types";
import {
  ACTIVATION_STAGE_COPY,
  INVITE_PENDING_NOTE,
  ONBOARDING_PANEL_COPY,
  ONBOARDING_PHASE_COPY,
  ONBOARDING_STEP_COPY,
} from "./workspace-onboarding-copy";

/**
 * Guided Workspace Onboarding panel.
 *
 * Renders the evidence-derived activation checklist from
 * GET /api/workspace-activation. Progress can never be edited from here —
 * the only writes are personal display preferences (collapse / dismiss /
 * skip optional step) via PATCH. Every step state shown comes from real
 * workspace data.
 */

type ActivationEnvelope = {
  ok: boolean;
  data?: {
    activation: WorkspaceActivationResult;
    preferences: WorkspaceOnboardingPreferences;
  };
};

const fetcher = async (url: string) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed ${url}`);
  return response.json();
};

const PHASE_ORDER: WorkspaceActivationPhase[] = ["foundation", "execution", "operational_value"];

function StatusMark({ step }: { step: WorkspaceActivationStep }) {
  // Status is always conveyed with text as well (never color alone).
  if (step.status === "completed") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white"
      >
        ✓
      </span>
    );
  }
  if (step.status === "blocked") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-[11px] text-slate-400"
      >
        ·
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white"
    />
  );
}

function tierLabel(step: WorkspaceActivationStep): string | null {
  if (step.required) return null;
  return step.tier === "recommended" ? "Recommended" : "Optional";
}

function StepRow({
  step,
  skipped,
  onToggleSkip,
  saving,
}: {
  step: WorkspaceActivationStep;
  skipped: boolean;
  onToggleSkip: (stepId: WorkspaceActivationStep["id"], skip: boolean) => void;
  saving: boolean;
}) {
  const copy = ONBOARDING_STEP_COPY[step.id];
  const isCompleted = step.status === "completed";
  const isBlocked = step.status === "blocked";
  const showCta = step.status === "available" && step.actionAllowed && step.route && copy.ctaLabel;
  const showRestricted = step.status === "available" && !step.actionAllowed && copy.restrictedNote;
  const label = tierLabel(step);
  const statusText = isCompleted
    ? "Completed"
    : isBlocked
      ? "Blocked"
      : skipped
        ? "Skipped"
        : "Available";

  return (
    <li
      className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${
        isCompleted
          ? "border-emerald-100 bg-emerald-50/40"
          : skipped
            ? "border-slate-100 bg-slate-50/60 opacity-70"
            : "border-slate-100 bg-white"
      }`}
      data-testid={`onboarding-step-${step.id}`}
      data-status={step.status}
    >
      <StatusMark step={step} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <p className={`text-sm font-medium ${isCompleted ? "text-emerald-900" : "text-slate-900"}`}>
            {copy.title}
          </p>
          {label && (
            <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
              {label}
            </span>
          )}
          <span className="sr-only">Status: {statusText}</span>
        </div>
        {!isCompleted && (
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            {isBlocked && copy.blockedNote ? copy.blockedNote : copy.description}
          </p>
        )}
        {isCompleted && step.note === "invite_pending" && (
          <p className="mt-0.5 text-xs text-amber-700">{INVITE_PENDING_NOTE}</p>
        )}
        {showRestricted && <p className="mt-0.5 text-xs text-slate-400">{copy.restrictedNote}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {showCta && step.id === "task_created" ? (
            <AddTaskCta
              label={copy.ctaLabel as string}
              className="inline-flex rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
            />
          ) : (
            showCta && (
              <Link
                href={step.route as string}
                className="inline-flex rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
              >
                {copy.ctaLabel}
              </Link>
            )
          )}
          {!isCompleted && !isBlocked && !step.required && (
            <button
              type="button"
              disabled={saving}
              onClick={() => onToggleSkip(step.id, !skipped)}
              className="text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-50"
            >
              {skipped ? "Restore step" : "Skip for now"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function WorkspaceOnboardingPanel({
  surface = "dashboard",
  workspaceId,
}: {
  /** "dashboard" renders compact/dismissible; "setup" always renders expanded. */
  surface?: "dashboard" | "setup";
  /**
   * The workspace this panel is about, when the host already authorized one (e.g. the
   * project conversation's routed workspace — CHAT-SHELL-01 F4). Sent on the read AND on
   * every preference write; the route re-validates membership for it and never trusts it
   * as-is. Omitted, the route answers for the preferred workspace, as before.
   */
  workspaceId?: string;
}) {
  const endpoint = workspaceId
    ? `/api/workspace-activation?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/api/workspace-activation";
  const { data, error, isLoading, mutate } = useSWR<ActivationEnvelope>(
    endpoint,
    fetcher,
    { refreshInterval: 30000 },
  );
  const [saving, setSaving] = useState(false);

  const activation = data?.data?.activation;
  const preferences = data?.data?.preferences;

  const patchPreferences = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await mutate();
    } finally {
      setSaving(false);
    }
  };

  const phases = useMemo(() => {
    if (!activation) return [];
    return PHASE_ORDER.map((phase) => ({
      phase,
      copy: ONBOARDING_PHASE_COPY[phase],
      steps: activation.steps.filter(
        (step) => step.phase === phase && step.status !== "not_applicable",
      ),
    })).filter((group) => group.steps.length > 0);
  }, [activation]);

  if (isLoading) return null;

  if (error || !activation || !preferences) {
    if (surface === "setup") {
      return (
        <section className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5" data-testid="onboarding-panel-error">
          <p className="text-sm text-rose-800">Unable to load workspace setup status.</p>
        </section>
      );
    }
    return null;
  }

  const progressText = `${activation.completedEssentialSteps} of ${activation.totalEssentialSteps} essential steps completed`;
  const remainingRecommended = activation.totalRecommendedSteps - activation.completedRecommendedSteps;
  const dismissed = Boolean(preferences.dismissedAt);
  const collapsed = preferences.collapsed && surface !== "setup";
  const skippedSet = new Set(preferences.skippedStepIds);

  const onToggleSkip = (stepId: WorkspaceActivationStep["id"], skip: boolean) => {
    const next = skip
      ? [...preferences.skippedStepIds, stepId]
      : preferences.skippedStepIds.filter((id) => id !== stepId);
    void patchPreferences({ skippedStepIds: next });
  };

  // Dismissed on the dashboard: a single discreet reopen link — the guide is
  // hidden, never reported as finished.
  if (dismissed && surface === "dashboard") {
    return (
      <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-white px-4 py-2" data-testid="onboarding-reopen-link">
        <p className="text-xs text-slate-500">
          {ONBOARDING_PANEL_COPY.reopenLabel} · {progressText}
        </p>
        <button
          type="button"
          disabled={saving}
          onClick={() => void patchPreferences({ dismissed: false })}
          className="text-xs font-medium text-cyan-800 underline-offset-2 hover:underline disabled:opacity-50"
        >
          {ONBOARDING_PANEL_COPY.reopenAction}
        </button>
      </div>
    );
  }

  // Ready state: essentials are complete. Compact confirmation, honest about
  // remaining recommended steps — never "everything is configured".
  if (activation.workspaceReady && surface === "dashboard") {
    return (
      <section
        aria-label="Workspace setup status"
        className="rounded-2xl border border-emerald-100 bg-emerald-50/50 px-5 py-4"
        data-testid="onboarding-ready-state"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-emerald-900">{ONBOARDING_PANEL_COPY.readyTitle}</p>
            <p className="mt-0.5 text-xs text-emerald-800">
              {ONBOARDING_PANEL_COPY.readyDescription} {ACTIVATION_STAGE_COPY[activation.stage]}.
            </p>
            <p className="mt-0.5 text-xs text-emerald-700">
              {progressText}
              {remainingRecommended > 0
                ? ` · ${remainingRecommended} recommended setup step${remainingRecommended === 1 ? "" : "s"} remaining`
                : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/workspace-setup" className="text-xs text-emerald-800 underline-offset-2 hover:underline">
              View setup
            </Link>
            {!dismissed && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void patchPreferences({ dismissed: true })}
                className="text-xs text-emerald-700 underline-offset-2 hover:underline disabled:opacity-50"
              >
                {ONBOARDING_PANEL_COPY.dismissLabel}
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (collapsed) {
    return (
      <section
        aria-label="Workspace setup progress"
        className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-2.5"
        data-testid="onboarding-panel-collapsed"
      >
        <p className="text-xs text-slate-600">
          <span className="font-semibold text-slate-800">{ONBOARDING_PANEL_COPY.reopenLabel}</span>{" "}
          · {progressText}
        </p>
        <button
          type="button"
          aria-expanded={false}
          disabled={saving}
          onClick={() => void patchPreferences({ collapsed: false })}
          className="text-xs font-medium text-cyan-800 underline-offset-2 hover:underline disabled:opacity-50"
        >
          {ONBOARDING_PANEL_COPY.expandLabel}
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Workspace setup guide"
      className="rounded-2xl border border-slate-200 bg-white p-5"
      data-testid="onboarding-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
            Workspace Setup
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
            {ONBOARDING_PANEL_COPY.title}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{ONBOARDING_PANEL_COPY.description}</p>
        </div>
        {surface === "dashboard" && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-expanded={true}
              disabled={saving}
              onClick={() => void patchPreferences({ collapsed: true })}
              className="text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-50"
            >
              {ONBOARDING_PANEL_COPY.collapseLabel}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void patchPreferences({ dismissed: true })}
              className="text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-50"
            >
              {ONBOARDING_PANEL_COPY.dismissLabel}
            </button>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs font-medium text-slate-600" role="status" data-testid="onboarding-progress">
        {progressText}
        {activation.totalRecommendedSteps > 0 && (
          <span className="text-slate-400">
            {" "}
            · {activation.completedRecommendedSteps} of {activation.totalRecommendedSteps} recommended steps
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-slate-400">{ACTIVATION_STAGE_COPY[activation.stage]}</p>

      <div className="mt-4 space-y-4">
        {phases.map(({ phase, copy, steps }) => (
          <div key={phase} data-testid={`onboarding-phase-${phase}`}>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {copy.title}
            </h3>
            <ul className="mt-2 space-y-1.5">
              {steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  skipped={skippedSet.has(step.id)}
                  onToggleSkip={onToggleSkip}
                  saving={saving}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
