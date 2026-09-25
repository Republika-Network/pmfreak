/**
 * CHAT-SHELL-01 — the context tree as data.
 *
 * Pure: it turns the navigation read (`GET /api/navigation/context-tree`) plus
 * the route-derived scope into the nodes the tree renders. Nothing here fetches,
 * reads storage or decides access — the rows it is given are the rows the
 * caller's own session was allowed to read, and the scope only decides what is
 * highlighted.
 */

import {
  WORKSPACE_CHAT_PATH,
  buildWorkspaceBranch,
  type ConversationScope,
  type ScopeConversation,
  type TreePmo,
  type TreeProject,
  type TreeWorkspace,
} from "@/lib/navigation/conversation-shell-scope";
import { pmoChatPath, pmoHomePath } from "@/lib/pmos/pmo-paths";
import { projectHomePath } from "@/lib/projects/project-paths";
import { workspaceHomePath } from "@/lib/workspaces/workspace-paths";

export type BranchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; pmos: TreePmo[]; projects: TreeProject[] };

export type TreeNodeKind = "workspace" | "pmo" | "project" | "conversation" | "overview" | "notice";

export type TreeNode = {
  /** Stable, unique across the whole tree. */
  key: string;
  kind: TreeNodeKind;
  label: string;
  /** Present for navigable nodes. Group nodes (workspace, PMO) toggle instead. */
  href: string | null;
  level: number;
  /** Only group nodes are expandable. */
  expandable: boolean;
  expanded: boolean;
  /** The node the current route IS — exactly one at most. */
  current: boolean;
  /** An ancestor of the current node, or the scope the current page belongs to. */
  inActivePath: boolean;
  status: string | null;
  icon: string | null;
  children: TreeNode[];
};

export const workspaceNodeKey = (workspaceId: string) => `ws:${workspaceId}`;
export const pmoNodeKey = (pmoId: string) => `pmo:${pmoId}`;
export const projectNodeKey = (projectId: string) => `project:${projectId}`;

/**
 * The conversations a project carries. PB-CHAT-01: exactly one, the canonical
 * Project Brain thread, addressed by the project's own conversation surface.
 */
export function projectConversations(workspaceId: string, projectId: string): ScopeConversation[] {
  return [{ key: "project-brain", label: "Project Brain", href: projectHomePath(workspaceId, projectId) }];
}

/** The workspace an active scope belongs to, when the scope names one (or the session's, for `/chat`). */
export function scopeWorkspaceId(scope: ConversationScope | null, workspaces: TreeWorkspace[]): string | null {
  if (!scope) return null;
  if (scope.kind === "workspace-chat") return workspaces.find((workspace) => workspace.sessionActive)?.id ?? null;
  return scope.workspaceId;
}

/**
 * Which group nodes the route itself opens: the active workspace, and the PMO
 * that owns the active project (or is the active PMO). The user's own toggles
 * are layered on top by the caller.
 */
export function routeExpandedKeys(
  scope: ConversationScope | null,
  workspaces: TreeWorkspace[],
  branches: Record<string, BranchState>,
): Set<string> {
  const keys = new Set<string>();
  const workspaceId = scopeWorkspaceId(scope, workspaces);
  if (!workspaceId) return keys;
  keys.add(workspaceNodeKey(workspaceId));
  if (scope?.kind === "pmo") keys.add(pmoNodeKey(scope.pmoId));
  if (scope?.kind === "project") {
    const branch = branches[workspaceId];
    const pmoId = branch?.status === "ready" ? branch.projects.find((project) => project.id === scope.projectId)?.pmoId : null;
    if (pmoId) keys.add(pmoNodeKey(pmoId));
  }
  return keys;
}

export function buildContextTree(input: {
  workspaces: TreeWorkspace[];
  branches: Record<string, BranchState>;
  /** Keys of expanded group nodes (route-derived ∪ user toggles, minus user collapses). */
  expanded: Set<string>;
  scope: ConversationScope | null;
}): TreeNode[] {
  const { workspaces, branches, expanded, scope } = input;
  const activeWorkspaceId = scopeWorkspaceId(scope, workspaces);

  return workspaces.map((workspace) => {
    const key = workspaceNodeKey(workspace.id);
    const isExpanded = expanded.has(key);
    const inWorkspace = workspace.id === activeWorkspaceId;
    const children: TreeNode[] = [];

    if (isExpanded) {
      // Workspace Chat is session-scoped (`/chat` answers for the preferred
      // workspace and its URL names none), so it is offered only under the
      // workspace it will actually open. Offering it elsewhere would open a
      // different workspace's conversation than the one it is filed under.
      if (workspace.sessionActive) {
        children.push(
          leaf({
            key: `${key}:chat`,
            kind: "conversation",
            label: "Workspace chat",
            href: WORKSPACE_CHAT_PATH,
            level: 2,
            current: scope?.kind === "workspace-chat",
          }),
        );
      }
      children.push(
        leaf({
          key: `${key}:overview`,
          kind: "overview",
          label: "Workspace overview",
          href: workspaceHomePath(workspace.id),
          level: 2,
          current: scope?.kind === "workspace" && scope.workspaceId === workspace.id && scope.surface === "home",
        }),
      );

      const branch = branches[workspace.id];
      if (!branch || branch.status === "loading") {
        children.push(notice(`${key}:loading`, "Loading projects…", 2));
      } else if (branch.status === "error") {
        children.push(notice(`${key}:error`, "Projects couldn't be loaded.", 2));
      } else {
        const shaped = buildWorkspaceBranch(branch.pmos, branch.projects);
        for (const pmo of shaped.pmos) children.push(pmoNode(workspace.id, pmo, pmo.projects, expanded, scope));
        for (const project of shaped.directProjects) children.push(projectNode(workspace.id, project, 2, scope));
        if (shaped.pmos.length === 0 && shaped.directProjects.length === 0) {
          children.push(notice(`${key}:empty`, "No projects yet", 2));
        }
      }
    }

    return {
      key,
      kind: "workspace",
      label: workspace.name,
      href: null,
      level: 1,
      expandable: true,
      expanded: isExpanded,
      current: false,
      inActivePath: inWorkspace,
      status: workspace.status,
      icon: null,
      children,
    };
  });
}

function pmoNode(
  workspaceId: string,
  pmo: TreePmo,
  projects: TreeProject[],
  expanded: Set<string>,
  scope: ConversationScope | null,
): TreeNode {
  const key = pmoNodeKey(pmo.id);
  const isExpanded = expanded.has(key);
  const pmoScope = scope?.kind === "pmo" && scope.pmoId === pmo.id ? scope : null;
  const ownsActiveProject = scope?.kind === "project" && projects.some((project) => project.id === scope.projectId);
  const children: TreeNode[] = [];
  if (isExpanded) {
    children.push(
      leaf({ key: `${key}:chat`, kind: "conversation", label: "PMO chat", href: pmoChatPath(workspaceId, pmo.id), level: 3, current: pmoScope?.surface === "chat" }),
      leaf({ key: `${key}:overview`, kind: "overview", label: "PMO overview", href: pmoHomePath(workspaceId, pmo.id), level: 3, current: pmoScope?.surface === "home" }),
    );
    for (const project of projects) children.push(projectNode(workspaceId, project, 3, scope));
    if (projects.length === 0) children.push(notice(`${key}:empty`, "No projects in this PMO", 3));
  }
  return {
    key,
    kind: "pmo",
    label: pmo.name,
    href: null,
    level: 2,
    expandable: true,
    expanded: isExpanded,
    current: false,
    inActivePath: Boolean(pmoScope) || ownsActiveProject,
    status: pmo.status,
    icon: pmo.icon,
    children,
  };
}

function projectNode(workspaceId: string, project: TreeProject, level: number, scope: ConversationScope | null): TreeNode {
  const active = scope?.kind === "project" && scope.projectId === project.id;
  // The active project shows the conversation(s) it carries, so the tree says
  // which conversation is open, not only which project.
  const children = active
    ? projectConversations(workspaceId, project.id).map((conversation) =>
        leaf({
          key: `${projectNodeKey(project.id)}:${conversation.key}`,
          kind: "conversation",
          label: conversation.label,
          href: conversation.href,
          level: level + 1,
          current: scope.surface === "home",
        }),
      )
    : [];
  return {
    key: projectNodeKey(project.id),
    kind: "project",
    label: project.name,
    href: projectHomePath(workspaceId, project.id),
    level,
    expandable: false,
    expanded: false,
    // A project row is "current" on its secondary surfaces (overview, operational
    // overview); on the conversation itself the conversation leaf is.
    current: active && scope.surface !== "home",
    inActivePath: active,
    status: project.status,
    icon: null,
    children,
  };
}

function leaf(input: { key: string; kind: TreeNodeKind; label: string; href: string; level: number; current: boolean }): TreeNode {
  return { ...input, expandable: false, expanded: false, inActivePath: input.current, status: null, icon: null, children: [] };
}

function notice(key: string, label: string, level: number): TreeNode {
  return { key, kind: "notice", label, href: null, level, expandable: false, expanded: false, current: false, inActivePath: false, status: null, icon: null, children: [] };
}

/** Every node a keyboard user can currently reach, in visual order. Notices are text, not items. */
export function flattenVisible(nodes: TreeNode[], parentKey: string | null = null): Array<TreeNode & { parentKey: string | null }> {
  const out: Array<TreeNode & { parentKey: string | null }> = [];
  for (const node of nodes) {
    if (node.kind !== "notice") out.push({ ...node, parentKey });
    if (node.children.length > 0) out.push(...flattenVisible(node.children, node.key));
  }
  return out;
}

export type TreeKeyResult = { focus?: string; toggle?: { key: string; open?: boolean }; activate?: boolean; handled: boolean };

/**
 * The WAI-ARIA tree keyboard contract, as a pure function of the visible rows:
 * ↑/↓ move, Home/End jump, → opens a group or enters it, ← closes a group or
 * returns to the parent, Enter/Space toggle a group or activate a link.
 */
export function treeKeyAction(visible: Array<TreeNode & { parentKey: string | null }>, currentKey: string, key: string): TreeKeyResult {
  const index = visible.findIndex((node) => node.key === currentKey);
  if (index === -1) return { handled: false };
  const node = visible[index];
  switch (key) {
    case "ArrowDown":
      return { focus: visible[index + 1]?.key, handled: true };
    case "ArrowUp":
      return { focus: visible[index - 1]?.key, handled: true };
    case "Home":
      return { focus: visible[0]?.key, handled: true };
    case "End":
      return { focus: visible[visible.length - 1]?.key, handled: true };
    case "ArrowRight":
      if (node.expandable && !node.expanded) return { toggle: { key: node.key, open: true }, handled: true };
      return { focus: visible[index + 1]?.parentKey === node.key ? visible[index + 1].key : undefined, handled: true };
    case "ArrowLeft":
      if (node.expandable && node.expanded) return { toggle: { key: node.key, open: false }, handled: true };
      return { focus: node.parentKey ?? undefined, handled: true };
    case "Enter":
      // A link follows itself natively on Enter; only a group needs handling.
      return node.expandable ? { toggle: { key: node.key }, handled: true } : { handled: false };
    case " ":
      return node.expandable ? { toggle: { key: node.key }, handled: true } : { activate: true, handled: true };
    default:
      return { handled: false };
  }
}
