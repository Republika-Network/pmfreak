"use server";

import { getAuthUser } from "@/lib/auth";
import { resolveWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import { requireWorkspaceRole } from "@/lib/workspace-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import type { PmoTenant } from "./pmo-tenant-types";
import { validatePmoTenantPayload } from "./pmo-tenant-validate";
import { defaultOwnerTypeFor, type CommandCenterType } from "@/lib/command-center/command-center-types";

// Explicit three-state contract — callers must handle all three.
export type PmoTenantSaveResult =
  | { status: "success"; correlationId: string }
  | { status: "recoverable_failure"; error: string; failureClass: string; correlationId: string }
  | { status: "fatal_failure"; error: string; failureClass: string; correlationId: string };

const PMO_TENANT_SCHEMA_VERSION = 2;

type LogLevel = "info" | "warn" | "error";

function emit(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>
) {
  console[level](JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

export async function savePmoTenant(tenant: PmoTenant): Promise<PmoTenantSaveResult> {
  const correlationId = crypto.randomUUID();
  let upsertedWorkspaceId: string | null = null;
  let supabaseClient: ReturnType<typeof createSupabaseServiceRoleClient> | null = null;
  let userId: string | undefined;
  let workspaceId: string | undefined;

  emit("info", "pmo.create.started", { correlationId });

  try {
    const validation = validatePmoTenantPayload(tenant);
    if (!validation.ok) {
      emit("error", "pmo.create.failed", {
        correlationId,
        failureClass: "validation_failed",
        errors: validation.errors,
      });
      return { status: "fatal_failure", error: "Invalid PMO configuration.", failureClass: "validation_failed", correlationId };
    }

    const user = await getAuthUser();
    if (!user) {
      emit("error", "pmo.create.failed", { correlationId, failureClass: "unauthenticated" });
      return { status: "fatal_failure", error: "Not authenticated.", failureClass: "unauthenticated", correlationId };
    }
    userId = user.id;

    const resolution = await resolveWriteWorkspace(user.id);
    if (!resolution.workspaceId) {
      emit("error", "pmo.create.failed", { correlationId, userId, failureClass: "no_workspace" });
      return { status: "fatal_failure", error: "No active workspace found for this account.", failureClass: "no_workspace", correlationId };
    }
    workspaceId = resolution.workspaceId;

    // Authorization BEFORE any service-role write (F5): activating the PMO rewrites the
    // workspace's governance and renames the workspace, so it requires an owner/admin
    // membership in the resolved workspace, read from workspace_memberships — never from
    // the client or the display role.
    try {
      await requireWorkspaceRole(resolution.workspaceId, "admin");
    } catch {
      emit("error", "pmo.create.failed", { correlationId, userId, workspaceId, failureClass: "forbidden" });
      return { status: "fatal_failure", error: "Only a workspace owner or admin can activate the PMO.", failureClass: "forbidden", correlationId };
    }

    supabaseClient = createSupabaseServiceRoleClient({
      routeId: "pmo/save-pmo-tenant",
      operation: "upsert",
      reason: "pmo_tenant_activation",
      workspaceId: resolution.workspaceId,
      actorUserId: user.id,
    });

    const { error: upsertError } = await supabaseClient.from("workspace_governance").upsert(
      {
        workspace_id: resolution.workspaceId,
        schema_version: PMO_TENANT_SCHEMA_VERSION,
        governance_jsonb: tenant as unknown as Record<string, unknown>,
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" }
    );

    if (upsertError) {
      emit("error", "pmo.create.failed", {
        correlationId,
        userId,
        workspaceId,
        failureClass: "upsert_error",
        error: upsertError.message,
      });
      return {
        status: "recoverable_failure",
        error: "Failed to save PMO configuration. Please try again.",
        failureClass: "upsert_error",
        correlationId,
      };
    }

    // Track that the upsert landed so we can roll back on subsequent failure.
    upsertedWorkspaceId = resolution.workspaceId;

    // Promote the auto-bootstrapped workspace into a fully typed Command Center:
    // this is the transition from "no Command Center exists yet" to a real one.
    const commandCenterType = tenant.identity.pmoType as CommandCenterType;
    const { error: workspaceUpdateError } = await supabaseClient
      .from("workspaces")
      .update({
        name: tenant.identity.pmoName,
        command_center_type: commandCenterType,
        owner_type: defaultOwnerTypeFor(commandCenterType),
        source_context: tenant.contextSeed.strategicObjective || null,
      })
      .eq("id", resolution.workspaceId);

    if (workspaceUpdateError) {
      emit("warn", "pmo.create.workspace_metadata_warn", {
        correlationId,
        userId,
        workspaceId,
        error: workspaceUpdateError.message,
      });
    }

    // data_owner is recorded once, on first activation. Re-activation (by any owner/admin)
    // never transfers it: the conditional update only matches while it is still unset.
    const { error: dataOwnerError } = await supabaseClient
      .from("workspaces")
      .update({ data_owner: user.id })
      .eq("id", resolution.workspaceId)
      .is("data_owner", null);

    if (dataOwnerError) {
      emit("warn", "pmo.create.workspace_metadata_warn", {
        correlationId,
        userId,
        workspaceId,
        error: dataOwnerError.message,
      });
    }

    // Materialize the PMO as a first-class entity (Workspace → PMO → Project
    // hierarchy). The governance JSON above stays the source of tenant
    // config; the pmos row is what navigation, project assignment, and the
    // PMO chat scope hang off.
    //
    // Idempotent and race-safe: ensure_default_pmo is the same
    // advisory-lock-guarded Postgres function pmo-service.ts's
    // ensureDefaultPmo() already uses for project-creation bootstrap
    // (migrations 20260828000002, 20260831000000). Two tabs, a
    // client-timeout racing its own retry, or a concurrent project-creation
    // call for the same brand-new workspace all serialize against the same
    // lock and converge on the same canonical default PMO row — a raw
    // check-then-insert here could otherwise let two concurrent activations
    // each observe "no existing PMO" and both insert. p_sync_existing keeps
    // the pmos row's name/type in sync with a rename on re-activation,
    // matching the previous check-then-insert-or-update behavior exactly.
    const { data: pmoRow, error: pmoRpcError } = await supabaseClient.rpc("ensure_default_pmo", {
      p_workspace_id: resolution.workspaceId,
      p_name: tenant.identity.pmoName,
      p_created_by_user_id: user.id,
      p_pmo_type: commandCenterType,
      p_sync_existing: true,
    });
    if (pmoRpcError || !pmoRow) {
      emit("warn", "pmo.create.pmo_entity_warn", {
        correlationId,
        userId,
        workspaceId,
        error: pmoRpcError?.message ?? "unknown",
      });
    }

    emit("info", "pmo.create.persisted", {
      correlationId,
      userId,
      workspaceId,
      schemaVersion: PMO_TENANT_SCHEMA_VERSION,
    });

    emit("info", "pmo.create.success", { correlationId, userId, workspaceId });
    return { status: "success", correlationId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    emit("error", "pmo.create.failed", {
      correlationId,
      userId,
      workspaceId,
      failureClass: "unexpected_exception",
      error: message,
    });

    // Explicit rollback: if the upsert landed before the exception, undo it.
    if (upsertedWorkspaceId && supabaseClient) {
      emit("warn", "pmo.create.rollback.started", { correlationId, userId, workspaceId: upsertedWorkspaceId });
      try {
        await supabaseClient
          .from("workspace_governance")
          .delete()
          .eq("workspace_id", upsertedWorkspaceId);
        emit("warn", "pmo.create.rollback.completed", { correlationId, userId, workspaceId: upsertedWorkspaceId });
      } catch (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : "unknown";
        emit("error", "pmo.create.rollback.failed", {
          correlationId,
          userId,
          workspaceId: upsertedWorkspaceId,
          error: rbMsg,
        });
      }
    }

    return {
      status: "recoverable_failure",
      error: "An unexpected error occurred. Please try again.",
      failureClass: "unexpected_exception",
      correlationId,
    };
  }
}
