import { NextRequest, NextResponse } from "next/server";
import { listProjectKnowledgeHistory, retrieveProjectKnowledge } from "@/lib/project-knowledge/project-knowledge-service";
import { authorizeKnowledgeScope, KNOWLEDGE_GOVERN_DISPLAY_ROLES } from "@/lib/project-knowledge/route-authorization";
import { knowledgeErrorResponse } from "@/lib/project-knowledge/route-responses";

/**
 * P2-19 — Project knowledge for one project.
 *
 *   GET ?workspaceId=&projectId=
 *     knowledge  AUTHORITATIVE: active, source-project, unexpired, non-fixture knowledge only
 *                (retrieve_project_knowledge). Candidates, rejected reviews and revoked or
 *                expired records are never in this list.
 *     history    every review and every knowledge record (revoked/expired included), for the
 *                review and audit views. Never a knowledge source.
 *     canGovern  display hint only; the governance runtime and database decide.
 */
const ROUTE_ID = "/api/project-knowledge";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProjectKnowledgeRouteDeps = {
  authorize: typeof authorizeKnowledgeScope;
  retrieve: typeof retrieveProjectKnowledge;
  history: typeof listProjectKnowledgeHistory;
  now: () => Date;
};

const defaultDeps: ProjectKnowledgeRouteDeps = {
  authorize: authorizeKnowledgeScope,
  retrieve: retrieveProjectKnowledge,
  history: listProjectKnowledgeHistory,
  now: () => new Date(),
};

export async function handleGetProjectKnowledge(request: NextRequest, depsOverride: Partial<ProjectKnowledgeRouteDeps> = {}): Promise<NextResponse> {
  const deps: ProjectKnowledgeRouteDeps = { ...defaultDeps, ...depsOverride };
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(workspaceId)) {
    return NextResponse.json({ ok: false, error: "workspaceId and projectId are required." }, { status: 400 });
  }
  const auth = await deps.authorize(projectId, workspaceId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.status === 401 ? "Unauthenticated." : "Access denied." }, { status: auth.status });
  }
  const evaluatedAt = deps.now().toISOString();
  try {
    const scope = { workspaceId, projectId };
    const [knowledge, history] = await Promise.all([
      deps.retrieve(auth.client, scope, { evaluatedAt }),
      deps.history(auth.client, scope, { evaluatedAt }),
    ]);
    return NextResponse.json({
      ok: true,
      evaluatedAt,
      knowledge,
      history: { records: history.records, reviews: history.reviews },
      canGovern: KNOWLEDGE_GOVERN_DISPLAY_ROLES.has(auth.role),
    });
  } catch (error) {
    return knowledgeErrorResponse(error, ROUTE_ID);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleGetProjectKnowledge(request);
}
