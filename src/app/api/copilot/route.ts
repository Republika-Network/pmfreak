import { randomUUID } from "node:crypto";
import { getAuthUser, type UserRole } from "@/lib/auth";
import { getCompanySubscription, type SubscriptionPlan } from "@/lib/billing";
import { canUseAdvancedAi, requireFeatureAccess } from "@/lib/feature-gates";
import { canUsePortfolioMemory } from "@/lib/plan-access";
import { buildPmNativeResponse } from "@/lib/pm-response-shaping";
import { readProjectMemory, type StoredProjectAnalysis } from "@/lib/project-memory";
import { getRuntimeAuthorityView } from "@/lib/aoc/runtime-observability";
import { appendOperationalMemory, extractOperationalMemoryCandidates } from "@/lib/operational-memory-v1";
import { enforceRuntimeAuthorization } from "@/aoc/runtime-consumer";
import { consumeExecutionGrant } from "@/aoc/runtime-consumer";
import { buildAuthorityLineage, consumeDelegatedCapability, explainDelegationChain } from "@/aoc/runtime-consumer";
import { evaluateAgentAccess } from "@/aoc/runtime-consumer";
// verifyAgentAttestation is enforced within governance-runtime for ai.execute actions.
import { denyResponse } from "@/lib/security/deny-response";
import { verifyAiResponse } from "@/lib/ai/response-verifier";
import { CopilotRequestContract, CopilotResponseContract } from "@/lib/contracts";
import { runInference } from "@/lib/ai/providers/router";
import { InferenceError } from "@/lib/ai/inference/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadRuntimeConversationState, updateRuntimeConversationState } from "@/lib/runtime-conversation-state";
import { readProjectMemorySnapshot } from "@/lib/memory/organization-memory";
import { ingestConversationIntoVault, type ConversationVaultIngestionResult } from "@/lib/vault/conversation-ingestion";
import { isArchivedProject } from "@/lib/projects/archived-project-server";
import { retrieveOperationalContinuity as retrieveOperationalContinuityLegacy, buildContinuityContext as buildRuntimeContinuityContext } from "@/lib/vault/continuity-retrieval";
import { retrieveOperationalContinuity as retrieveOperationalContinuityEngine } from "@/lib/operational-continuity/retrieval-engine";
import { detectLearnedExecutionPatterns } from "@/lib/vault/learned-execution-patterns";
import { retrieveInterventionHistory, buildInterventionMemorySummary, extractOperationalInterventions, persistOperationalIntervention } from "@/lib/vault/intervention-memory";
import { buildOperationalConfidenceProfile, calculateInterventionEfficacy, calculateStakeholderResponsiveness, buildInterventionEfficacySummary } from "@/lib/vault/intervention-efficacy";
import { buildAdaptiveOperationalConfidence } from "@/lib/vault/adaptive-confidence";
import { prioritizeOperationalMemory } from "@/lib/vault/memory-prioritization";
import { orchestrateOperationalAttention } from "@/lib/vault/attention-orchestration";
import { analyzeOperationalCoordination } from "@/lib/vault/coordination-intelligence";
import { analyzeOperationalEscalation } from "@/lib/vault/escalation-intelligence";
import { buildInterventionSnapshot } from "@/lib/intervention-engine";
import { buildExecutionRiskSnapshot } from "@/lib/execution-risk";
import { buildStakeholderRelationshipSnapshot } from "@/lib/stakeholder-intelligence";
import { buildOperationalCoordinationSnapshot } from "@/lib/coordination-orchestrator";
import { generateRuntimeOperationalPlans, type RuntimeOperationalPlan } from "@/lib/runtime-operational-plans";
import { loadPmoTenant } from "@/lib/pmo/load-pmo-tenant";
import { resolveEnabledDomains } from "@/lib/pmo/agent-domain-map";

// Resolves the caller's workspace from their project (if given) or first membership.
// Used only on the human-user path where no workspace header is supplied.
async function resolveWorkspaceIdForUser(userId: string, projectId: string | undefined): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  if (projectId) {
    const { data } = await supabase
      .from("projects")
      .select("workspace_id")
      .eq("id", projectId)
      .maybeSingle();
    if (data?.workspace_id) return data.workspace_id as string;
  }
  const { data } = await supabase
    .from("workspace_memberships")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  return (data?.workspace_id as string | undefined) ?? null;
}

type CopilotRequest = {
  message?: string;
  projectId?: string;
  sessionKey?: string;
  activeDomain?: string;
  projectName?: string;
  companyId?: string;
  role?: UserRole;
  methodology?: "PMI" | "Agile" | "Hybrid" | "General PMO";
};

type CopilotResponse = {
  answer: string;
  runtimeResponse?: { observation: string; interpretation: string; supportingEvidence: string[]; confidence: string; suggestedActions: string[]; followUps: string[]; trustNotes: string[] };
  operationalPlans?: RuntimeOperationalPlan[];
  diagnosis?: string;
  immediateAction?: string;
  reinforcement?: string;
  nextStep?: string;
  cards: Array<{ type: "Risks" | "Next Actions" | "Draft Email" | "RACI" | "Checklist"; title: string; items: string[] }>;
  facts: string[];
  bestPractices: string[];
  assumptions: string[];
  requiresMoreContext: boolean;
  contextGapQuestions: string[];
  plan: SubscriptionPlan;
  aiPowered: boolean;
  methodology: "PMI" | "Agile" | "Hybrid" | "General PMO";
  conversationIngestion?: { status: "skipped" | "ingested" | "failed"; reason?: string; nutrientsCreated: number; nutrientTypes: string[]; signalCount: number };
};

const safeList = (items: string[], limit = 8) => items.map((item) => item.trim()).filter(Boolean).slice(0, limit);
const hasRequiredSections = (answer: string) =>
  ["Situation", "Escalation logic", "Decision now", "Next 24h"].every((section) => answer.includes(section));
const getMethodologyGuide = (methodology: CopilotResponse["methodology"]) =>
  methodology === "PMI"
    ? "Bias to governance cadence, formal risk controls, and explicit ownership."
    : methodology === "Agile"
      ? "Bias to iterative delivery, backlog clarity, and rapid decision loops."
      : methodology === "General PMO"
        ? "Use neutral PMO language with practical governance and stakeholder framing."
        : "Blend governance rigor with iterative execution pressure and clear escalation boundaries.";

const toOperationalSignals = (runtimeContext: unknown): string[] => {
  if (!runtimeContext || typeof runtimeContext !== "object") return [];

  const signals = new Set<string>();
  const text = JSON.stringify(runtimeContext).toLowerCase();

  if (text.includes("blocker") || text.includes("blocked")) signals.add("blocker recurrence observed in recent operating notes");
  if (text.includes("stakeholder") || text.includes("sponsor")) signals.add("stakeholder alignment signals have shifted since prior checkpoints");
  if (text.includes("escalat")) signals.add("escalation follows a repeating path and should be acknowledged");
  if (text.includes("dependenc")) signals.add("dependency timing drift has prior precedent");
  if (text.includes("decision") || text.includes("approval")) signals.add("prior decision logic should be reused before opening new decision threads");
  if (text.includes("slip") || text.includes("delay") || text.includes("drift")) signals.add("timeline drift trend should be reflected in current risk framing");
  if (text.includes("confidence")) signals.add("confidence trend is evolving and should be stated directionally");

  return Array.from(signals).slice(0, 6);
};


export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return denyResponse({ status: 401, routeId: "/api/copilot", message: "Unauthorized", reason: "unauthorized" });

  const advancedAiAccess = await canUseAdvancedAi(user.id);
  if (!advancedAiAccess.ok) {
    return Response.json(
      { error: advancedAiAccess.error, feature: advancedAiAccess.feature, requiredPlan: advancedAiAccess.requiredPlan },
      { status: 402 },
    );
  }

  let payload: CopilotRequest;
  try {
    payload = (await request.json()) as CopilotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestValidation = CopilotRequestContract(payload);
  if (!requestValidation.ok) {
    console.warn("[contracts] copilot_request_invalid", {
      errors: requestValidation.errors,
      companyId: user.companyId,
    });
    return Response.json({ error: "Invalid request format.", code: "INVALID_REQUEST" }, { status: 400 });
  }
  payload = requestValidation.data as CopilotRequest;

  if (!payload.message?.trim()) return Response.json({ error: "Message is required." }, { status: 400 });
  if (payload.companyId && payload.companyId !== user.companyId) return denyResponse({ status: 403, routeId: "/api/copilot", message: "Tenant mismatch.", reason: "tenant_mismatch", actorUserId: user.id, eventType: "suspicious_cross_scope_attempt" });
  const agentToken = request.headers.get("x-pmf-agent-token");
  const agentId = request.headers.get("x-pmf-agent-id");
  const workspaceIdHeader = request.headers.get("x-pmf-workspace-id");

  // Partial agent headers are malformed — an attacker supplying only some
  // headers must not accidentally fall through to the human-user path.
  const agentHeaderCount = [agentToken, agentId, workspaceIdHeader].filter(Boolean).length;
  if (agentHeaderCount > 0 && agentHeaderCount < 3) {
    return denyResponse({ status: 403, routeId: "/api/copilot", message: "Agent attestation required.", reason: "malformed_attestation", actorUserId: user.id, eventType: "malformed_attestation" });
  }

  const isAgentCall = agentHeaderCount === 3;

  if (isAgentCall) {
    // Agent path: all three headers present — enforce strict attestation and scope.
    const workspaceId = workspaceIdHeader!;
    const agentAuth = await evaluateAgentAccess({ workspaceId, agentId: agentId!, resourceType: "copilot", resourceId: payload.projectId?.trim() || workspaceId, permission: "execute_ai_action" }) as { decision: string };
    if (agentAuth.decision !== "allow") return denyResponse({ status: 403, routeId: "/api/copilot", message: "Agent scope denied.", reason: `agent_${agentAuth.decision}`, actorUserId: user.id, actorAgentId: agentId, workspaceId, projectId: payload.projectId?.trim() || null, requestedPermission: "execute_ai_action", deniedPermission: "execute_ai_action", eventType: "revoked_agent_access" });

    const delegatedCapabilityToken = request.headers.get("x-pmf-delegation-token");
    if (delegatedCapabilityToken) {
      const delegated = await consumeDelegatedCapability({ delegationToken: delegatedCapabilityToken, action: "ai.execute", workspaceId, projectId: payload.projectId?.trim() || null, requestedPermission: "execute_ai_action", resourceType: "copilot", actorUserId: user.id, actorAgentId: agentId }) as { ok: boolean; reason?: string; delegation: { parent_grant_id?: string | null; parent_decision_id?: string | null; delegator_user_id?: string | null; delegator_agent_id?: string | null; delegatee_user_id?: string | null; delegatee_agent_id?: string | null; action: string; requested_permission: string; workspace_id: string; project_id?: string | null; constraints?: { delegationDepth?: number } | null; expires_at?: string | null } };
      if (!delegated.ok) return denyResponse({ status: 403, routeId: "/api/copilot", message: "Invalid delegated capability.", reason: String(delegated.reason ?? "delegation_denied"), actorUserId: user.id, actorAgentId: agentId, workspaceId, projectId: payload.projectId?.trim() || null, requestedPermission: "execute_ai_action", deniedPermission: "execute_ai_action", eventType: "delegated_capability_invalid" });
      console.info("[delegation]", explainDelegationChain(buildAuthorityLineage({ parentGrantId: delegated.delegation.parent_grant_id, parentDecisionId: delegated.delegation.parent_decision_id, delegatorUserId: delegated.delegation.delegator_user_id, delegatorAgentId: delegated.delegation.delegator_agent_id, delegateeUserId: delegated.delegation.delegatee_user_id, delegateeAgentId: delegated.delegation.delegatee_agent_id, action: delegated.delegation.action, requestedPermission: delegated.delegation.requested_permission, workspaceId: delegated.delegation.workspace_id, projectId: delegated.delegation.project_id, constraints: delegated.delegation.constraints ?? undefined, expiresAt: delegated.delegation.expires_at ?? undefined, depth: delegated.delegation.constraints?.delegationDepth ?? 0 })));
    } else {
      const executionGrantToken = request.headers.get("x-pmf-execution-grant");
      if (executionGrantToken) {
        const granted = await consumeExecutionGrant({ grantToken: executionGrantToken, action: "ai.execute", workspaceId, projectId: payload.projectId?.trim() || null, requestedPermission: "execute_ai_action", resourceType: "copilot", actorUserId: user.id, actorAgentId: agentId }) as { ok: boolean; reason?: string };
        if (!granted.ok) return denyResponse({ status: 403, routeId: "/api/copilot", message: "Invalid execution grant.", reason: granted.reason ?? "execution_grant_invalid", actorUserId: user.id, actorAgentId: agentId, workspaceId, projectId: payload.projectId?.trim() || null, requestedPermission: "execute_ai_action", deniedPermission: "execute_ai_action", eventType: "execution_grant_invalid" });
      } else {
        const governance = await enforceRuntimeAuthorization({
          actorType: "ai_agent",
          actorUserId: user.id,
          actorAgentId: agentId,
          workspaceId,
          projectId: payload.projectId?.trim() || undefined,
          action: "ai.execute",
          routeId: "/api/copilot",
          requestedPermission: "execute_ai_action",
          agentToken: agentToken!,
          resourceType: "copilot",
        });
        if (governance.response) return governance.response;
      }
    }
  } else {
    // Human user path: no agent headers present. Resolve workspace and enforce governance as user.
    const resolvedWorkspaceId = await resolveWorkspaceIdForUser(user.id, payload.projectId?.trim());
    const governance = await enforceRuntimeAuthorization({
      actorType: "user",
      actorUserId: user.id,
      workspaceId: resolvedWorkspaceId ?? undefined,
      projectId: payload.projectId?.trim() || undefined,
      action: "ai.execute",
      routeId: "/api/copilot",
      requestedPermission: "execute_ai_action",
      resourceType: "copilot",
    });
    if (governance.response) return governance.response;
  }

  const methodology = payload.methodology ?? "Hybrid";
  const conversationSessionKey = payload.sessionKey?.trim() || "default";
  const activeDomain = payload.activeDomain?.trim() || "operational_memory";
  const resolvedWorkspaceId = isAgentCall ? workspaceIdHeader! : await resolveWorkspaceIdForUser(user.id, payload.projectId?.trim());

  const [subscription, pmoResult, allMemory] = await Promise.all([
    getCompanySubscription(user.companyId),
    resolvedWorkspaceId ? loadPmoTenant(resolvedWorkspaceId) : Promise.resolve({ found: false } as const),
    readProjectMemory(user.companyId),
  ]);
  const selectedProject = allMemory.find((p) => p.id === payload.projectId) ?? allMemory.find((p) => p.projectName === payload.projectName);
  const allowedMemory = canUsePortfolioMemory(subscription.plan) ? allMemory : selectedProject ? [selectedProject] : [];

  const analysisAccess = await requireFeatureAccess(user.companyId, "ai_analysis");
  if (!analysisAccess.ok) {
  }

  const runtimeContext = await getRuntimeAuthorityView({
    companyId: user.companyId,
    projectId: selectedProject?.id ?? null,
    sourceRef: `user:${user.id}`,
    domain: "operational_memory",
  });

  const contextSummary = allowedMemory
    .slice(0, 6)
    .map((p: StoredProjectAnalysis) => `Project: ${p.projectName}\nRisks: ${p.risks.join("; ") || "none"}\nDependencies: ${p.dependencies.join("; ") || "none"}`)
    .join("\n\n");

  const continuitySignals = toOperationalSignals(runtimeContext);
  let continuityRetrievalStatus: "retrieved" | "empty" | "degraded" = "empty";
  let continuityRetrievalItemCount = 0;
  let continuityRetrievalTopTypes: string[] = [];
  let continuityRetrievalConfidence: "none" | "low" | "medium" | "high" = "none";
  let continuityRetrievalTrustNote: string | null = null;
  try {
    const continuityRetrieval = await retrieveOperationalContinuityEngine({
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId ?? null,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      sessionKey: conversationSessionKey,
      activeDomain,
      limit: 18,
      includeSessionMemory: true,
      includeVaultNutrients: true,
    });
    continuityRetrievalItemCount = continuityRetrieval.items.length;
    continuityRetrievalTopTypes = Array.from(new Set(continuityRetrieval.items.map((item) => item.type))).slice(0, 4);
    const topScore = continuityRetrieval.items[0]?.score ?? 0;
    continuityRetrievalConfidence = topScore >= 75 ? "high" : topScore >= 50 ? "medium" : topScore > 0 ? "low" : "none";
    continuityRetrievalStatus = continuityRetrievalItemCount ? "retrieved" : "empty";
  } catch (error) {
    continuityRetrievalStatus = "degraded";
    continuityRetrievalConfidence = "none";
    continuityRetrievalTrustNote = "Operational continuity retrieval is degraded; response used live runtime context only.";
    console.warn("[copilot] operational_continuity_retrieval_failed", {
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const continuity = await retrieveOperationalContinuityLegacy({
    companyId: user.companyId,
    workspaceId: resolvedWorkspaceId ?? "",
    projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
    sessionKey: conversationSessionKey,
    actorUserId: user.id,
    activeDomain: ["delivery", "risk", "governance", "stakeholder", "financial", "timeline", "general"].includes(activeDomain) ? activeDomain as "delivery" | "risk" | "governance" | "stakeholder" | "financial" | "timeline" | "general" : "general",
    currentMessage: payload.message,
    maxNutrients: 50,
    maxEvidence: 8,
    includeResolved: false,
  });
  const boundedContinuityContext = buildRuntimeContinuityContext(continuity.continuitySignals, 8);
  const learnedExecutionPatterns = await detectLearnedExecutionPatterns({
    companyId: user.companyId,
    workspaceId: resolvedWorkspaceId ?? "",
    projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
    activeDomain: ["delivery", "risk", "governance", "stakeholder", "financial", "timeline", "general"].includes(activeDomain) ? activeDomain as "delivery" | "risk" | "governance" | "stakeholder" | "financial" | "timeline" | "general" : "general",
    lookbackDays: 21,
    includeResolved: false,
    maxPatterns: 8,
  });
  if (learnedExecutionPatterns.status === "degraded") {
    console.warn("[copilot] execution_pattern_detection_degraded", {
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      reason: learnedExecutionPatterns.degradationReason ?? "unknown",
    });
  }
  const executionPatternSignals = learnedExecutionPatterns.patterns.slice(0, 4).map((pattern) => `- ${pattern.patternType.replaceAll("_", " ")} (${pattern.severity}): ${pattern.explanation}`).join("\n") || "- No recurring execution pattern detected.";
  const executionPatternSummary = learnedExecutionPatterns.summary.slice(0, 4).map((line) => `- ${line}`).join("\n") || "- No compact execution pattern summary available.";
  const interventionHistory = await retrieveInterventionHistory({ workspaceId: resolvedWorkspaceId ?? "", projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null, unresolvedOnly: false, recentOnlyDays: 30, limit: 18 });
  const boundedInterventionSummary = buildInterventionMemorySummary(interventionHistory).slice(0, 4);
  let boundedOperationalConfidenceSummary = ["Operational confidence is degraded; deterministic efficacy scoring unavailable."];
  let boundedAdaptiveConfidenceSummary = ["confidence trajectory degrading", "operational drift elevated"];
  let boundedPrioritizedMemorySummary = ["Operational prioritization unavailable; using continuity and execution defaults."];
  let boundedAttentionRoutingSummary = ["Operational attention orchestration degraded; bounded routing defaults applied."];
  let boundedCoordinationSummary = ["Operational coordination intelligence degraded; bounded coordination defaults applied."];
  let boundedEscalationSummary = ["Operational escalation intelligence degraded; bounded escalation defaults applied."];
  try {
    const [efficacy, stakeholders, confidence] = await Promise.all([
      calculateInterventionEfficacy({ workspaceId: resolvedWorkspaceId ?? "", projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null, scoringWindowDays: 30, recentOnly: true, limit: 40 }),
      calculateStakeholderResponsiveness({ workspaceId: resolvedWorkspaceId ?? "", projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null, scoringWindowDays: 30, limit: 60 }),
      buildOperationalConfidenceProfile({ workspaceId: resolvedWorkspaceId ?? "", projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null, scoringWindowDays: 30 }),
    ]);
    const adaptiveConfidence = await buildAdaptiveOperationalConfidence({
      workspaceId: resolvedWorkspaceId ?? "",
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      previousConfidence: confidence.operationalConfidence,
      interventionHistory,
      efficacy,
      stakeholders,
      learnedPatterns: learnedExecutionPatterns,
      continuitySignals: continuity.continuitySignals,
    });
    boundedOperationalConfidenceSummary = [
      `Operational confidence ${confidence.operationalTrust} (${confidence.operationalConfidence}/100).`,
      ...buildInterventionEfficacySummary({ efficacy, stakeholders, confidence }).slice(0, 2),
    ].slice(0, 4);
    boundedAdaptiveConfidenceSummary = adaptiveConfidence.summaries.slice(0, 4);
    const prioritizedMemory = await prioritizeOperationalMemory({
      workspaceId: resolvedWorkspaceId ?? "",
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      continuitySignals: continuity.continuitySignals,
      interventionHistory,
      adaptiveConfidence: adaptiveConfidence.adaptive,
      learnedPatterns: learnedExecutionPatterns,
      efficacy,
      stakeholders,
    });
    boundedPrioritizedMemorySummary = prioritizedMemory.summaries.slice(0, 4);
    const attentionOrchestration = await orchestrateOperationalAttention({
      workspaceId: resolvedWorkspaceId ?? "",
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      prioritizedMemory: prioritizedMemory.prioritized,
      adaptiveConfidence: adaptiveConfidence.adaptive,
      efficacy,
      stakeholders,
      continuitySignals: continuity.continuitySignals,
      interventionHistory,
    });
    boundedAttentionRoutingSummary = attentionOrchestration.routingSummaries.slice(0, 4);
    const coordinationIntelligence = await analyzeOperationalCoordination({
      workspaceId: resolvedWorkspaceId ?? "",
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      continuitySignals: continuity.continuitySignals,
      learnedPatterns: learnedExecutionPatterns,
      prioritizedMemory: prioritizedMemory.prioritized,
      attentionSignals: attentionOrchestration.attentionSignals,
      interventionHistory,
      adaptiveConfidence: adaptiveConfidence.adaptive,
      stakeholders,
      maxNodes: 24,
      maxEdges: 32,
      maxSignals: 12,
    });
    boundedCoordinationSummary = coordinationIntelligence.summaries.slice(0, 5);
    const escalationIntelligence = await analyzeOperationalEscalation({
      workspaceId: resolvedWorkspaceId ?? "",
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      continuitySignals: continuity.continuitySignals,
      learnedPatterns: learnedExecutionPatterns,
      interventionHistory,
      prioritizedMemory: prioritizedMemory.prioritized,
      attentionSignals: attentionOrchestration.attentionSignals,
      coordinationSignals: coordinationIntelligence.signals,
      adaptiveConfidence: adaptiveConfidence.adaptive,
      stakeholders,
      maxSignals: 12,
    });
    boundedEscalationSummary = escalationIntelligence.summaries.slice(0, 5);
  } catch (error) {
    console.warn("[copilot] intervention_efficacy_scoring_failed", {
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  let scopedConversationState = null;
  let continuityPersistenceDegraded = false;
  try {
    scopedConversationState = await loadRuntimeConversationState({
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      sessionKey: conversationSessionKey,
    });
  } catch (error) {
    continuityPersistenceDegraded = true;
    console.warn("[copilot] continuity_load_failed", { companyId: user.companyId, error: error instanceof Error ? error.message : String(error) });
  }

  const pmoGovernanceBlock = (() => {
    if (!pmoResult.found) return "";
    const { tenant } = pmoResult;
    const enabledAgentDomains = resolveEnabledDomains(tenant.agents);
    const lines = [
      `PMO: ${tenant.identity.pmoName} (${tenant.identity.organizationName})`,
      `Type: ${tenant.identity.pmoType} | Model: ${tenant.identity.operatingModel}`,
      `Governance: ${tenant.governance.methodology}, ${tenant.governance.reportingCadence} cadence, ${tenant.governance.projectScale} scale, ${tenant.governance.approvalGovernance} approvals`,
      `Active agent domains: ${enabledAgentDomains.join(", ") || "general"}`,
      tenant.contextSeed.strategicObjective
        ? `Strategic objective: ${tenant.contextSeed.strategicObjective.slice(0, 200)}`
        : null,
      tenant.contextSeed.deliveryChallenges.length
        ? `Known delivery challenges: ${tenant.contextSeed.deliveryChallenges.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    return `\nPMO Governance Context:\n${lines}\n`;
  })();

  const system = `You are PMFreak, an AI Project Manager with operational realism and delivery accountability.${pmoGovernanceBlock}
Preserve PM-native operational tone: experienced, calm under pressure, politically aware, delivery-focused.
Do not sound like a template, startup guru, aggressive CEO, or verbose consultant.
Avoid motivational language.

Response shaping goals:
1) Preserve concise operational structure.
2) Keep deterministic reasoning and fact discipline.
3) Vary sentence rhythm and framing between responses.
4) Increase realism in delivery reasoning (dependencies, ownership, sequence, constraints).

Execution behavior:
- Identify the single highest-leverage execution issue first.
- Apply dynamic escalation framing: explain why escalation is or is not warranted now.
- Be dependency-aware: mention critical path or inter-team dependency when relevant.
- Modulate tone by stakeholder impact (team, sponsor, executive, client).
- Calibrate communication style by severity (low, medium, high, critical).
- Adapt phrasing to timeline pressure (same-day, this week, multi-week).
- Articulate tradeoffs concisely.
- Calibrate confidence: explicit confidence level based on evidence strength.
- Sustain operational continuity when evidence exists: use subtle references to recurring blockers, stakeholder continuity, repeated escalation paths, dependency history, prior decisions, timeline drift, confidence evolution, and trend direction.
- Keep continuity references natural and sparse (at most 1-2 short mentions in the full answer).
- Never mention memory systems, cognition architecture, tracking mechanics, or surveillance framing.

Hard rules:
- Never invent project facts.
- Never use cross-tenant data.
- If context is missing, state the missing input briefly and still issue one concrete decision.
- Avoid vague phrases such as "improve communication" or "optimize workflow."
- Every decision/action must include WHO, WHAT, and WHEN.
- Keep output compact and operational.

Output contract:
- Return compact JSON only.
- Return keys: answer, diagnosis, immediateAction, reinforcement, nextStep, facts, bestPractices, assumptions, tradeoffs, dependencies, escalationPath.
- "answer" must use this exact markdown section format:
  ### Situation
  ### Escalation logic
  ### Decision now
  ### Next 24h
- Each section: 1-2 short lines.
- "Escalation logic" should include severity, timeline pressure, and confidence in one tight statement.
- "Decision now" must include one decisive action.
- Also include arrays for "facts", "bestPractices", and "assumptions".
- Keep each section 1-2 short lines.
- Also include arrays for "facts", "bestPractices", "assumptions", "tradeoffs", "dependencies", and "escalationPath".

Methodology mode: ${methodology}. ${getMethodologyGuide(methodology)}`;

  let content: string;
  try {
    const inferenceResult = await runInference({
      moduleId: "copilot",
      workspaceId: isAgentCall ? workspaceIdHeader! : undefined,
      projectId: payload.projectId?.trim() || selectedProject?.id,
      actorId: user.id,
      actorType: isAgentCall ? "ai_agent" : "user",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `User role: ${payload.role ?? user.role}\nProject selected: ${payload.projectName ?? selectedProject?.projectName ?? "Not specified"}\nKnown project memory:\n${contextSummary || "No memory available."}\n\nRecent Operational Continuity:\n${boundedContinuityContext.continuitySignals.slice(0, 4).map((signal) => `- ${signal.type.replaceAll("_signal", "").replaceAll("_", " ")} (${signal.urgency}): ${signal.evidenceExcerpt}`).join("\n") || "- No scoped continuity signals available."}\n\nContinuity summary:\n${boundedContinuityContext.continuitySummary.map((line) => `- ${line}`).join("\n") || "- No continuity summary available."}\n\nOperational continuity signals:\n${continuitySignals.length ? continuitySignals.map((s) => `- ${s}`).join("\n") : "- No reliable continuity signal extracted."}\n\nExecution Pattern Signals:\n${executionPatternSignals}\n\nExecution pattern summary:\n${executionPatternSummary}\n\nOperational Confidence:\n${boundedOperationalConfidenceSummary.map((line) => `- ${line}`).join("\n")}\n\n
Adaptive Operational Confidence:
${boundedAdaptiveConfidenceSummary.map((line) => `- ${line}`).join("\n")}

Operational Priority Signals:
${boundedPrioritizedMemorySummary.map((line) => `- ${line}`).join("\n")}

Operational Attention Signals:
${boundedAttentionRoutingSummary.map((line) => `- ${line}`).join("\n")}

Operational Coordination Intelligence:
${boundedCoordinationSummary.map((line) => `- ${line}`).join("\n")}

Operational Escalation Intelligence:
${boundedEscalationSummary.map((line) => `- ${line}`).join("\n")}

AOC runtime authority context:\n${JSON.stringify(runtimeContext)}\n\nUser message: ${payload.message}`,
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: 0.2,
      timeoutMs: 25000,
      maxAttempts: 2,
      retryDelayMs: 1000,
      operationName: "copilot",
      idempotencyKey: randomUUID(),
      metadata: { companyId: user.companyId },
    });
    content = inferenceResult.content;
  } catch (error) {
    if (error instanceof InferenceError) {
      console.error("[copilot] inference_failed", {
        errorClass: error.errorClass,
        attempts: error.attempts,
        companyId: user.companyId,
      });
      return Response.json(
        { error: "Copilot temporarily unavailable.", code: error.errorClass },
        { status: error.errorClass === "rate_limited" ? 429 : 502 },
      );
    }
    return Response.json({ error: "Copilot temporarily unavailable." }, { status: 502 });
  }

  if (!content) return Response.json({ error: "AI returned empty response." }, { status: 502 });

  const extractedInterventions = extractOperationalInterventions(content);
  const traceId = runtimeContext && typeof runtimeContext === "object" && "decisionId" in runtimeContext ? String((runtimeContext as { decisionId?: string }).decisionId ?? "") : null;
  await Promise.all(extractedInterventions.slice(0, 6).map((item) => persistOperationalIntervention({
    companyId: user.companyId,
    workspaceId: resolvedWorkspaceId ?? "",
    projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
    source: "copilot",
    interventionType: item.interventionType,
    operationalDomain: item.operationalDomain,
    severity: item.severity,
    interventionText: item.interventionText,
    targetStakeholders: item.targetStakeholders,
    relatedPatterns: learnedExecutionPatterns.patterns.slice(0, 3).map((pattern) => pattern.patternType),
    relatedNutrients: boundedContinuityContext.continuitySignals.slice(0, 4).map((signal) => signal.nutrientId),
    runtimeDecisionId: null,
    lineage: { sessionKey: conversationSessionKey, correlationId: payload.projectId ?? null, executionTraceId: traceId },
  })));

  let parsed: Partial<CopilotResponse> = {};
  try {
    parsed = JSON.parse(content) as Partial<CopilotResponse>;
  } catch {
    parsed = { answer: content };
  }

  const responseValidation = CopilotResponseContract(parsed);
  const parsedValidated = responseValidation.ok ? responseValidation.data : {};
  console.info("[contracts] copilot_response_validated", {
    fieldCount: Object.keys(parsedValidated).length,
    companyId: user.companyId,
  });

  const verificationContext = {
    projectName: selectedProject?.projectName ?? payload.projectName ?? null,
    knownRisks: selectedProject?.risks ?? [],
    knownDependencies: selectedProject?.dependencies ?? [],
    unresolvedMemory: boundedContinuityContext.unresolvedBlockers.map((item) => item.evidenceExcerpt),
    userMessage: payload.message,
  };

  const verification = verifyAiResponse(parsed, verificationContext);

  console.info("[ai-verifier]", {
    passed: verification.passed,
    confidenceScore: verification.confidenceScore,
    flagCount: verification.flags.length,
    flags: verification.flags.map((f) => ({ field: f.field, rule: f.rule, severity: f.severity })),
    companyId: user.companyId,
    projectId: selectedProject?.id ?? null,
  });

  if (!verification.passed && verification.confidenceScore < 40) {
    console.warn("[ai-verifier] low_confidence_response", {
      confidenceScore: verification.confidenceScore,
      flagCount: verification.flags.length,
      companyId: user.companyId,
      projectId: selectedProject?.id ?? null,
    });
  }

  const verifiedDiagnosis = verification.sanitized.diagnosis ?? (typeof parsedValidated.diagnosis === "string" ? parsedValidated.diagnosis : undefined);
  const verifiedImmediateAction = verification.sanitized.immediateAction ?? (typeof parsedValidated.immediateAction === "string" ? parsedValidated.immediateAction : undefined);

  const result: CopilotResponse = {
    answer: buildPmNativeResponse({
      diagnosis: verifiedDiagnosis ?? "Single-thread accountability is missing; decisions are waiting in queue.",
      immediateAction:
        verifiedImmediateAction ??
        "Program lead assigns one accountable owner for the next milestone and publishes due date before end of day.",
      reinforcement:
        typeof parsedValidated.reinforcement === "string"
          ? parsedValidated.reinforcement
          : "Without an owner reset, escalation load and timeline variance both increase this week.",
      nextStep:
        typeof parsedValidated.nextStep === "string"
          ? parsedValidated.nextStep
          : "Within 24 hours, clear shared ownership on active workstreams and confirm dependency handoffs.",
    }),
    diagnosis: verifiedDiagnosis,
    immediateAction: verifiedImmediateAction,
    reinforcement: typeof parsedValidated.reinforcement === "string" ? parsedValidated.reinforcement : undefined,
    nextStep: typeof parsedValidated.nextStep === "string" ? parsedValidated.nextStep : undefined,
    cards: Array.isArray(parsedValidated.cards) ? (parsedValidated.cards.slice(0, 5) as CopilotResponse["cards"]) : [],
    facts: safeList(verification.sanitized.facts),
    bestPractices: safeList(Array.isArray(parsedValidated.bestPractices) ? parsedValidated.bestPractices : []),
    assumptions: safeList(verification.sanitized.assumptions),
    requiresMoreContext: Boolean(parsedValidated.requiresMoreContext),
    contextGapQuestions: safeList(Array.isArray(parsedValidated.contextGapQuestions) ? parsedValidated.contextGapQuestions : []),
    plan: subscription.plan,
    aiPowered: true,
    methodology,
  };


  const extractedFromMessage = extractOperationalMemoryCandidates({
    text: payload.message,
    sourceType: "copilot_message",
    sourceReference: `copilot:${new Date().toISOString()}`,
  });

  await appendOperationalMemory({
    companyId: user.companyId,
    projectId: selectedProject?.id ?? null,
    entries: extractedFromMessage,
  });

  if (!hasRequiredSections(result.answer)) {
    result.answer = buildPmNativeResponse({
      diagnosis: result.diagnosis ?? "Execution signal quality is insufficient for decision velocity.",
      immediateAction: result.immediateAction ?? "PM assigns accountable owner and due date on top risk item today.",
      reinforcement: result.reinforcement ?? "If governance is delayed again, stakeholder confidence will degrade further.",
      nextStep: result.nextStep ?? "Run a 15-minute dependency review in the next working block.",
    });
  }


  const evidenceRefs = [
    "execution-risk",
    "stakeholders",
    "interventions",
    "coordination",
    boundedContinuityContext.unresolvedBlockers.length ? "operational-memory" : "operational-memory:low",
  ];

  let updatedConversationState = scopedConversationState;
  try {
    updatedConversationState = await updateRuntimeConversationState({
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      sessionKey: conversationSessionKey,
      activeDomain,
      message: payload.message,
      evidenceRefs,
    });
  } catch (error) {
    continuityPersistenceDegraded = true;
    console.warn("[copilot] continuity_update_failed", { companyId: user.companyId, error: error instanceof Error ? error.message : String(error) });
  }

  const trustNotes: string[] = [];
  if (!boundedContinuityContext.unresolvedBlockers.length) trustNotes.push("Operational memory is currently sparse; guidance is based on live runtime signals.");
  if (!continuitySignals.length) trustNotes.push("Cross-signal confidence is limited because runtime context currently has weak evidence density.");
  if (["scope", "lessons"].includes(activeDomain)) trustNotes.push("Selected domain currently carries simulated placeholder reasoning.");
  if (continuityPersistenceDegraded) trustNotes.push("Continuity persistence is degraded; response used live runtime context only.");
  if (learnedExecutionPatterns.status === "degraded") trustNotes.push("Execution pattern detection is degraded; response used live continuity signals only.");

  const confidence = verification.confidenceScore >= 75 ? "High" : verification.confidenceScore >= 50 ? "Moderate" : "Low";
  const followUps = [
    "Show dependency chain for unresolved blockers",
    "Review unresolved blocker evidence",
    "Compare this pattern with previous escalation cycles",
    "Generate an executive explanation with decision asks",
  ];

  result.runtimeResponse = {
    observation: result.diagnosis ?? "Operational deterioration pattern detected.",
    interpretation: result.reinforcement ?? "Current trajectory suggests governance and dependency pressure are compounding.",
    supportingEvidence: [
      ...continuitySignals.slice(0, 2),
      ...boundedContinuityContext.continuitySignals.slice(0, 2).map((item) => `${item.type}: ${item.evidenceExcerpt}`),
      `Evidence sources: ${(updatedConversationState?.recentEvidence ?? evidenceRefs).join(", ")}`,
    ],
    confidence: `${confidence} confidence (${verification.confidenceScore}/100 verification score).`,
    suggestedActions: [
      result.immediateAction ?? "Assign accountable owner for top-risk delivery item today.",
      result.nextStep ?? "Run targeted dependency review within 24h.",
    ],
    followUps,
    trustNotes,
  };
  const ingestionSourceRef = `copilot:${conversationSessionKey}:${new Date().toISOString()}`;
  const ingestionProjectId = selectedProject?.id ?? payload.projectId?.trim() ?? null;
  // PD-25: the copilot still answers about an archived project, but records no new vault signals
  // (nutrients) for it — an archived project is read-only.
  const ingestion: ConversationVaultIngestionResult = (await isArchivedProject(ingestionProjectId))
    ? { status: "skipped", reason: "project_archived", nutrientsCreated: 0, residueCreated: 0, nutrientTypes: [], signalCount: 0, evidenceRefs: [] }
    : await ingestConversationIntoVault({
    companyId: user.companyId,
    workspaceId: resolvedWorkspaceId,
    projectId: ingestionProjectId,
    sessionKey: conversationSessionKey,
    activeDomain,
    message: payload.message,
    runtimeResponse: result.runtimeResponse,
    conversationState: updatedConversationState,
    sourceRef: ingestionSourceRef,
    actorUserId: user.id,
  });

  result.conversationIngestion = {
    status: ingestion.status,
    reason: ingestion.reason,
    nutrientsCreated: ingestion.nutrientsCreated,
    nutrientTypes: ingestion.nutrientTypes,
    signalCount: ingestion.signalCount,
  };

  if (ingestion.status === "failed") {
    result.runtimeResponse.trustNotes.push("Conversation signal ingestion is degraded; learning update was not persisted.");
    console.warn("[copilot] conversation_ingestion_failed", {
      companyId: user.companyId,
      workspaceId: resolvedWorkspaceId,
      projectId: selectedProject?.id ?? payload.projectId?.trim() ?? null,
      sessionKey: conversationSessionKey,
      reason: ingestion.reason ?? "unknown",
    });
  }

  if (selectedProject?.id) {
    const snapshot = await readProjectMemorySnapshot(selectedProject.id);
    const interventionSnapshot = buildInterventionSnapshot(selectedProject.id, snapshot);
    const coordinationSnapshot = buildOperationalCoordinationSnapshot({
      projectId: selectedProject.id,
      workspaceId: isAgentCall ? workspaceIdHeader! : null,
      executionRisk: buildExecutionRiskSnapshot(selectedProject.id, snapshot),
      stakeholderIntelligence: buildStakeholderRelationshipSnapshot(selectedProject.id, snapshot),
      interventionIntelligence: interventionSnapshot,
      organizationalMemory: snapshot,
      timelineIntelligence: {
        daysSinceUpdate: snapshot?.lastUpdatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.lastUpdatedAt)) / 86_400_000)) : 30,
        stale: snapshot?.lastUpdatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.lastUpdatedAt)) / 86_400_000)) >= 7 : true,
      },
    });
    result.operationalPlans = generateRuntimeOperationalPlans({
      projectId: selectedProject.id,
      intervention: interventionSnapshot,
      coordination: coordinationSnapshot,
    });
  } else {
    result.operationalPlans = [];
  }
  return Response.json({ ...result, verificationScore: verification.confidenceScore, continuityRetrieval: { status: continuityRetrievalStatus, itemCount: continuityRetrievalItemCount, topTypes: continuityRetrievalTopTypes, confidence: continuityRetrievalConfidence } });
}
