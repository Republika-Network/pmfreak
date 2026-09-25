"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationScope, TreePmo, TreeProject, TreeWorkspace } from "@/lib/navigation/conversation-shell-scope";
import { buildContextTree, routeExpandedKeys, scopeWorkspaceId, type BranchState, type TreeNode } from "./context-tree-model";

const TREE_ENDPOINT = "/api/navigation/context-tree";
/**
 * The user's own expand/collapse choices. A per-browser CONVENIENCE only: it
 * decides which rows are open, never which rows exist — every row still comes
 * from the server read, scoped by the caller's own session.
 */
const TOGGLES_STORAGE_KEY = "pmfreak.contextTree.toggles";

type WorkspacesState = { status: "loading" } | { status: "error" } | { status: "ready"; workspaces: TreeWorkspace[] };

function readStoredToggles(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(TOGGLES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * The context tree's data, owned ONCE by the shell and shared by the desktop
 * sidebar and the mobile drawer, so the two can never show different trees and
 * the navigation read is never issued twice.
 *
 * Loading is lazy by level: the workspace list first, then a workspace's PMOs
 * and projects only when that workspace is expanded. No operational read of any
 * kind happens here.
 */
export function useContextTreeData(scope: ConversationScope | null) {
  const [workspacesState, setWorkspacesState] = useState<WorkspacesState>({ status: "loading" });
  const [branches, setBranches] = useState<Record<string, BranchState>>({});
  const [toggles, setToggles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Hydrate after mount: storage is not available during the server render, and
    // reading it in the initial state would make the two renders disagree.
    const stored = readStoredToggles();
    if (Object.keys(stored).length > 0) queueMicrotask(() => setToggles(stored));
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesState({ status: "loading" });
    try {
      const res = await fetch(TREE_ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { workspaces?: TreeWorkspace[] };
      setWorkspacesState({ status: "ready", workspaces: data.workspaces ?? [] });
    } catch {
      setWorkspacesState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadWorkspaces());
  }, [loadWorkspaces]);

  const loadBranch = useCallback(async (workspaceId: string) => {
    setBranches((current) => ({ ...current, [workspaceId]: { status: "loading" } }));
    try {
      const res = await fetch(`${TREE_ENDPOINT}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { pmos?: TreePmo[]; projects?: TreeProject[] };
      setBranches((current) => ({ ...current, [workspaceId]: { status: "ready", pmos: data.pmos ?? [], projects: data.projects ?? [] } }));
    } catch {
      setBranches((current) => ({ ...current, [workspaceId]: { status: "error" } }));
    }
  }, []);

  const workspaces = useMemo(() => (workspacesState.status === "ready" ? workspacesState.workspaces : []), [workspacesState]);

  const routeKeys = useMemo(() => routeExpandedKeys(scope, workspaces, branches), [scope, workspaces, branches]);
  const routeKeyList = useMemo(() => [...routeKeys].sort().join("|"), [routeKeys]);

  // Arriving somewhere reveals it: a row the user collapsed earlier is reopened
  // when the route moves inside it, or the active project could sit hidden.
  useEffect(() => {
    if (!routeKeyList) return;
    const keys = routeKeyList.split("|");
    queueMicrotask(() =>
      setToggles((current) => {
        if (!keys.some((key) => current[key] === false)) return current;
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      }),
    );
  }, [routeKeyList]);

  const expanded = useMemo(() => {
    const keys = new Set(routeKeys);
    for (const [key, open] of Object.entries(toggles)) {
      if (open) keys.add(key);
      else keys.delete(key);
    }
    return keys;
  }, [routeKeys, toggles]);

  // Fetch the branch of every expanded workspace once.
  useEffect(() => {
    for (const workspace of workspaces) {
      if (expanded.has(`ws:${workspace.id}`) && branches[workspace.id] === undefined) {
        queueMicrotask(() => void loadBranch(workspace.id));
      }
    }
  }, [workspaces, expanded, branches, loadBranch]);

  // A project or PMO created since the branch was read is not in it yet. When the
  // route names one the loaded branch does not hold, re-read that one branch —
  // once per route, so a genuinely unauthorized id cannot loop.
  const activeWorkspaceId = scopeWorkspaceId(scope, workspaces);
  const missingEntity =
    scope && activeWorkspaceId && branches[activeWorkspaceId]?.status === "ready"
      ? (() => {
          const branch = branches[activeWorkspaceId] as Extract<BranchState, { status: "ready" }>;
          if (scope.kind === "project") return branch.projects.some((project) => project.id === scope.projectId) ? null : `project:${scope.projectId}`;
          if (scope.kind === "pmo") return branch.pmos.some((pmo) => pmo.id === scope.pmoId) ? null : `pmo:${scope.pmoId}`;
          return null;
        })()
      : null;
  const [refreshedFor, setRefreshedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!missingEntity || !activeWorkspaceId || refreshedFor === missingEntity) return;
    queueMicrotask(() => {
      setRefreshedFor(missingEntity);
      void loadBranch(activeWorkspaceId);
    });
  }, [missingEntity, activeWorkspaceId, refreshedFor, loadBranch]);

  const toggle = useCallback(
    (key: string, open?: boolean) => {
      setToggles((current) => {
        const isOpen = expanded.has(key);
        const next = { ...current, [key]: open ?? !isOpen };
        try {
          globalThis.localStorage?.setItem(TOGGLES_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Storage is a convenience; a private window without it still navigates.
        }
        return next;
      });
    },
    [expanded],
  );

  const nodes: TreeNode[] = useMemo(
    () => buildContextTree({ workspaces, branches, expanded, scope }),
    [workspaces, branches, expanded, scope],
  );

  const hasProjects = Object.values(branches).some((branch) => branch.status === "ready" && branch.projects.length > 0);

  return {
    status: workspacesState.status,
    nodes,
    toggle,
    retry: loadWorkspaces,
    hasProjects,
  };
}

export type ContextTreeData = ReturnType<typeof useContextTreeData>;
