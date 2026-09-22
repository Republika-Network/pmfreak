import { NextRequest, NextResponse } from "next/server";
import { revokeProjectKnowledge, validateRationale } from "@/lib/project-knowledge/project-knowledge-service";
import { authorizeKnowledgeScope, evaluateKnowledgeGovernance } from "@/lib/project-knowledge/route-authorization";
import { KNOWLEDGE_GOVERNANCE_ACTIONS } from "@/lib/project-knowledge/types";
import { governanceRefusal, knowledgeErrorResponse } from "@/lib/project-knowledge/route-responses";

/**
 * P2-19 — revoke one Project knowledge record.
 *
 *   POST { workspaceId, projectId, knowledgeId, reason }
 *
 * authenticate → resolve the record canonically in the claimed Workspace/Project → evaluate
 * knowledge.revoke in the in-process governance runtime → on ALLOW only, one RPC that locks
 * the record and writes the terminal revocation + event. A retry is already_revoked (no second
 * event). The record leaves authoritative retrieval immediately; audit history keeps it.
 */
const ROUTE_ID = "/api/project-knowledge/revoke";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RevokeKnowledgeRouteDeps = {
  authorize: typeof authorizeKnowledgeScope;
  evaluateGovernance: typeof evaluateKnowledgeGovernance;
  revoke: typeof revokeProjectKnowledge;
  now: () => Date;
};

const defaultDeps: RevokeKnowledgeRouteDeps = {
  authorize: authorizeKnowledgeScope,
  evaluateGovernance: evaluateKnowledgeGovernance,
  revoke: revokeProjectKnowledge,
  now: () => new Date(),
};

export async function handlePostRevokeKnowledge(request: NextRequest, depsOverride: Partial<RevokeKnowledgeRouteDeps> = {}): Promise<NextResponse> {
  const deps: RevokeKnowledgeRouteDeps = { ...defaultDeps, ...depsOverride };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const knowledgeId = typeof body.knowledgeId === "string" ? body.knowledgeId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(knowledgeId)) {
    return NextResponse.json({ ok: false, error: "workspaceId, projectId and knowledgeId are required." }, { status: 400 });
  }
  try {
    validateRationale(reason);
  } catch (error) {
    return knowledgeErrorResponse(error, ROUTE_ID);
  }

  const auth = await deps.authorize(projectId, workspaceId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.status === 401 ? "Unauthenticated." : "Access denied." }, { status: auth.status });
  }
  const evaluatedAt = deps.now().toISOString();
  try {
    // The record must belong to the claimed Workspace and Project (RLS read, explicit scope).
    const { data: record, error } = await auth.client.from("canonical_project_knowledge_records")
      .select("id").eq("id", knowledgeId).eq("workspace_id", workspaceId).eq("project_id", projectId).maybeSingle();
    if (error) throw new Error(`project_knowledge_read_failed: ${error.message}`);
    if (!record) return NextResponse.json({ ok: false, error: "That record was not found in this project.", failureClass: "project_knowledge_not_found" }, { status: 404 });

    const outcome = await deps.evaluateGovernance({
      user: auth.user, action: KNOWLEDGE_GOVERNANCE_ACTIONS.revoke, routeId: ROUTE_ID, workspaceId, projectId,
      resourceType: "canonical_project_knowledge_record", resourceId: knowledgeId,
    });
    if (outcome.kind !== "allow") return governanceRefusal(outcome);

    const result = await deps.revoke(auth.client, { workspaceId, projectId }, { knowledgeId, reason }, outcome.reference, { evaluatedAt });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    return knowledgeErrorResponse(error, ROUTE_ID);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePostRevokeKnowledge(request);
}
