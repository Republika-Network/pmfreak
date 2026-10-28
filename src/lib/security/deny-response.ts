import { NextResponse } from "next/server";
import { isProjectArchivedDenial, projectArchivedResponse } from "@/lib/projects/archived-project";
import { AccessDeniedError } from "@/lib/security/access-guards";
import { logSecurityEvent, type SecurityEventType } from "@/lib/security/telemetry";
import { sdkRuntimeError } from "@/lib/aoc/contracts/envelope-helpers";

type DenyInput = {
  status: 401 | 403 | 404 | 409;
  routeId: string;
  message: string;
  eventType?: SecurityEventType;
  reason: string;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  requestedPermission?: string | null;
  deniedPermission?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown>;
};

export function denyResponse(input: DenyInput) {
  void logSecurityEvent(input.eventType ?? (input.status === 401 ? "auth_denied" : "denied_permission"), {
    routeId: input.routeId,
    actorUserId: input.actorUserId ?? null,
    actorAgentId: input.actorAgentId ?? null,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    requested_permission: input.requestedPermission ?? null,
    denied_permission: input.deniedPermission ?? null,
    actorRole: input.actorRole ?? null,
    metadata: { denial_reason: input.reason, ...(input.metadata ?? {}) },
  });

  const envelope = sdkRuntimeError({
    code: "authorization_denied",
    message: input.message,
    metadata: {
      routeId: input.routeId,
      reason: input.reason,
      actorUserId: input.actorUserId ?? null,
      actorAgentId: input.actorAgentId ?? null,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      requestedPermission: input.requestedPermission ?? null,
      deniedPermission: input.deniedPermission ?? null,
      actorRole: input.actorRole ?? null,
      ...(input.metadata ?? {}),
    },
  });

  return NextResponse.json({ ...envelope, error: input.message }, { status: input.status });
}

export function denyFromAccessError(error: AccessDeniedError, input: Omit<DenyInput, "reason">) {
  // PD-25: a write to an archived project is a state conflict, not a permission failure.
  if (isProjectArchivedDenial(error.metadata.reason)) return projectArchivedResponse();
  return denyResponse({
    ...input,
    reason: String(error.metadata.reason ?? "access_denied"),
    metadata: error.metadata,
  });
}
