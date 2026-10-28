// Perilla 11 — AI runtime guardrails: workspace concurrency, provider circuit
// breaker, and agent-chain depth. All in-memory and per-instance (the same
// posture as the in-memory abuse-protection fallback — see
// docs/security/abuse-protection-boundary.md); the durable cross-instance
// bounds are the daily request/cost ceilings enforced through the
// Supabase-backed abuse store and ai_usage_events accounting.
//
// Everything here fails CLOSED for exceeding a bound (the request is denied
// with a typed error) and fails FAST for a tripped breaker (no provider call
// is attempted while the circuit is open).

import { InferenceError } from "@/lib/ai/inference/types";

export type AiGuardrail =
  | "chain_depth"
  | "workspace_concurrency"
  | "circuit_open"
  | "daily_request_ceiling"
  | "daily_cost_ceiling"
  /** B6: the requested model has no allowlisted price, so its cost cannot be bounded. */
  | "model_not_priced"
  /** B6: the cost ledger could not reserve or was not configured; spend cannot be bounded. */
  | "cost_accounting_unavailable"
  /** B6: a billable request named neither a workspace nor a user to charge. */
  | "budget_scope_missing"
  /** B6: this request's reservation key is already in flight or settled. */
  | "duplicate_request";

export class AiGuardrailError extends InferenceError {
  constructor(
    message: string,
    public readonly guardrail: AiGuardrail,
    provider = "none",
  ) {
    super(message, "rate_limited", provider);
    this.name = "AiGuardrailError";
  }
}

// ── Agent chain depth ────────────────────────────────────────────────────────

export function assertChainDepthAllowed(chainDepth: number | undefined, maxChainDepth: number): void {
  const depth = chainDepth ?? 0;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new AiGuardrailError(`Invalid AI chain depth: ${String(chainDepth)}.`, "chain_depth");
  }
  if (depth >= maxChainDepth) {
    throw new AiGuardrailError(
      `AI chain depth ${depth} reached the configured maximum of ${maxChainDepth}; refusing to fan out further.`,
      "chain_depth",
    );
  }
}

// ── Per-workspace concurrency ────────────────────────────────────────────────

export type WorkspaceConcurrencyGate = {
  /** Throws AiGuardrailError when the workspace is at its concurrency bound. */
  acquire(workspaceId: string, maxConcurrent: number): () => void;
  inFlight(workspaceId: string): number;
};

export function createWorkspaceConcurrencyGate(): WorkspaceConcurrencyGate {
  const inFlightByWorkspace = new Map<string, number>();
  return {
    acquire(workspaceId, maxConcurrent) {
      const current = inFlightByWorkspace.get(workspaceId) ?? 0;
      if (current >= maxConcurrent) {
        throw new AiGuardrailError(
          `Workspace already has ${current} AI requests in flight (limit ${maxConcurrent}). Try again shortly.`,
          "workspace_concurrency",
        );
      }
      inFlightByWorkspace.set(workspaceId, current + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const now = inFlightByWorkspace.get(workspaceId) ?? 1;
        if (now <= 1) inFlightByWorkspace.delete(workspaceId);
        else inFlightByWorkspace.set(workspaceId, now - 1);
      };
    },
    inFlight(workspaceId) {
      return inFlightByWorkspace.get(workspaceId) ?? 0;
    },
  };
}

// ── Provider circuit breaker ─────────────────────────────────────────────────
//
// Consecutive-failure breaker: after `failureThreshold` consecutive provider
// failures the circuit opens for `cooldownMs`. While open, calls fail fast
// with AiGuardrailError("circuit_open") instead of hammering a provider that
// is down (or burning retry budget/cost on a quota-exhausted key). After the
// cooldown one probe call is allowed through (half-open); success closes the
// circuit, failure re-opens it for another cooldown.

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
};

export type ProviderCircuitBreaker = {
  assertCallAllowed(providerId: string): void;
  recordSuccess(providerId: string): void;
  recordFailure(providerId: string): void;
  state(providerId: string): "closed" | "open" | "half_open";
};

export function createProviderCircuitBreaker(options: CircuitBreakerOptions = {}): ProviderCircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const now = options.now ?? Date.now;

  type BreakerState = { consecutiveFailures: number; openedAt: number | null; probing: boolean };
  const states = new Map<string, BreakerState>();
  const getState = (id: string): BreakerState => {
    let state = states.get(id);
    if (!state) {
      state = { consecutiveFailures: 0, openedAt: null, probing: false };
      states.set(id, state);
    }
    return state;
  };

  return {
    assertCallAllowed(providerId) {
      const state = getState(providerId);
      if (state.openedAt === null) return;
      const elapsed = now() - state.openedAt;
      if (elapsed < cooldownMs) {
        throw new AiGuardrailError(
          `AI provider "${providerId}" circuit is open after ${state.consecutiveFailures} consecutive failures; retrying in ${Math.ceil((cooldownMs - elapsed) / 1000)}s.`,
          "circuit_open",
          providerId,
        );
      }
      if (state.probing) {
        throw new AiGuardrailError(`AI provider "${providerId}" circuit is half-open with a probe in flight.`, "circuit_open", providerId);
      }
      state.probing = true; // half-open: allow exactly one probe
    },
    recordSuccess(providerId) {
      states.set(providerId, { consecutiveFailures: 0, openedAt: null, probing: false });
    },
    recordFailure(providerId) {
      const state = getState(providerId);
      state.consecutiveFailures += 1;
      state.probing = false;
      if (state.consecutiveFailures >= failureThreshold || state.openedAt !== null) {
        state.openedAt = now();
      }
    },
    state(providerId) {
      const state = getState(providerId);
      if (state.openedAt === null) return "closed";
      return now() - state.openedAt >= cooldownMs ? "half_open" : "open";
    },
  };
}

// Shared per-instance singletons used by the inference router.
export const workspaceConcurrencyGate = createWorkspaceConcurrencyGate();
export const providerCircuitBreaker = createProviderCircuitBreaker();
