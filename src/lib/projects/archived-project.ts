// PD-25 — an archived project is read-only.
//
// docs/product-architecture/07-route-layout-and-navigation-architecture.md §7: an archived
// entity shows its last-known data "with mutation actions disabled", and archival "is a state
// transition (soft-delete equivalent), not a deletion". Until PD-25 only task creation honoured
// it; uploads, vault intake, operational captures, Brain turns and every other project write
// still succeeded. Reactivation (status leaving `archived`) stays allowed for authorized
// writers — it is the way back. `completed` is not read-only.
//
// Enforced at the server boundaries: the project-permission adapter refuses mutating
// permissions (lib/aoc/adapters/access-verification.ts), routes that authorize another way
// check explicitly, and the operational chain's SQL gate (can_write_operational_project)
// refuses in the database.

export const PROJECT_ARCHIVED_CODE = "project_archived";
export const PROJECT_ARCHIVED_MESSAGE = "This project is archived and read-only. Reactivate it to make changes.";

/** Permissions that mutate a project's data; reads are never affected by archival. */
export const PROJECT_MUTATING_PERMISSIONS: ReadonlySet<string> = new Set(["write", "delete", "upload_documents", "write_memory"]);

export const isArchivedProjectStatus = (status: unknown): boolean => status === "archived";

/** True for a denial raised because the project is archived (the reason travels as text through the runtime). */
export const isProjectArchivedDenial = (reason: unknown): boolean => String(reason ?? "").includes(PROJECT_ARCHIVED_CODE);

/** The one response every archived-write refusal uses: 409, a stable code, a fixed message. */
export const projectArchivedResponse = () =>
  Response.json({ ok: false, error: PROJECT_ARCHIVED_MESSAGE, code: PROJECT_ARCHIVED_CODE }, { status: 409 });
