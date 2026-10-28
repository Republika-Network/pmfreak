"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type {
  PmoTenant,
  PmoTenantIdentity,
  VaultConfig,
  GovernanceProfile,
  AgentActivationState,
  ContextSeed,
  DeliveryChallenge,
  PmoAgentId,
} from "@/lib/pmo/pmo-tenant-types";
import {
  DEFAULT_AGENT_STATES,
  AGENT_META,
} from "@/lib/pmo/pmo-tenant-types";
import { savePmoTenant } from "@/lib/pmo/save-pmo-tenant";
import { COMMAND_CENTER_TYPES } from "@/lib/command-center/command-center-types";
import {
  CommandCenterActivationSequence,
  useCommandCenterActivation,
  SUCCESS_CONFIRMATION_DURATION_MS,
} from "@/components/pmfreak/activation/command-center-activation";
import { clearScopedDraft, loadScopedDraft, saveScopedDraft } from "@/lib/drafts/draft-storage";

// ─── Storage ──────────────────────────────────────────────────────────────────

// Scoped to the signed-in user and their workspace by the server-issued key (PD-21).
const loadDraft = (draftKey: string | null) => loadScopedDraft<Partial<PmoTenant>>(draftKey);

// ─── Default state ─────────────────────────────────────────────────────────────

const DEFAULT_IDENTITY: PmoTenantIdentity = {
  pmoName: "",
  organizationName: "",
  pmoType: "",
  operatingModel: "",
};

const DEFAULT_VAULT: VaultConfig = {
  provider: "pmfreak-cloud",
  label: "PMFreak Cloud Vault",
};

const DEFAULT_GOVERNANCE: GovernanceProfile = {
  methodology: "",
  reportingCadence: "",
  projectScale: "",
  approvalGovernance: "",
};

const DEFAULT_CONTEXT: ContextSeed = {
  strategicObjective: "",
  deliveryChallenges: [],
  successDefinition: "",
};

// ─── Stepper config ────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "Command Center Identity", short: "Identity" },
  { id: 2, label: "Data Sovereignty", short: "Vault" },
  { id: 3, label: "Governance", short: "Governance" },
  { id: 4, label: "Agent Activation", short: "Agents" },
  { id: 5, label: "Context Seed", short: "Context" },
  { id: 6, label: "Activate", short: "Activate" },
] as const;

// ─── Shared styles ─────────────────────────────────────────────────────────────

const input =
  "block w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400/60";
const select = `${input} [&>option]:bg-[#FCFBF9]`;
const label = "flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-zinc-500";
const chip = (active: boolean) =>
  `cursor-pointer rounded-xl border px-4 py-3 text-left text-sm transition-all ${
    active
      ? "border-cyan-400/40 bg-cyan-400/[0.08] text-cyan-900 shadow-[0_0_16px_rgba(34,211,238,0.08)]"
      : "border-slate-200 bg-white text-zinc-600 hover:border-slate-200 hover:text-zinc-800"
  }`;

// ─── Validation ────────────────────────────────────────────────────────────────

type WizardState = {
  identity: PmoTenantIdentity;
  vault: VaultConfig;
  governance: GovernanceProfile;
  agents: AgentActivationState[];
  contextSeed: ContextSeed;
};

function validate(step: number, d: WizardState): string[] {
  const errs: string[] = [];
  if (step === 1) {
    if (!d.identity.pmoName.trim()) errs.push("Command Center name is required.");
    if (!d.identity.organizationName.trim()) errs.push("Organization name is required.");
    if (!d.identity.pmoType) errs.push("Command Center type is required.");
    if (!d.identity.operatingModel) errs.push("Operating model is required.");
  }
  if (step === 3) {
    if (!d.governance.methodology) errs.push("Delivery methodology is required.");
    if (!d.governance.reportingCadence) errs.push("Reporting cadence is required.");
    if (!d.governance.projectScale) errs.push("Project scale is required.");
    if (!d.governance.approvalGovernance) errs.push("Approval governance is required.");
  }
  return errs;
}

// ─── Reusable sub-components ──────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-[10px] uppercase tracking-[0.3em] text-zinc-400">{children}</p>
  );
}

function StepIntro({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-7">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">{description}</p>
    </div>
  );
}

// ─── Step renders ──────────────────────────────────────────────────────────────

function StepIdentity({
  data,
  onChange,
}: {
  data: PmoTenantIdentity;
  onChange: (field: keyof PmoTenantIdentity, value: string) => void;
}) {
  const PMO_TYPES = COMMAND_CENTER_TYPES.map((meta) => ({
    value: meta.type,
    label: meta.label,
    desc: meta.description,
  }));

  const MODELS = [
    { value: "centralized", label: "Centralized", desc: "Single command, unified standards" },
    { value: "federated", label: "Federated", desc: "Distributed teams, shared protocol" },
    { value: "hybrid", label: "Hybrid", desc: "Federated delivery, centralized oversight" },
  ];

  return (
    <div className="space-y-7">
      <StepIntro
        title="Identify your Command Center"
        description="This becomes the governance identity PMFreak uses to calibrate agents, communication tone, and executive reporting."
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={label}>
          Command Center Name <span className="text-pink-600 normal-case">*</span>
          <input
            className={input}
            placeholder="Enterprise Delivery Office"
            value={data.pmoName}
            onChange={(e) => onChange("pmoName", e.target.value)}
          />
        </label>
        <label className={label}>
          Organization Name <span className="text-pink-600 normal-case">*</span>
          <input
            className={input}
            placeholder="Acme Corporation"
            value={data.organizationName}
            onChange={(e) => onChange("organizationName", e.target.value)}
          />
        </label>
      </div>

      <div>
        <SectionLabel>Command Center Type *</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {PMO_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onChange("pmoType", t.value)}
              className={chip(data.pmoType === t.value)}
            >
              <span className="block font-semibold">{t.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Operating Model *</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {MODELS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange("operatingModel", m.value)}
              className={chip(data.operatingModel === m.value)}
            >
              <span className="block font-semibold">{m.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{m.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepVault({
  data,
  onChange,
}: {
  data: VaultConfig;
  onChange: (vault: VaultConfig) => void;
}) {
  const VAULTS: Array<{ provider: VaultConfig["provider"]; label: string; description: string; badge?: string }> = [
    {
      provider: "pmfreak-cloud",
      label: "PMFreak Cloud Vault",
      description: "Fully managed, encrypted at rest and in transit. Zero operational overhead. Recommended for most teams.",
      badge: "Recommended",
    },
    {
      provider: "dedicated-enterprise",
      label: "Dedicated Enterprise Vault",
      description: "Isolated single-tenant infrastructure deployed in your preferred cloud region. Full data residency control.",
    },
    {
      provider: "local-sovereign",
      label: "Local Sovereign Deployment",
      description: "Air-gapped or on-premise deployment. You own the runtime. No data ever leaves your perimeter.",
      badge: "Maximum Control",
    },
  ];

  return (
    <div className="space-y-7">
      <StepIntro
        title="Choose your data sovereignty"
        description="PMFreak runs on AOC Protocol and supports Bring Your Own Sovereignty. Select where operational intelligence, governance events, and agent memory are stored."
      />

      <div className="rounded-2xl border border-indigo-300/10 bg-indigo-400/[0.04] px-5 py-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-300/60">AOC Protocol</p>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          All data is governed by the AOC Protocol data sovereignty layer. Your choice below determines physical storage location — the protocol guarantees audit trails, cryptographic integrity, and access control regardless of vault provider.
        </p>
      </div>

      <div className="space-y-3">
        {VAULTS.map((v) => (
          <button
            key={v.provider}
            type="button"
            onClick={() => onChange({ provider: v.provider, label: v.label })}
            className={`w-full rounded-2xl border px-5 py-4 text-left transition-all ${
              data.provider === v.provider
                ? "border-cyan-400/40 bg-cyan-400/[0.06] shadow-[0_0_24px_rgba(34,211,238,0.07)]"
                : "border-slate-200 bg-white hover:border-slate-200"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className={`text-sm font-semibold ${data.provider === v.provider ? "text-cyan-900" : "text-slate-800"}`}>
                    {v.label}
                  </span>
                  {v.badge && (
                    <span className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] text-cyan-700">
                      {v.badge}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-zinc-500">{v.description}</p>
              </div>
              <div
                className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                  data.provider === v.provider
                    ? "border-cyan-400 bg-cyan-400"
                    : "border-zinc-700 bg-transparent"
                }`}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepGovernance({
  data,
  onChange,
}: {
  data: GovernanceProfile;
  onChange: (field: keyof GovernanceProfile, value: string) => void;
}) {
  const METHODOLOGIES = [
    { value: "agile", label: "Agile" },
    { value: "scrum", label: "Scrum" },
    { value: "hybrid", label: "Hybrid" },
    { value: "waterfall", label: "Waterfall" },
    { value: "custom", label: "Custom" },
  ];

  const CADENCES = [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "biweekly", label: "Biweekly" },
    { value: "monthly", label: "Monthly" },
  ];

  const SCALES = [
    { value: "small", label: "Small", desc: "< 5 active projects" },
    { value: "mid", label: "Mid", desc: "5–20 active projects" },
    { value: "large", label: "Large", desc: "20–100 active projects" },
    { value: "enterprise", label: "Enterprise", desc: "100+ projects & programmes" },
  ];

  const APPROVALS = [
    { value: "lightweight", label: "Lightweight", desc: "PM-led, fast decisions" },
    { value: "structured", label: "Structured", desc: "PM + PMO Lead sign-off" },
    { value: "multi-layer-executive", label: "Multi-layer Executive", desc: "Finance + executive approval gates" },
  ];

  return (
    <div className="space-y-7">
      <StepIntro
        title="Governance structure"
        description="These selections configure how PMFreak's agents reason about delivery rhythm, approval chains, and escalation triggers."
      />

      <div>
        <SectionLabel>Delivery Methodology *</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {METHODOLOGIES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange("methodology", m.value)}
              className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                data.methodology === m.value
                  ? "border-indigo-300/50 bg-indigo-400/15 text-indigo-900"
                  : "border-slate-200 bg-white text-zinc-500 hover:border-slate-200 hover:text-zinc-800"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Reporting Cadence *</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {CADENCES.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => onChange("reportingCadence", c.value)}
              className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                data.reportingCadence === c.value
                  ? "border-indigo-300/50 bg-indigo-400/15 text-indigo-900"
                  : "border-slate-200 bg-white text-zinc-500 hover:border-slate-200 hover:text-zinc-800"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Project Scale *</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {SCALES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange("projectScale", s.value)}
              className={chip(data.projectScale === s.value)}
            >
              <span className="block font-semibold">{s.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{s.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Approval Governance *</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {APPROVALS.map((a) => (
            <button
              key={a.value}
              type="button"
              onClick={() => onChange("approvalGovernance", a.value)}
              className={chip(data.approvalGovernance === a.value)}
            >
              <span className="block font-semibold">{a.label}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-400">{a.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepAgents({
  agents,
  onToggle,
}: {
  agents: AgentActivationState[];
  onToggle: (agentId: PmoAgentId) => void;
}) {
  const coreAgents = agents.filter((a) => AGENT_META[a.agentId].tier === "core");
  const advancedAgents = agents.filter((a) => AGENT_META[a.agentId].tier === "advanced");

  const AgentCard = ({ agent }: { agent: AgentActivationState }) => {
    const meta = AGENT_META[agent.agentId];
    return (
      <button
        type="button"
        onClick={() => onToggle(agent.agentId)}
        className={`group relative w-full overflow-hidden rounded-2xl border px-5 py-4 text-left transition-all duration-300 ${
          agent.enabled
            ? "border-cyan-400/30 bg-gradient-to-br from-cyan-950/40 to-black/60 shadow-[0_0_20px_rgba(34,211,238,0.06)]"
            : "border-slate-200 bg-slate-50 hover:border-slate-200"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full transition-colors ${
                  agent.enabled ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]" : "bg-zinc-700"
                }`}
              />
              <span className={`text-sm font-semibold ${agent.enabled ? "text-slate-900" : "text-zinc-500"}`}>
                {meta.label}
              </span>
            </div>
            <p className={`mt-1 text-xs leading-relaxed ${agent.enabled ? "text-zinc-600" : "text-zinc-300"}`}>
              {meta.description}
            </p>
          </div>
          <span
            className={`mt-0.5 shrink-0 rounded-full border px-2.5 py-0.5 text-[9px] uppercase tracking-[0.15em] transition-all ${
              agent.enabled
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-700"
                : "border-zinc-800 text-zinc-300"
            }`}
          >
            {agent.enabled ? "Awakening" : "Dormant"}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-7">
      <StepIntro
        title="Agent Activation Profile"
        description="Select which governance agents activate when your Command Center goes live. Core agents are recommended by default. Advanced agents can be enabled now or later."
      />

      <div>
        <SectionLabel>Core Agents — Recommended</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {coreAgents.map((a) => (
            <AgentCard key={a.agentId} agent={a} />
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Advanced Agents</SectionLabel>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {advancedAgents.map((a) => (
            <AgentCard key={a.agentId} agent={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepContext({
  data,
  onChange,
  onToggleChallenge,
}: {
  data: ContextSeed;
  onChange: (field: "strategicObjective" | "successDefinition", value: string) => void;
  onToggleChallenge: (challenge: DeliveryChallenge) => void;
}) {
  const CHALLENGES: Array<{ value: DeliveryChallenge; label: string }> = [
    { value: "scope-ambiguity", label: "Scope Ambiguity" },
    { value: "stakeholder-misalignment", label: "Stakeholder Misalignment" },
    { value: "timeline-drift", label: "Timeline Drift" },
    { value: "budget-pressure", label: "Budget Pressure" },
    { value: "resource-overload", label: "Resource Overload" },
    { value: "governance-inconsistency", label: "Governance Inconsistency" },
    { value: "reporting-fatigue", label: "Reporting Fatigue" },
  ];

  return (
    <div className="space-y-7">
      <StepIntro
        title="Seed the Command Center"
        description="This context initializes your Command Center's operational memory. Agents use it to calibrate reasoning, prioritize signals, and personalize their first responses."
      />

      <label className={label}>
        Strategic Objective
        <textarea
          className={`${input} resize-none`}
          rows={3}
          placeholder="What is the primary mission or outcome this Command Center exists to deliver?"
          value={data.strategicObjective}
          onChange={(e) => onChange("strategicObjective", e.target.value)}
        />
      </label>

      <div>
        <SectionLabel>Main Delivery Challenges</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {CHALLENGES.map((c) => {
            const active = data.deliveryChallenges.includes(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => onToggleChallenge(c.value)}
                className={`rounded-xl border px-3.5 py-2 text-sm transition-colors ${
                  active
                    ? "border-pink-400/40 bg-pink-400/[0.08] text-pink-800"
                    : "border-slate-200 bg-white text-zinc-500 hover:border-slate-200 hover:text-zinc-800"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className={label}>
        How does success look for this Command Center?
        <textarea
          className={`${input} resize-none`}
          rows={3}
          placeholder="Describe the outcomes, metrics, or states that would mark this Command Center as successful."
          value={data.successDefinition}
          onChange={(e) => onChange("successDefinition", e.target.value)}
        />
      </label>
    </div>
  );
}

function humanize(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function StepReview({
  state,
  creating,
  onCreate,
  createError,
}: {
  state: WizardState;
  creating: boolean;
  onCreate: () => void;
  createError: string | null;
}) {
  const enabledAgents = state.agents.filter((a) => a.enabled);

  return (
    <div className="space-y-5">
      <StepIntro
        title="Activate your Command Center"
        description="Review your governance configuration. Once activated, PMFreak will initialize all selected agents and direct you to your Command Center."
      />

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Command Center Identity</p>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {[
            ["Command Center Name", state.identity.pmoName],
            ["Organization", state.identity.organizationName],
            ["Type", humanize(state.identity.pmoType)],
            ["Operating Model", humanize(state.identity.operatingModel)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-zinc-400">{k}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Data Sovereignty</p>
        <p className="text-sm text-slate-800">{state.vault.label}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Governance</p>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {[
            ["Methodology", humanize(state.governance.methodology)],
            ["Reporting", humanize(state.governance.reportingCadence)],
            ["Scale", humanize(state.governance.projectScale)],
            ["Approval", humanize(state.governance.approvalGovernance)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-zinc-400">{k}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">
          Agents Activating ({enabledAgents.length})
        </p>
        <div className="flex flex-wrap gap-2">
          {enabledAgents.map((a) => (
            <span
              key={a.agentId}
              className="rounded-full border border-cyan-300/30 bg-cyan-400/[0.08] px-3 py-1 text-xs text-cyan-800"
            >
              {AGENT_META[a.agentId].label}
            </span>
          ))}
        </div>
      </div>

      {(state.contextSeed.strategicObjective || state.contextSeed.deliveryChallenges.length > 0) && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <p className="mb-3 text-[10px] uppercase tracking-[0.24em] text-indigo-300/60">Context Seed</p>
          {state.contextSeed.strategicObjective && (
            <p className="text-sm leading-relaxed text-slate-700">{state.contextSeed.strategicObjective}</p>
          )}
          {state.contextSeed.deliveryChallenges.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {state.contextSeed.deliveryChallenges.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-pink-300/25 bg-pink-400/[0.06] px-2.5 py-0.5 text-[11px] text-pink-800"
                >
                  {humanize(c)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onCreate}
        disabled={creating || !!createError}
        className="relative w-full overflow-hidden rounded-2xl border border-cyan-300/30 bg-gradient-to-r from-cyan-950/60 via-indigo-950/60 to-cyan-950/60 px-6 py-4 text-base font-semibold text-slate-900 shadow-[0_0_40px_rgba(34,211,238,0.12)] transition-all hover:shadow-[0_0_60px_rgba(34,211,238,0.2)] disabled:opacity-60"
      >
        {creating ? (
          <span className="flex items-center justify-center gap-2.5">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-cyan-400" />
            Initializing Command Center…
          </span>
        ) : (
          "Activate Command Center →"
        )}
      </button>
    </div>
  );
}

// ─── Main Wizard ───────────────────────────────────────────────────────────────

export function CreatePmoWizard({ draftKey = null }: { draftKey?: string | null } = {}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createErrorClass, setCreateErrorClass] = useState<"recoverable_failure" | "fatal_failure" | null>(null);
  const [createCorrelationId, setCreateCorrelationId] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const activation = useCommandCenterActivation();
  // Guards against a second savePmoTenant going in flight beside the first.
  const inFlightRef = useRef(false);

  const [identity, setIdentityState] = useState<PmoTenantIdentity>(() => {
    const draft = loadDraft(draftKey);
    return draft?.identity ?? DEFAULT_IDENTITY;
  });
  const [vault, setVaultState] = useState<VaultConfig>(() => {
    const draft = loadDraft(draftKey);
    return draft?.vault ?? DEFAULT_VAULT;
  });
  const [governance, setGovernanceState] = useState<GovernanceProfile>(() => {
    const draft = loadDraft(draftKey);
    return draft?.governance ?? DEFAULT_GOVERNANCE;
  });
  const [agents, setAgents] = useState<AgentActivationState[]>(() => {
    const draft = loadDraft(draftKey);
    return draft?.agents ?? DEFAULT_AGENT_STATES;
  });
  const [contextSeed, setContextSeedState] = useState<ContextSeed>(() => {
    const draft = loadDraft(draftKey);
    return draft?.contextSeed ?? DEFAULT_CONTEXT;
  });

  const wizardState: WizardState = { identity, vault, governance, agents, contextSeed };

  const persist = useCallback(
    (patch: Partial<WizardState>) => saveScopedDraft(draftKey, { ...wizardState, ...patch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, vault, governance, agents, contextSeed]
  );

  const updateIdentity = (field: keyof PmoTenantIdentity, value: string) => {
    const next = { ...identity, [field]: value };
    setIdentityState(next);
    persist({ identity: next });
  };

  const updateVault = (v: VaultConfig) => {
    setVaultState(v);
    persist({ vault: v });
  };

  const updateGovernance = (field: keyof GovernanceProfile, value: string) => {
    const next = { ...governance, [field]: value };
    setGovernanceState(next);
    persist({ governance: next });
  };

  const toggleAgent = (agentId: PmoAgentId) => {
    const next = agents.map((a) => (a.agentId === agentId ? { ...a, enabled: !a.enabled } : a));
    setAgents(next);
    persist({ agents: next });
  };

  const updateContext = (field: "strategicObjective" | "successDefinition", value: string) => {
    const next = { ...contextSeed, [field]: value };
    setContextSeedState(next);
    persist({ contextSeed: next });
  };

  const toggleChallenge = (challenge: DeliveryChallenge) => {
    const has = contextSeed.deliveryChallenges.includes(challenge);
    const next: ContextSeed = {
      ...contextSeed,
      deliveryChallenges: has
        ? contextSeed.deliveryChallenges.filter((c) => c !== challenge)
        : [...contextSeed.deliveryChallenges, challenge],
    };
    setContextSeedState(next);
    persist({ contextSeed: next });
  };

  const handleNext = () => {
    const errs = validate(step, wizardState);
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

  const handleCreate = async () => {
    // Single duplicate-submission guard: without it, Retry or a double click
    // could put a second savePmoTenant in flight alongside the first.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    if (createError) {
      console.info(JSON.stringify({ event: "pmo.create.retry", timestamp: new Date().toISOString() }));
    }
    setCreating(true);
    setCreateError(null);
    setCreateErrorClass(null);
    // Synchronous, so the overlay reflects the in-flight request immediately.
    activation.markSubmitting();

    const tenant: PmoTenant = {
      identity,
      vault,
      governance,
      agents,
      contextSeed,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const result = await savePmoTenant(tenant);

      if (result.status !== "success") {
        // Persistence failed — block navigation, preserve draft, surface error.
        setCreateError(result.error);
        setCreateErrorClass(result.status);
        setCreateCorrelationId(result.correlationId);
        activation.markFailure(result.error);
        // Draft intentionally preserved so the user does not lose their work.
        return;
      }

      // Persistence confirmed — clear the draft. (The activated tenant used to be cached
      // under a global key nothing read; it only left the configuration on the device. PD-21)
      clearScopedDraft(draftKey);

      activation.markSuccess();
    } catch (err) {
      // A rejected server action (transport failure, redirected POST, dropped
      // connection) must never strand the overlay mid-flight. Before this
      // catch existed, a rejection escaped handleCreate and pinned the UI on
      // "Creating Command Center..." indefinitely — the reported UAT hang.
      const message =
        "We couldn't reach the server to finish creating your Command Center. Your setup has been preserved, so you can try again.";
      console.error(
        JSON.stringify({
          event: "pmo.create.request_rejected",
          reason: err instanceof Error ? err.message : "unknown",
        }),
      );
      setCreateError(message);
      setCreateErrorClass("recoverable_failure");
      activation.markFailure(message);
    } finally {
      setCreating(false);
      inFlightRef.current = false;
    }
  };

  /**
   * Retry after a confirmed failure. Starts a genuinely new savePmoTenant
   * attempt — safe to repeat because savePmoTenant upserts
   * workspace_governance on workspace_id and guards its pmos insert with an
   * existence check, so retrying cannot create a duplicate Command Center.
   */
  const handleRetryActivation = () => {
    void handleCreate();
  };

  // Automatic navigation after a brief success confirmation. The delay only
  // acknowledges that activation completed; no work is running during it.
  // /command-center opens the Project Intelligence Inbox on its own, from the
  // durable initial-ingestion marker — no brainActivated=1 needed.
  useEffect(() => {
    if (activation.state.status !== "success") return;
    const timer = setTimeout(() => {
      router.push("/command-center?from=onboarding");
    }, SUCCESS_CONFIRMATION_DURATION_MS);
    return () => clearTimeout(timer);
  }, [activation.state.status, router]);

  const renderStep = () => {
    switch (step) {
      case 1:
        return <StepIdentity data={identity} onChange={updateIdentity} />;
      case 2:
        return <StepVault data={vault} onChange={updateVault} />;
      case 3:
        return <StepGovernance data={governance} onChange={updateGovernance} />;
      case 4:
        return <StepAgents agents={agents} onToggle={toggleAgent} />;
      case 5:
        return (
          <StepContext
            data={contextSeed}
            onChange={updateContext}
            onToggleChallenge={toggleChallenge}
          />
        );
      case 6:
        return (
          <StepReview
            state={wizardState}
            creating={creating}
            onCreate={handleCreate}
            createError={createError}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <CommandCenterActivationSequence
        state={activation.state}
        enabledAgentIds={agents.filter((a) => a.enabled).map((a) => a.agentId)}
        pmoName={identity.pmoName}
        deliveryChallengeCount={contextSeed.deliveryChallenges.length}
        hasContextSeed={Boolean(contextSeed.strategicObjective || contextSeed.successDefinition)}
        onRetry={handleRetryActivation}
      />

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

      {/* Blocking persistence error — no navigation until resolved */}
      {createError && (
        <div className="rounded-xl border border-red-400/40 bg-red-950/40 p-4" role="alert">
          <p className="mb-0.5 text-[10px] uppercase tracking-[0.18em] text-red-400/70">
            {createErrorClass === "fatal_failure" ? "Fatal failure" : "Recoverable failure"}
          </p>
          <p className="mb-1 text-sm font-semibold text-red-700">Command Center activation failed</p>
          <p className="text-sm text-red-200/80">{createError}</p>
          <div className="mt-3 flex gap-2.5">
            {createErrorClass === "fatal_failure" ? (
              <button
                type="button"
                onClick={() => { setCreateError(null); setCreateErrorClass(null); setStep(1); }}
                className="rounded-lg border border-red-400/30 px-4 py-1.5 text-sm font-medium text-red-800 transition hover:bg-red-400/10"
              >
                Return to edit
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="rounded-lg border border-red-400/30 px-4 py-1.5 text-sm font-medium text-red-800 transition hover:bg-red-400/10 disabled:opacity-40"
              >
                {creating ? "Retrying…" : "Retry"}
              </button>
            )}
            {createCorrelationId && (
              <button
                type="button"
                onClick={() => setShowErrorDetails((v) => !v)}
                className="rounded-lg border border-red-400/30 px-4 py-1.5 text-sm font-medium text-red-800 transition hover:bg-red-400/10"
              >
                View Details
              </button>
            )}
          </div>
          {showErrorDetails && createCorrelationId && (
            <p className="mt-2 text-[11px] text-red-300/70">Reference ID: {createCorrelationId}</p>
          )}
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-red-400/25 bg-red-400/[0.05] p-4">
          <ul className="space-y-1">
            {errors.map((e) => (
              <li key={e} className="text-sm text-red-700">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Nav */}
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
            disabled={creating}
            className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm text-zinc-600 transition hover:border-slate-200 hover:text-slate-800 disabled:opacity-30"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
