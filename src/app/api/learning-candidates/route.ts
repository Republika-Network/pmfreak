import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger, safeErrorMessage } from "@/lib/observability/logger";
import { listLearningCandidates, proposeLearningCandidate } from "@/lib/learning-candidates/learning-candidate-service";

/**
 * P2-18 — Learning Candidates for one project.
 *
 *   GET  ?workspaceId=&projectId=           project-scoped candidates and their sources
 *   POST { workspaceId, projectId, outcomeId, observationId? }
 *                                           evaluate one canonical outcome lineage and, if
 *                                           eligible, link it as candidate evidence
 *
 * A candidate is never ratified, elevated or made organizational truth here; there is no
 * review, validation, rejection, elevation-request or revocation operation (P2-19).
 */
const ROUTE_ID = "/api/learning-candidates";
// The same authority as can_write_operational_project, which gates the RPC itself.
const WRITE_ROLES = new Set(["owner", "admin", "pm"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LearningCandidateAuthorization =
  | { ok: true; userId: string; role: string; client: SupabaseClient }
  | { ok: false; status: 401 | 403 };

export type LearningCandidateRouteDeps = {
  authorize: (projectId: string, workspaceId: string, permission: "read" | "write") => Promise<LearningCandidateAuthorization>;
  propose: typeof proposeLearningCandidate;
  list: typeof listLearningCandidates;
  now: () => Date;
};

/**
 * Server-side scope resolution, as in the P2-16 schedule-exposure route: identity from the
 * session, project access from the canonical capability check, and the workspace↔project
 * relationship and role read back through the caller's RLS client. A caller-supplied
 * workspaceId is only CHECKED against that relationship, never trusted.
 */
async function authorizeLearningCandidates(projectId: string, workspaceId: string, permission: "read" | "write"): Promise<LearningCandidateAuthorization> {
  let userId: string;
  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
  } catch {
    return { ok: false, status: 401 };
  }
  try {
    await requireProjectAccess(projectId, permission);
  } catch {
    return { ok: false, status: 403 };
  }
  const client = await createSupabaseServerClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    client.from("projects").select("id").eq("id", projectId).eq("workspace_id", workspaceId).maybeSingle(),
    client.from("workspace_memberships").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
  ]);
  if (!project || !membership?.role) return { ok: false, status: 403 };
  const role = String(membership.role);
  if (permission === "write" && !WRITE_ROLES.has(role)) return { ok: false, status: 403 };
  return { ok: true, userId, role, client };
}

const defaultDeps: LearningCandidateRouteDeps = {
  authorize: authorizeLearningCandidates,
  propose: proposeLearningCandidate,
  list: listLearningCandidates,
  now: () => new Date(),
};

function denied(status: 401 | 403) {
  return NextResponse.json({ ok: false, error: status === 401 ? "Unauthenticated." : "Access denied." }, { status });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Handled refusals name their stable snake_case code (never a raw provider message). The
  // service wraps database errors as "learning_candidate_rpc_failed: <code>", so the most
  // specific code is the last one.
  const failureClass = message.match(/\blearning_candidate_[a-z_]+/g)?.at(-1) ?? null;
  if (/unauthenticated/.test(message)) return denied(401);
  if (/role_denied|write_denied/.test(message)) return denied(403);
  if (/outcome_not_found|observation_not_found/.test(message)) {
    return NextResponse.json({ ok: false, error: "That outcome lineage was not found in this project.", failureClass }, { status: 404 });
  }
  if (/payload_invalid/.test(message)) {
    return NextResponse.json({ ok: false, error: "The learning candidate request is not valid for this project.", failureClass }, { status: 400 });
  }
  if (/read_truncated/.test(message)) {
    return NextResponse.json({ ok: false, error: "Too many records to read completely; nothing partial is returned.", failureClass }, { status: 503 });
  }
  logger.error("route_internal_error", { route: ROUTE_ID, error_detail: safeErrorMessage(error) });
  return NextResponse.json({ ok: false, error: "The learning candidate could not be evaluated. Please retry." }, { status: 500 });
}

export async function handleGetLearningCandidates(request: NextRequest, depsOverride: Partial<LearningCandidateRouteDeps> = {}): Promise<NextResponse> {
  const deps: LearningCandidateRouteDeps = { ...defaultDeps, ...depsOverride };
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(workspaceId)) {
    return NextResponse.json({ ok: false, error: "workspaceId and projectId are required." }, { status: 400 });
  }
  const auth = await deps.authorize(projectId, workspaceId, "read");
  if (!auth.ok) return denied(auth.status);
  try {
    const list = await deps.list(auth.client, { workspaceId, projectId }, { evaluatedAt: deps.now().toISOString() });
    return NextResponse.json({ ok: true, ...list, canPropose: WRITE_ROLES.has(auth.role) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePostLearningCandidate(request: NextRequest, depsOverride: Partial<LearningCandidateRouteDeps> = {}): Promise<NextResponse> {
  const deps: LearningCandidateRouteDeps = { ...defaultDeps, ...depsOverride };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  // Valid JSON is not necessarily an object (null, arrays, scalars): refuse before reading fields.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const outcomeId = typeof body.outcomeId === "string" ? body.outcomeId.trim() : "";
  const observationId = typeof body.observationId === "string" && body.observationId.trim() ? body.observationId.trim() : null;
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(outcomeId) || (observationId !== null && !UUID_PATTERN.test(observationId))) {
    return NextResponse.json({ ok: false, error: "workspaceId, projectId and outcomeId are required." }, { status: 400 });
  }
  const auth = await deps.authorize(projectId, workspaceId, "write");
  if (!auth.ok) return denied(auth.status);
  try {
    // The evaluation clock is the database's (inside the RPC), never the caller's.
    const result = await deps.propose(auth.client, { workspaceId, projectId, userId: auth.userId, role: auth.role }, { outcomeId, observationId });
    if (result.disposition === "ineligible") {
      return NextResponse.json({ ok: false, disposition: "ineligible", reasons: result.reasons, elevationInferred: false }, { status: 422 });
    }
    return NextResponse.json({ ok: true, ...result }, { status: result.disposition === "created" ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleGetLearningCandidates(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePostLearningCandidate(request);
}
