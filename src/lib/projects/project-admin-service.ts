import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ProjectMethodology, ProjectRow, ProjectStatus } from "@/lib/db/database-contract";
import { PROJECT_SELECTABLE_COLUMNS } from "@/lib/db/database-contract";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { duplicateProjectWithinLimit } from "@/lib/quota/project-quota";

const PROJECT_COLUMNS = PROJECT_SELECTABLE_COLUMNS.join(", ");

export const PROJECT_METHODOLOGIES: readonly ProjectMethodology[] = ["predictive", "agile", "hybrid", "kanban", "other"] as const;
export const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "archived", "completed"] as const;

export function normalizeProjectMethodology(value: unknown): ProjectMethodology | null {
  return PROJECT_METHODOLOGIES.includes(value as ProjectMethodology) ? (value as ProjectMethodology) : null;
}

export function normalizeProjectStatus(value: unknown): ProjectStatus | null {
  return PROJECT_STATUSES.includes(value as ProjectStatus) ? (value as ProjectStatus) : null;
}

/**
 * Looks up a project's own workspace_id without pre-knowing it — the
 * authoritative source for scope derivation (never trust a caller-supplied
 * or cookie-derived workspaceId for an entity that carries its own). Callers
 * must still independently verify the caller may access the project.
 */
export async function getProjectWorkspaceId(projectId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("projects").select("workspace_id").eq("id", projectId).maybeSingle<{ workspace_id: string }>();
  return data?.workspace_id ?? null;
}

export async function getProjectInWorkspace(workspaceId: string, projectId: string): Promise<ProjectRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .maybeSingle();
  return (data as unknown as ProjectRow) ?? null;
}

export type UpdateProjectInput = Partial<{
  name: string;
  description: string | null;
  status: ProjectStatus;
  methodology: ProjectMethodology | null;
  icon: string | null;
  color: string | null;
  pmoId: string | null;
  ownerUserId: string;
}>;

export async function updateProject(workspaceId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectRow> {
  const supabase = await createSupabaseServerClient();

  if (input.pmoId) {
    const pmo = await getPmoById(workspaceId, input.pmoId);
    if (!pmo) throw new Error("Target PMO not found in this workspace.");
    // The move-target dropdown (listPmos default) only lists active PMOs, so
    // this rejects a crafted request that bypasses that UI filtering —
    // archived PMOs stay a valid data container (existing projects inside one
    // keep working) but must not silently receive new project assignments.
    if (pmo.status === "archived") throw new Error("Cannot assign a project to an archived PMO.");
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.methodology !== undefined) patch.methodology = input.methodology;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.color !== undefined) patch.color = input.color;
  if (input.pmoId !== undefined) patch.pmo_id = input.pmoId;
  if (input.ownerUserId !== undefined) patch.user_id = input.ownerUserId;

  const { data, error } = await supabase
    .from("projects")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .select(PROJECT_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Unable to update project: ${error?.message ?? "unknown"}`);
  return data as unknown as ProjectRow;
}

/**
 * The database refuses to hard-delete a project that has retained history: execution tasks
 * (NO ACTION), audit events (RESTRICT) or append-only provenance. Archival is that project's
 * end state; nothing is deleted when this is thrown (PD-26).
 */
export class ProjectHasRetainedHistoryError extends Error {
  constructor() {
    super("This project has tasks, audit or provenance records that are kept, so it can't be permanently deleted. Archive it instead.");
    this.name = "ProjectHasRetainedHistoryError";
  }
}

const RETAINED_HISTORY_PATTERN = /violates foreign key constraint|append_only|is_immutable|immutab/i;

export async function deleteProject(workspaceId: string, projectId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("projects").delete().eq("workspace_id", workspaceId).eq("id", projectId);
  if (error && (error.code === "23503" || RETAINED_HISTORY_PATTERN.test(error.message))) throw new ProjectHasRetainedHistoryError();
  if (error) throw new Error(`Unable to delete project: ${error.message}`);
}

export type DuplicateProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; failureClass: "upgrade_required" | "insufficient_role" | "not_found"; error: string };

/**
 * Duplicates a project's shell (identity, PMO, methodology, look) without its
 * operational history — conversations, memory, and evidence stay with the
 * original context by design (context isolation).
 *
 * A duplicate is a new project, so it counts against the duplicating user's
 * plan limit exactly like a create (PD-14). The count, the limit check and the
 * insert happen in one database transaction serialised per user
 * (duplicateProjectWithinLimit), so concurrent duplicates cannot overshoot and a
 * refused or failed duplicate leaves nothing behind.
 */
export async function duplicateProject(workspaceId: string, projectId: string, createdByUserId: string): Promise<DuplicateProjectResult> {
  const source = await getProjectInWorkspace(workspaceId, projectId);
  if (!source) return { ok: false, failureClass: "not_found", error: "Project not found." };

  // Duplicating is a new project assignment, same as an explicit move — so it
  // must obey the same archived-PMO rule as updateProject rather than
  // silently copying source.pmo_id into an archived container.
  let targetPmoId = source.pmo_id;
  if (targetPmoId) {
    const pmo = await getPmoById(workspaceId, targetPmoId);
    if (!pmo || pmo.status === "archived") targetPmoId = null;
  }

  const result = await duplicateProjectWithinLimit({ actorUserId: createdByUserId, workspaceId, sourceProjectId: source.id, targetPmoId });
  if (!result.ok) {
    if (result.reason === "project_limit_reached") return { ok: false, failureClass: "upgrade_required", error: "Project limit reached for your plan." };
    if (result.reason === "insufficient_role") return { ok: false, failureClass: "insufficient_role", error: "Your role in this workspace can't create projects." };
    return { ok: false, failureClass: "not_found", error: "Project not found." };
  }

  const project = await getProjectInWorkspace(workspaceId, result.projectId);
  if (!project) throw new Error("Unable to duplicate project: the copy could not be read back.");
  return { ok: true, project };
}
