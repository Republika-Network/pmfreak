/**
 * CHAT-SHELL-01 — the conversation-first product shell.
 *
 * Before: the protected area rendered one light application shell (a rail carrying the
 * PMO tree plus discovery, recommended actions, tasks, schedule, critical path, portfolio
 * and evidence panels), and inside it the Workspace Command Center mounted a SECOND, dark
 * application — its own project sidebar, its own top bar, its own scrolling canvas —
 * with Project Brain as a collapsible panel at the bottom of that canvas.
 *
 * After: the canonical Workspace → PMO → Project family renders in ONE conversation
 * shell — a context tree on the left, the conversation in the centre, the Command
 * Center's tools in a rail and inspector on the right — and nothing is nested.
 *
 * Behaviour is asserted against real renders (`chat-shell-01-harness.tsx`) and the pure
 * models the components run on; route and security contracts against source, where the
 * property IS a property of the source (which resolver a page calls, which client a
 * route reads through).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildWorkspaceBranch,
  isConversationShellPath,
  resolveConversationScope,
} from "../src/lib/navigation/conversation-shell-scope.ts";
import {
  buildContextTree,
  flattenVisible,
  routeExpandedKeys,
  treeKeyAction,
} from "../src/components/pmfreak/conversation-shell/context-tree-model.ts";
import { parseProjectTool, PROJECT_TOOLS } from "../src/components/pmfreak/conversation-shell/operational-tools.ts";
import { projectBriefIndicators } from "../src/components/pmfreak/conversation-shell/project-brief-indicators.ts";
import { parseCanonicalProjectRoute, projectHomePath, projectOverviewPath } from "../src/lib/projects/project-paths.ts";

const read = (file) => readFileSync(file, "utf8");
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const harness = JSON.parse(
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/chat-shell-01-harness.tsx"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/**
 * The comparison base for "this increment did not touch X". A shallow CI checkout has
 * no `origin/main`; those checks then skip explicitly (and say so) rather than pass
 * vacuously or fail on a missing ref.
 */
const BASE_REF = (() => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
    return "origin/main";
  } catch {
    return null;
  }
})();

const PROJECT_PAGE = "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx";
const PROJECT_OVERVIEW_PAGE = "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/overview/page.tsx";
const PROJECT_CC_PAGE = "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/command-center/page.tsx";
const WORKSPACE_CC_PAGE = "src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx";
const TREE_ROUTE = "src/app/api/navigation/context-tree/route.ts";
const VIEW = "src/components/pmfreak/conversation-shell/project-conversation-view.tsx";

// ═══ 1. One shell, chosen by route ═══════════════════════════════════════════

test("the canonical project route renders ONE shell: the conversation shell", () => {
  const shell = harness.shells.projectConversation;
  assert.equal(shell.shell, "pmfreak-conversation-shell");
  assert.equal(shell.shellCount, 1, "exactly one application shell");
  assert.equal(shell.hasNavigator, true, "the context tree is the left zone");
  assert.equal(shell.hasLegacyRail, false, "the operational rail's navigation is not also rendered");
  assert.equal(shell.hasDiscoveryPanel, false, "no operational panel is carried by the shell");
  assert.equal(shell.fillsCenter, true, "the conversation fills the centre");
  assert.equal(shell.pageRendered, true);
});

test("every surface the context tree links to renders inside the same shell", () => {
  for (const name of ["projectConversation", "projectOverview", "projectCommandCenter", "workspaceHome", "workspaceCommandCenter", "pmoChat", "workspaceChat"]) {
    assert.equal(harness.shells[name].shell, "pmfreak-conversation-shell", `${name} must not swap the navigation system out`);
    assert.equal(harness.shells[name].hasLegacyRail, false, `${name} must not render a second navigation`);
  }
  // Conversations fill the centre; ordinary pages get one padded, scrolling column.
  assert.equal(harness.shells.pmoChat.fillsCenter, true);
  assert.equal(harness.shells.workspaceChat.fillsCenter, true);
  assert.equal(harness.shells.projectOverview.fillsCenter, false);
  assert.equal(harness.shells.workspaceHome.fillsCenter, false);
});

test("routes outside the family keep the operational rail shell, unchanged", () => {
  for (const name of ["portfolio", "projectsIndex", "legacyCommandCenter"]) {
    assert.equal(harness.shells[name].shell, "pmfreak-shell");
    assert.equal(harness.shells[name].hasNavigator, false, `${name} must not render two left navigations`);
  }
  assert.equal(harness.shells.setup.shell, "pmfreak-light-workspace-setup");
});

test("the scope model: the route is the only input, and a scope is never authority", () => {
  assert.deepEqual(resolveConversationScope("/workspaces/w1/projects/p1"), { kind: "project", workspaceId: "w1", projectId: "p1", surface: "home" });
  assert.deepEqual(resolveConversationScope("/workspaces/w1/projects/p1/overview"), { kind: "project", workspaceId: "w1", projectId: "p1", surface: "overview" });
  assert.deepEqual(resolveConversationScope("/workspaces/w1/pmos/m1/chat"), { kind: "pmo", workspaceId: "w1", pmoId: "m1", surface: "chat" });
  assert.deepEqual(resolveConversationScope("/workspaces/w1"), { kind: "workspace", workspaceId: "w1", surface: "home" });
  assert.deepEqual(resolveConversationScope("/chat"), { kind: "workspace-chat" });
  assert.deepEqual(resolveConversationScope("/workspaces/w1/projects/p1?tool=attention"), { kind: "project", workspaceId: "w1", projectId: "p1", surface: "home" });
  for (const outside of ["/", "/projects", "/projects/p1", "/portfolio", "/command-center", "/workspaces", "/pmos", "/workspaces/w1/projects/p1/tasks"]) {
    assert.equal(isConversationShellPath(outside), false, `${outside} is not a conversation-shell route`);
  }
  const scopeSource = code("src/lib/navigation/conversation-shell-scope.ts");
  assert.doesNotMatch(scopeSource, /localStorage|cookies|document\.cookie|fetch\(/, "the scope reads the route and nothing else");
});

test("OperationalShell is a router: the rail's operational reads never run on conversation routes", () => {
  const shell = read("src/components/pmfreak/operational-shell.tsx");
  const router = shell.slice(shell.indexOf("export function OperationalShell("), shell.indexOf("function OperationalRailShell("));
  assert.match(router, /isConversationShellPath\(pathname\)/);
  assert.match(router, /<ConversationShell/);
  assert.doesNotMatch(router, /fetch\(|useEffect|useState/, "the router owns no state and issues no request");
  // Every operational read lives in the rail shell, which a conversation route never renders.
  const railShell = shell.slice(shell.indexOf("function OperationalRailShell("));
  for (const endpoint of ["/api/project-discovery", "/api/recommended-actions", "/api/execution-tasks", "/api/schedule", "/api/critical-path", "/api/portfolio"]) {
    assert.ok(railShell.includes(endpoint), `${endpoint} stays with the rail shell`);
    assert.equal(router.includes(endpoint), false);
  }
  const conversationShell = code("src/components/pmfreak/conversation-shell/conversation-shell.tsx");
  assert.doesNotMatch(conversationShell, /\/api\/(project-discovery|recommended-actions|execution-tasks|schedule|critical-path|portfolio|operational-flow)/);
});

// ═══ 2. The context tree ════════════════════════════════════════════════════

test("the tree is an accessible hierarchy: Workspace → PMO → Project → Conversation", () => {
  const { markup, items } = harness.trees.onFrontera;
  assert.match(markup, /role="tree" aria-label="Workspaces, projects and conversations"/);
  const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
  assert.equal(byKey["ws:ws-a"].level, "1");
  assert.equal(byKey["ws:ws-a"].expanded, "true", "the active workspace is open");
  assert.equal(byKey["pmo:pmo-delivery"].level, "2");
  assert.equal(byKey["pmo:pmo-delivery"].expanded, "true", "the PMO owning the active project is open");
  assert.equal(byKey["project:p-frontera"].level, "3");
  assert.equal(byKey["project:p-frontera:project-brain"].level, "4");
  // Groups toggle; they are not links, so no treeitem nests a second control.
  assert.equal(byKey["ws:ws-a"].element, "div");
  assert.equal(byKey["pmo:pmo-delivery"].element, "div");
  assert.equal(byKey["project:p-frontera"].element, "a");
  // Collapsed groups say so, and render no children.
  assert.equal(byKey["ws:ws-b"].expanded, "false");
  assert.equal(byKey["pmo:pmo-empty"].expanded, "false");
});

test("the selected project and its conversation are obvious — and there is one selection", () => {
  const { items } = harness.trees.onFrontera;
  const selected = items.filter((item) => item.selected === "true").map((item) => item.key);
  assert.deepEqual(selected, ["project:p-frontera", "project:p-frontera:project-brain"]);
  const current = items.filter((item) => item.current === "page").map((item) => item.key);
  assert.deepEqual(current, ["project:p-frontera:project-brain"], "the open conversation is the current page");
  // Roving tabindex: exactly one item is in the tab order, and it is the current one.
  assert.deepEqual(items.filter((item) => item.tabIndex === "0").map((item) => item.key), ["project:p-frontera:project-brain"]);
  assert.equal(items.find((item) => item.key === "project:p-frontera").href, "/workspaces/ws-a/projects/p-frontera");
  // On a project's secondary surface (details, operational overview) the PROJECT row is
  // the current page, and the conversation leaf is not.
  const overview = harness.trees.onFronteraOverview.items;
  assert.deepEqual(overview.filter((item) => item.current === "page").map((item) => item.key), ["project:p-frontera"]);
  assert.equal(overview.find((item) => item.key === "project:p-frontera:project-brain").current, null);
});

test("switching projects moves the selection with the route", () => {
  const onOther = harness.trees.onOther.items;
  assert.equal(onOther.find((item) => item.key === "project:p-other").selected, "true");
  assert.equal(onOther.find((item) => item.key === "project:p-frontera").selected, null, "the previous project is no longer selected");
  assert.equal(onOther.some((item) => item.key === "project:p-frontera:project-brain"), false, "its conversation leaf is gone");
  assert.equal(onOther.some((item) => item.key === "project:p-other:project-brain"), true);
  // A direct project (no PMO) is selected directly under its workspace.
  const onDirect = harness.trees.onDirect.items;
  assert.equal(onDirect.find((item) => item.key === "project:p-direct").level, "2");
  assert.equal(onDirect.find((item) => item.key === "project:p-direct").selected, "true");
});

test("workspace and PMO conversations appear where the backend supports them — and only there", () => {
  const onPmoChat = harness.trees.onPmoChat.items;
  assert.equal(onPmoChat.find((item) => item.key === "pmo:pmo-delivery:chat").current, "page");
  assert.equal(onPmoChat.find((item) => item.key === "pmo:pmo-delivery:chat").href, "/workspaces/ws-a/pmos/pmo-delivery/chat");
  // Workspace Chat is session-scoped (`/chat` answers for the preferred workspace), so it
  // is offered only under THAT workspace — never under one it would not open.
  const onWorkspaceChat = harness.trees.onWorkspaceChat.items;
  assert.equal(onWorkspaceChat.find((item) => item.key === "ws:ws-a:chat").current, "page");
  const withBeta = harness.trees.withBetaExpandedToo.items;
  assert.equal(withBeta.some((item) => item.key === "ws:ws-b:chat"), false, "no Workspace Chat under a non-session workspace");
  // No fake threads: one conversation per project, and none for projects not open.
  assert.equal(harness.trees.onFrontera.items.filter((item) => item.kind === "conversation" && item.key.startsWith("project:")).length, 1);
});

test("the hierarchy is the REAL persisted one — no fake PMO, no fake Portfolio", () => {
  const branch = buildWorkspaceBranch(
    [{ id: "m1", name: "PMO", icon: null, status: "active" }],
    [
      { id: "p1", name: "In PMO", status: "active", pmoId: "m1" },
      { id: "p2", name: "Direct", status: "active", pmoId: null },
      { id: "p3", name: "Unseen PMO", status: "active", pmoId: "m-invisible" },
    ],
  );
  assert.deepEqual(branch.pmos.map((pmo) => [pmo.id, pmo.projects.map((p) => p.id)]), [["m1", ["p1"]]]);
  assert.deepEqual(branch.directProjects.map((p) => p.id), ["p2", "p3"], "an unreadable PMO is never invented");
  const { items } = harness.trees.onFrontera;
  assert.equal(items.find((item) => item.key === "project:p-orphan").level, "2", "listed under its workspace, not a guessed PMO");
  // Portfolio (`personal_portfolios`) is a per-user lens that owns no project: no tree level.
  assert.equal(items.some((item) => /portfolio/i.test(item.key)), false);
  assert.doesNotMatch(code("src/components/pmfreak/conversation-shell/context-tree-model.ts"), /portfolio/i);
  // Archived entities stay visible, and say so.
  assert.match(harness.trees.onFrontera.markup, /Archived Project[\s\S]{0,200}Archived/);
});

test("no cross-workspace leakage: another workspace's rows never render under this one", () => {
  const { markup, items } = harness.trees.onFrontera;
  // Workspace B's branch is loaded in the fixture, but B is collapsed: none of its rows render.
  assert.doesNotMatch(markup, /Beta Secret Project|Beta PMO/);
  // Expanded, B's rows render under B — and only under B.
  const withBeta = harness.trees.withBetaExpandedToo.items;
  const betaProject = withBeta.find((item) => item.key === "project:p-beta");
  assert.ok(betaProject, "B's project renders under B once B is opened");
  assert.equal(betaProject.href, "/workspaces/ws-b/projects/p-beta", "and it links into B, its own workspace");
  const aKeys = items.map((item) => item.key);
  assert.equal(aKeys.includes("project:p-beta"), false);
  // A route naming a workspace the caller does not belong to highlights nothing.
  const foreign = harness.trees.onForeign.items;
  assert.equal(foreign.some((item) => item.selected === "true" || item.current === "page"), false);
  assert.equal(foreign.some((item) => item.expanded === "true"), false);
});

test("the tree's keyboard contract (WAI-ARIA tree pattern)", () => {
  const scope = resolveConversationScope("/workspaces/ws-a/projects/p-frontera");
  const workspaces = [
    { id: "ws-a", name: "A", status: "active", sessionActive: true },
    { id: "ws-b", name: "B", status: "active", sessionActive: false },
  ];
  const branches = {
    "ws-a": { status: "ready", pmos: [{ id: "m1", name: "PMO", icon: null, status: "active" }], projects: [{ id: "p-frontera", name: "F", status: "active", pmoId: "m1" }] },
  };
  const expanded = routeExpandedKeys(scope, workspaces, branches);
  const visible = flattenVisible(buildContextTree({ workspaces, branches, expanded, scope }));
  const keys = visible.map((node) => node.key);
  assert.deepEqual(keys.slice(0, 2), ["ws:ws-a", "ws:ws-a:chat"]);
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a", "ArrowDown"), { focus: "ws:ws-a:chat", handled: true });
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a:chat", "ArrowUp"), { focus: "ws:ws-a", handled: true });
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a:chat", "Home"), { focus: "ws:ws-a", handled: true });
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a", "End"), { focus: "ws:ws-b", handled: true });
  // → on an open group enters it; ← on an open group closes it.
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a", "ArrowRight"), { focus: "ws:ws-a:chat", handled: true });
  assert.deepEqual(treeKeyAction(visible, "ws:ws-a", "ArrowLeft"), { toggle: { key: "ws:ws-a", open: false }, handled: true });
  // → on a closed group opens it; ← on a leaf returns to its parent.
  assert.deepEqual(treeKeyAction(visible, "ws:ws-b", "ArrowRight"), { toggle: { key: "ws:ws-b", open: true }, handled: true });
  assert.deepEqual(treeKeyAction(visible, "project:p-frontera", "ArrowLeft"), { focus: "pmo:m1", handled: true });
  // Enter/Space toggle a group; Space activates a link; Enter on a link is native.
  assert.deepEqual(treeKeyAction(visible, "ws:ws-b", "Enter"), { toggle: { key: "ws:ws-b" }, handled: true });
  assert.deepEqual(treeKeyAction(visible, "project:p-frontera", " "), { activate: true, handled: true });
  assert.deepEqual(treeKeyAction(visible, "project:p-frontera", "Enter"), { handled: false });
  assert.deepEqual(treeKeyAction(visible, "project:p-frontera", "a"), { handled: false });
});

test("the tree's data contract is narrow, lazy, and read through the caller's own session", () => {
  const route = code(TREE_ROUTE);
  assert.match(route, /requireAuthenticatedUser\(\)/);
  assert.match(route, /await requireWorkspaceMember\(requestedWorkspaceId\)/, "the requested workspace is authorized before any branch read");
  assert.match(route, /createSupabaseServerClient\(\)/, "RLS is the enforcing boundary");
  assert.doesNotMatch(route, /createSupabaseServiceRoleClient|createPrivilegedSupabaseClient/);
  // Both branch reads are scoped by the requested (and authorized) workspace.
  const branch = route.slice(route.indexOf("await requireWorkspaceMember(requestedWorkspaceId)"));
  assert.equal((branch.match(/\.eq\("workspace_id", requestedWorkspaceId\)/g) ?? []).length, 2);
  // Names, statuses and parent ids — nothing operational.
  assert.match(route, /\.select\("id, name, icon, status"\)/);
  assert.match(route, /\.select\("id, name, status, pmo_id"\)/);
  assert.doesNotMatch(route, /recommended_actions|raid_items|execution_tasks|operational_/);
  // The workspace list is the caller's own memberships.
  assert.match(route, /\.from\("workspace_memberships"\)\.select\("workspace_id"\)\.eq\("user_id", user\.id\)/);
  assert.match(route, /\.from\("workspaces"\)\.select\("id, name, status"\)\.in\("id", ids\)/);
  // The client loads the list, then a branch only when its workspace is opened.
  const hook = read("src/components/pmfreak/conversation-shell/use-context-tree-data.ts");
  assert.match(hook, /expanded\.has\(`ws:\$\{workspace\.id\}`\) && branches\[workspace\.id\] === undefined/);
  const hookCode = code("src/components/pmfreak/conversation-shell/use-context-tree-data.ts");
  assert.equal((hookCode.match(/localStorage/g) ?? []).length, 2, "one read and one write of the toggles");
  assert.match(hookCode, /localStorage\?\.getItem\(TOGGLES_STORAGE_KEY\)/);
  assert.match(hookCode, /localStorage\?\.setItem\(TOGGLES_STORAGE_KEY, JSON\.stringify\(next\)\)/);
  assert.match(hookCode, /const TOGGLES_STORAGE_KEY = "pmfreak\.contextTree\.toggles";/, "storage remembers open rows, never access");
});

// ═══ 3. The project conversation ═══════════════════════════════════════════

test("the canonical project route renders Project Brain as the primary surface — not inside the Command Center", () => {
  const page = code(PROJECT_PAGE);
  assert.match(page, /<ProjectConversationView\s*\n\s*key=\{project\.id\}/);
  for (const nested of ["CommandCenterCanvas", "CommandCenterLayout", "ProjectSidebar", "ProjectBrainPanel", "CommandCenterClient"]) {
    assert.doesNotMatch(page, new RegExp(nested), `the project route must not mount ${nested}`);
    assert.doesNotMatch(code(VIEW), new RegExp(`<${nested}\\b`), `the conversation view must not mount ${nested}`);
  }
  assert.match(code(VIEW), /<ProjectBrainConversation projectId=\{project\.id\} projectName=\{project\.name\} variant="light" layout="surface" \/>/);
  // ONE conversation implementation, mounted in ONE place.
  const mounts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name) && /<ProjectBrainConversation\b/.test(code(full))) mounts.push(full);
    }
  };
  walk("src");
  assert.deepEqual(mounts, [VIEW]);
});

test("the conversation surface: full height, readable measure, composer pinned, disclosure kept", () => {
  const surface = harness.conversation.surface;
  assert.match(surface, /data-testid="project-brain-conversation"[^>]*data-layout="surface"/);
  assert.match(surface, /data-testid="project-brain-transcript"/);
  assert.match(surface, /max-w-3xl/);
  assert.match(surface, /data-testid="project-brain-composer"/);
  assert.ok(surface.indexOf('data-testid="project-brain-transcript"') < surface.indexOf('data-testid="project-brain-composer"'), "the composer sits below the transcript");
  assert.match(surface, /<label for="project-brain-input-p-frontera" class="sr-only">Ask Project Brain<\/label>/);
  assert.match(surface, /<span class="sr-only">Send<\/span>/, "the icon button keeps an accessible name");
  assert.match(surface, /data-testid="project-brain-disclosure"/);
  assert.match(surface, /a citation is not proof of every sentence/);
  // The panel layout is still the same implementation, unchanged in behaviour.
  assert.match(harness.conversation.panel, /data-layout="panel"/);
  assert.match(harness.conversation.panel, />Send<\/button>/);
});

test("the empty conversation invites typing: project name, one line, starter prompts that only fill the composer", () => {
  const source = read("src/components/pmfreak/project-brain/project-brain-conversation.tsx");
  assert.match(source, /Ask Project Brain about this project/);
  assert.match(source, /data-testid="project-brain-starters"/);
  const applyStarter = source.slice(source.indexOf("const applyStarter"), source.indexOf("const upgraded"));
  assert.match(applyStarter, /setDraft\(question\)/);
  assert.doesNotMatch(applyStarter, /submit\(|send\(/, "a starter never sends on the user's behalf");
});

test("the send path, idempotency and API are untouched by the new layout", () => {
  const source = code("src/components/pmfreak/project-brain/project-brain-conversation.tsx");
  assert.equal((source.match(/\/api\/projects\/\$\{encodeURIComponent\((?:forProject|projectId)\)\}\/brain\/turns/g) ?? []).length, 2, "one read, one post");
  assert.match(source, /clientMessageId: newClientMessageId\(\)/);
  assert.match(source, /submit\(\{ clientMessageId: question\.clientMessageId, text: question\.content, retry: true \}\)/);
  assert.equal((source.match(/const submit = useCallback/g) ?? []).length, 1, "one submit implementation for both layouts");
  assert.match(source, /if \(event\.key === "Enter" && !event\.shiftKey\)/, "Enter still sends, Shift+Enter still breaks a line");
});

test("the right rail opens tools beside the conversation, without removing it", () => {
  assert.deepEqual(PROJECT_TOOLS.map((tool) => tool.key), ["attention", "activity", "execution", "tasks", "schedule", "monitoring", "repository", "project"]);
  const view = code(VIEW);
  // The conversation is a sibling of the rail and the inspector, never their child.
  const centerEnd = view.indexOf("</section>");
  assert.ok(view.indexOf("<ProjectBrainConversation") < centerEnd);
  assert.ok(view.indexOf("<OperationalRail") > centerEnd);
  assert.ok(view.indexOf("<OperationalInspector") > centerEnd);
  // The inspector renders one focused tool, never the whole old canvas.
  const inspector = code("src/modules/workspace/screens/command-center/command-center-layout.tsx");
  assert.doesNotMatch(inspector, /CommandCenterCanvas|ProjectSidebar|ProjectBrainConversation|data-shell=/);
  for (const tool of ["attention", "activity", "execution", "schedule", "monitoring", "repository"]) {
    assert.match(inspector, new RegExp(`tool === "${tool}"`));
  }
});

test("a ?tool= hint is parsed against a closed list and is transient", () => {
  assert.equal(parseProjectTool("attention"), "attention");
  assert.equal(parseProjectTool(["tasks", "attention"]), "tasks");
  for (const hostile of [undefined, "", "admin", "../x", "Attention", "constructor", "__proto__"]) {
    assert.equal(parseProjectTool(hostile), null, `${String(hostile)} opens nothing`);
  }
  assert.match(code(VIEW), /url\.searchParams\.delete\("tool"\)/);
  assert.match(code(VIEW), /window\.history\.replaceState/);
});

test("the header is orientation, not analytics", () => {
  assert.deepEqual(projectBriefIndicators(null), [], "no brief is not 'clear' — it is no claim at all");
  const brief = {
    topExecutionRisks: [{ severity: "critical" }, { severity: "high" }, { severity: "low" }],
    detectedRaidOverview: { snapshot: { issues: 3 } },
    governanceGaps: [{}],
  };
  assert.deepEqual(projectBriefIndicators(brief).map((indicator) => indicator.label), ["2 high risks", "3 issues", "1 governance gap"]);
  assert.deepEqual(
    projectBriefIndicators({ topExecutionRisks: [], detectedRaidOverview: { snapshot: { issues: 0 } }, governanceGaps: [] }),
    [],
    "zero counts are not shown",
  );
});

// ═══ 4. Routes and compatibility ════════════════════════════════════════════

test("one canonical URL per experience: the project root is the conversation; details moved to /overview", () => {
  assert.equal(projectHomePath("w1", "p1"), "/workspaces/w1/projects/p1");
  assert.equal(projectOverviewPath("w1", "p1"), "/workspaces/w1/projects/p1/overview");
  assert.equal(parseCanonicalProjectRoute("/workspaces/w1/projects/p1/overview")?.surface, "overview");
  const overview = read(PROJECT_OVERVIEW_PAGE);
  for (const kept of ["<ProjectTaskList", "<ProjectPMAssignment", "/api/analyze-ai", "Previous analyses"]) {
    assert.ok(overview.includes(kept), `Project details keeps ${kept}`);
  }
});

test("legacy Workspace Command Center: hands off to the conversation with Needs You open, except the guided view", () => {
  const page = code(WORKSPACE_CC_PAGE);
  assert.match(page, /const guidedView = landingView === "ingestion" \|\| params\.view === "inbox" \|\| briefGenerationFailed;/);
  assert.match(page, /redirect\(`\$\{projectHomePath\(workspace\.workspaceId, resolution\.project!\.id\)\}\?tool=attention`\)/);
  // The id handed off was resolved against THIS workspace's own project list first.
  assert.ok(page.indexOf("resolveActiveProject(projectList, params.projectId)") < page.indexOf("redirect(`${projectHomePath("));
  assert.ok(page.indexOf("if (resolution.invalidId)") < page.indexOf("redirect(`${projectHomePath("));
  // The nested application is gone from the client.
  const client = code("src/modules/workspace/screens/command-center/command-center-client.tsx");
  assert.doesNotMatch(client, /CommandCenterLayout|ProjectSidebar|CommandCenterCanvas/);
  assert.match(client, /router\.push\(projectHomePath\(workspaceId, projectId\)\)/);
});

test("legacy project routes: the Project Command Center stays a secondary overview; /projects/[id]/chat lands on the conversation", () => {
  const cc = code(PROJECT_CC_PAGE);
  assert.doesNotMatch(cc, /<ProjectBrainConversation/, "no second copy of the conversation");
  assert.match(cc, /href=\{projectHomePath\(workspaceId, project\.id\)\}/);
  assert.match(cc, /resolveRoutedProject\(user\.id, requestedWorkspaceId, requestedProjectId\)/, "its authority is unchanged");
  assert.match(code("src/app/(protected)/projects/[id]/chat/page.tsx"), /redirect\(projectHomePath\(project\.workspace_id, project\.id\)\)/);
  // The bare /command-center still resolves a workspace and forwards `view` too.
  assert.match(read("src/lib/workspace/command-center-paths.ts"), /"view",\n\] as const;/);
});

// ═══ 5. Authorization preservation ══════════════════════════════════════════

test("the conversation route authorizes exactly as Project Home did — before any read", () => {
  const page = read(PROJECT_PAGE);
  const auth = page.indexOf("await requireAuthUser()");
  const resolve = page.indexOf("const access = await resolveRoutedProject(user.id, requestedWorkspaceId, requestedProjectId)");
  const capability = page.indexOf('await evaluateCapabilityAccess({ workspaceId, projectId, permission: "read" })');
  const firstRead = page.indexOf('.from("');
  assert.ok(auth > 0 && auth < resolve && resolve < capability && capability < firstRead, "auth → routed resolver → capability → reads");
  assert.match(page, /if \(access\.access === "denied"\)[\s\S]{0,400}return <ProjectNotAvailable \/>;/);
  const body = code(PROJECT_PAGE).slice(code(PROJECT_PAGE).indexOf("const { workspaceId, projectId } = access;"));
  assert.doesNotMatch(body, /requestedWorkspaceId|requestedProjectId/, "every read uses the authorized ids");
  assert.doesNotMatch(code(PROJECT_PAGE), /createSupabaseServiceRoleClient|resolvePreferredWorkspace/);
});

test("the project_brain.converse boundary and the PB-CHAT API are not touched", { skip: BASE_REF ? false : "no origin/main in this checkout" }, () => {
  for (const file of [
    "src/app/api/projects/[id]/brain/turns/route.ts",
    "src/lib/project-brain/conversation/prompt.ts",
    "src/lib/project-brain/conversation/turn-service.ts",
    "src/lib/project-brain/conversation/generative-access.ts",
    "src/lib/aoc/runtime/governance-actions.ts",
    "src/lib/security/server-authorization.ts",
  ]) {
    assert.ok(existsSync(file), `${file} exists`);
    const diff = execFileSync("git", ["diff", "--name-only", BASE_REF, "--", file], { encoding: "utf8" }).trim();
    assert.equal(diff, "", `${file} must be unchanged by CHAT-SHELL-01`);
  }
});

test("no schema change and no migration", { skip: BASE_REF ? false : "no origin/main in this checkout" }, () => {
  const changed = execFileSync("git", ["diff", "--name-only", BASE_REF, "--", "supabase"], { encoding: "utf8" }).trim();
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "supabase"], { encoding: "utf8" }).trim();
  assert.equal(changed, "");
  assert.equal(untracked, "");
});

// ═══ 6. Mobile ═════════════════════════════════════════════════════════════

test("mobile: the tree opens from a menu as a modal sheet, and tools open as a sheet", () => {
  const shell = harness.shells.projectConversation;
  assert.match(shell.leftDrawer, /lg:hidden/, "the navigator is a permanent column from lg up, a sheet below");
  assert.match(shell.leftDrawer, /hidden=""/, "closed, it is out of the accessibility tree");
  assert.equal(shell.drawerDialog, true);
  // The project conversation carries its own menu button, so there is no second bar.
  assert.equal(shell.shellTopBar, false);
  assert.equal(harness.shells.workspaceHome.shellTopBar, true);
  const drawer = read("src/components/pmfreak/conversation-shell/shell-drawer.tsx");
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /event\.key !== "Tab"/, "Tab is trapped while open");
  assert.match(drawer, /returnFocus\.current\?\.focus\?\.\(\)/, "focus returns to the opener");
  const view = read(VIEW);
  assert.match(view, /<MenuButton onClick=\{shell\.openNavigation\} \/>/);
  assert.match(view, /md:hidden[\s\S]{0,40}>\s*Tools\s*</);
  const inspector = read("src/components/pmfreak/conversation-shell/operational-inspector.tsx");
  assert.match(inspector, /role=\{overlay \? "dialog" : "complementary"\}/);
  assert.match(inspector, /aria-modal=\{overlay \? true : undefined\}/);
});

test("the shell keeps sign-out a POST and keeps the rest of the product reachable", () => {
  assert.equal(harness.shells.projectConversation.signOutIsPost, true);
  assert.equal(harness.shells.projectConversation.moreNavigation, true);
  assert.equal(harness.shells.projectConversation.treeSkeleton, true, "the tree skeletons independently while it loads");
});

// ═══ 7. Workspace / PMO chat in the same pattern ═══════════════════════════

test("workspace and PMO chat fill the centre with the same endpoints and the same scopes", () => {
  assert.match(harness.contextChat.surface, /data-testid="context-chat-panel" data-layout="surface"/);
  assert.match(harness.contextChat.card, /data-layout="card"/);
  const workspaceChat = code("src/app/(protected)/chat/page.tsx");
  assert.match(workspaceChat, /<ContextChatPanel\s*\n\s*contextType="workspace"\s*\n\s*layout="surface"/);
  const pmoChat = code("src/app/(protected)/workspaces/[workspaceId]/pmos/[pmoId]/chat/page.tsx");
  assert.match(pmoChat, /contextType="pmo"\s*\n\s*pmoId=\{pmo\.id\}\s*\n\s*layout="surface"/);
  assert.match(pmoChat, /resolveRoutedPmo\(user\.id, requestedWorkspaceId, requestedPmoId\)/);
  const panel = code("src/components/pmfreak/chat/context-chat-panel.tsx");
  assert.equal((panel.match(/\/api\/context-chat/g) ?? []).length, 2, "the same GET and POST, unchanged");
});
