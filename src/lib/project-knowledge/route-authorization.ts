/**
 * P2-19 — server-side scope resolution and governance evaluation for the knowledge routes.
 *
 * Scope: identity from the session, project read access from the canonical capability check,
 * and the workspace↔project relationship and membership read back through the caller's RLS
 * client (as the P2-16/P2-18 routes do). A caller-supplied workspaceId is only CHECKED
 * against that relationship, never trusted.
 *
 * Governance: the PMFreak in-process runtime evaluates knowledge.ratify / knowledge.reject /
 * knowledge.revoke (manage_workspace; users only) for the Workspace, with the concrete
 * Candidate/Knowledge record as the resource. Any non-ALLOW result — deny, approval routing,
 * runtime failure — fails closed (see classifyKnowledgeGovernanceDecision).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeRuntimeAction, buildEnterpriseRuntimeRequest } from "@/aoc/runtime-consumer";
import type { AuthUserContext } from "@/lib/auth";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { classifyKnowledgeGovernanceDecision, type KnowledgeGovernanceOutcome } from "./views";
import type { KnowledgeGovernanceAction } from "./types";

export type KnowledgeRouteAuthorization =
  | { ok: true; user: AuthUserContext; role: string; client: SupabaseClient }
  | { ok: false; status: 401 | 403 };

export async function authorizeKnowledgeScope(projectId: string, workspaceId: string): Promise<KnowledgeRouteAuthorization> {
  let user: AuthUserContext;
  try {
    ({ user } = await requireAuthenticatedUser());
  } catch {
    return { ok: false, status: 401 };
  }
  try {
    await requireProjectAccess(projectId, "read");
  } catch {
    return { ok: false, status: 403 };
  }
  const client = await createSupabaseServerClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    client.from("projects").select("id").eq("id", projectId).eq("workspace_id", workspaceId).maybeSingle(),
    client.from("workspace_memberships").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!project || !membership?.role) return { ok: false, status: 403 };
  return { ok: true, user, role: String(membership.role), client };
}

export async function evaluateKnowledgeGovernance(input: {
  user: AuthUserContext;
  action: KnowledgeGovernanceAction;
  routeId: string;
  workspaceId: string;
  projectId: string;
  resourceType: "canonical_learning_candidate" | "canonical_project_knowledge_record";
  resourceId: string;
}): Promise<KnowledgeGovernanceOutcome> {
  try {
    const decision = await authorizeRuntimeAction(
      buildEnterpriseRuntimeRequest({
        user: input.user,
        action: input.action,
        routeId: input.routeId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      }),
    );
    return classifyKnowledgeGovernanceDecision(input.action, decision as Parameters<typeof classifyKnowledgeGovernanceDecision>[1]);
  } catch {
    // Fail closed: an unavailable authority never authorises a knowledge transition.
    return { kind: "unavailable", decisionId: null };
  }
}

/**
 * Display hint only (which controls to render). It mirrors the roles that hold
 * manage_workspace; the governance runtime and the database remain authoritative.
 */
export const KNOWLEDGE_GOVERN_DISPLAY_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
