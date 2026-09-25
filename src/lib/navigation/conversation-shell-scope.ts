/**
 * CHAT-SHELL-01 — the conversation-first shell's ONE active-context model.
 *
 * The shell used to derive "where am I" three times over: the outer rail read
 * `?projectId=` and localStorage, the PMO tree parsed the pathname, and the
 * Command Center kept its own selected-project state. They could — and did —
 * disagree. Here the ROUTE is the only input. Every canonical URL already names
 * its workspace, PMO and project, so the active scope is a pure reading of the
 * pathname and nothing else: no cookie, no storage, no component state.
 *
 * A scope is NEVER authority. Every id below is the UNAUTHORIZED HINT the path
 * parsers return; the pages that render these routes re-authorize them with
 * `resolveRoutedWorkspace` / `resolveRoutedPmo` / `resolveRoutedProject`, which
 * have no fallback. The shell uses a scope only to decide what to highlight and
 * which chrome to draw, and a wrong hint can at worst highlight nothing.
 */

import { parseCanonicalPmoRoute, type PmoSurface } from "@/lib/pmos/pmo-paths";
import { parseCanonicalProjectRoute, type ProjectSurface } from "@/lib/projects/project-paths";
import { parseCanonicalWorkspaceRoute, type WorkspaceSurface } from "@/lib/workspaces/workspace-paths";

/** The session-scoped Workspace Chat. It names no workspace in its URL (see the tree). */
export const WORKSPACE_CHAT_PATH = "/chat";

export type ConversationScope =
  | { kind: "project"; workspaceId: string; projectId: string; surface: ProjectSurface }
  | { kind: "pmo"; workspaceId: string; pmoId: string; surface: PmoSurface }
  | { kind: "workspace"; workspaceId: string; surface: WorkspaceSurface }
  | { kind: "workspace-chat" };

/**
 * Which scope a pathname addresses, or `null` when it is not a surface of the
 * conversation-first shell.
 *
 * Project is tried before PMO before Workspace, most specific first: every
 * canonical PMO and Project path also begins `/workspaces/<id>/`, and the
 * workspace parser refuses them anyway, but the order states the intent.
 */
export function resolveConversationScope(pathname: string): ConversationScope | null {
  const path = stripQuery(pathname);
  if (path === WORKSPACE_CHAT_PATH || path === `${WORKSPACE_CHAT_PATH}/`) return { kind: "workspace-chat" };

  const project = parseCanonicalProjectRoute(path);
  if (project) return { kind: "project", workspaceId: project.workspaceId, projectId: project.projectId, surface: project.surface };

  const pmo = parseCanonicalPmoRoute(path);
  if (pmo) return { kind: "pmo", workspaceId: pmo.workspaceId, pmoId: pmo.pmoId, surface: pmo.surface };

  const workspace = parseCanonicalWorkspaceRoute(path);
  if (workspace) return { kind: "workspace", workspaceId: workspace.workspaceId, surface: workspace.surface };

  return null;
}

/**
 * Does this pathname render inside the conversation-first shell?
 *
 * Exactly the canonical Workspace → PMO → Project family plus Workspace Chat —
 * the routes the context tree navigates between. Keeping the tree's own
 * destinations inside one shell is what stops a click in the tree from
 * swapping the whole navigation system out from under the user. Everything else
 * keeps the operational rail shell for now (see CHAT-SHELL-01's known limits).
 */
export function isConversationShellPath(pathname: string): boolean {
  return resolveConversationScope(pathname) !== null;
}

function stripQuery(pathname: string): string {
  const cut = pathname.search(/[?#]/);
  return cut === -1 ? pathname : pathname.slice(0, cut);
}

// ── The context tree's data model ───────────────────────────────────────────

export type TreeWorkspace = {
  id: string;
  name: string;
  status: string;
  /** True for the session's active (preferred) workspace — the one `/chat` answers for. */
  sessionActive: boolean;
};

export type TreePmo = { id: string; name: string; icon: string | null; status: string };

export type TreeProject = { id: string; name: string; status: string; pmoId: string | null };

/**
 * One workspace's branch, shaped from the REAL persisted relationships:
 * `projects.workspace_id` is the mandatory parent, `projects.pmo_id` an optional
 * one. A project with no PMO sits directly under its workspace — it is never
 * filed under an invented "Unassigned PMO", and there is no Portfolio level,
 * because a portfolio (`personal_portfolios`) is a per-user lens over projects
 * that owns none of them.
 */
export type WorkspaceBranch = {
  pmos: Array<TreePmo & { projects: TreeProject[] }>;
  directProjects: TreeProject[];
};

export function buildWorkspaceBranch(pmos: TreePmo[], projects: TreeProject[]): WorkspaceBranch {
  const known = new Set(pmos.map((pmo) => pmo.id));
  const byPmo = new Map<string, TreeProject[]>();
  const directProjects: TreeProject[] = [];
  for (const project of projects) {
    // A `pmo_id` whose PMO this read did not return (not visible to the caller)
    // is not re-parented anywhere: filing it under a PMO we could not show would
    // be a relationship we never established. It is listed directly under its
    // workspace, which IS established — `projects.workspace_id` is the scope of
    // the read that returned it.
    if (project.pmoId && known.has(project.pmoId)) {
      const bucket = byPmo.get(project.pmoId) ?? [];
      bucket.push(project);
      byPmo.set(project.pmoId, bucket);
    } else {
      directProjects.push(project);
    }
  }
  return {
    pmos: pmos.map((pmo) => ({ ...pmo, projects: byPmo.get(pmo.id) ?? [] })),
    directProjects,
  };
}

/**
 * A conversation that belongs to a scope.
 *
 * PB-CHAT-01 gives a project exactly ONE persisted Project Brain thread, and the
 * tree renders exactly that — this list has one entry per scope today. It is a
 * list, not a boolean, so named threads can be added later as data without a
 * second shell rewrite. Nothing here creates a thread: the entry is only a link
 * to the scope's canonical conversation surface.
 */
export type ScopeConversation = { key: string; label: string; href: string };
