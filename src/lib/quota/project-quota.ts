import { resolveProjectLimit } from "@/lib/feature-gates";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import type { ProjectRow } from "@/lib/db/database-contract";

export type ProjectDuplicateQuotaResult =
  | { ok: true; projectId: string; projectCount: number; projectLimit: number | null }
  | { ok: false; reason: "project_limit_reached" | "insufficient_role" | "source_not_found" | "pmo_not_found" };

export type ProjectCreateQuotaResult =
  | { ok: true; project: ProjectRow; projectCount: number; projectLimit: number | null }
  | { ok: false; reason: "project_limit_reached" | "insufficient_role" | "pmo_not_found" };

type RpcQuotaResult = {
  ok: boolean;
  reason?: string;
  project_id?: string;
  project?: ProjectRow;
  project_count?: number;
  project_limit?: number | null;
};

const KNOWN_REFUSALS = new Set(["project_limit_reached", "insufficient_role", "source_not_found", "pmo_not_found"]);

/**
 * The actor's project limit and a service-role client tagged with the actor, shared by both
 * project-quota RPCs so creates and duplicates are measured against the same entitlement.
 * Returns null when the user cannot be resolved, which callers treat as project_limit_reached.
 */
async function projectQuotaContext(actorUserId: string, operation: string) {
  const entitlement = await resolveProjectLimit(actorUserId);
  if (!entitlement) return null;

  // PRIVILEGED_ACCESS: the project quota RPCs are EXECUTE-able by service_role only, so a
  // client can never pick its own project limit. Tagged with the authenticated actor.
  // AUDIT_REF: service-role-risk-register.md
  const supabase = createSupabaseServiceRoleClient({
    routeId: "lib.quota.project-quota",
    operation,
    reason: "project_limit_enforcement",
    actorUserId,
  });
  return { entitlement, supabase };
}

function knownRefusal(result: RpcQuotaResult, kind: "create" | "duplicate", actorUserId: string, entitlement: { plan: string; projectLimit: number | null }) {
  if (!result.reason || !KNOWN_REFUSALS.has(result.reason)) return null;
  if (result.reason === "project_limit_reached") {
    console.warn(`[project-quota] ${kind}_refused_at_limit`, { actorUserId, plan: entitlement.plan, limit: entitlement.projectLimit });
  }
  return result.reason;
}

/**
 * Duplicates a project inside the actor's project limit (PD-14), atomically.
 *
 * duplicate_project_within_limit() is EXECUTE-able by service_role only
 * (20261027000000_pd14_project_duplicate_quota.sql). In one transaction it re-checks that
 * the actor is an owner/admin/pm of the workspace and that the source and PMO belong to it,
 * serialises the actor's project-quota section with an advisory lock, counts, and inserts —
 * so concurrent duplicates cannot both pass the check, and a refused or failed duplicate
 * leaves no row (and therefore consumes no quota).
 *
 * The limit is derived here from the actor's own subscription (resolveProjectLimit, the
 * same source as canCreateMoreProjects), never supplied by the caller. actorUserId must be
 * the authenticated user; callers authorize the project first (requireProjectAccess write).
 */
export async function duplicateProjectWithinLimit(params: {
  actorUserId: string;
  workspaceId: string;
  sourceProjectId: string;
  targetPmoId: string | null;
}): Promise<ProjectDuplicateQuotaResult> {
  const { actorUserId, workspaceId, sourceProjectId, targetPmoId } = params;
  const context = await projectQuotaContext(actorUserId, "duplicate_project_within_limit");
  if (!context) return { ok: false, reason: "project_limit_reached" };
  const { entitlement, supabase } = context;

  const { data, error } = await supabase.rpc("duplicate_project_within_limit", {
    p_actor_user_id: actorUserId,
    p_workspace_id: workspaceId,
    p_source_project_id: sourceProjectId,
    p_target_pmo_id: targetPmoId,
    p_project_limit: entitlement.projectLimit,
  });
  if (error) throw new Error(`Project duplicate failed: ${error.message}`);

  const result = data as RpcQuotaResult;
  if (result.ok && result.project_id) {
    return { ok: true, projectId: result.project_id, projectCount: result.project_count ?? 0, projectLimit: result.project_limit ?? null };
  }
  const reason = knownRefusal(result, "duplicate", actorUserId, entitlement);
  if (reason) return { ok: false, reason: reason as Exclude<ProjectDuplicateQuotaResult, { ok: true }>["reason"] };
  throw new Error(`Project duplicate failed: unexpected result ${result.reason ?? "unknown"}`);
}

/**
 * Creates a project inside the actor's project limit (Q12), atomically.
 *
 * Every create path calls this: createMinimalProject (POST /api/projects and the /projects
 * inline form), saveProjectOnboarding (the setup wizard) and the Command Center quick-create.
 * create_project_within_limit() (20261028000000_q12_project_create_quota.sql) is the create
 * twin of duplicate_project_within_limit and takes the same per-actor advisory lock, so
 * concurrent creates and duplicates by one user are serialised against each other. It
 * re-checks the actor's owner/admin/pm membership and the PMO's workspace (it bypasses RLS),
 * counts and inserts in one transaction; a refused or failed create leaves no row.
 *
 * Callers resolve and authorize the workspace and PMO first; the function re-verifies both.
 * The limit is derived here, never supplied by the caller. Throws on an RPC error so each
 * caller keeps its own persistence-failure reply.
 */
export async function createProjectWithinLimit(params: {
  actorUserId: string;
  workspaceId: string;
  pmoId: string | null;
  name: string;
  description: string | null;
  onboardingPayload: Record<string, unknown> | null;
}): Promise<ProjectCreateQuotaResult> {
  const { actorUserId, workspaceId, pmoId, name, description, onboardingPayload } = params;
  const context = await projectQuotaContext(actorUserId, "create_project_within_limit");
  if (!context) return { ok: false, reason: "project_limit_reached" };
  const { entitlement, supabase } = context;

  const { data, error } = await supabase.rpc("create_project_within_limit", {
    p_actor_user_id: actorUserId,
    p_workspace_id: workspaceId,
    p_pmo_id: pmoId,
    p_name: name,
    p_description: description,
    p_onboarding_payload: onboardingPayload,
    p_project_limit: entitlement.projectLimit,
  });
  if (error) throw new Error(`Project create failed: ${error.message}`);

  const result = data as RpcQuotaResult;
  if (result.ok && result.project) {
    return { ok: true, project: result.project, projectCount: result.project_count ?? 0, projectLimit: result.project_limit ?? null };
  }
  const reason = knownRefusal(result, "create", actorUserId, entitlement);
  if (reason && reason !== "source_not_found") return { ok: false, reason: reason as Exclude<ProjectCreateQuotaResult, { ok: true }>["reason"] };
  throw new Error(`Project create failed: unexpected result ${result.reason ?? "unknown"}`);
}
