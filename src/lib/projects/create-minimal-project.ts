import { canCreateMoreProjects } from "@/lib/feature-gates";
import { createProjectWithinLimit, type ProjectCreateQuotaResult } from "@/lib/quota/project-quota";
import { resolveWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import { canWriteProjectData } from "@/lib/workspace-access";
import { ensureDefaultPmo, getPmoById } from "@/lib/pmos/pmo-service";
import type { ProjectRow } from "@/lib/db/database-contract";

/**
 * The canonical minimal project creation service. Every "create project"
 * surface (the /projects inline form, the JSON API used by the create
 * project modal, and any future entry point) should call this rather than
 * re-implementing project insertion — one create path, reused everywhere.
 *
 * Deliberately does not accept budget, governance framework, health score,
 * methodology, risks, milestones, dependencies, or AI-agent fields: those
 * are advanced/optional configuration, not required to start execution
 * (see docs referenced in the sprint spec — Zero State UX / no fabricated
 * secondary data on creation).
 */

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;

export type CreateMinimalProjectInput = {
  userId: string;
  name: string;
  description?: string | null;
  pmoId?: string | null;
  /** Caller-specific structured context (e.g. the wizard/inline-form's
   *  onboarding payload for downstream brief generation). Not part of the
   *  minimal form's validated surface — passed through as-is when present. */
  onboardingPayload?: Record<string, unknown> | null;
};

export type CreateMinimalProjectValidationError = { field: "name" | "description" | "pmoId"; message: string };

export type CreateMinimalProjectResult =
  | { ok: true; project: ProjectRow; workspaceId: string; role: "owner" | "admin" | "pm" | "viewer" | null }
  | { ok: false; error: string; failureClass: string; fieldErrors?: CreateMinimalProjectValidationError[] };

export function validateCreateMinimalProjectInput(
  input: unknown,
): { ok: true; data: { name: string; description: string | null; pmoId: string | null } } | { ok: false; errors: CreateMinimalProjectValidationError[] } {
  const errors: CreateMinimalProjectValidationError[] = [];
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.push({ field: "name", message: "Project name is required." });
  else if (name.length > MAX_NAME_LENGTH) {
    errors.push({ field: "name", message: `Project name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      errors.push({ field: "description", message: "Description must be text." });
    } else {
      const trimmed = body.description.trim();
      if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
        errors.push({ field: "description", message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` });
      } else {
        description = trimmed.length > 0 ? trimmed : null;
      }
    }
  }

  let pmoId: string | null = null;
  if (body.pmoId !== undefined && body.pmoId !== null && body.pmoId !== "") {
    if (typeof body.pmoId !== "string") errors.push({ field: "pmoId", message: "PMO is invalid." });
    else pmoId = body.pmoId.trim();
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { name, description, pmoId } };
}

/**
 * Creates a project with only the fields the schema actually requires plus
 * the small set of honestly-optional ones (description, PMO). Resolves the
 * write workspace and PMO server-side — never trusts a client-supplied
 * workspaceId. onboarding_payload / brief generation / RAID context
 * ingestion are the caller's responsibility (existing best-effort side
 * effects specific to the redirect-based server action stay there).
 */
export async function createMinimalProject(
  rawInput: { userId: string } & Record<string, unknown>,
): Promise<CreateMinimalProjectResult> {
  const { userId, onboardingPayload, ...rest } = rawInput as CreateMinimalProjectInput;
  const validated = validateCreateMinimalProjectInput(rest);
  if (!validated.ok) {
    return { ok: false, error: "Invalid project input.", failureClass: "validation_failed", fieldErrors: validated.errors };
  }
  const { name, description, pmoId } = validated.data;

  const projectAccess = await canCreateMoreProjects(userId);
  if (!projectAccess.ok) {
    return { ok: false, error: "Project limit reached for your plan.", failureClass: "upgrade_required" };
  }

  const ensured = await resolveWriteWorkspace(userId);
  // RLS refuses the insert for viewers (F21); refuse first, with an honest message.
  if (ensured.role && !canWriteProjectData(ensured.role)) {
    return { ok: false, error: "Your role in this workspace can't create projects.", failureClass: "insufficient_role" };
  }

  let resolvedPmoId: string;
  if (pmoId) {
    const requestedPmo = await getPmoById(ensured.workspaceId, pmoId);
    if (!requestedPmo) {
      return {
        ok: false,
        error: "Selected PMO was not found.",
        failureClass: "validation_failed",
        fieldErrors: [{ field: "pmoId", message: "Selected PMO was not found in this workspace." }],
      };
    }
    resolvedPmoId = requestedPmo.id;
  } else {
    const defaultPmo = await ensureDefaultPmo(ensured.workspaceId, userId);
    resolvedPmoId = defaultPmo.id;
  }

  // The check above is a fast refusal; the limit is enforced here, atomically (Q12).
  let created: ProjectCreateQuotaResult;
  try {
    created = await createProjectWithinLimit({
      actorUserId: userId,
      workspaceId: ensured.workspaceId,
      pmoId: resolvedPmoId,
      name,
      description,
      onboardingPayload: onboardingPayload ?? null,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to create project.", failureClass: "persistence_failed" };
  }
  if (!created.ok) {
    if (created.reason === "project_limit_reached") return { ok: false, error: "Project limit reached for your plan.", failureClass: "upgrade_required" };
    if (created.reason === "insufficient_role") return { ok: false, error: "Your role in this workspace can't create projects.", failureClass: "insufficient_role" };
    return {
      ok: false,
      error: "Selected PMO was not found.",
      failureClass: "validation_failed",
      fieldErrors: [{ field: "pmoId", message: "Selected PMO was not found in this workspace." }],
    };
  }

  return { ok: true, project: created.project, workspaceId: ensured.workspaceId, role: ensured.role };
}
