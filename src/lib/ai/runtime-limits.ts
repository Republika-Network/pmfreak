// Perilla 11 — centralized, env-configurable AI runtime limits.
//
// Every AI invocation must be bounded: a pilot workspace can never hang on an
// unbounded request, retry forever, fan out unbounded agent chains, or spend
// past a daily ceiling. Routes and providers previously hardcoded these
// values; this module is now the single source of truth, with conservative
// defaults and hard clamping so a typo in an env var can never disable a
// bound (an unparsable or out-of-range value falls back to the default).
//
// Enforcement lives in src/lib/ai/runtime-guardrails.ts and
// src/lib/ai/providers/router.ts; the three cost ceilings are enforced atomically by
// reserve_ai_cost() (20261103000000_b6_ai_cost_reservations.sql). Tests: tests/ai-runtime-guardrails.test.mjs.

export type AiRuntimeLimits = {
  /** Per-attempt provider timeout (AbortController) in milliseconds. */
  requestTimeoutMs: number;
  /** Total attempts per provider call: 1 initial + AI_MAX_RETRIES retries. */
  maxAttempts: number;
  /** Maximum agent-chain depth an inference request may declare. */
  maxChainDepth: number;
  /** Maximum in-flight inference calls per workspace (per instance). */
  maxConcurrentPerWorkspace: number;
  /** Daily per-workspace request ceiling (fixed 24h window). */
  dailyWorkspaceRequestLimit: number;
  /** Daily per-workspace cost ceiling in USD (reserved worst case + settled cost). */
  dailyWorkspaceCostLimitUsd: number;
  /** Daily per-user cost ceiling in USD, across every workspace the user belongs to. */
  dailyUserCostLimitUsd: number;
  /** Daily deployment-wide cost ceiling in USD: the hard bound on total AI spend per UTC day. */
  dailyGlobalCostLimitUsd: number;
};

type EnvRecord = Record<string, string | undefined>;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export const AI_RUNTIME_LIMIT_DEFAULTS: AiRuntimeLimits = {
  requestTimeoutMs: 25_000,
  maxAttempts: 3,
  maxChainDepth: 3,
  maxConcurrentPerWorkspace: 4,
  dailyWorkspaceRequestLimit: 500,
  dailyWorkspaceCostLimitUsd: 25,
  dailyUserCostLimitUsd: 10,
  dailyGlobalCostLimitUsd: 50,
};

export function resolveAiRuntimeLimits(env: EnvRecord = process.env): AiRuntimeLimits {
  const d = AI_RUNTIME_LIMIT_DEFAULTS;
  return {
    requestTimeoutMs: clampInt(env.AI_REQUEST_TIMEOUT_MS, d.requestTimeoutMs, 1_000, 120_000),
    // AI_MAX_RETRIES counts retries after the first attempt; internally we
    // track total attempts. 0 retries (single attempt) is a valid setting.
    maxAttempts: clampInt(env.AI_MAX_RETRIES, d.maxAttempts - 1, 0, 5) + 1,
    maxChainDepth: clampInt(env.AI_MAX_CHAIN_DEPTH, d.maxChainDepth, 1, 10),
    maxConcurrentPerWorkspace: clampInt(env.AI_MAX_CONCURRENT_PER_WORKSPACE, d.maxConcurrentPerWorkspace, 1, 100),
    dailyWorkspaceRequestLimit: clampInt(env.AI_DAILY_REQUEST_LIMIT, d.dailyWorkspaceRequestLimit, 1, 1_000_000),
    dailyWorkspaceCostLimitUsd: clampNumber(env.AI_DAILY_COST_LIMIT_USD, d.dailyWorkspaceCostLimitUsd, 0.01, 100_000),
    dailyUserCostLimitUsd: clampNumber(env.AI_DAILY_USER_COST_LIMIT_USD, d.dailyUserCostLimitUsd, 0.01, 100_000),
    dailyGlobalCostLimitUsd: clampNumber(env.AI_DAILY_GLOBAL_COST_LIMIT_USD, d.dailyGlobalCostLimitUsd, 0.01, 1_000_000),
  };
}
