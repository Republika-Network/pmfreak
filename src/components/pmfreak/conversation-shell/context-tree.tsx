"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { flattenVisible, treeKeyAction, type TreeNode } from "./context-tree-model";

/**
 * CHAT-SHELL-01 — the ONE left-side navigator: Workspace → PMO → Project →
 * Conversation, as a WAI-ARIA tree.
 *
 * Keyboard (the tree pattern): one item is in the tab order at a time (roving
 * tabindex); ↑/↓ move between visible items, → opens a group or enters it,
 * ← closes a group or returns to its parent, Home/End jump to the ends, and
 * Enter/Space open a group or follow a link.
 *
 * Group rows (workspace, PMO) toggle; they are not links, so a treeitem never
 * nests a second interactive control. Each group's home screen is its own leaf
 * ("Workspace overview", "PMO overview") beside its conversation.
 */
export function ContextTreeView({
  nodes,
  onToggle,
  onNavigate,
  label = "Workspaces, projects and conversations",
}: {
  nodes: TreeNode[];
  onToggle: (key: string, open?: boolean) => void;
  /** Called after a link is followed — the mobile drawer closes on it. */
  onNavigate?: () => void;
  label?: string;
}) {
  const visible = flattenVisible(nodes);
  const items = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // The roving tab stop: the item last focused, else the current page, else the first row.
  const tabStop =
    (focusKey && visible.some((node) => node.key === focusKey) ? focusKey : null) ??
    visible.find((node) => node.current)?.key ??
    visible.find((node) => node.inActivePath && node.kind === "project")?.key ??
    visible[0]?.key ??
    null;

  const focus = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    items.current.get(key)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const currentKey = (event.target as HTMLElement).dataset.treeKey;
    if (!currentKey) return;
    const result = treeKeyAction(visible, currentKey, event.key);
    if (!result.handled) return;
    event.preventDefault();
    if (result.toggle) onToggle(result.toggle.key, result.toggle.open);
    if (result.focus) focus(result.focus);
    // Space follows a link in a tree just as Enter does natively.
    if (result.activate) items.current.get(currentKey)?.click();
  };

  return (
    <ul role="tree" aria-label={label} onKeyDown={onKeyDown} className="space-y-0.5" data-testid="context-tree">
      {nodes.map((node) => (
        <TreeRow
          key={node.key}
          node={node}
          tabStop={tabStop}
          register={(key, element) => {
            if (element) items.current.set(key, element);
            else items.current.delete(key);
          }}
          onFocusItem={setFocusKey}
          onToggle={onToggle}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  tabStop,
  register,
  onFocusItem,
  onToggle,
  onNavigate,
}: {
  node: TreeNode;
  tabStop: string | null;
  register: (key: string, element: HTMLElement | null) => void;
  onFocusItem: (key: string) => void;
  onToggle: (key: string, open?: boolean) => void;
  onNavigate?: () => void;
}) {
  if (node.kind === "notice") {
    return (
      <li role="none" className="py-1 text-[12px] text-slate-400" style={{ paddingLeft: indent(node.level) + 22 }} data-tree-notice>
        {node.label}
      </li>
    );
  }

  const archived = node.status === "archived";
  const tone = node.current
    ? "bg-white font-medium text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-slate-200"
    : node.inActivePath && (node.kind === "project" || node.kind === "workspace" || node.kind === "pmo")
      ? "font-medium text-slate-900 hover:bg-white/70"
      : archived
        ? "text-slate-400 hover:bg-white/70 hover:text-slate-600"
        : "text-slate-600 hover:bg-white/70 hover:text-slate-900";
  const rowClass = `group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[13px] leading-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-500/60 ${tone}`;
  const common = {
    role: "treeitem" as const,
    "aria-level": node.level,
    "aria-selected": node.current || (node.inActivePath && node.kind === "project") ? true : undefined,
    tabIndex: node.key === tabStop ? 0 : -1,
    "data-tree-key": node.key,
    "data-tree-kind": node.kind,
    "data-active": node.inActivePath ? "true" : undefined,
    onFocus: () => onFocusItem(node.key),
    style: { paddingLeft: indent(node.level) },
    className: rowClass,
  };

  const content = (
    <>
      {node.expandable ? (
        <Chevron open={node.expanded} />
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
      <NodeIcon node={node} />
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      {archived ? <span className="shrink-0 rounded border border-slate-200 px-1 text-[10px] uppercase tracking-wide text-slate-400">Archived</span> : null}
    </>
  );

  const group = node.children.length > 0 ? (
    <ul role="group" className="space-y-0.5">
      {node.children.map((child) => (
        <TreeRow key={child.key} node={child} tabStop={tabStop} register={register} onFocusItem={onFocusItem} onToggle={onToggle} onNavigate={onNavigate} />
      ))}
    </ul>
  ) : null;

  if (node.expandable) {
    return (
      <li role="none">
        <div
          {...common}
          ref={(element) => register(node.key, element)}
          aria-expanded={node.expanded}
          onClick={() => onToggle(node.key)}
        >
          {content}
        </div>
        {node.expanded ? group : null}
      </li>
    );
  }

  return (
    <li role="none">
      <Link
        {...common}
        href={node.href ?? "#"}
        ref={(element) => register(node.key, element)}
        aria-current={node.current ? "page" : undefined}
        aria-expanded={node.children.length > 0 ? true : undefined}
        onClick={() => onNavigate?.()}
      >
        {content}
      </Link>
      {group}
    </li>
  );
}

function indent(level: number): number {
  return 6 + (level - 1) * 14;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NodeIcon({ node }: { node: TreeNode }) {
  const cls = `h-4 w-4 shrink-0 ${node.current || node.inActivePath ? "text-cyan-700" : "text-slate-400"}`;
  if (node.kind === "pmo" && node.icon) {
    return <span aria-hidden className="w-4 shrink-0 text-center text-[13px] leading-none">{node.icon}</span>;
  }
  switch (node.kind) {
    case "workspace":
      return (
        <svg aria-hidden viewBox="0 0 16 16" className={cls}>
          <path d="M2.5 13.5V4.5l5.5-2 5.5 2v9M6 13.5v-3h4v3M5 6.5h1M10 6.5h1M5 8.5h1M10 8.5h1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "pmo":
      return (
        <svg aria-hidden viewBox="0 0 16 16" className={cls}>
          <path d="M8 2.5l5.5 3L8 8.5l-5.5-3 5.5-3zM2.5 8.5L8 11.5l5.5-3M2.5 11L8 14l5.5-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "project":
      return (
        <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
          <span className={`h-2 w-2 rounded-full ${node.inActivePath ? "bg-cyan-600" : "border border-slate-400"}`} />
        </span>
      );
    case "conversation":
      return (
        <svg aria-hidden viewBox="0 0 16 16" className={cls}>
          <path d="M3 3.5h10a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 2.5v-2.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden viewBox="0 0 16 16" className={cls}>
          <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
  }
}
