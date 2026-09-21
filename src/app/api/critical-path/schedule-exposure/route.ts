import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger, safeErrorMessage } from "@/lib/observability/logger";
import {
  evaluateAndRecordScheduleExposure,
  listScheduleExposures,
  listScheduleTriggerCandidates,
  resumeScheduleExposureMaterialization,
  type ScheduleTriggerRef,
} from "@/lib/critical-path/schedule-exposure-service";
import { createScheduleExposureTrustedWriter } from "@/lib/critical-path/schedule-exposure-trusted-writer";

const ROUTE_ID = "/api/critical-path/schedule-exposure";
const WRITE_ROLES = new Set(["owner", "admin", "pm"]);
const TRIGGER_KINDS = new Set(["dependency_change", "milestone_state_evaluation"]);

export type ScheduleExposureAuthorization =
  | { ok: true; userId: string; role: string; client: SupabaseClient }
  | { ok: false; status: 401 | 403 };

export type ScheduleExposureRouteDeps = {
  authorize: (projectId: string, workspaceId: string, permission: "read" | "write") => Promise<ScheduleExposureAuthorization>;
  createTrustedWriter: typeof createScheduleExposureTrustedWriter;
  evaluateAndRecord: typeof evaluateAndRecordScheduleExposure;
  resumeMaterialization: typeof resumeScheduleExposureMaterialization;
  listExposures: typeof listScheduleExposures;
  listCandidates: typeof listScheduleTriggerCandidates;
};

/**
 * Server-side scope resolution. Identity comes from the session; project access from the
 * canonical capability check; the workspace↔project relationship and the caller's role are
 * read back from the database. A caller-supplied workspaceId is only ever CHECKED against
 * that relationship, never trusted. Every read runs on the request-scoped (RLS) client; the
 * trusted writer is created only after this succeeds, only for writes, and carries the
 * authenticated user — never an actor named in the request.
 */
async function authorizeScheduleExposure(projectId: string, workspaceId: string, permission: "read" | "write"): Promise<ScheduleExposureAuthorization> {
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

const defaultDeps: ScheduleExposureRouteDeps = {
  authorize: authorizeScheduleExposure,
  createTrustedWriter: createScheduleExposureTrustedWriter,
  evaluateAndRecord: evaluateAndRecordScheduleExposure,
  resumeMaterialization: resumeScheduleExposureMaterialization,
  listExposures: listScheduleExposures,
  listCandidates: listScheduleTriggerCandidates,
};

function denied(status: 401 | 403) {
  return NextResponse.json(
    { ok: false, error: status === 401 ? "Unauthenticated." : "Access denied." },
    { status },
  );
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthenticated/.test(message)) return denied(401);
  if (/role_denied|access_denied|write_denied/.test(message)) return denied(403);
  if (/trigger_not_found/.test(message)) return NextResponse.json({ ok: false, error: "The schedule change was not found in this project." }, { status: 404 });
  if (/evidence_not_found/.test(message)) return NextResponse.json({ ok: false, error: "That schedule evaluation was not found in this project." }, { status: 404 });
  if (/trigger_invalid|trigger_scope_mismatch|payload_invalid/.test(message)) return NextResponse.json({ ok: false, error: "The schedule change is not valid for this project." }, { status: 400 });
  if (/idempotency_conflict/.test(message)) return NextResponse.json({ ok: false, error: "This schedule change was already recorded with different content." }, { status: 409 });
  if (/source_(degraded|stale|unavailable|revoked)|source_kind_mismatch/.test(message)) {
    return NextResponse.json({ ok: false, error: "The schedule engine source is not available for this project." }, { status: 409 });
  }
  logger.error("route_internal_error", { route: ROUTE_ID, error_detail: safeErrorMessage(error) });
  return NextResponse.json({ ok: false, error: "Schedule exposure could not be evaluated. Please retry." }, { status: 500 });
}

export async function handleGetScheduleExposure(request: NextRequest, depsOverride: Partial<ScheduleExposureRouteDeps> = {}): Promise<NextResponse> {
  const deps: ScheduleExposureRouteDeps = { ...defaultDeps, ...depsOverride };
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  if (!projectId || !workspaceId) return NextResponse.json({ ok: false, error: "workspaceId and projectId are required." }, { status: 400 });

  const auth = await deps.authorize(projectId, workspaceId, "read");
  if (!auth.ok) return denied(auth.status);
  try {
    const scope = { workspaceId, projectId };
    const [exposures, candidates] = await Promise.all([deps.listExposures(auth.client, scope), deps.listCandidates(auth.client, scope)]);
    return NextResponse.json({ ok: true, exposures, candidates, canEvaluate: WRITE_ROLES.has(auth.role) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePostScheduleExposure(request: NextRequest, depsOverride: Partial<ScheduleExposureRouteDeps> = {}): Promise<NextResponse> {
  const deps: ScheduleExposureRouteDeps = { ...defaultDeps, ...depsOverride };
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!projectId || !workspaceId) return NextResponse.json({ ok: false, error: "workspaceId and projectId are required." }, { status: 400 });

  const action = body.action === undefined ? "evaluate" : body.action;
  if (action === "resume_materialization") {
    const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId.trim() : "";
    if (!evidenceId) return NextResponse.json({ ok: false, error: "evidenceId is required." }, { status: 400 });
    const auth = await deps.authorize(projectId, workspaceId, "write");
    if (!auth.ok) return denied(auth.status);
    try {
      const writer = deps.createTrustedWriter({ workspaceId, actorUserId: auth.userId, operation: "resume_schedule_exposure_materialization" });
      const resumed = await deps.resumeMaterialization(auth.client, writer, { workspaceId, projectId, userId: auth.userId, role: auth.role }, evidenceId);
      return NextResponse.json({ ok: true, disposition: resumed.disposition, resumed }, { status: resumed.disposition === "created" ? 201 : 200 });
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (action !== "evaluate") return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });

  const trigger = (body.trigger ?? null) as Record<string, unknown> | null;
  if (!trigger || !TRIGGER_KINDS.has(String(trigger.kind)) || typeof trigger.entityId !== "string" || !trigger.entityId.trim()) {
    return NextResponse.json({ ok: false, error: "trigger.kind and trigger.entityId are required." }, { status: 400 });
  }

  const auth = await deps.authorize(projectId, workspaceId, "write");
  if (!auth.ok) return denied(auth.status);

  const ref: ScheduleTriggerRef = { kind: trigger.kind as ScheduleTriggerRef["kind"], entityId: trigger.entityId.trim() };
  try {
    const writer = deps.createTrustedWriter({ workspaceId, actorUserId: auth.userId, operation: "evaluate_schedule_exposure" });
    const result = await deps.evaluateAndRecord(auth.client, writer, { workspaceId, projectId, userId: auth.userId, role: auth.role }, ref);
    const { evaluation, recorded } = result;
    if (evaluation.status === "invalid_topology") {
      // Refused, not degraded-and-recorded: no critical path is computed from invalid topology
      // and nothing canonical is written.
      return NextResponse.json({ ok: false, disposition: "refused", failureClass: "invalid_topology", evaluation, recorded: null }, { status: 422 });
    }
    if (!recorded) return NextResponse.json({ ok: true, disposition: "not_recorded", evaluation, recorded: null });
    return NextResponse.json({ ok: true, disposition: recorded.disposition, evaluation, recorded }, { status: recorded.disposition === "created" ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleGetScheduleExposure(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePostScheduleExposure(request);
}
