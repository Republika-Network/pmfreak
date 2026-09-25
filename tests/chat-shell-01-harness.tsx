/**
 * CHAT-SHELL-01 — render harness for the conversation-first shell.
 *
 * Executed by `tests/chat-shell-01-conversation-first-shell.test.mjs` through tsx (the
 * repository's pattern for asserting REAL renders rather than source text). It mounts the
 * real `OperationalShell` router under Next's pathname context, the real context tree from
 * the real tree model, the real project conversation and the real chat surfaces, and
 * prints one JSON document describing what a user would see.
 */

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { OperationalShell } from "../src/components/pmfreak/operational-shell";
import { ContextTreeView } from "../src/components/pmfreak/conversation-shell/context-tree";
import { buildContextTree, flattenVisible, routeExpandedKeys, type BranchState } from "../src/components/pmfreak/conversation-shell/context-tree-model";
import { ProjectBrainConversation } from "../src/components/pmfreak/project-brain/project-brain-conversation";
import { ContextChatPanel } from "../src/components/pmfreak/chat/context-chat-panel";
import { resolveConversationScope, type TreeWorkspace } from "../src/lib/navigation/conversation-shell-scope";

const noopRouter = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  hmrRefresh: () => {},
};

function withPathname(pathname: string, node: ReactNode): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AppRouterContext.Provider value={noopRouter as any}>
      <PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const USER = { fullName: "Ana PM", role: "owner", companyName: "Republika" };
const PAGE = <div data-testid="page-content">page</div>;

function shellAt(pathname: string) {
  const markup = withPathname(pathname, <OperationalShell user={USER} workspaceId="ws-a">{PAGE}</OperationalShell>);
  return {
    shell: /data-shell="([a-z-]+)"/.exec(markup)?.[1] ?? null,
    shellCount: (markup.match(/data-shell="/g) ?? []).length,
    hasNavigator: markup.includes('data-testid="conversation-shell-navigator"'),
    hasLegacyRail: markup.includes('aria-label="Primary navigation"'),
    hasDiscoveryPanel: markup.includes("Discovery Summary"),
    fillsCenter: /data-testid="conversation-shell-center"[^>]*data-fills-center="true"/.test(markup),
    shellTopBar: markup.includes('aria-label="Open navigation"'),
    leftDrawer: (() => {
      const at = markup.indexOf('data-testid="shell-drawer-left"');
      return at < 0 ? null : markup.slice(markup.lastIndexOf("<div", at), markup.indexOf(">", at) + 1);
    })(),
    drawerDialog: /role="dialog" aria-modal="true" aria-label="Navigation"/.test(markup),
    treeSkeleton: markup.includes('data-testid="context-tree-skeleton"'),
    pageRendered: markup.includes('data-testid="page-content"'),
    moreNavigation: markup.includes("More in PMFreak"),
    signOutIsPost: /<form[^>]*action="\/logout"[^>]*method="post"/.test(markup),
  };
}

// ── Context tree fixtures: two workspaces, the real persisted relationships ──

const WORKSPACES: TreeWorkspace[] = [
  { id: "ws-a", name: "Acme", status: "active", sessionActive: true },
  { id: "ws-b", name: "Beta Corp", status: "active", sessionActive: false },
  { id: "ws-c", name: "Old Co", status: "archived", sessionActive: false },
];

const BRANCHES: Record<string, BranchState> = {
  "ws-a": {
    status: "ready",
    pmos: [
      { id: "pmo-delivery", name: "Delivery PMO", icon: null, status: "active" },
      { id: "pmo-empty", name: "Empty PMO", icon: "🏛️", status: "active" },
    ],
    projects: [
      { id: "p-frontera", name: "Frontera Governed Machine Payments", status: "active", pmoId: "pmo-delivery" },
      { id: "p-other", name: "Other Project", status: "active", pmoId: "pmo-delivery" },
      { id: "p-direct", name: "Direct Project", status: "active", pmoId: null },
      { id: "p-archived", name: "Archived Project", status: "archived", pmoId: null },
      // A pmo_id this read did not return: never re-parented under a PMO we cannot show.
      { id: "p-orphan", name: "Orphaned Link Project", status: "active", pmoId: "pmo-not-visible" },
    ],
  },
  // Workspace B's rows are loaded too — and must never appear under A.
  "ws-b": {
    status: "ready",
    pmos: [{ id: "pmo-b", name: "Beta PMO", icon: null, status: "active" }],
    projects: [{ id: "p-beta", name: "Beta Secret Project", status: "active", pmoId: "pmo-b" }],
  },
};

function treeFor(pathname: string, extraExpanded: string[] = []) {
  const scope = resolveConversationScope(pathname);
  const expanded = routeExpandedKeys(scope, WORKSPACES, BRANCHES);
  for (const key of extraExpanded) expanded.add(key);
  const nodes = buildContextTree({ workspaces: WORKSPACES, branches: BRANCHES, expanded, scope });
  const markup = renderToStaticMarkup(<ContextTreeView nodes={nodes} onToggle={() => {}} />);
  const items = [...markup.matchAll(/<(a|div)\b([^>]*role="treeitem"[^>]*)>/g)].map((match) => {
    const attrs = match[2];
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    return {
      element: match[1],
      key: attr("data-tree-key"),
      kind: attr("data-tree-kind"),
      level: attr("aria-level"),
      expanded: attr("aria-expanded"),
      selected: attr("aria-selected"),
      current: attr("aria-current"),
      tabIndex: attr("tabindex") ?? attr("tabIndex"),
      href: attr("href"),
    };
  });
  return {
    markup,
    items,
    visible: flattenVisible(nodes).map((node) => ({ key: node.key, parentKey: node.parentKey, expandable: node.expandable, expanded: node.expanded })),
    groupCount: (markup.match(/role="group"/g) ?? []).length,
  };
}

const conversationSurface = renderToStaticMarkup(
  <div style={{ height: 600 }}>
    <ProjectBrainConversation projectId="p-frontera" projectName="Frontera Governed Machine Payments" variant="light" layout="surface" />
  </div>,
);
const conversationPanel = renderToStaticMarkup(
  <ProjectBrainConversation projectId="p-frontera" projectName="Frontera Governed Machine Payments" variant="dark" />,
);
const workspaceChatSurface = renderToStaticMarkup(
  <ContextChatPanel contextType="workspace" layout="surface" title="Workspace Conversation" subtitle="s" />,
);
const workspaceChatCard = renderToStaticMarkup(<ContextChatPanel contextType="workspace" title="Workspace Conversation" subtitle="s" />);

process.stdout.write(
  JSON.stringify(
    {
      shells: {
        projectConversation: shellAt("/workspaces/ws-a/projects/p-frontera"),
        projectOverview: shellAt("/workspaces/ws-a/projects/p-frontera/overview"),
        projectCommandCenter: shellAt("/workspaces/ws-a/projects/p-frontera/command-center"),
        workspaceHome: shellAt("/workspaces/ws-a"),
        workspaceCommandCenter: shellAt("/workspaces/ws-a/command-center"),
        pmoChat: shellAt("/workspaces/ws-a/pmos/pmo-delivery/chat"),
        workspaceChat: shellAt("/chat"),
        portfolio: shellAt("/portfolio"),
        projectsIndex: shellAt("/projects"),
        legacyCommandCenter: shellAt("/command-center"),
        setup: shellAt("/workspace/setup"),
      },
      trees: {
        onFrontera: treeFor("/workspaces/ws-a/projects/p-frontera"),
        onFronteraOverview: treeFor("/workspaces/ws-a/projects/p-frontera/overview"),
        onOther: treeFor("/workspaces/ws-a/projects/p-other"),
        onDirect: treeFor("/workspaces/ws-a/projects/p-direct"),
        onPmoChat: treeFor("/workspaces/ws-a/pmos/pmo-delivery/chat"),
        onWorkspaceChat: treeFor("/chat"),
        onBeta: treeFor("/workspaces/ws-b/projects/p-beta"),
        // A route naming a workspace the caller is not a member of highlights nothing.
        onForeign: treeFor("/workspaces/ws-zzz/projects/p-zzz"),
        withBetaExpandedToo: treeFor("/workspaces/ws-a/projects/p-frontera", ["ws:ws-b", "pmo:pmo-b"]),
      },
      conversation: {
        surface: conversationSurface,
        panel: conversationPanel,
      },
      contextChat: {
        surface: workspaceChatSurface,
        card: workspaceChatCard,
      },
    },
    null,
    2,
  ),
);
