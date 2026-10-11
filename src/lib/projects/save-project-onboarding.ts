"use server";

import { getAuthUser } from "@/lib/auth";
import { canCreateMoreProjects } from "@/lib/feature-gates";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { ensureDefaultPmo, getPmoById } from "@/lib/pmos/pmo-service";
import {
  composeActivationPayload,
  normalizeActivationRequestId,
  readBrainActivation,
  type BrainActivationMarker,
} from "@/lib/projects/brain-activation-state";
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
    /**
     * The wizard's activation key, stable across retries and reloads. With it,
     * a retry after a partial or lost activation RESUMES the project that
     * attempt created instead of creating a second one. Shape-checked and
     * always scoped to the caller's own user id. Omitted (older clients), each
     * call is a fresh activation, as before.
     */
    activationRequestId?: string | null;
  }
): Promise<ProjectSaveResult> {
  const cid = correlationId ?? `proj_${Date.now()}`;
  const activationRequestId = normalizeActivationRequestId(opts?.activationRequestId);
  let insertedProjectId: string | null = null;

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

    emit("project.create.started", { correlationId: cid, userId: user.id, activationRequestId });

    const supabase = await createSupabaseServerClient();

    // Resume: a previous attempt of THIS activation already created the
    // project (its response was lost, or it failed after the insert). Finish
    // that project instead of creating another. Checked before the plan limit
    // because the resumed project is already counted against it.
    if (activationRequestId) {
      const prior = await findActivationProject(supabase, user.id, activationRequestId);
      if (prior === "unavailable") {
        emit("project.create.failed", { correlationId: cid, failureClass: "recoverable_failure", reason: "activation_lookup_failed", userId: user.id });
        return {
          status: "recoverable_failure",
          error: "We couldn't check whether this project was already created. Nothing new was created — please try again.",
          failureClass: "activation_lookup_failed",
          correlationId: cid,
        };
      }
      if (prior) {
        return await resumeActivation({ prior, payload, user, cid, supabase });
      }
    }

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

    const pmoId = await resolveProjectPmo({
      workspaceId: ensured.workspaceId,
      role: ensured.role,
      requestedPmoId: opts?.pmoId ?? null,
      userId: user.id,
      cid,
    });

    const startedAt = new Date().toISOString();
    const marker: BrainActivationMarker | null = activationRequestId
      ? { requestId: activationRequestId, startedAt, setupContextCompletedAt: null, briefCompletedAt: null, completedAt: null }
      : null;
    const onboardingPayload = marker
      ? composeActivationPayload(payload as unknown as Record<string, unknown>, marker)
      : (payload as unknown as Record<string, unknown>);

    const { data, error } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        workspace_id: ensured.workspaceId,
        pmo_id: pmoId,
        name: payload.identity.projectName,
        description: payload.deliveryContext.problemStatement || null,
        status: "active",
        onboarding_payload: onboardingPayload,
      })
      .select("id")
      .single<{ id: string }>();

    // A concurrent attempt of the same activation won the unique index
    // (projects_brain_activation_request_uidx): resume the project it created.
    if (error?.code === "23505" && activationRequestId) {
      const prior = await findActivationProject(supabase, user.id, activationRequestId);
      if (prior && prior !== "unavailable") {
        return await resumeActivation({ prior, payload, user, cid, supabase });
      }
    }

    if (error || !data?.id) {
      emit("project.create.failed", {
        correlationId: cid,
        failureClass: "recoverable_failure",
        reason: "db_insert_error",
        detail: error?.message,
        userId: user.id,
        workspaceId: ensured.workspaceId,
      });
      return {
        status: "recoverable_failure",
        error: error?.message ?? "Unable to create project. Please try again.",
        failureClass: "db_insert_error",
        correlationId: cid,
      };
    }

    // Insert confirmed — project creation must survive first-insight failures.
    insertedProjectId = data.id;

    return await runActivationSteps({
      projectId: data.id,
      workspaceId: ensured.workspaceId,
      role: ensured.role ?? null,
      payload,
      persistedPayload: onboardingPayload,
      marker,
      user,
      cid,
      supabase,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // The project row exists: keep it. Deleting it used to orphan whatever
    // intelligence rows had already been written for it; instead the retry —
    // which carries the same activation key — resumes this project and runs
    // only the steps that have not completed.
    if (insertedProjectId) {
      emit("project.create.activation_incomplete", {
        correlationId: cid,
        projectId: insertedProjectId,
        detail: message,
      });
      return {
        status: "recoverable_failure",
        error: "Your project was saved, but Project Brain activation didn't finish. Retry to complete it — nothing will be duplicated.",
        failureClass: "activation_incomplete",
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

type ActivationUser = { id: string; companyId: string };
type ServerSupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type PriorActivation = { id: string; workspace_id: string; onboarding_payload: unknown };

/** The project this user's activation key already created, null if none, or "unavailable" when it can't be read. */
async function findActivationProject(
  supabase: ServerSupabase,
  userId: string,
  requestId: string,
): Promise<PriorActivation | null | "unavailable"> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, workspace_id, onboarding_payload")
    .eq("user_id", userId)
    .eq("onboarding_payload->brainActivation->>requestId", requestId)
    .limit(1);
  if (error || !Array.isArray(data)) return "unavailable";
  return (data[0] as PriorActivation | undefined) ?? null;
}

/**
 * Which PMO the new project is attached to — never a precondition for creating it.
 *
 * ADR-PMF-006 Rule 11: no permission check may require PMO creation before a
 * Project can be created, and ADR-PMF-003 rule 4: `pmo_id IS NULL` is a
 * first-class state. Creating the workspace's default PMO is restricted by RLS
 * to owner/admin/pm ("workspace managers can manage pmos"), while creating a
 * project is open to every member ("workspace members can insert projects").
 * Activation used to call ensure_default_pmo unconditionally, so a member
 * without PMO-management rights in a workspace that had no PMO yet failed the
 * whole activation with an RLS violation reported as an unexpected exception.
 *
 *   - an explicitly requested PMO in this workspace is used, as before;
 *   - a member who may manage PMOs gets the default PMO ensured, as before;
 *   - anyone else is attached to the existing default PMO if there is one,
 *     otherwise the project is created unassigned — no PMO write is attempted,
 *     and neither RLS policy is changed;
 *   - a failure to ensure the default PMO leaves the project unassigned rather
 *     than failing activation.
 */
async function resolveProjectPmo(input: {
  workspaceId: string;
  role: string | null;
  requestedPmoId: string | null;
  userId: string;
  cid: string;
}): Promise<string | null> {
  const requested = input.requestedPmoId ? await getPmoById(input.workspaceId, input.requestedPmoId) : null;
  if (requested) return requested.id;

  if (input.role === "owner" || input.role === "admin" || input.role === "pm") {
    try {
      return (await ensureDefaultPmo(input.workspaceId, input.userId)).id;
    } catch (pmoErr) {
      emit("project.create.pmo_unassigned", {
        correlationId: input.cid,
        reason: "default_pmo_unavailable",
        detail: pmoErr instanceof Error ? pmoErr.message : "unknown",
        userId: input.userId,
        workspaceId: input.workspaceId,
      });
      return null;
    }
  }

  // Same canonical default the ensure_default_pmo function would return:
  // the oldest active PMO in the workspace. Read-only.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("pmos")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (data?.id) return data.id;

  emit("project.create.pmo_unassigned", {
    correlationId: input.cid,
    reason: "no_default_pmo_and_role_cannot_create_one",
    role: input.role,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  return null;
}

/**
 * Finish an activation whose project already exists. The workspace is
 * re-authorized (it must still be an active membership), the project's
 * content is refreshed from the latest submission — so an edit made before
 * retrying is not lost — and only the steps without a completion marker run.
 */
async function resumeActivation(input: {
  prior: PriorActivation;
  payload: ProjectOnboardingPayload;
  user: ActivationUser;
  cid: string;
  supabase: ServerSupabase;
}): Promise<ProjectSaveResult> {
  const { prior, payload, user, cid, supabase } = input;
  const marker = readBrainActivation(prior.onboarding_payload);
  const access = await resolveRoutedWorkspace(user.id, prior.workspace_id);
  if (!marker || access.access !== "granted") {
    emit("project.create.failed", { correlationId: cid, failureClass: "fatal_failure", reason: "activation_resume_refused", projectId: prior.id, userId: user.id });
    return {
      status: "fatal_failure",
      error: "This project can no longer be activated from here. Nothing new was created.",
      failureClass: "activation_resume_refused",
      correlationId: cid,
    };
  }

  emit("project.create.resumed", { correlationId: cid, projectId: prior.id, userId: user.id, workspaceId: access.workspaceId, marker });

  const persistedPayload = composeActivationPayload(payload as unknown as Record<string, unknown>, marker, prior.onboarding_payload);
  const { error: refreshError } = await supabase
    .from("projects")
    .update({
      name: payload.identity.projectName,
      description: payload.deliveryContext.problemStatement || null,
      onboarding_payload: persistedPayload,
    })
    .eq("id", prior.id)
    .eq("workspace_id", access.workspaceId);
  if (refreshError) {
    emit("project.create.failed", { correlationId: cid, failureClass: "recoverable_failure", reason: "activation_resume_write_failed", detail: refreshError.message, projectId: prior.id, userId: user.id });
    return {
      status: "recoverable_failure",
      error: "Your project was saved, but Project Brain activation didn't finish. Retry to complete it — nothing will be duplicated.",
      failureClass: "activation_incomplete",
      correlationId: cid,
    };
  }

  return runActivationSteps({
    projectId: prior.id,
    workspaceId: access.workspaceId,
    role: access.role,
    payload,
    persistedPayload,
    marker,
    user,
    cid,
    supabase,
  });
}

/**
 * The post-insert activation steps, each recorded in the brainActivation
 * marker when it completes so a resumed activation skips it:
 *   1. setup-context ingestion — vault document + RAID extraction (Risk
 *      Baseline), recommended actions, and the operational evidence chain
 *      (Project Memory). Runs once per project.
 *   2. the operational governance brief (Governance Skeleton and baseline
 *      read-out). Upserted per project, so it is re-run until it succeeds.
 * Identity, Scope Baseline, Stakeholder Map and Delivery Constraints are the
 * submitted onboarding content itself, persisted verbatim on the project row.
 */
async function runActivationSteps(input: {
  projectId: string;
  workspaceId: string;
  role: string | null;
  payload: ProjectOnboardingPayload;
  persistedPayload: Record<string, unknown>;
  marker: BrainActivationMarker | null;
  user: ActivationUser;
  cid: string;
  supabase: ServerSupabase;
}): Promise<ProjectSaveResult> {
  const { projectId, workspaceId, payload, user, cid, supabase } = input;
  let marker = input.marker;
  let persistedPayload = input.persistedPayload;

  const recordStep = async (patch: Partial<BrainActivationMarker>) => {
    if (!marker) return;
    marker = { ...marker, ...patch };
    persistedPayload = composeActivationPayload(persistedPayload, marker, persistedPayload);
    const { error } = await supabase.from("projects").update({ onboarding_payload: persistedPayload }).eq("id", projectId);
    if (error) {
      // The step itself succeeded; a lost marker only means a resume repeats
      // an idempotent step. Never fail activation for it.
      emit("project.create.activation_marker_write_failed", { correlationId: cid, projectId, detail: error.message });
    }
  };

  if (!marker?.setupContextCompletedAt) {
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
        workspaceId,
        projectId,
        userId: user.id,
        companyId: user.companyId,
        role: (input.role as Parameters<typeof ingestProjectSetupContext>[0]["role"]) ?? null,
        projectName: payload.identity.projectName,
        content: contextLines.join("\n"),
        // One setup-context capture per project, however often activation resumes.
        idempotencyScope: projectId,
      });
    }
    await recordStep({ setupContextCompletedAt: new Date().toISOString() });
  }

  let briefStatus: "generated" | "generation_failed" = "generated";
  let briefError: string | undefined;
  try {
    const briefResult = await generateAndPersistOperationalGovernanceBrief({
      workspaceId,
      projectId,
      projectOnboardingPayload: payload as unknown as Record<string, unknown>,
      createdBy: user.id,
      supabase,
    });

    if (!briefResult.ok) {
      briefStatus = "generation_failed";
      briefError = briefResult.error;
      emit("project.create.brief_generation_failed", { correlationId: cid, projectId, userId: user.id, workspaceId, detail: briefResult.error });
    } else {
      emit("project.create.brief_generated", {
        correlationId: cid,
        projectId,
        briefId: briefResult.brief.briefId,
        confidenceScore: briefResult.brief.confidenceScore,
        userId: user.id,
        workspaceId,
      });
    }
  } catch (briefErr) {
    briefStatus = "generation_failed";
    briefError = briefErr instanceof Error ? briefErr.message : "brief_generation_exception";
    emit("project.create.brief_generation_failed", { correlationId: cid, projectId, userId: user.id, workspaceId, detail: briefError });
  }

  const now = new Date().toISOString();
  await recordStep(briefStatus === "generated" ? { briefCompletedAt: now, completedAt: now } : { completedAt: now });

  emit("project.create.persisted", { correlationId: cid, projectId, userId: user.id, workspaceId });
  emit("project.create.success", { correlationId: cid, projectId, userId: user.id, workspaceId });

  return { status: "success", projectId, workspaceId, correlationId: cid, briefStatus, briefError };
}
