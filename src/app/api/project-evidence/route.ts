import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import { getUploadProvider, isEvidenceStoragePathFor } from "@/lib/storage/upload-provider";
import { abuseDenyResponse, buildAbuseKey, enforceAbuseLimit } from "@/lib/security/abuse-protection";

type EvidenceRow = {
  id: string;
  file_name: string;
  file_type: string;
  storage_path: string;
  uploaded_at: string;
  status: "uploaded" | "processing" | "processed" | "failed";
};

const normalizeProjectId = (request: Request) => new URL(request.url).searchParams.get("projectId")?.trim() ?? "";

export async function GET(request: Request) {
  let userId: string | null = null;
  const projectId = normalizeProjectId(request);

  if (!projectId) {
    return Response.json({ error: "projectId is required." }, { status: 400 });
  }

  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
    await requireProjectAccess(projectId, "read");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: "/api/project-evidence", message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, {
        status: 403,
        routeId: "/api/project-evidence",
        message: "Invalid project context.",
        actorUserId: userId,
        projectId,
        requestedPermission: "read",
        deniedPermission: "read",
        eventType: "project_scope_violation",
      });
    }
    throw error;
  }

  const abuseDecision = await enforceAbuseLimit({
    scope: "project_evidence.read",
    identifier: buildAbuseKey([userId, projectId]),
    limit: 300,
    windowSeconds: 3600,
  });
  if (!abuseDecision.allowed) return abuseDenyResponse(abuseDecision);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("project_evidence")
    .select("id,file_name,file_type,storage_path,uploaded_at,status")
    .eq("project_id", projectId)
    .order("uploaded_at", { ascending: false });

  if (error) {
    return Response.json({ error: "Unable to load project evidence." }, { status: 500 });
  }

  return Response.json({ evidence: (data ?? []) as EvidenceRow[] });
}

export async function DELETE(request: Request) {
  let userId: string | null = null;
  let payload: { id?: string; projectId?: string };

  try {
    payload = (await request.json()) as { id?: string; projectId?: string };
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const evidenceId = payload.id?.trim() ?? "";
  const projectId = payload.projectId?.trim() ?? "";

  if (!evidenceId || !projectId) {
    return Response.json({ error: "id and projectId are required." }, { status: 400 });
  }

  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
    await requireProjectAccess(projectId, "write");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: "/api/project-evidence", message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, {
        status: 403,
        routeId: "/api/project-evidence",
        message: "Invalid project context.",
        actorUserId: userId,
        projectId,
        requestedPermission: "write",
        deniedPermission: "write",
        eventType: "project_scope_violation",
      });
    }
    throw error;
  }

  const abuseDecision = await enforceAbuseLimit({
    scope: "project_evidence.delete",
    identifier: buildAbuseKey([userId, projectId]),
    limit: 60,
    windowSeconds: 3600,
  });
  if (!abuseDecision.allowed) return abuseDenyResponse(abuseDecision);

  const supabase = await createSupabaseServerClient();
  const { data: evidence, error: loadError } = await supabase
    .from("project_evidence")
    .select("id,storage_path,uploaded_by")
    .eq("id", evidenceId)
    .eq("project_id", projectId)
    .maybeSingle<{ id: string; storage_path: string; uploaded_by: string | null }>();

  if (loadError) {
    return Response.json({ error: "Unable to load evidence." }, { status: 500 });
  }

  if (!evidence) {
    return Response.json({ error: "Evidence not found." }, { status: 404 });
  }

  // The storage deletion is privileged (service role), and storage_path is a row value: only
  // delete an object under the uploader's own prefix for this project (F22-B). An unverifiable
  // legacy path is never handed to the privileged client; the row is still removed.
  if (isEvidenceStoragePathFor({ storagePath: evidence.storage_path, uploadedBy: evidence.uploaded_by, projectId })) {
    try {
      await getUploadProvider().delete(evidence.storage_path);
    } catch {
      return Response.json({ error: "Unable to delete evidence storage." }, { status: 500 });
    }
  } else {
    console.warn("[security] evidence_storage_path_unverified", { routeId: "/api/project-evidence", evidenceId, projectId, actorUserId: userId });
  }

  const { error: deleteError } = await supabase.from("project_evidence").delete().eq("id", evidenceId).eq("project_id", projectId);

  if (deleteError) {
    return Response.json({ error: "Unable to delete evidence." }, { status: 500 });
  }

  return Response.json({ ok: true });
}
