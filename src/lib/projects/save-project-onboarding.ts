"use server";

import { getAuthUser } from "@/lib/auth";
import { canCreateMoreProjects } from "@/lib/feature-gates";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { resolveWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { canWriteProjectData } from "@/lib/workspace-access";
import { ensureDefaultPmo, getPmoById } from "@/lib/pmos/pmo-service";
import { createProjectWithinLimit, type ProjectCreateQuotaResult } from "@/lib/quota/project-quota";
import { generateAndPersistOperationalGovernanceBrief } from "@/lib/projects/first-insight";
import { ingestProjectSetupContext } from "@/lib/projects/ingest-project-setup-context";
import type { ResolvedWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import type { ProjectOnboardingPayload } from "./project-onboarding-types";

export type ProjectSaveResult =
  | {
      status: "success";
      projectId: string;
      /** The workspace the project was actually created in — read from the server's own resolution. */
      workspaceId: string;
      correlationId: string;
      briefStatus: "generated" | "generation_failed";
      briefError?: string;
    }
  | {
      status: "recoverable_failure";
      error: string;
      failureClass: string;
      correlationId: string;
    }
  | {
      status: "fatal_failure";
      error: string;
      failureClass: string;
      correlationId: string;
    };

function validatePayload(payload: ProjectOnboardingPayload): string | null {
  if (!payload?.identity?.projectName?.trim()) return "Project name is required";
  if (!payload?.identity?.clientOrganization?.trim()) return "Client organization is required";
  if (!payload?.identity?.projectType) return "Project type is required";
  if (!payload?.identity?.pmAssigned?.trim()) return "PM assigned is required";
  if (!payload?.deliveryContext?.problemStatement?.trim()) return "Problem statement is required";
  if (!payload?.deliveryContext?.mainDeliverable?.trim()) return "Main deliverable is required";
  return null;
}

function emit(event: string, fields: Record<string, unknown>) {
  console.info(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

export async function saveProjectOnboarding(
  payload: ProjectOnboardingPayload,
  correlationId?: string,
  opts?: {
    pmoId?: string | null;
    /**
     * CHAT-SHELL-01 (F1) — an EXPLICIT target workspace, e.g. the one the conversation
     * shell was displaying when "New project" was chosen. It is a CLAIM, never authority:
     * it is re-authorized below with `resolveRoutedWorkspace`, which admits only an active
     * workspace the caller is a member of and has no fallback. When it does not authorize
     * the save is REFUSED — it never falls back to the preferred-workspace cookie, which
     * is exactly how a project meant for workspace B used to land silently in A.
     * Omitted, the previous behaviour (the preferred workspace) is unchanged.
     */
    workspaceId?: string | null;
  }
): Promise<ProjectSaveResult> {
  const cid = correlationId ?? `proj_${Date.now()}`;
  let insertedProjectId: string | null = null;
  // The row this request inserted, for the compensating delete below.
  let insertedProject: { id: string; workspaceId: string; userId: string } | null = null;

  try {
    const user = await getAuthUser();
    if (!user) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "fatal_failure",
        reason: "unauthenticated",
      });
      return {
        status: "fatal_failure",
        error: "Not authenticated. Please sign in and try again.",
        failureClass: "unauthenticated",
        correlationId: cid,
      };
    }

    const validationError = validatePayload(payload);
    if (validationError) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "fatal_failure",
        reason: "invalid_payload",
        detail: validationError,
        userId: user.id,
      });
      return {
        status: "fatal_failure",
        error: validationError,
        failureClass: "invalid_payload",
        correlationId: cid,
      };
    }

    emit("project.create.started", { correlationId: cid, userId: user.id });

    const projectAccess = await canCreateMoreProjects(user.id);
    if (!projectAccess.ok) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "fatal_failure",
        reason: "upgrade_required",
        userId: user.id,
      });
      return {
        status: "fatal_failure",
        error: "upgrade_required",
        failureClass: "upgrade_required",
        correlationId: cid,
      };
    }

    let ensured: ResolvedWriteWorkspace;
    try {
      if (opts?.workspaceId) {
        const routed = await resolveRoutedWorkspace(user.id, opts.workspaceId);
        if (routed.access !== "granted") {
          // Denied (not a member / no such workspace) and archived are both refusals
          // here; the reply names neither, so it cannot be used to probe workspace ids.
          emit("project.create.failed", {
            correlationId: cid,
            failureClass: "fatal_failure",
            reason: "target_workspace_not_writable",
            userId: user.id,
          });
          return {
            status: "fatal_failure",
            error: "You can't create a project in that workspace. Nothing was created.",
            failureClass: "target_workspace_not_writable",
            correlationId: cid,
          };
        }
        ensured = { workspaceId: routed.workspaceId, role: routed.role, bootstrapped: false };
      } else {
        ensured = await resolveWriteWorkspace(user.id);
      }
    } catch (wsErr) {
      const detail = wsErr instanceof Error ? wsErr.message : "unknown workspace error";
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "recoverable_failure",
        reason: "workspace_error",
        detail,
        userId: user.id,
      });
      return {
        status: "recoverable_failure",
        error: "Unable to resolve workspace. Please try again.",
        failureClass: "workspace_error",
        correlationId: cid,
      };
    }

    if (!ensured.workspaceId) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "fatal_failure",
        reason: "missing_workspace",
        userId: user.id,
      });
      return {
        status: "fatal_failure",
        error: "No workspace found. Please contact support.",
        failureClass: "missing_workspace",
        correlationId: cid,
      };
    }

    // RLS refuses the insert for viewers (F21); refuse first, with an honest message.
    if (ensured.role && !canWriteProjectData(ensured.role)) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "fatal_failure",
        reason: "insufficient_role",
        userId: user.id,
        workspaceId: ensured.workspaceId,
      });
      return {
        status: "fatal_failure",
        error: "Your role in this workspace can't create projects. Nothing was created.",
        failureClass: "insufficient_role",
        correlationId: cid,
      };
    }

    const supabase = await createSupabaseServerClient();

    // Attach the project to its PMO: an explicit selection (e.g. "New
    // Project" launched from a PMO page) wins; otherwise the workspace's
    // default PMO is used/created.
    let pmoId: string;
    const requestedPmo = opts?.pmoId ? await getPmoById(ensured.workspaceId, opts.pmoId) : null;
    if (requestedPmo) {
      pmoId = requestedPmo.id;
    } else {
      const defaultPmo = await ensureDefaultPmo(ensured.workspaceId, user.id);
      pmoId = defaultPmo.id;
    }
    // The canCreateMoreProjects check above is a fast refusal; the limit is enforced here,
    // atomically, together with the insert (Q12). status takes the column default, 'active'.
    let created: ProjectCreateQuotaResult;
    try {
      created = await createProjectWithinLimit({
        actorUserId: user.id,
        workspaceId: ensured.workspaceId,
        pmoId,
        name: payload.identity.projectName,
        description: payload.deliveryContext.problemStatement || null,
        onboardingPayload: payload as unknown as Record<string, unknown>,
      });
    } catch (insertErr) {
      const detail = insertErr instanceof Error ? insertErr.message : undefined;
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "recoverable_failure",
        reason: "db_insert_error",
        detail,
        userId: user.id,
        workspaceId: ensured.workspaceId,
      });
      return {
        status: "recoverable_failure",
        error: detail ?? "Unable to create project. Please try again.",
        failureClass: "db_insert_error",
        correlationId: cid,
      };
    }

    if (!created.ok) {
      const refusal =
        created.reason === "project_limit_reached"
          ? { status: "fatal_failure" as const, error: "upgrade_required", failureClass: "upgrade_required" }
          : created.reason === "insufficient_role"
            ? { status: "fatal_failure" as const, error: "Your role in this workspace can't create projects. Nothing was created.", failureClass: "insufficient_role" }
            : { status: "recoverable_failure" as const, error: "The selected PMO is no longer available. Nothing was created. Please try again.", failureClass: "pmo_not_found" };
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: refusal.status,
        reason: refusal.failureClass,
        userId: user.id,
        workspaceId: ensured.workspaceId,
      });
      return { ...refusal, correlationId: cid };
    }
    const data = { id: created.project.id };

    // Insert confirmed — project creation must survive first-insight failures.
    insertedProjectId = data.id;
    insertedProject = { id: data.id, workspaceId: ensured.workspaceId, userId: user.id };

    // Feed the onboarding context into the intelligence loop (vault RAID
    // extraction + operational evidence chain) before generating the first
    // brief, so detected RAID items are part of it. Best-effort by design.
    const contextLines = [
      payload.deliveryContext.problemStatement ? `Problem statement: ${payload.deliveryContext.problemStatement}` : null,
      payload.deliveryContext.externalDependencies ? `External dependencies: ${payload.deliveryContext.externalDependencies}` : null,
      payload.deliveryContext.contractualMilestones ? `Contractual milestones: ${payload.deliveryContext.contractualMilestones}` : null,
      payload.discovery?.unknowns ? `Known unknowns: ${payload.discovery.unknowns}` : null,
      payload.discovery?.pendingClientDependencies ? `Pending client dependencies: ${payload.discovery.pendingClientDependencies}` : null,
      payload.discovery?.pendingAccesses ? `Pending accesses: ${payload.discovery.pendingAccesses}` : null,
      payload.discovery?.vendorDependencies ? `Vendor dependencies: ${payload.discovery.vendorDependencies}` : null,
      payload.discovery?.financialBlockers ? `Financial blockers: ${payload.discovery.financialBlockers}` : null,
    ].filter(Boolean) as string[];
    if (contextLines.length > 0) {
      await ingestProjectSetupContext({
        supabase,
        workspaceId: ensured.workspaceId,
        projectId: data.id,
        userId: user.id,
        companyId: user.companyId,
        role: ensured.role ?? null,
        projectName: payload.identity.projectName,
        content: contextLines.join("\n"),
      });
    }

    let briefStatus: "generated" | "generation_failed" = "generated";
    let briefError: string | undefined;
    try {
      const briefResult = await generateAndPersistOperationalGovernanceBrief({
        workspaceId: ensured.workspaceId,
        projectId: data.id,
        projectOnboardingPayload: payload as unknown as Record<string, unknown>,
        createdBy: user.id,
        supabase,
      });

      if (!briefResult.ok) {
        briefStatus = "generation_failed";
        briefError = briefResult.error;
        emit("project.create.brief_generation_failed", {
          correlationId: cid,
          projectId: data.id,
          userId: user.id,
          workspaceId: ensured.workspaceId,
          detail: briefResult.error,
        });
      } else {
        emit("project.create.brief_generated", {
          correlationId: cid,
          projectId: data.id,
          briefId: briefResult.brief.briefId,
          confidenceScore: briefResult.brief.confidenceScore,
          userId: user.id,
          workspaceId: ensured.workspaceId,
        });
      }
    } catch (briefErr) {
      briefStatus = "generation_failed";
      briefError = briefErr instanceof Error ? briefErr.message : "brief_generation_exception";
      emit("project.create.brief_generation_failed", {
        correlationId: cid,
        projectId: data.id,
        userId: user.id,
        workspaceId: ensured.workspaceId,
        detail: briefError,
      });
    }

    emit("project.create.persisted", {
      correlationId: cid,
      projectId: data.id,
      userId: user.id,
      workspaceId: ensured.workspaceId,
    });

    emit("project.create.success", {
      correlationId: cid,
      projectId: data.id,
      userId: user.id,
      workspaceId: ensured.workspaceId,
    });

    return { status: "success", projectId: data.id, workspaceId: ensured.workspaceId, correlationId: cid, briefStatus, briefError };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Rollback if the project row was already inserted before the downstream failure
    if (insertedProjectId) {
      emit("project.create.rollback.started", {
        correlationId: cid,
        projectId: insertedProjectId,
        reason: message,
      });

      try {
        // Project DELETE is owner/admin-only under RLS (F21), but a pm may create a
        // project, so undoing this request's own insert runs privileged — limited to
        // exactly the row inserted above (id + workspace + creating user).
        const supabase = createSupabaseServiceRoleClient({
          routeId: "lib.projects.save-project-onboarding",
          operation: "delete",
          reason: "compensating_rollback_of_own_insert",
          workspaceId: insertedProject?.workspaceId,
          actorUserId: insertedProject?.userId,
        });
        const { data: removed, error: rbErr } = insertedProject
          ? await supabase
              .from("projects")
              .delete()
              .eq("id", insertedProject.id)
              .eq("workspace_id", insertedProject.workspaceId)
              .eq("user_id", insertedProject.userId)
              .select("id")
          : { data: null, error: { message: "inserted project context missing" } };

        if (rbErr || removed?.length !== 1) {
          emit("project.create.rollback.failed", {
            correlationId: cid,
            projectId: insertedProjectId,
            detail: rbErr?.message ?? "rollback removed no row",
          });
        } else {
          emit("project.create.rollback.completed", {
            correlationId: cid,
            projectId: insertedProjectId,
          });
        }
      } catch (rbCatch) {
        emit("project.create.rollback.failed", {
          correlationId: cid,
          projectId: insertedProjectId,
          detail: rbCatch instanceof Error ? rbCatch.message : "rollback exception",
        });
      }

      return {
        status: "recoverable_failure",
        error: "Project initialization failed. The project has been removed. Please try again.",
        failureClass: "downstream_failure",
        correlationId: cid,
      };
    }

    emit("project.create.failed", {
      correlationId: cid,
      failureClass: "recoverable_failure",
      reason: "unexpected_exception",
      detail: message,
    });
    return {
      status: "recoverable_failure",
      error: "An unexpected error occurred. Please try again.",
      failureClass: "unexpected_exception",
      correlationId: cid,
    };
  }
}
