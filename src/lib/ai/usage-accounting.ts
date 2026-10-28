// Perilla 11 — AI cost/usage accounting.
//
// Every inference call routed through src/lib/ai/providers/router.ts records
// one row in public.ai_usage_events (provider, model, workspace, user,
// operation, tokens, estimated cost, status, duration). Recording is
// best-effort and never throws into the caller: losing an accounting row must
// not fail a user request. Without Supabase service-role env (local dev,
// tests) the recorder is a no-op.
//
// B6 — ai_usage_events is a REPORT, not the ceiling. The daily cost ceilings are
// enforced by the reservation ledger below (public.ai_cost_reservations,
// 20261103000000_b6_ai_cost_reservations.sql): the router reserves the worst-case
// cost of a provider call before sending it and settles the reservation after.
// The ledger FAILS CLOSED: without service-role env, or when a reservation cannot
// be written, the router refuses the call instead of sending it unaccounted.

import { hasSupabaseServiceRoleEnv } from "@/lib/supabase/env";
import { createPrivilegedSupabaseClient } from "@/lib/security/privileged-access";
import { costOfUsageUsd, resolveModelPrice } from "@/lib/ai/model-pricing";

export type AiUsageRecord = {
  provider: string;
  model: string;
  workspaceId?: string;
  userId?: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USD; null when the provider returned no usage or the model is unpriced. */
  estimatedCostUsd: number | null;
  status: "success" | "error" | "timeout" | "blocked";
  durationMs?: number;
};

/**
 * Cost of reported usage at the allowlisted price (src/lib/ai/model-pricing.ts). Null —
 * never 0 — when the model or snapshot is unpriced or a token count is missing.
 */
export function estimateCostUsd(model: string, inputTokens?: number, outputTokens?: number, provider = "openai"): number | null {
  const resolution = resolveModelPrice(provider, model);
  if (!resolution.ok) return null;
  return costOfUsageUsd(resolution.price, inputTokens, outputTokens);
}

type UsageClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
};

function getDefaultClient(): UsageClient | null {
  if (!hasSupabaseServiceRoleEnv) return null;
  return createPrivilegedSupabaseClient({
    routeId: "lib.ai.usage-accounting",
    operation: "record_ai_usage",
    reason: "ai_cost_accounting",
    systemActor: "system",
  }) as unknown as UsageClient;
}

export async function recordAiUsage(record: AiUsageRecord, getClient: () => UsageClient | null = getDefaultClient): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;
    const { error } = await client.from("ai_usage_events").insert({
      provider: record.provider,
      model: record.model,
      workspace_id: record.workspaceId ?? null,
      user_id: record.userId ?? null,
      operation: record.operation,
      input_tokens: record.inputTokens ?? null,
      output_tokens: record.outputTokens ?? null,
      estimated_cost_usd: record.estimatedCostUsd,
      status: record.status,
      duration_ms: record.durationMs ?? null,
    });
    if (error) {
      console.warn("[ai-usage] record_failed", { operation: record.operation, error: error.message });
    }
  } catch (error) {
    console.warn("[ai-usage] record_failed", { operation: record.operation, error: error instanceof Error ? error.message : "unknown" });
  }
}

// ── B6 cost reservation ledger ───────────────────────────────────────────────

export type AiCostScope = { workspaceId: string | null; userId: string | null };

export type AiCostReserveInput = AiCostScope & {
  reservationKey: string;
  operation: string;
  provider: string;
  model: string;
  priceVersion: string;
  amountUsd: number;
  limits: { workspaceUsd: number; userUsd: number; globalUsd: number };
};

export type AiCostReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "daily_cost_ceiling"; scope: "global" | "workspace" | "user"; spentUsd: number; limitUsd: number }
  | { ok: false; reason: "duplicate_request" }
  | { ok: false; reason: "unavailable"; detail: string };

export type AiCostSettleInput = {
  reservationId: string;
  outcome: "settled" | "released";
  settledUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  responseModel?: string;
  reason: AiCostSettleReason;
};

export type AiCostSettleReason =
  | "success"
  | "success_usage_unknown"
  | "success_model_unrecognized"
  | "provider_not_contacted"
  | "provider_refused"
  | "provider_failed"
  | "outcome_unknown"
  | "circuit_open";

export type AiCostLedger = {
  reserve(input: AiCostReserveInput): Promise<AiCostReserveResult>;
  /** Never throws. A failed settle leaves the reservation counting at its full amount. */
  settle(input: AiCostSettleInput): Promise<{ ok: boolean }>;
};

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function getDefaultRpcClient(): RpcClient | null {
  if (!hasSupabaseServiceRoleEnv) return null;
  return createPrivilegedSupabaseClient({
    routeId: "lib.ai.usage-accounting",
    operation: "reserve_ai_cost",
    reason: "ai_cost_ceiling",
    systemActor: "system",
  }) as unknown as RpcClient;
}

const nonNegativeIntOrNull = (value: number | undefined) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export function createSupabaseAiCostLedger(getClient: () => RpcClient | null = getDefaultRpcClient): AiCostLedger {
  return {
    async reserve(input) {
      let client: RpcClient | null;
      try {
        client = getClient();
      } catch (error) {
        return { ok: false, reason: "unavailable", detail: error instanceof Error ? error.message : "client_error" };
      }
      if (!client) return { ok: false, reason: "unavailable", detail: "service_role_not_configured" };
      try {
        const { data, error } = await client.rpc("reserve_ai_cost", {
          p_reservation_key: input.reservationKey,
          p_workspace_id: input.workspaceId,
          p_user_id: input.userId,
          p_operation: input.operation,
          p_provider: input.provider,
          p_model: input.model,
          p_price_version: input.priceVersion,
          p_amount_usd: input.amountUsd,
          p_workspace_limit_usd: input.limits.workspaceUsd,
          p_user_limit_usd: input.limits.userUsd,
          p_global_limit_usd: input.limits.globalUsd,
        });
        if (error) return { ok: false, reason: "unavailable", detail: error.message };
        const result = data as { ok?: boolean; reservation_id?: string; reason?: string; scope?: string; spent_usd?: number | string; limit_usd?: number | string } | null;
        if (result?.ok === true && typeof result.reservation_id === "string") return { ok: true, reservationId: result.reservation_id };
        if (result?.reason === "daily_cost_ceiling" && (result.scope === "global" || result.scope === "workspace" || result.scope === "user")) {
          return { ok: false, reason: "daily_cost_ceiling", scope: result.scope, spentUsd: Number(result.spent_usd), limitUsd: Number(result.limit_usd) };
        }
        if (result?.reason === "duplicate_request") return { ok: false, reason: "duplicate_request" };
        return { ok: false, reason: "unavailable", detail: "unexpected_reserve_result" };
      } catch (error) {
        return { ok: false, reason: "unavailable", detail: error instanceof Error ? error.message : "rpc_error" };
      }
    },
    async settle(input) {
      try {
        const client = getClient();
        if (!client) return { ok: false };
        const { data, error } = await client.rpc("settle_ai_cost", {
          p_reservation_id: input.reservationId,
          p_outcome: input.outcome,
          p_settled_usd: input.outcome === "released" ? 0 : input.settledUsd,
          p_input_tokens: nonNegativeIntOrNull(input.inputTokens),
          p_output_tokens: nonNegativeIntOrNull(input.outputTokens),
          p_response_model: input.responseModel ?? null,
          p_settle_reason: input.reason,
        });
        const ok = !error && (data as { ok?: boolean } | null)?.ok === true;
        if (!ok) {
          // The reservation stays 'reserved' and keeps counting at its full amount.
          console.warn("[ai-cost] settle_failed", { reservationId: input.reservationId, outcome: input.outcome, error: error?.message ?? (data as { reason?: string } | null)?.reason ?? "unknown" });
        }
        return { ok };
      } catch (error) {
        console.warn("[ai-cost] settle_failed", { reservationId: input.reservationId, outcome: input.outcome, error: error instanceof Error ? error.message : "unknown" });
        return { ok: false };
      }
    },
  };
}
