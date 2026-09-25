"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import type {
  ProjectIdentity,
  DeliveryContext,
  GovernanceSkeleton,
  IntelligenceDiscovery,
  ProjectOnboardingPayload,
  ScopeType,
} from "@/lib/projects/project-onboarding-types";
import {
  PROJECT_TYPES,
  SCOPE_TYPES,
  DEFAULT_GOVERNANCE,
} from "@/lib/projects/project-onboarding-types";
import { saveProjectOnboarding } from "@/lib/projects/save-project-onboarding";
import type { ProjectSaveResult } from "@/lib/projects/save-project-onboarding";
import { BrainBootSequence } from "./brain-boot-sequence";
import { workspaceCommandCenterPath } from "@/lib/workspaces/workspace-paths";

// ─── Styles ────────────────────────────────────────────────────────────────────

const inputCls =
  "block w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400/60";
const labelCls =
  "flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-zinc-500";
const chip = (active: boolean) =>
  `cursor-pointer rounded-xl border px-4 py-3 text-left text-sm transition-all ${
    active
      ? "border-cyan-400/40 bg-cyan-400/[0.08] text-cyan-900 shadow-[0_0_16px_rgba(34,211,238,0.08)]"
      : "border-slate-200 bg-white text-zinc-600 hover:border-slate-200 hover:text-zinc-800"
  }`;
const sectionLabel = "mb-4 text-[10px] uppercase tracking-[0.3em] text-zinc-400";

// ─── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "Project Identity", short: "Identity" },
  { id: 2, label: "Delivery Context", short: "Context" },
  { id: 3, label: "Governance", short: "Governance" },
  { id: 4, label: "Discovery", short: "Discovery" },
  { id: 5, label: "Activate Brain", short: "Activate" },
] as const;

// ─── Default state ─────────────────────────────────────────────────────────────

const DEFAULT_IDENTITY: ProjectIdentity = {
  projectName: "",
  clientOrganization: "",
  projectType: "",
  contractCode: "",
  pmAssigned: "",
  technicalLead: "",
  targetDeliveryDate: "",
};

const DEFAULT_DELIVERY: DeliveryContext = {
  problemStatement: "",
  mainDeliverable: "",
  externalDependencies: "",
  contractualMilestones: "",
  scopeType: "closed",
};

const DEFAULT_DISCOVERY: IntelligenceDiscovery = {
  unknowns: "",
  requirementsDefined: null,
  pendingClientDependencies: "",
  pendingAccesses: "",
  vendorDependencies: "",
  financialBlockers: "",
};

// ─── Draft persistence ─────────────────────────────────────────────────────────

const DRAFT_KEY = "pmfreak.project.draft";

function loadDraft(): Partial<{ identity: ProjectIdentity; delivery: DeliveryContext; discovery: IntelligenceDiscovery }> | null {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(DRAFT_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft(data: object) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validate(step: number, identity: ProjectIdentity, delivery: DeliveryContext): string[] {
  const errs: string[] = [];
  if (step === 1) {
    if (!identity.projectName.trim()) errs.push("Project name is required.");
    if (!identity.clientOrganization.trim()) errs.push("Client / organization is required.");
    if (!identity.projectType) errs.push("Project type is required.");
    if (!identity.pmAssigned.trim()) errs.push("PM assigned is required.");
  }
  if (step === 2) {
    if (!delivery.problemStatement.trim()) errs.push("Problem statement is required.");
    if (!delivery.mainDeliverable.trim()) errs.push("Main deliverable is required.");
    if (!delivery.scopeType) errs.push("Scope type is required.");
  }
  return errs;
}

function hasMinimumContext(identity: ProjectIdentity, delivery: DeliveryContext): boolean {
  return (
    Boolean(identity.projectName.trim()) &&
    Boolean(identity.clientOrganization.trim()) &&
    Boolean(identity.projectType) &&
    Boolean(identity.pmAssigned.trim()) &&
    Boolean(delivery.problemStatement.trim()) &&
    Boolean(delivery.mainDeliverable.trim())
  );
}

// ─── Step 1: Project Identity ──────────────────────────────────────────────────

function StepIdentity({
  data,
  onChange,
}: {
  data: ProjectIdentity;
  onChange: (field: keyof ProjectIdentity, value: string) => void;
}) {
  return (
    <div className="space-y-7">
      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Project identity</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
          This becomes the identity layer PMFreak uses to anchor all governance reasoning, reporting, and intelligence synthesis.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelCls}>
          Project Name <span className="text-pink-600 normal-case">*</span>
          <input
            className={inputCls}
            placeholder="ERP Phase 2 Rollout"
            value={data.projectName}
            onChange={(e) => onChange("projectName", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Client / Organization <span className="text-pink-600 normal-case">*</span>
          <input
            className={inputCls}
            placeholder="Acme Corporation"
            value={data.clientOrganization}
            onChange={(e) => onChange("clientOrganization", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Contract / Opportunity Code
          <input
            className={inputCls}
            placeholder="OPP-2025-0142"
            value={data.contractCode}
            onChange={(e) => onChange("contractCode", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          PM Assigned <span className="text-pink-600 normal-case">*</span>
          <input
            className={inputCls}
            placeholder="Jane Smith"
            value={data.pmAssigned}
            onChange={(e) => onChange("pmAssigned", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Technical Lead
          <input
            className={inputCls}
            placeholder="Carlos Rivera"
            value={data.technicalLead}
            onChange={(e) => onChange("technicalLead", e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Target Delivery Date
          <input
            type="date"
            className={inputCls}
            value={data.targetDeliveryDate}
            onChange={(e) => onChange("targetDeliveryDate", e.target.value)}
          />
        </label>
      </div>

      <div>
        <p className={sectionLabel}>Project Type <span className="text-pink-600 normal-case font-normal">*</span></p>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {PROJECT_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onChange("projectType", t.value)}
              className={chip(data.projectType === t.value)}
            >
              <span className="block font-semibold">{t.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step 2: Delivery Context ──────────────────────────────────────────────────

function StepDeliveryContext({
  data,
  onChange,
}: {
  data: DeliveryContext;
  onChange: (field: keyof DeliveryContext, value: string | ScopeType) => void;
}) {
  return (
    <div className="space-y-7">
      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Delivery context</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
          Define the delivery landscape. This seeds the project brain with the constraints and commitments it will reason from.
        </p>
      </div>

      <label className={labelCls}>
        What problem does this project solve? <span className="text-pink-600 normal-case">*</span>
        <textarea
          className={`${inputCls} resize-none`}
          rows={3}
          placeholder="Describe the core business or technical problem this project addresses."
          value={data.problemStatement}
          onChange={(e) => onChange("problemStatement", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        Main deliverable <span className="text-pink-600 normal-case">*</span>
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="The primary outcome or artefact this project produces."
          value={data.mainDeliverable}
          onChange={(e) => onChange("mainDeliverable", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        External dependencies
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="Third-party vendors, upstream teams, regulatory bodies, or infrastructure dependencies."
          value={data.externalDependencies}
          onChange={(e) => onChange("externalDependencies", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        Contractual milestones
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="Key contract gates, SLA dates, or governance sign-off points."
          value={data.contractualMilestones}
          onChange={(e) => onChange("contractualMilestones", e.target.value)}
        />
      </label>

      <div>
        <p className={sectionLabel}>Scope type <span className="text-pink-600 normal-case font-normal">*</span></p>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {SCOPE_TYPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange("scopeType", s.value)}
              className={chip(data.scopeType === s.value)}
            >
              <span className="block font-semibold">{s.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{s.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Governance Skeleton ───────────────────────────────────────────────

const GOVERNANCE_ITEMS = [
  {
    key: "raidInitialized" as keyof GovernanceSkeleton,
    label: "RAID Register",
    desc: "Risks, Assumptions, Issues, Decisions — pre-structured and ready for population.",
    icon: "⚑",
    color: "border-amber-300/30 bg-amber-400/[0.05]",
    tag: "border-amber-300/40 bg-amber-300/10 text-amber-800",
  },
  {
    key: "stakeholdersInitialized" as keyof GovernanceSkeleton,
    label: "Stakeholder Map",
    desc: "Influence matrix, communication preferences, and escalation paths scaffolded.",
    icon: "◎",
    color: "border-violet-300/30 bg-violet-400/[0.05]",
    tag: "border-violet-300/40 bg-violet-300/10 text-violet-800",
  },
  {
    key: "deliveryCadenceInitialized" as keyof GovernanceSkeleton,
    label: "Delivery Cadence",
    desc: "Sprint, milestone, and checkpoint rhythm aligned to your governance profile.",
    icon: "◈",
    color: "border-cyan-300/30 bg-cyan-400/[0.05]",
    tag: "border-cyan-300/40 bg-cyan-300/10 text-cyan-800",
  },
  {
    key: "reportingStructureInitialized" as keyof GovernanceSkeleton,
    label: "Reporting Structure",
    desc: "Status report templates and executive summary cadence initialized.",
    icon: "▤",
    color: "border-emerald-300/30 bg-emerald-400/[0.05]",
    tag: "border-emerald-300/40 bg-emerald-300/10 text-emerald-800",
  },
  {
    key: "escalationMapInitialized" as keyof GovernanceSkeleton,
    label: "Escalation Map",
    desc: "Decision authority, escalation thresholds, and sponsor chain defined.",
    icon: "▲",
    color: "border-fuchsia-300/30 bg-fuchsia-400/[0.05]",
    tag: "border-fuchsia-300/40 bg-fuchsia-300/10 text-fuchsia-800",
  },
  {
    key: "healthBaselineInitialized" as keyof GovernanceSkeleton,
    label: "Project Health Baseline",
    desc: "Initial confidence score, delivery risk tier, and RAG status zeroed in.",
    icon: "◉",
    color: "border-slate-300/30 bg-slate-400/[0.05]",
    tag: "border-slate-300/40 bg-slate-300/10 text-slate-800",
  },
];

function StepGovernanceSkeleton({ projectName }: { projectName: string }) {
  return (
    <div className="space-y-7">
      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Build governance skeleton</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
          PMFreak automatically prepares the foundational governance structures for{" "}
          <span className="text-cyan-800">{projectName || "this project"}</span>. These activate on brain initialization.
        </p>
      </div>

      <div className="rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.03] px-5 py-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/60">AOC Protocol</p>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          All governance structures are pre-wired to the AOC reasoning engine. Once activated, agents will populate, monitor, and evolve each structure in real time.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {GOVERNANCE_ITEMS.map((item) => (
          <div
            key={item.key}
            className={`rounded-2xl border p-5 ${item.color}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base">{item.icon}</span>
                  <span className="text-sm font-semibold text-slate-900">{item.label}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{item.desc}</p>
              </div>
              <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[9px] uppercase tracking-[0.15em] ${item.tag}`}>
                Ready
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Step 4: Intelligence Discovery ───────────────────────────────────────────

function StepIntelligenceDiscovery({
  data,
  onChange,
  onToggleReqs,
}: {
  data: IntelligenceDiscovery;
  onChange: (field: keyof IntelligenceDiscovery, value: string) => void;
  onToggleReqs: (value: boolean | null) => void;
}) {
  return (
    <div className="space-y-7">
      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Intelligence discovery</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
          Surface early unknowns and pending blockers. The project brain uses this to calibrate its risk baseline and prioritize its first signals.
        </p>
      </div>

      <label className={labelCls}>
        What is still unknown?
        <textarea
          className={`${inputCls} resize-none`}
          rows={3}
          placeholder="List open questions, undefined constraints, or areas where clarity is still pending."
          value={data.unknowns}
          onChange={(e) => onChange("unknowns", e.target.value)}
        />
      </label>

      <div>
        <p className={sectionLabel}>Are technical requirements fully defined?</p>
        <div className="flex gap-3">
          {[
            { value: true, label: "Yes, defined" },
            { value: false, label: "No, pending" },
            { value: null, label: "Partially" },
          ].map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onToggleReqs(opt.value)}
              className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                data.requirementsDefined === opt.value
                  ? "border-indigo-300/50 bg-indigo-400/15 text-indigo-900"
                  : "border-slate-200 bg-white text-zinc-500 hover:border-slate-200 hover:text-zinc-800"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <label className={labelCls}>
        Pending client dependencies
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="What do you need from the client before work can proceed or complete?"
          value={data.pendingClientDependencies}
          onChange={(e) => onChange("pendingClientDependencies", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        Pending accesses
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="Systems, environments, credentials, or approvals not yet granted."
          value={data.pendingAccesses}
          onChange={(e) => onChange("pendingAccesses", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        Vendor / logistics dependencies
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="Third-party vendors, hardware, or procurement dependencies."
          value={data.vendorDependencies}
          onChange={(e) => onChange("vendorDependencies", e.target.value)}
        />
      </label>

      <label className={labelCls}>
        Financial or approval blockers
        <textarea
          className={`${inputCls} resize-none`}
          rows={2}
          placeholder="Budget approvals, POs, contract signatures, or funding gates outstanding."
          value={data.financialBlockers}
          onChange={(e) => onChange("financialBlockers", e.target.value)}
        />
      </label>
    </div>
  );
}

// ─── Step 5: Project Brain Activation ─────────────────────────────────────────

function StepBrainActivation({
  identity,
  delivery,
  discovery,
  activating,
  contextReady,
  saveError,
  saveFailureClass,
  saveFailureDetail,
  onActivate,
  onRetry,
  onFixConfig,
}: {
  identity: ProjectIdentity;
  delivery: DeliveryContext;
  discovery: IntelligenceDiscovery;
  activating: boolean;
  contextReady: boolean;
  saveError: string | null;
  saveFailureClass: "recoverable_failure" | "fatal_failure" | null;
  saveFailureDetail: string | null;
  onActivate: () => void;
  onRetry: () => void;
  onFixConfig: () => void;
}) {
  const humanize = (v: string) => v.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const BRAIN_COMPONENTS = [
    { label: "Project Memory", desc: "Operational context, history, and delivery signals" },
    { label: "Scope Baseline", desc: "Problem, deliverable, milestones, and scope type" },
    { label: "Risk Baseline", desc: "Initial RAID, unknowns, and dependency map" },
    { label: "Stakeholder Map", desc: "Influence matrix and escalation chain" },
    { label: "Delivery Constraints", desc: "Accesses, vendor deps, financial blockers" },
    { label: "Governance Skeleton", desc: "RAID, cadence, reporting, and health baseline" },
  ];

  return (
    <div className="space-y-6">
      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Activate Project Brain</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
          Review your project configuration. Once activated, PMFreak initializes the full intelligence layer for this initiative.
        </p>
      </div>

      {!contextReady && (
        <div className="rounded-2xl border border-amber-300/25 bg-amber-400/[0.05] p-4">
          <p className="text-sm text-amber-800">
            Project Brain activation requires minimum context — complete Steps 1 and 2 before activating.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Project Identity</p>
          <dl className="space-y-2">
            {[
              ["Project", identity.projectName],
              ["Client", identity.clientOrganization],
              ["Type", identity.projectType ? humanize(identity.projectType) : "—"],
              ["PM", identity.pmAssigned],
              ...(identity.technicalLead ? [["Tech Lead", identity.technicalLead] as [string, string]] : []),
              ...(identity.contractCode ? [["Contract", identity.contractCode] as [string, string]] : []),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 shrink-0">{k}</dt>
                <dd className="text-xs text-slate-800 text-right">{v || "—"}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Delivery Context</p>
          <p className="text-xs leading-relaxed text-slate-700 line-clamp-3">
            {delivery.problemStatement || "—"}
          </p>
          {delivery.scopeType && (
            <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
              Scope: {humanize(delivery.scopeType)}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="mb-4 text-[10px] uppercase tracking-[0.24em] text-cyan-300/60">
          Brain initializing with
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {BRAIN_COMPONENTS.map((c) => (
            <div key={c.label} className="flex items-start gap-2.5">
              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]" />
              <div>
                <p className="text-xs font-semibold text-slate-800">{c.label}</p>
                <p className="text-[10px] text-zinc-400">{c.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {discovery.unknowns && (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-400/[0.03] p-5">
          <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-amber-300/60">Discovery Signals</p>
          <p className="text-xs leading-relaxed text-zinc-600 line-clamp-3">{discovery.unknowns}</p>
        </div>
      )}

      {/* INVARIANT 5: Blocking error banner — surfaced on every failure */}
      {saveError && saveFailureClass && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-2xl border border-red-400/35 bg-red-950/40 p-5 space-y-3"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-red-600 text-base shrink-0">✕</span>
            <div className="space-y-1 flex-1">
              <p className="text-sm font-semibold text-red-800">Project Brain activation failed</p>
              <p className="text-sm text-red-300/80 leading-relaxed">
                {saveError === "upgrade_required"
                  ? "Your current plan does not support additional projects. Please upgrade to continue."
                  : saveError}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-red-700">
              {saveFailureClass === "fatal_failure" ? "Fatal" : "Recoverable"}
            </span>
            {saveFailureDetail && (
              <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-0.5 text-[10px] text-zinc-500">
                {saveFailureDetail}
              </span>
            )}
            <span className="text-[10px] text-zinc-400">Your draft has been preserved.</span>
          </div>
          {saveFailureClass === "recoverable_failure" ? (
            <button
              type="button"
              onClick={onRetry}
              className="w-full rounded-xl border border-red-300/30 bg-red-400/[0.08] px-4 py-2.5 text-sm font-semibold text-red-800 transition hover:bg-red-400/[0.14]"
            >
              Retry
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onFixConfig}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-slate-200"
              >
                Return to edit
              </button>
              {saveError === "upgrade_required" && (
                <a
                  href="/billing"
                  className="flex-1 rounded-xl border border-amber-300/30 bg-amber-400/[0.08] px-4 py-2.5 text-sm font-semibold text-amber-800 text-center transition hover:bg-amber-400/[0.14]"
                >
                  Upgrade plan
                </a>
              )}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onActivate}
        disabled={activating || !contextReady || !!saveError}
        className="relative w-full overflow-hidden rounded-2xl border border-cyan-300/30 bg-gradient-to-r from-cyan-950/60 via-indigo-950/60 to-cyan-950/60 px-6 py-5 text-base font-semibold text-slate-900 shadow-[0_0_40px_rgba(34,211,238,0.12)] transition-all hover:shadow-[0_0_60px_rgba(34,211,238,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {activating ? (
          <span className="flex items-center justify-center gap-2.5">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-cyan-400" />
            Initializing Project Intelligence…
          </span>
        ) : (
          "Activate Project Brain →"
        )}
      </button>
    </div>
  );
}

// ─── Main Wizard ───────────────────────────────────────────────────────────────

export function CreateProjectWizard({
  pmoId,
  workspaceId,
}: {
  pmoId?: string;
  /**
   * The target workspace the page authorized server-side (CHAT-SHELL-01 F1). Passed to
   * the save action as a claim that the action re-authorizes; never trusted as-is.
   */
  workspaceId?: string;
} = {}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<string[]>([]);
  const [activating, setActivating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFailureClass, setSaveFailureClass] = useState<"recoverable_failure" | "fatal_failure" | null>(null);
  const [saveFailureDetail, setSaveFailureDetail] = useState<string | null>(null);
  const activationInFlightRef = useRef(false);
  const navigationCommittedRef = useRef(false);
  const [correlationId] = useState(() => `proj_${Date.now()}`);
  const [showBootSequence, setShowBootSequence] = useState(false);
  const bootSequenceCompleteRef = useRef<(() => void) | null>(null);

  // Resolves once BrainBootSequence's onComplete fires, so handleActivate can
  // await the animation before navigating — the navigation call itself stays
  // a single, literal router.push keyed off the confirmed result.projectId.
  const waitForBootSequence = useCallback(
    () =>
      new Promise<void>((resolve) => {
        bootSequenceCompleteRef.current = resolve;
      }),
    []
  );

  const [identity, setIdentity] = useState<ProjectIdentity>(() => {
    const d = loadDraft();
    return d?.identity ?? DEFAULT_IDENTITY;
  });
  const [delivery, setDelivery] = useState<DeliveryContext>(() => {
    const d = loadDraft();
    return d?.delivery ?? DEFAULT_DELIVERY;
  });
  const [discovery, setDiscovery] = useState<IntelligenceDiscovery>(() => {
    const d = loadDraft();
    return d?.discovery ?? DEFAULT_DISCOVERY;
  });

  const persist = useCallback(
    (patch: Partial<{ identity: ProjectIdentity; delivery: DeliveryContext; discovery: IntelligenceDiscovery }>) => {
      saveDraft({ identity, delivery, discovery, ...patch });
    },
    [identity, delivery, discovery]
  );

  const updateIdentity = (field: keyof ProjectIdentity, value: string) => {
    const next = { ...identity, [field]: value };
    setIdentity(next);
    persist({ identity: next });
  };

  const updateDelivery = (field: keyof DeliveryContext, value: string | ScopeType) => {
    const next = { ...delivery, [field]: value };
    setDelivery(next);
    persist({ delivery: next });
  };

  const updateDiscovery = (field: keyof IntelligenceDiscovery, value: string) => {
    const next = { ...discovery, [field]: value };
    setDiscovery(next);
    persist({ discovery: next });
  };

  const toggleRequirementsDefined = (value: boolean | null) => {
    const next = { ...discovery, requirementsDefined: value };
    setDiscovery(next);
    persist({ discovery: next });
  };

  const handleNext = () => {
    const errs = validate(step, identity, delivery);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    setStep((s) => Math.min(s + 1, STEPS.length));
  };

  const handleBack = () => {
    setErrors([]);
    setStep((s) => Math.max(s - 1, 1));
  };

  const handleActivate = async () => {
    const contextReady = hasMinimumContext(identity, delivery);
    if (!contextReady || activationInFlightRef.current || navigationCommittedRef.current) return;

    activationInFlightRef.current = true;
    setActivating(true);
    setSaveError(null);
    setSaveFailureClass(null);

    const payload: ProjectOnboardingPayload = {
      identity,
      deliveryContext: delivery,
      governance: DEFAULT_GOVERNANCE,
      discovery,
      createdAt: new Date().toISOString(),
    };

    let result: ProjectSaveResult;
    try {
      result = await saveProjectOnboarding(payload, correlationId, { pmoId: pmoId ?? null, workspaceId: workspaceId ?? null });
    } catch {
      // Server action transport failure — treat as recoverable
      setSaveError("A network error occurred. Your draft is preserved. Please try again.");
      setSaveFailureClass("recoverable_failure");
      setSaveFailureDetail("network_error");
      activationInFlightRef.current = false;
      setActivating(false);
      return;
    }

    if (result.status !== "success") {
      // INVARIANT 3: draft preserved on failure — INVARIANT 1: no navigation
      setSaveError(result.error);
      setSaveFailureClass(result.status);
      setSaveFailureDetail(result.failureClass);
      activationInFlightRef.current = false;
      setActivating(false);
      return;
    }

    // Persistence confirmed — safe to clear draft and navigate. Navigation
    // itself waits for the brain boot sequence to finish playing; new
    // projects land in the Command Center showing the Project Intelligence
    // Inbox first.
    clearDraft();
    navigationCommittedRef.current = true;
    setShowBootSequence(true);
    await waitForBootSequence();
    // A dedicated `brainActivated` marker (not the generic `from=onboarding`
    // used by the PMO activation and invite-team flows) so only the project
    // actually just activated here shows the Project Intelligence Inbox.
    //
    // CHAT-SHELL-01 F1: to the Command Center of the workspace the server ACTUALLY created
    // the project in. The bare `/command-center` resolves the preferred-workspace cookie,
    // which would refuse a project created in any other workspace as "not found".
    router.push(
      workspaceCommandCenterPath(result.workspaceId, {
        projectId: result.projectId,
        briefGeneration: result.briefStatus === "generation_failed" ? "failed" : undefined,
        brainActivated: 1,
      }),
    );
  };

  const handleRetry = () => {
    console.info(JSON.stringify({ event: "project.create.retry", correlationId, ts: new Date().toISOString() }));
    setSaveError(null);
    setSaveFailureClass(null);
    setSaveFailureDetail(null);
    void handleActivate();
  };

  const contextReady = hasMinimumContext(identity, delivery);

  const renderStep = () => {
    switch (step) {
      case 1:
        return <StepIdentity data={identity} onChange={updateIdentity} />;
      case 2:
        return <StepDeliveryContext data={delivery} onChange={updateDelivery} />;
      case 3:
        return <StepGovernanceSkeleton projectName={identity.projectName} />;
      case 4:
        return (
          <StepIntelligenceDiscovery
            data={discovery}
            onChange={updateDiscovery}
            onToggleReqs={toggleRequirementsDefined}
          />
        );
      case 5:
        return (
          <StepBrainActivation
            identity={identity}
            delivery={delivery}
            discovery={discovery}
            activating={activating}
            contextReady={contextReady}
            saveError={saveError}
            saveFailureClass={saveFailureClass}
            saveFailureDetail={saveFailureDetail}
            onActivate={handleActivate}
            onRetry={handleRetry}
            onFixConfig={() => { setSaveError(null); setSaveFailureClass(null); setSaveFailureDetail(null); setStep(1); }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {STEPS.map((s, i) => {
          const isDone = s.id < step;
          const isCurrent = s.id === step;
          return (
            <div key={s.id} className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (isDone) {
                    setErrors([]);
                    setStep(s.id);
                  }
                }}
                disabled={!isDone}
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs transition-colors ${
                  isCurrent
                    ? "border border-cyan-300/40 bg-cyan-400/[0.1] text-cyan-900"
                    : isDone
                    ? "cursor-pointer border border-slate-200 bg-white text-zinc-600 hover:text-slate-800"
                    : "cursor-default border border-slate-200 text-zinc-300"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                    isCurrent
                      ? "bg-cyan-400/25 text-cyan-900"
                      : isDone
                      ? "bg-slate-50 text-zinc-700"
                      : "bg-white text-zinc-300"
                  }`}
                >
                  {isDone ? "✓" : s.id}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
                <span className="sm:hidden">{s.short}</span>
              </button>
              {i < STEPS.length - 1 && (
                <span
                  className={`h-px w-3 shrink-0 ${s.id < step ? "bg-cyan-400/25" : "bg-white"}`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Content */}
      <div className="rounded-2xl border border-slate-200 bg-[#FCFBF9]/50 p-6 md:p-8">
        {renderStep()}
      </div>

      {/* Validation errors */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-red-400/25 bg-red-400/[0.05] p-4">
          <ul className="space-y-1">
            {errors.map((e) => (
              <li key={e} className="text-sm text-red-700">{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Navigation */}
      {step < STEPS.length && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === 1}
            className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm text-zinc-600 transition hover:border-slate-200 hover:text-slate-800 disabled:cursor-default disabled:opacity-30"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="rounded-xl border border-cyan-200/30 bg-cyan-400/[0.1] px-6 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.18]"
          >
            Continue →
          </button>
        </div>
      )}
      {step === STEPS.length && step > 1 && (
        <div className="flex">
          <button
            type="button"
            onClick={handleBack}
            disabled={activating}
            className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm text-zinc-600 transition hover:border-slate-200 hover:text-slate-800 disabled:opacity-30"
          >
            Back
          </button>
        </div>
      )}

      {showBootSequence && (
        <BrainBootSequence
          projectName={identity.projectName}
          onComplete={() => bootSequenceCompleteRef.current?.()}
        />
      )}
    </div>
  );
}
