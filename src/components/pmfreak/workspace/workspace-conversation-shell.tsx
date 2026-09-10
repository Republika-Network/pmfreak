"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgentAwakeningPanel } from "@/components/pmfreak/workspace/agent-awakening-panel";
import { ImprintSummary } from "@/components/pmfreak/workspace/imprint-summary";
import { deriveAwakeningState, type AwakeningState } from "@/lib/workspace/awakening-state";
import { isMeaningfulOperationalContact } from "@/lib/workspace/first-contact-detector";
import { computeImprintConfidence } from "@/lib/workspace/imprint-confidence";
import { detectOperationalLanguage, type SupportedLanguage } from "@/lib/workspace/language/language-detection";
import { resolveLanguagePreference } from "@/lib/workspace/language/language-preference";
import { normalizeOperationalConcepts } from "@/lib/workspace/language/operational-concepts";
import {
  observeInteraction,
  computeIgnitionCues,
} from "@/lib/workspace/imprint-inference";
import { WORKSPACE_DISPLAY } from "@/lib/workspace/display-semantics";
import { isRuntimeValidationEnabled } from "@/lib/workspace/beta-validation-mode";
import {
  emptyImprintState,
  loadImprintState,
  persistImprintState,
  type PMImprintState,
} from "@/lib/workspace/operational-imprint-profile";
import {
  computeAdaptiveClarifyingQuestion,
} from "@/lib/workspace/imprint-inference";
import { runtimePersistence, type RuntimePersistenceScope, type RuntimeSyncStatus } from "@/lib/workspace/runtime-persistence";
import { bootstrapRuntimeState } from "@/lib/workspace/runtime-bootstrap";
import { buildValidationTrace } from "@/lib/workspace/validation-trace-builder";
import { detectContradiction } from "@/lib/workspace/validation-consistency";
import {
  addTrace,
  applyFeedback,
  emptyValidationState,

  type ValidationFeedback,
  type ValidationState,
  type ValidationTrace,
} from "@/lib/workspace/runtime-validation";
import { RuntimeTrustPanel } from "@/components/pmfreak/workspace/runtime-trust-panel";
import { ValidationTimeline } from "@/components/pmfreak/workspace/validation-timeline";
import { ValidationReplay } from "@/components/pmfreak/workspace/validation-replay";

type ProjectOption = { id: string; projectName: string; uploadDate: string };
type CopilotCard = { type: "Risks" | "Next Actions" | "Draft Email" | "RACI" | "Checklist"; title: string; items: string[] };
type IngestionMetadata = {
  status: "skipped" | "ingested";
  reason?: string;
  indicators: string[];
  domainsAffected: string[];
  recordsPersisted: number;
  signalCount: number;
};

type CopilotResponse = {
  answer: string;
  runtimeResponse?: { observation: string; interpretation: string; supportingEvidence: string[]; confidence: string; suggestedActions: string[]; followUps: string[]; trustNotes: string[] };
  operationalPlans?: Array<{ id: string; title: string; status: string; severity: string; confidence: string; supportingEvidence: string[]; operationalSequence: Array<{ id: string; action: string; priority: number; ownerSuggestion?: string; status: string }> }>;
  cards: CopilotCard[];
  plan: "free" | "pro" | "enterprise";
  aiPowered: boolean;
  ingestion?: IngestionMetadata;
  contextGapQuestions?: string[];
};
type UploadApiResponse =
  | { ok: true; uploadedFileNames: string[]; uploadedCount: number; ingestion: { extractedSignals: { risks: number; stakeholders: number } } }
  | { ok: false; error: string; code: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  response?: CopilotResponse;
  ingestion?: IngestionMetadata;
  state?: "streaming" | "complete" | "error";
  trace?: ValidationTrace;
};

type AmbientMemory = { blockers: string[]; recentDecisions: string[]; stakeholderPressure: string[]; criticalRisks: string[]; concerns: string[] };
type ExecutionRiskSnapshot = {
  deliveryConfidence: "low" | "medium" | "high" | "critical";
  stakeholderPressure: "low" | "medium" | "high" | "critical";
  executionStability: "stable" | "watching" | "degrading";
  activeEscalationRisk: "none" | "watch" | "elevated" | "immediate";
  commentary: string[];
};

type InterventionSnapshot = {
  interventionUrgency: "none" | "watch" | "elevated" | "critical";
  escalationProbability: number;
  organizationalDrift: number;
  deliveryBreakdownRisk: number;
  recommendedInterventionType: "delivery_recovery" | "stakeholder_alignment" | "execution_unblock" | "capacity_protection" | "escalation_governance";
  escalationTarget: "none" | "project_lead" | "delivery_manager" | "sponsor" | "executive_steering_committee" | "portfolio_office";
  commentary: string[];
};

type StakeholderRelationshipSnapshot = {
  stakeholderAlignment: "aligned" | "mixed" | "fragmented";
  politicalRisk: "low" | "moderate" | "high" | "critical";
  executivePressure: "stable" | "increasing" | "critical";
  communicationStability: "stable" | "watching" | "volatile";
  escalationTrajectory: "none" | "reactive" | "patterned" | "accelerating";
  executiveAlignment: "aligned" | "mixed" | "fragmented";
  commentary: string[];
};
type CoordinationSnapshot = {
  operational_priority_queue: { actions: Array<{ actionId: string; priority: "critical" | "high" | "medium" | "low"; urgency: number; type: string; targetStakeholder: string; recommendedExecutionOrder: number; commentary: string }> };
  escalation_sequence: { sequence: string[]; deadlockRisk: "none" | "watch" | "high" };
  coordination_conflict_risk: { level: "none" | "watch" | "high"; conflicts: string[] };
  execution_recovery_path: { ready: boolean; commentary: string[] };
  dependency_deadlock_risk: { level: "none" | "watch" | "high"; deadlocks: string[] };
  stakeholder_alignment_sequence: { commentary: string[] };
  escalation_overload_risk: { level: "none" | "watch" | "high"; commentary: string };
  commentary: string[];
};

const MEMORY_DOMAINS = ["stakeholder_intelligence","delivery_intelligence","risk_intelligence","pmo_governance","team_health","executive_context","operational_memory","operational_plans"] as const;
const SESSION_KEY = "copilot-shell-v1";

const GREETING_MESSAGE: ChatMessage = {
  id: "greeting-0",
  role: "assistant",
  text: "Hi — I'm ready. Tell me what project, blocker, risk, or decision needs attention, and I'll help you turn it into a clear next move.",
  state: "complete",
};

type Props = {
  awakening: AwakeningState;
  onAwakeningAdvance: (state: AwakeningState) => void;
  scope: RuntimePersistenceScope;
};

export function WorkspaceConversationShell({ awakening, onAwakeningAdvance, scope }: Props) {
  const IMPRINT_COMPANY_ID = scope.companyId;
  const IMPRINT_WORKSPACE_ID = scope.workspaceId;
  const IMPRINT_USER_ID = scope.userId;
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [methodology] = useState<"PMI" | "Agile" | "Hybrid" | "General PMO">("Hybrid");
  const [input, setInput] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<SupportedLanguage>("en");
  const [memoryDomain] = useState<(typeof MEMORY_DOMAINS)[number]>("operational_memory");
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING_MESSAGE]);
  const [loading, setLoading] = useState(false);
  const [thinkingState, setThinkingState] = useState<"idle" | "triaging" | "reasoning" | "validating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [imprintState, setImprintState] = useState<PMImprintState>(() => loadImprintState(scope.companyId, scope.workspaceId, scope.userId));
  const [validationState, setValidationState] = useState<ValidationState>(() => emptyValidationState());
  const [validationEnabled, setValidationEnabled] = useState(() => isRuntimeValidationEnabled());
  const [, setSyncStatus] = useState<RuntimeSyncStatus>("synced");
  const pendingTraceRef = useRef<ValidationTrace | null>(null);
  const [ambientMemory, setAmbientMemory] = useState<AmbientMemory>({ blockers: [], recentDecisions: [], stakeholderPressure: [], criticalRisks: [], concerns: [] });
  const [executionRisk, setExecutionRisk] = useState<ExecutionRiskSnapshot | null>(null);
  const [stakeholderIntel, setStakeholderIntel] = useState<StakeholderRelationshipSnapshot | null>(null);
  const [intervention, setIntervention] = useState<InterventionSnapshot | null>(null);
  const [coordination, setCoordination] = useState<CoordinationSnapshot | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageIdRef = useRef(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    void bootstrapRuntimeState(scope).then((boot) => {
      setImprintState(boot.imprint);
      setValidationState(boot.validation);
      setValidationEnabled(boot.flags.runtimeValidationEnabled);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    void fetch("/api/copilot/context")
      .then((r) => r.json())
      .then((d: { projects?: ProjectOption[] }) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId), [projects, selectedProjectId]);

  useEffect(() => {
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    void fetch(`/api/copilot/memory${query}`)
      .then((r) => r.json())
      .then((d: AmbientMemory) => setAmbientMemory(d))
      .catch(() => setAmbientMemory({ blockers: [], recentDecisions: [], stakeholderPressure: [], criticalRisks: [], concerns: [] }));
  }, [selectedProjectId]);

  useEffect(() => {
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    void fetch(`/api/intelligence/coordination${query}`)
      .then((r) => r.json())
      .then((d: { coordination: CoordinationSnapshot }) => setCoordination(d.coordination))
      .catch(() => setCoordination(null));
  }, [selectedProjectId]);

  useEffect(() => {
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    void fetch(`/api/intelligence/interventions${query}`)
      .then((r) => r.json())
      .then((d: { intervention: InterventionSnapshot }) => setIntervention(d.intervention))
      .catch(() => setIntervention(null));
  }, [selectedProjectId]);

  useEffect(() => {
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    void fetch(`/api/intelligence/execution-risk${query}`)
      .then((r) => r.json())
      .then((d: ExecutionRiskSnapshot) => setExecutionRisk(d))
      .catch(() => setExecutionRisk(null));
  }, [selectedProjectId]);

  useEffect(() => {
    const query = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : "";
    void fetch(`/api/intelligence/stakeholders${query}`)
      .then((r) => r.json())
      .then((d: StakeholderRelationshipSnapshot) => setStakeholderIntel(d))
      .catch(() => setStakeholderIntel(null));
  }, [selectedProjectId]);

  const streamAssistant = async (messageId: string, text: string) => {
    const chunks = text.split(" ");
    for (let i = 0; i < chunks.length; i += 1) {
      const partial = `${chunks.slice(0, i + 1).join(" ")} `;
      setMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, text: partial, state: "streaming" } : msg)));
      await new Promise((resolve) => setTimeout(resolve, Math.max(16, Math.min(80, 640 / chunks.length))));
    }
  };

  const send = async (preset?: string) => {
    const message = (preset ?? input).trim();
    if (!message || loading) return;

    const detection = detectOperationalLanguage(message);
    const preference = resolveLanguagePreference({
      currentDetection: detection,
      previousLanguage: preferredLanguage,
      workspaceDefault: "en",
    });
    const normalizedConcepts = normalizeOperationalConcepts(message);
    setPreferredLanguage(preference.preferredLanguage);

    // Advance awakening and observe imprint on meaningful operational signal
    if (isMeaningfulOperationalContact(message)) {
      const nextCount = awakening.interactionCount + 1;
      const nextAwakening = deriveAwakeningState(nextCount);
      onAwakeningAdvance(nextAwakening);
      const nextImprint = observeInteraction(message, imprintState);
      setImprintState(nextImprint);
      persistImprintState(IMPRINT_COMPANY_ID, IMPRINT_WORKSPACE_ID, IMPRINT_USER_ID, nextImprint);
      setSyncStatus("syncing");
      void runtimePersistence.persistImprint(scope, nextImprint).then(() => setSyncStatus("synced")).catch(() => setSyncStatus("fallback"));
      if (validationEnabled) {
        const contradiction = detectContradiction(message, imprintState);
        const trace = buildValidationTrace(
          nextAwakening,
          nextImprint,
          computeImprintConfidence(nextImprint.profile),
          validationState.feedbackBias,
          contradiction.hasContradiction,
          message.slice(0, 80),
          preference.preferredLanguage,
          normalizedConcepts.concepts,
          normalizedConcepts.matchedAliases,
        );
        pendingTraceRef.current = trace;
        const nextVState = addTrace(validationState, trace);
        setValidationState(nextVState);
        void runtimePersistence.persistValidation(scope, nextVState).catch(() => setSyncStatus("fallback"));
      }
    }

    messageIdRef.current += 1;
    const userMessageId = `user-${messageIdRef.current}`;
    messageIdRef.current += 1;
    const assistantMessageId = `assistant-${messageIdRef.current}`;
    setError(null);
    setLastFailedMessage(null);
    setMessages((p) => [
      ...p,
      { id: userMessageId, role: "user", text: message, state: "complete" },
      { id: assistantMessageId, role: "assistant", text: "", state: "streaming" },
    ]);
    setInput("");
    setLoading(true);
    setThinkingState("triaging");
    try {
      setTimeout(() => setThinkingState("reasoning"), 280);
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          projectId: selectedProject?.id,
          projectName: selectedProject?.projectName,
          methodology,
          activeDomain: memoryDomain,
          sessionKey: SESSION_KEY,
          language: preference.preferredLanguage,
          languageConfidence: detection.confidence,
          mixedLanguage: detection.mixed,
          operationalConcepts: normalizedConcepts.concepts,
          matchedOperationalAliases: normalizedConcepts.matchedAliases,
        }),
      });
      const payload = (await response.json()) as CopilotResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to get a response.");
      setThinkingState("validating");
      await streamAssistant(assistantMessageId, payload.answer);
      setMessages((prev) => prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, text: payload.answer, response: payload, state: "complete", trace: pendingTraceRef.current ?? undefined } : msg)));
      pendingTraceRef.current = null;
    } catch (e) {
      const failure = e instanceof Error ? e.message : "Unable to get a response.";
      setError(failure);
      setLastFailedMessage(message);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId ? { ...msg, text: "Response unavailable — try again to continue.", state: "error" } : msg,
        ),
      );
    } finally {
      setThinkingState("idle");
      setLoading(false);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!selectedProject?.id) {
      setError("Select a project before uploading workspace documents.");
      return;
    }

    const body = new FormData();
    body.append("projectId", selectedProject.id);
    Array.from(files).forEach((file) => body.append("documents", file));

    try {
      const response = await fetch("/api/upload", { method: "POST", body });
      const payload = (await response.json()) as UploadApiResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Upload failed." : payload.error);
      }
      setUploadedFiles((prev) => [...payload.uploadedFileNames, ...prev].slice(0, 6));
      setError(null);
      const ingestionSummary = `Uploaded ${payload.uploadedCount} document(s). Detected ${payload.ingestion.extractedSignals.risks} risks and ${payload.ingestion.extractedSignals.stakeholders} stakeholders.`;
      setMessages((prev) => [...prev, { id: `assistant-upload-${Date.now()}`, role: "assistant", text: ingestionSummary, state: "complete" }]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload failed. Please try again.");
    }
  };

  return (
    <main className="mx-auto min-h-[82vh] w-full">
      <section className="rounded-3xl border border-white/10 bg-slate-900/55 p-4 shadow-[0_30px_70px_-50px_rgba(15,23,42,0.95)] backdrop-blur-xl md:p-6">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Workspace Chat</h1>
        </header>

        <div
          onDrop={(e) => { e.preventDefault(); setDragActive(false); void handleUpload(e.dataTransfer.files); }}
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          className={`min-h-[560px] rounded-2xl border p-4 transition ${dragActive ? "border-cyan-300/50 bg-cyan-400/5" : "border-white/10 bg-slate-950/50"}`}
        >
          <div className="space-y-3">
            {messages.map((msg) => (
              <article key={msg.id} className={`max-w-3xl rounded-2xl p-3 text-sm transition-all ${msg.role === "user" ? "ml-auto border border-cyan-300/20 bg-cyan-400/[0.12]" : "border border-white/10 bg-slate-900/80"} ${msg.state === "streaming" ? "ring-1 ring-cyan-300/30" : ""}`}>
                <p>{msg.text}</p>
                {msg.role === "assistant" && msg.state === "streaming" ? <p className="mt-2 text-[11px] text-cyan-200 animate-pulse">typing…</p> : null}
                {msg.role === "assistant" && msg.state === "error" ? <p className="mt-2 text-[11px] text-rose-200">Response unavailable — try again to continue.</p> : null}
                {msg.role === "assistant" && msg.response?.runtimeResponse ? <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-200"><p><span className="text-slate-400">Observation:</span> {msg.response.runtimeResponse.observation}</p><p><span className="text-slate-400">Interpretation:</span> {msg.response.runtimeResponse.interpretation}</p><p><span className="text-slate-400">Confidence:</span> {msg.response.runtimeResponse.confidence}</p><ul className="list-disc pl-4 text-slate-300">{msg.response.runtimeResponse.supportingEvidence.map((item) => <li key={item}>{item}</li>)}</ul>{msg.response.runtimeResponse.trustNotes.length ? <p className="text-amber-200">Trust notes: {msg.response.runtimeResponse.trustNotes.join(" ")}</p> : null}</div> : null}
                {msg.role === "assistant" && msg.state === "complete" && msg.trace && validationEnabled ? (
                  <details className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.01] p-2 text-[11px]">
                    <summary className="cursor-pointer select-none text-zinc-600">Why this response</summary>
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-zinc-600 mb-1">Generated from:</p>
                      {msg.trace.continuitySignals.map((sig) => (
                        <p key={sig} className="flex items-start gap-1.5 text-slate-500">
                          <span className="mt-0.5 shrink-0 text-violet-500/50">•</span>
                          {sig}
                        </p>
                      ))}
                      {msg.trace.activeSources.slice(0, 3).map((src) => (
                        <p key={src} className="flex items-start gap-1.5 text-zinc-600">
                          <span className="mt-0.5 shrink-0">•</span>
                          {src} signal active
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
                {msg.role === "assistant" && msg.response?.operationalPlans?.length ? (
                  <div className="mt-3 space-y-2 rounded-xl border border-cyan-300/20 bg-cyan-400/5 p-3 text-xs">
                    <p className="font-semibold text-cyan-100">Operational Plans</p>
                    {msg.response.operationalPlans.map((plan) => (
                      <div key={plan.id} className="rounded-lg border border-cyan-200/15 p-2 text-slate-200">
                        <p>{plan.title} · {plan.status} · {plan.severity} · {plan.confidence}</p>
                        <ul className="list-disc pl-4">{plan.operationalSequence.slice(0, 3).sort((a, b) => a.priority - b.priority).map((step) => <li key={step.id}>P{step.priority}: {step.action} {step.ownerSuggestion ? `(owner: ${step.ownerSuggestion})` : ""}</li>)}</ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {loading ? <p className="text-sm text-slate-500 animate-pulse">…</p> : null}
            {error ? <p className="text-sm text-rose-200">{error}</p> : null}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => void handleUpload(e.target.files)} />
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={computeAdaptiveClarifyingQuestion(imprintState.profile, computeImprintConfidence(imprintState.profile))}
              className="flex-1 rounded-xl border border-white/15 bg-slate-950/75 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
            />
            <button onClick={() => void send()} disabled={loading} className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.08] px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/[0.16]">Send</button>
          </div>
          {lastFailedMessage ? (
            <button onClick={() => void send(lastFailedMessage)} className="rounded-xl border border-amber-300/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              Retry
            </button>
          ) : null}
        </div>
      </section>

      {/* Stage chip bar: tracks awakening progression */}
      <div className="mt-2 flex gap-1.5 text-[10px] text-slate-500">
        {(["dormant", "initializing", "orienting", "engaged", "expanded", "fully-operational"] as const).map((stage) => (
          <span key={stage} className={`rounded-full border px-2 py-0.5 ${awakening.stage === stage ? "border-cyan-300/40 text-cyan-200" : "border-white/10"}`}>{stage}</span>
        ))}
      </div>

      {/* Dormant invitation — shown before meaningful interaction */}
      {awakening.stage === "dormant" && (
        <p className="mt-3 text-sm text-slate-400">{WORKSPACE_DISPLAY.labels.dormantInvitation}</p>
      )}

      {/* Dynamic ignition cues from imprint */}
      {(() => {
        const ignitionCues = computeIgnitionCues(imprintState.profile, computeImprintConfidence(imprintState.profile));
        return ignitionCues.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {ignitionCues.map((cue) => (
              <li key={cue} className="text-xs text-slate-500 cursor-pointer hover:text-slate-300" onClick={() => void send(cue)}>{cue}</li>
            ))}
          </ul>
        ) : null;
      })()}

      {/* Imprint summary with reset */}
      <ImprintSummary
        profile={imprintState.profile}
        companyId={IMPRINT_COMPANY_ID}
        workspaceId={IMPRINT_WORKSPACE_ID}
        userId={IMPRINT_USER_ID}
        onReset={() => setImprintState(emptyImprintState())}
      />

      {/* Agent awakening panel — right sidebar */}
      <aside className="mt-4">
        <AgentAwakeningPanel state={awakening} />
        {/* Telemetry cards: dormant labels before awakening */}
        <div className="mt-2 grid grid-cols-3 gap-1 text-[10px]">
          <div className="rounded-lg border border-white/10 p-2 text-slate-500">
            <p className="font-medium text-slate-400">Status</p>
            <p>{awakening.stage === "dormant" ? "Dormant" : "Active"}</p>
          </div>
          <div className="rounded-lg border border-white/10 p-2 text-slate-500">
            <p className="font-medium text-slate-400">Signal</p>
            <p>{awakening.stage === "dormant" ? "Awaiting signal" : "Received"}</p>
          </div>
          <div className="rounded-lg border border-white/10 p-2 text-slate-500">
            <p className="font-medium text-slate-400">Agents</p>
            <p>{awakening.stage === "dormant" ? "Pending" : `${awakening.awakenedAgents.length} active`}</p>
          </div>
        </div>
      </aside>

    </main>
  );
}
