// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — may THIS turn call the model? (PB-CHAT-01)
//
// Generative Project Brain is billable inference, so it sits behind the same
// commercial AI entitlement as every other generative route (`canUseAdvancedAi`
// → `advanced_ai_actions`) — with ONE explicit, documented exception:
//
//   PMFREAK_OPERATING_PROFILE === "closed-free-beta"
//     Project Brain generative conversation is part of the certified closed free
//     beta. Every authorized project reader in that profile may use it, although
//     the ordinary commercial Free plan does not grant Advanced AI. This is a beta
//     entitlement for Project Brain only: no plan capability changes, and no other
//     AI route is affected.
//
//   any other profile
//     the canonical commercial entitlement decides.
//
// This runs on the server AFTER authentication, project read access and the
// `project_brain.converse` governance check — it narrows, never widens. An
// un-entitled turn is still answered, in deterministic limited mode, without
// calling the provider. Rate, request, cost and concurrency limits apply to every
// entitled turn unchanged (the route's per-user limit and `runInference`).
// ─────────────────────────────────────────────────────────────────────────────

import { canUseAdvancedAi } from "@/lib/feature-gates";
import { CLOSED_FREE_BETA_PROFILE } from "@/lib/security/environment";

export type ProjectBrainGenerativeAccess =
  | { entitled: true; basis: "closed_free_beta" | "commercial_plan" }
  | { entitled: false; reason: "plan_not_entitled" };

export async function resolveProjectBrainGenerativeAccess(
  input: { userId: string },
  deps: {
    env?: Record<string, string | undefined>;
    checkCommercialEntitlement?: (userId: string) => Promise<{ ok: boolean }>;
  } = {},
): Promise<ProjectBrainGenerativeAccess> {
  const env = deps.env ?? process.env;
  if (env.PMFREAK_OPERATING_PROFILE === CLOSED_FREE_BETA_PROFILE) {
    return { entitled: true, basis: "closed_free_beta" };
  }
  const check = deps.checkCommercialEntitlement ?? canUseAdvancedAi;
  const decision = await check(input.userId);
  return decision.ok ? { entitled: true, basis: "commercial_plan" } : { entitled: false, reason: "plan_not_entitled" };
}
