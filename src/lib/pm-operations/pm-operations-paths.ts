/**
 * Canonical PM Operations route construction — ONE definition.
 *
 * WHY THIS SURFACE IS NOT A "COMMAND CENTER"
 * ------------------------------------------
 * ADR-PMF-014 Rule 6 rules that internal/ops-only surfaces "must not use the
 * same unqualified phrase as a user-facing feature; if retained, such surfaces
 * need their own, clearly internal name." It names THIS route as its example.
 * `02-canonical-product-language.md` §27 carries the same item as a pending
 * migration: "Rename or remove the unrelated `/pmo-command-center` internal
 * dashboard."
 *
 * The rename is not cosmetic — the two surfaces are differently scoped, and the
 * shared words actively mislead about which entity is being projected:
 *
 *   - THIS surface aggregates a workspace's PROJECT MANAGERS. Its data layer
 *     (`getPMOCommandCenter`) takes a `workspaceId` and NO `pmoId` at all; it
 *     fans out over `listProjectManagers(workspaceId)` to build one operating
 *     dossier per PM — capacity, performance, evidence confidence. It never
 *     reads the `pmos` table.
 *   - The user-facing PMO Command Center named by the canonical route map is a
 *     projection over ONE `pmos` entity, at
 *     `/workspaces/[workspaceId]/pmos/[pmoId]/command-center`.
 *     `03-screen-catalog.md` declares it "structurally and visually distinct
 *     from the internal `/pmo-command-center` ops dashboard ... out of this
 *     user-facing catalog's scope entirely."
 *
 * So this is a RENAME of an internal surface, NOT a route migration toward the
 * canonical map. Nothing here is a step toward the PMO Command Center: that
 * screen does not exist yet, and this route was never it. Reading this rename as
 * "the PMO Command Center got migrated" is the precise confusion Rule 6 exists
 * to prevent, which is why the reasoning is recorded here rather than in a
 * commit message.
 *
 * `/pm-operations` joins the existing internal `pm-*` family — `/pm-registry`,
 * `/pm-capacity`, `/pm-performance` — which are exactly the three surfaces this
 * dashboard is built from and already links to.
 *
 * Keeping the literal in one module is what makes the rename reversible:
 * reverting is reverting the callers of this constant, not hunting strings
 * (ADR-PMF-068 rule 5).
 */

export const PM_OPERATIONS_PATH = "/pm-operations";

/**
 * The pre-rename path, retained as a redirect-only entry point.
 *
 * It is kept for the same reason the Command Center slice kept its legacy
 * entry: bookmarks and in-flight links predate the rename, and a dead internal
 * URL is indistinguishable to an operator from a broken dashboard. It renders a
 * redirect and nothing else — never a second copy of the screen, which is what
 * would let the two drift (ADR-PMF-068 rule 2, strangler seam).
 *
 * Unlike the Command Center legacy entry this forwards no query parameters,
 * because the screen reads none: it takes no route params and no search params,
 * and fetches its whole view from `/api/pmo-command-center`. Forwarding keys the
 * destination does not read would be inventing a contract, not preserving one.
 */
export const PM_OPERATIONS_LEGACY_PATH = "/pmo-command-center";
