import { getCompanySubscription, type SubscriptionPlan } from "@/lib/billing";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

/**
 * Centralized capability model.
 *
 * Server must remain the source of truth: clients can hide UI affordances,
 * but only the API can enforce access boundaries and tenancy safety.
 * UI-only checks are not security controls because requests can be forged.
 *
 * Design notes:
 * - Unknown plans are safely coerced to `free` to avoid accidental privilege grants.
 * - Capability map is exhaustive per plan to prevent impossible states.
 * - Future enterprise expansions can add new plans/capabilities in one place.
 */
export const PLANS = ["free", "pro", "pmo"] as const;
export type Plan = (typeof PLANS)[number];

export const CAPABILITY_KEYS = [
  "ai_analysis",
  "advanced_ai_actions",
  "exports",
  "file_upload_limit",
  "pmo_workspaces",
  "pmo_team_members",
  "organizational_memory",
  "advanced_reporting",
  "copilot_memory",
  "governance_directives",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

type PlanCapabilities = {
  ai_analysis: boolean;
  advanced_ai_actions: boolean;
  exports: boolean;
  file_upload_limit: number | null;
  pmo_workspaces: boolean;
  pmo_team_members: boolean;
  organizational_memory: boolean;
  advanced_reporting: boolean;
  copilot_memory: boolean;
  governance_directives: boolean;
  seat_limit: number;
};

const FREE_CAPABILITIES: PlanCapabilities = {
  ai_analysis: false,
  advanced_ai_actions: false,
  exports: false,
  file_upload_limit: 5,
  pmo_workspaces: false,
  pmo_team_members: false,
  organizational_memory: false,
  advanced_reporting: false,
  copilot_memory: false,
  governance_directives: false,
  seat_limit: 1,
};

const PLAN_CAPABILITIES: Record<Plan, PlanCapabilities> = {
  free: FREE_CAPABILITIES,
  pro: {
    ...FREE_CAPABILITIES,
    ai_analysis: true,
    advanced_ai_actions: true,
    exports: true,
    advanced_reporting: true,
    seat_limit: 1,
  },
  pmo: {
    ...FREE_CAPABILITIES,
    ai_analysis: true,
    advanced_ai_actions: true,
    exports: true,
    file_upload_limit: null,
    pmo_workspaces: true,
    pmo_team_members: true,
    organizational_memory: true,
    advanced_reporting: true,
    copilot_memory: true,
    governance_directives: true,
    seat_limit: 10,
  },
};

const toPlan = (plan: SubscriptionPlan | string): Plan => (PLANS.includes(plan as Plan) ? (plan as Plan) : "free");

const logGateEvent = (event: string, details: Record<string, unknown>) => {
  console.warn(`[feature-gates] ${event}`, { timestamp: new Date().toISOString(), ...details });
};

export const getPlanCapabilities = (plan: SubscriptionPlan | string): Readonly<PlanCapabilities> => {
  const normalizedPlan = toPlan(plan);
  if (normalizedPlan !== plan) {
    logGateEvent("invalid_plan_access", { plan, normalizedPlan });
  }
  return PLAN_CAPABILITIES[normalizedPlan];
};

export const canAccessFeature = (plan: SubscriptionPlan | string, feature: CapabilityKey): boolean => {
  const capabilities = getPlanCapabilities(plan);
  const value = capabilities[feature];
  return typeof value === "boolean" ? value : value !== null;
};

export const getUploadLimit = (plan: SubscriptionPlan | string): number | null => getPlanCapabilities(plan).file_upload_limit;

export const getSeatLimit = (plan: SubscriptionPlan | string): number => getPlanCapabilities(plan).seat_limit;

export const requireFeatureAccess = async (
  companyId: string,
  feature: CapabilityKey,
): Promise<{ ok: true; plan: Plan } | { ok: false; status: 402; code: "upgrade_required"; requiredPlan: Plan }> => {
  const subscription = await getCompanySubscription(companyId);
  const plan = toPlan(subscription.plan);

  if (canAccessFeature(plan, feature)) {
    return { ok: true, plan };
  }

  logGateEvent("denied_feature_attempt", { companyId, plan, feature });
  return { ok: false, status: 402, code: "upgrade_required", requiredPlan: feature.startsWith("pmo_") ? "pmo" : "pro" };
};

export const requirePMOAccess = async (companyId: string) => {
  const result = await requireFeatureAccess(companyId, "pmo_workspaces");
  return result.ok ? result : { ...result, requiredPlan: "pmo" as const };
};

export const requireSeatAvailability = async (
  companyId: string,
  currentSeatCount: number,
): Promise<{ ok: true; seatLimit: number } | { ok: false; status: 402; code: "seat_limit_exceeded"; seatLimit: number }> => {
  const subscription = await getCompanySubscription(companyId);
  const seatLimit = getSeatLimit(subscription.plan);
  if (currentSeatCount < seatLimit) {
    return { ok: true, seatLimit };
  }

  logGateEvent("exceeded_seat_limit", { companyId, currentSeatCount, seatLimit, plan: subscription.plan });
  return { ok: false, status: 402, code: "seat_limit_exceeded", seatLimit };
};

// PRIVILEGED_ACCESS: supabase.auth.admin.getUserById() is only available via service role — there is no scoped-client equivalent for reading another user's auth metadata.
// AUDIT_REF: service-role-risk-register.md
const getCompanyIdByUserId = async (userId: string) => {
  const supabase = createSupabaseServiceRoleClient({ routeId: "feature-gates.getCompanyIdByUserId", operation: "lookup_user_company", reason: "feature_gate_precheck", systemActor: "system" });
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const metadata = data.user.user_metadata ?? {};
  return typeof metadata.company_id === "string" ? metadata.company_id : data.user.id;
};

const upgradeRequired = (feature: string, requiredPlan: "pro" | "pmo") => ({ ok: false as const, error: "upgrade_required" as const, feature, requiredPlan });


const PROJECT_LIMITS: Record<Plan, number> = { free: 3, pro: 25, pmo: Number.MAX_SAFE_INTEGER };

export async function canCreateMoreProjects(userId: string) {
  const companyId = await getCompanyIdByUserId(userId);
  if (!companyId) return upgradeRequired("personal_projects", "pro");

  const supabase = createSupabaseServiceRoleClient({ routeId: "feature-gates.canCreateMoreProjects", operation: "count_projects", reason: "feature_limit_enforcement", actorUserId: userId });
  // Reuse the contextualized privileged client above: billing.ts rejects useServiceRole without privilegedContext.
  const subscription = await getCompanySubscription(companyId, { client: supabase });
  const { count, error } = await supabase.from("projects").select("id", { head: true, count: "exact" }).eq("user_id", userId);
  if (error) throw new Error(`Unable to verify project limit: ${error.message}`);

  const limit = PROJECT_LIMITS[toPlan(subscription.plan)];
  return (count ?? 0) < limit
    ? { ok: true as const, plan: toPlan(subscription.plan), projectLimit: limit }
    : upgradeRequired("personal_projects", "pro");
}

export async function canUseAdvancedAi(userId: string) {
  const companyId = await getCompanyIdByUserId(userId);
  if (!companyId) return upgradeRequired("advanced_ai", "pro");
  const gate = await requireFeatureAccess(companyId, "advanced_ai_actions");
  return gate.ok ? { ok: true as const, plan: gate.plan } : upgradeRequired("advanced_ai", gate.requiredPlan === "free" ? "pro" : gate.requiredPlan);
}

export async function canCreatePmoWorkspace(userId: string) {
  const companyId = await getCompanyIdByUserId(userId);
  if (!companyId) return upgradeRequired("pmo_workspace", "pmo");
  const gate = await requirePMOAccess(companyId);
  return gate.ok ? { ok: true as const, plan: gate.plan } : upgradeRequired("pmo_workspace", "pmo");
}

export async function canInviteTeamMembers(userId: string) {
  const companyId = await getCompanyIdByUserId(userId);
  if (!companyId) return upgradeRequired("team_invites", "pmo");
  const gate = await requireFeatureAccess(companyId, "pmo_team_members");
  return gate.ok ? { ok: true as const, plan: gate.plan } : upgradeRequired("team_invites", "pmo");
}
