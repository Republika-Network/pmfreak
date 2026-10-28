import { openAIProvider, isOpenAIProviderConfigured } from "@/lib/ai/providers/openai-provider";
import type { InferenceProvider, InferenceRequest, InferenceResponse } from "@/lib/ai/inference/types";
import { InferenceError } from "@/lib/ai/inference/types";
import { randomUUID } from "node:crypto";
import { resolveAiRuntimeLimits, type AiRuntimeLimits } from "@/lib/ai/runtime-limits";
import {
  AiGuardrailError,
  assertChainDepthAllowed,
  providerCircuitBreaker,
  workspaceConcurrencyGate,
} from "@/lib/ai/runtime-guardrails";
import {
  createSupabaseAiCostLedger,
  estimateCostUsd,
  recordAiUsage,
  type AiCostLedger,
  type AiCostScope,
  type AiCostSettleReason,
} from "@/lib/ai/usage-accounting";
import {
  costOfUsageUsd,
  inputTokenUpperBound,
  outputTokenUpperBound,
  resolveModelPrice,
  roundUsdUp,
  worstCaseAttemptCostUsd,
  type ModelPrice,
} from "@/lib/ai/model-pricing";
import { enforceAbuseLimit } from "@/lib/security/abuse-protection";
import { buildRoutingContext, resolveProviderCandidates } from "./provider-candidate-resolver";
import { evaluateProviderEgress } from "./egress-policy";
import { emitRoutingAudit, emitRoutingFallback } from "./routing-audit";
import {
  getRegisteredProviders,
  isProviderRegistered,
  isProviderConfigured,
  getProviderHealth,
  setProviderAvailabilityResolver,
} from "./provider-registry";

export { getRegisteredProviders, isProviderRegistered, isProviderConfigured, getProviderHealth };

const DEFAULT_MODEL = process.env.DEFAULT_AI_MODEL ?? "gpt-4.1-mini";

// Per-module model overrides; resolved once at startup from env.
const MODULE_MODEL_MAP: Record<string, string> = {
  "meta-intelligence": process.env.OPENAI_META_INTELLIGENCE_MODEL ?? DEFAULT_MODEL,
  "message-nudges": process.env.OPENAI_MESSAGE_NUDGES_MODEL ?? DEFAULT_MODEL,
};

const providerRegistry = new Map<string, InferenceProvider>([
  ["openai", openAIProvider],
  // Future providers registered here:
  // ["anthropic", anthropicProvider],
  // ["gemini", geminiProvider],
  // ["local", localProvider],
]);

// Inject availability into the capability registry so routing decisions are accurate.
// API key checks live in each provider adapter; the registry queries via this resolver.
setProviderAvailabilityResolver((id) => {
  if (id === "openai") return isOpenAIProviderConfigured() ? "enabled" : "not_configured";
  if (id === "mock") return "enabled";
  // anthropic, gemini, local: adapters not yet registered
  return providerRegistry.has(id) ? "enabled" : "not_configured";
});

export function resolveProvider(moduleId?: string): InferenceProvider {
  // Future: consult module registry or policy engine for per-module routing.
  // For now, route everything through the configured default provider.
  void moduleId;
  const providerId = process.env.DEFAULT_AI_PROVIDER ?? "openai";
  const provider = providerRegistry.get(providerId);
  if (!provider) {
    throw new InferenceError(
      `AI provider "${providerId}" is not registered. Available providers: ${[...providerRegistry.keys()].join(", ")}`,
      "unknown",
      providerId,
    );
  }
  return provider;
}

export function resolveModelForModule(moduleId?: string): string {
  return (moduleId && MODULE_MODEL_MAP[moduleId]) ?? DEFAULT_MODEL;
}

export function registerProvider(provider: InferenceProvider): void {
  providerRegistry.set(provider.id, provider);
}

/** Dependencies of runInference that tests replace; production uses the defaults. */
export type InferenceDeps = {
  ledger: AiCostLedger;
  enforceLimit: typeof enforceAbuseLimit;
  limits?: AiRuntimeLimits;
};

const defaultInferenceDeps: InferenceDeps = { ledger: createSupabaseAiCostLedger(), enforceLimit: enforceAbuseLimit };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value: string | undefined) => (typeof value === "string" && UUID_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null);

/** Who pays for a billable request: its workspace and/or the acting user. Neither → refused. */
export function resolveBudgetScope(request: Pick<InferenceRequest, "workspaceId" | "actorId">): AiCostScope | null {
  const workspaceId = asUuid(request.workspaceId);
  const userId = asUuid(request.actorId);
  return workspaceId || userId ? { workspaceId, userId } : null;
}

/**
 * Perilla 11 + B6 guardrails, enforced here because every inference path (gateway
 * modules, copilot, analyze-ai, meta-intelligence, Project Brain) converges on runInference:
 *
 *  - agent-chain depth is bounded (AI_MAX_CHAIN_DEPTH);
 *  - every request names a budget scope (its workspace and/or acting user) or is refused;
 *  - daily request ceiling (AI_DAILY_REQUEST_LIMIT) per workspace, or per user when there
 *    is no workspace, through the fail-closed abuse store;
 *  - per-workspace concurrency bound (AI_MAX_CONCURRENT_PER_WORKSPACE);
 *  - B6 cost control, per metered provider call (reserveProviderCall / settlementFor):
 *    the model must have an allowlisted price; the worst-case cost of every allowed attempt
 *    is RESERVED against the workspace, user and deployment-wide daily ceilings
 *    (AI_DAILY_COST_LIMIT_USD, AI_DAILY_USER_COST_LIMIT_USD, AI_DAILY_GLOBAL_COST_LIMIT_USD)
 *    in one atomic ledger transaction BEFORE the provider is called, and settled against
 *    the reported usage after. An unpriced model, an unavailable ledger or a refused
 *    reservation stops the request before any billable call — never fail open;
 *  - per-provider circuit breaker (fail fast while a provider is down);
 *  - timeout/attempt defaults from AI_REQUEST_TIMEOUT_MS / AI_MAX_RETRIES
 *    when the caller did not set tighter ones;
 *  - every call records an ai_usage_events accounting row (best-effort report).
 */
export async function runInference(request: InferenceRequest, deps: InferenceDeps = defaultInferenceDeps): Promise<InferenceResponse> {
  const limits = deps.limits ?? resolveAiRuntimeLimits();
  const operation = request.operationName ?? request.moduleId ?? "inference";
  const startedAt = Date.now();
  const recordOutcome = (status: "success" | "error" | "timeout" | "blocked", response?: InferenceResponse, providerId = "none") =>
    recordAiUsage({
      provider: response?.provider ?? providerId,
      model: response?.model ?? request.modelPreference ?? resolveModelForModule(request.moduleId),
      workspaceId: request.workspaceId,
      userId: request.actorId,
      operation,
      inputTokens: response?.usage?.inputTokens,
      outputTokens: response?.usage?.outputTokens,
      estimatedCostUsd: response ? estimateCostUsd(response.model, response.usage?.inputTokens, response.usage?.outputTokens, response.provider) : null,
      status,
      durationMs: Date.now() - startedAt,
    });

  let scope: AiCostScope;
  try {
    assertChainDepthAllowed(request.chainDepth, limits.maxChainDepth);

    const resolvedScope = resolveBudgetScope(request);
    if (!resolvedScope) {
      throw new AiGuardrailError("AI request refused: no workspace or user to charge it to.", "budget_scope_missing");
    }
    scope = resolvedScope;

    const daily = await deps.enforceLimit(
      scope.workspaceId
        ? { scope: "ai.workspace_daily_requests", identifier: scope.workspaceId, limit: limits.dailyWorkspaceRequestLimit, windowSeconds: 24 * 60 * 60 }
        : { scope: "ai.user_daily_requests", identifier: scope.userId as string, limit: limits.dailyWorkspaceRequestLimit, windowSeconds: 24 * 60 * 60 },
    );
    if (!daily.allowed) {
      throw new AiGuardrailError(
        `${scope.workspaceId ? "Workspace" : "User"} reached its daily AI request ceiling (${limits.dailyWorkspaceRequestLimit}/day).`,
        "daily_request_ceiling",
      );
    }
  } catch (error) {
    if (error instanceof AiGuardrailError) await recordOutcome("blocked");
    throw error;
  }

  const releaseConcurrency = scope.workspaceId
    ? (() => {
        try {
          return workspaceConcurrencyGate.acquire(scope.workspaceId, limits.maxConcurrentPerWorkspace);
        } catch (error) {
          if (error instanceof AiGuardrailError) void recordOutcome("blocked");
          throw error;
        }
      })()
    : null;

  try {
    const response = await executeInference(request, limits, { scope, operation, ledger: deps.ledger });
    providerCircuitBreaker.recordSuccess(response.provider);
    await recordOutcome("success", response);
    return response;
  } catch (error) {
    const status =
      error instanceof AiGuardrailError ? "blocked" : error instanceof InferenceError && error.errorClass === "timeout" ? "timeout" : "error";
    await recordOutcome(status, undefined, error instanceof InferenceError ? error.provider : "none");
    throw error;
  } finally {
    releaseConcurrency?.();
  }
}

type CostContext = { scope: AiCostScope; operation: string; ledger: AiCostLedger };

type ProviderCallReservation = {
  reservationId: string;
  price: ModelPrice;
  perAttemptUsd: number;
  reservedUsd: number;
  maxAttempts: number;
};

const MAX_RESERVED_ATTEMPTS = 6;
const clampAttempts = (attempts: number) => Math.min(Math.max(Math.trunc(Number.isFinite(attempts) ? attempts : 1), 1), MAX_RESERVED_ATTEMPTS);

/**
 * Price and reserve ONE metered provider call before it is made. Throws AiGuardrailError —
 * so nothing is sent — when the model is unpriced, the ledger is unavailable, a ceiling
 * would be exceeded, or the same request is already in flight or answered.
 */
async function reserveProviderCall(providerId: string, request: InferenceRequest, cost: CostContext, limits: AiRuntimeLimits): Promise<ProviderCallReservation> {
  const model = request.modelPreference ?? DEFAULT_MODEL;
  const pricing = resolveModelPrice(providerId, model);
  if (!pricing.ok) {
    console.error("[ai-cost] model_not_priced", { provider: providerId, model, reason: pricing.reason });
    throw new AiGuardrailError(`AI model "${model}" has no allowlisted price (${pricing.reason}); request refused before any billable call.`, "model_not_priced", providerId);
  }
  const maxAttempts = clampAttempts(request.maxAttempts ?? 1);
  const perAttemptUsd = worstCaseAttemptCostUsd(
    pricing.price,
    inputTokenUpperBound({ messages: request.messages, responseFormat: request.responseFormat }),
    outputTokenUpperBound(pricing.price, request.maxTokens),
  );
  const reservedUsd = roundUsdUp(perAttemptUsd * maxAttempts);
  const reservationKey = `${request.idempotencyKey ?? randomUUID()}:${providerId}`;

  const reserved = await cost.ledger.reserve({
    ...cost.scope,
    reservationKey,
    operation: cost.operation,
    provider: providerId,
    model,
    priceVersion: pricing.priceVersion,
    amountUsd: reservedUsd,
    limits: { workspaceUsd: limits.dailyWorkspaceCostLimitUsd, userUsd: limits.dailyUserCostLimitUsd, globalUsd: limits.dailyGlobalCostLimitUsd },
  });
  if (reserved.ok) return { reservationId: reserved.reservationId, price: pricing.price, perAttemptUsd, reservedUsd, maxAttempts };
  if (reserved.reason === "daily_cost_ceiling") {
    const label = reserved.scope === "global" ? "This deployment" : reserved.scope === "workspace" ? "Workspace" : "User";
    throw new AiGuardrailError(`${label} reached its daily AI cost ceiling ($${reserved.limitUsd.toFixed(2)}).`, "daily_cost_ceiling", providerId);
  }
  if (reserved.reason === "duplicate_request") {
    throw new AiGuardrailError("This AI request is already in progress or was already answered.", "duplicate_request", providerId);
  }
  console.error("[ai-cost] reservation_unavailable", { provider: providerId, operation: cost.operation, detail: reserved.detail });
  throw new AiGuardrailError("AI cost accounting is unavailable, so the request was refused before any billable call.", "cost_accounting_unavailable", providerId);
}

const DEFINITIVELY_UNGENERATED = new Set(["bad_request", "auth_error", "rate_limited"]);

/**
 * Settle a reservation from what is KNOWN. Earlier failed attempts of a retried call and any
 * attempt whose outcome is unknown are charged at the per-attempt worst case; only a provider
 * that was never contacted, or that refused the only attempt with a 4xx/429, releases it.
 */
function settlementFor(
  reservation: ProviderCallReservation,
  providerId: string,
  outcome: { response: InferenceResponse } | { error: unknown },
): { outcome: "settled" | "released"; settledUsd: number; reason: AiCostSettleReason; inputTokens?: number; outputTokens?: number; responseModel?: string } {
  const charge = (attempts: number) => roundUsdUp(reservation.perAttemptUsd * Math.min(Math.max(attempts, 0), reservation.maxAttempts));

  if ("response" in outcome) {
    const { response } = outcome;
    const attempts = typeof response.attempts === "number" && response.attempts >= 1 ? response.attempts : reservation.maxAttempts;
    const earlierAttemptsUsd = charge(attempts - 1);
    const inputTokens = response.usage?.inputTokens;
    const outputTokens = response.usage?.outputTokens;
    const responsePrice = resolveModelPrice(providerId, response.model);
    if (!responsePrice.ok) {
      console.error("[ai-cost] response_model_unrecognized", { provider: providerId, model: response.model, reason: responsePrice.reason });
      return { outcome: "settled", settledUsd: roundUsdUp(earlierAttemptsUsd + reservation.perAttemptUsd), reason: "success_model_unrecognized", inputTokens, outputTokens, responseModel: response.model };
    }
    const actual = costOfUsageUsd(responsePrice.price, inputTokens, outputTokens);
    if (actual === null) {
      return { outcome: "settled", settledUsd: roundUsdUp(earlierAttemptsUsd + reservation.perAttemptUsd), reason: "success_usage_unknown", inputTokens, outputTokens, responseModel: response.model };
    }
    if (actual > reservation.perAttemptUsd) {
      console.error("[ai-cost] usage_exceeded_reservation_bound", { provider: providerId, model: response.model, actualUsd: actual, boundUsd: reservation.perAttemptUsd });
    }
    return { outcome: "settled", settledUsd: roundUsdUp(earlierAttemptsUsd + actual), reason: "success", inputTokens, outputTokens, responseModel: response.model };
  }

  const { error } = outcome;
  if (error instanceof InferenceError && typeof error.attempts === "number") {
    if (error.attempts === 0) return { outcome: "released", settledUsd: 0, reason: "provider_not_contacted" };
    const lastAttemptUngenerated = DEFINITIVELY_UNGENERATED.has(error.errorClass);
    const charged = charge(lastAttemptUngenerated ? error.attempts - 1 : error.attempts);
    if (charged === 0) return { outcome: "released", settledUsd: 0, reason: "provider_refused" };
    return { outcome: "settled", settledUsd: charged, reason: "provider_failed" };
  }
  return { outcome: "settled", settledUsd: reservation.reservedUsd, reason: "outcome_unknown" };
}

async function executeInference(request: InferenceRequest, limits: AiRuntimeLimits, cost: CostContext): Promise<InferenceResponse> {
  const context = buildRoutingContext(request);
  const candidates = resolveProviderCandidates(context);

  const allowedCandidates: Array<{ candidate: (typeof candidates)[0]; requiresAudit: boolean }> = [];
  const rejectedCandidates: Array<{ providerId: string; reason: string }> = [];

  for (const candidate of candidates) {
    const egress = evaluateProviderEgress(candidate.metadata, context.dataSensitivity, context.routingMode);
    if (egress.allowed) {
      allowedCandidates.push({ candidate, requiresAudit: egress.requiresAudit ?? false });
    } else {
      rejectedCandidates.push({ providerId: candidate.providerId, reason: egress.reason });
    }
  }

  if (allowedCandidates.length === 0) {
    throw new InferenceError(
      `No approved provider available for this request. Candidates evaluated: [${candidates.map((c) => c.providerId).join(", ") || "none"}]. Rejected: [${rejectedCandidates.map((r) => `${r.providerId}(${r.reason})`).join(", ") || "none"}].`,
      "unknown",
      "none",
    );
  }

  const resolvedRequest: InferenceRequest = {
    ...request,
    modelPreference: request.modelPreference ?? resolveModelForModule(request.moduleId),
    // Callers may set tighter bounds; anything unset falls back to the
    // centralized env-configurable limits so no call is ever unbounded.
    timeoutMs: request.timeoutMs ?? limits.requestTimeoutMs,
    // B6: the provider makes exactly as many attempts as the reservation covers.
    maxAttempts: clampAttempts(request.maxAttempts ?? limits.maxAttempts),
  };

  const primaryProviderId = allowedCandidates[0].candidate.providerId;
  let lastError: unknown;

  const limit = context.allowFallback ? allowedCandidates.length : 1;

  for (let i = 0; i < limit; i++) {
    const { candidate, requiresAudit } = allowedCandidates[i];
    const provider = providerRegistry.get(candidate.providerId);

    if (!provider) {
      // Adapter not yet registered for this provider (e.g. anthropic, gemini, local).
      rejectedCandidates.push({ providerId: candidate.providerId, reason: "provider_adapter_not_registered" });
      continue;
    }

    // B6: a metered call is priced and reserved before anything is sent. A refusal stops the
    // whole request (no fallback can be cheaper than "refused").
    const reservation = provider.metering === "unmetered" ? null : await reserveProviderCall(candidate.providerId, resolvedRequest, cost, limits);

    // Fail fast while this provider's circuit is open (repeated failures /
    // timeout spikes / exhausted quota) instead of burning another attempt.
    try {
      providerCircuitBreaker.assertCallAllowed(candidate.providerId);
    } catch (error) {
      if (reservation) await cost.ledger.settle({ reservationId: reservation.reservationId, outcome: "released", settledUsd: 0, reason: "circuit_open" });
      lastError = error;
      rejectedCandidates.push({ providerId: candidate.providerId, reason: "circuit_open" });
      continue;
    }

    const fallbackUsed = i > 0;
    if (fallbackUsed) {
      emitRoutingFallback(
        allowedCandidates[i - 1].candidate.providerId,
        candidate.providerId,
        lastError instanceof Error ? lastError.message : "unknown_error",
        { module: context.moduleId, routingMode: context.routingMode },
      );
    }

    try {
      const result = await provider.complete(resolvedRequest);
      if (reservation) await cost.ledger.settle({ reservationId: reservation.reservationId, ...settlementFor(reservation, candidate.providerId, { response: result }) });

      emitRoutingAudit({
        timestamp: new Date().toISOString(),
        selectedProvider: primaryProviderId,
        routingMode: context.routingMode,
        fallbackUsed,
        finalProvider: candidate.providerId,
        rejectedProviders: rejectedCandidates,
        module: context.moduleId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorType: context.actorType,
        dataSensitivity: context.dataSensitivity,
        requiresAudit,
      });

      return result;
    } catch (error) {
      if (reservation) await cost.ledger.settle({ reservationId: reservation.reservationId, ...settlementFor(reservation, candidate.providerId, { error }) });
      providerCircuitBreaker.recordFailure(candidate.providerId);
      lastError = error;
    }
  }

  throw lastError ?? new InferenceError("All approved providers failed.", "unknown", "none");
}

// Alias kept for inference-gateway.ts and any callers that reference this name.
export const runProviderInference = runInference;
