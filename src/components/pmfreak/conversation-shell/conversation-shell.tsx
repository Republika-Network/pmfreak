"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { newProjectHref, resolveConversationScope, type ConversationScope } from "@/lib/navigation/conversation-shell-scope";
import { computeCapabilityRevealState, computeNavigationRail } from "@/features/runtime/capability-reveal/capability-reveal-selectors";
import { NAVIGATION_HIERARCHY } from "@/lib/workspace/navigation-hierarchy";
import { WORKSPACE_COMMAND_CENTER_LEGACY_PATH } from "@/lib/workspace/command-center-paths";
import type { CapabilityProfile } from "@/lib/workspace/pilot-capability-set";
import { ContextTreeView } from "./context-tree";
import { ShellDrawer } from "./shell-drawer";
import { useContextTreeData, type ContextTreeData } from "./use-context-tree-data";

type ShellUser = { fullName: string; role: string; companyName: string };

const ShellNavigationContext = createContext<{ openNavigation: () => void } | null>(null);

/**
 * Lets a page that draws its own top bar (the project conversation) put the
 * navigator's menu button in it, instead of stacking a second bar above it on a
 * phone.
 */
export function useShellNavigation() {
  return useContext(ShellNavigationContext);
}

/**
 * CHAT-SHELL-01 — the conversation-first application shell.
 *
 * ONE shell, three conceptual zones:
 *
 *   A  the context tree (this component, left)       — navigation/context only
 *   B  the page (centre)                              — for a project: Project Brain
 *   C  the page's operational rail/inspector (right)  — owned by the page, not here
 *
 * What this shell deliberately does NOT own: operational data. The rail shell it
 * replaces on these routes fetched discovery, recommended actions, tasks, the
 * task graph, schedule, critical path and portfolio at boot to draw navigation.
 * This one reads names and parent ids (`useContextTreeData`) and nothing else;
 * every operational read belongs to the feature surface that shows it.
 *
 * Scroll model: the shell is exactly one viewport tall and never scrolls itself.
 * The tree scrolls independently if it outgrows the column; the centre region is
 * the single scroll container for ordinary pages, and a page that manages its
 * own regions (the conversation: transcript scroll + fixed composer) fills it
 * exactly, so nothing scrolls around it.
 */
export function ConversationShell({
  user,
  capabilityProfile = "pilot",
  children,
}: {
  user: ShellUser;
  capabilityProfile?: CapabilityProfile;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const scope = useMemo(() => resolveConversationScope(pathname ?? ""), [pathname]);
  const tree = useContextTreeData(scope);
  const [navOpen, setNavOpen] = useState(false);
  const openNavigation = useCallback(() => setNavOpen(true), []);
  const closeNavigation = useCallback(() => setNavOpen(false), []);
  const navigation = useMemo(() => ({ openNavigation }), [openNavigation]);
  // After a breakpoint dismissal the ☰ opener is hidden; the permanent navigator's own
  // tab stop (the current item) is where the user's place in the page now is.
  const focusDesktopNavigator = useCallback(
    () =>
      document.querySelector<HTMLElement>('[data-testid="conversation-shell-navigator"] [role="treeitem"][tabindex="0"]') ??
      document.querySelector<HTMLElement>('[data-testid="conversation-shell-navigator"] a[href]'),
    [],
  );
  // Conversation pages fill the centre exactly and manage their own regions
  // (transcript scroll, pinned composer); every other page is one padded column
  // that the centre region scrolls.
  const pageFillsCenter = isConversationSurface(scope);
  // The project conversation draws its own header, menu button included.
  const pageOwnsMobileHeader = scope?.kind === "project" && scope.surface === "home";

  // Continuity for the operational rail's pages (Execution, Portfolio, …), which
  // read their project hint from this key. It is a hint they validate against
  // their own workspace-scoped project list — never an access decision.
  const routedProjectId = scope?.kind === "project" ? scope.projectId : null;
  useEffect(() => {
    if (!routedProjectId) return;
    try {
      globalThis.localStorage?.setItem("pmfreak.currentProjectId", routedProjectId);
    } catch {
      // Storage unavailable — continuity is a convenience.
    }
  }, [routedProjectId]);

  return (
    <ShellNavigationContext.Provider value={navigation}>
      <div data-shell="pmfreak-conversation-shell" className="flex h-dvh overflow-hidden bg-white text-slate-900">
        <aside
          aria-label="Navigation"
          className="hidden w-[272px] shrink-0 flex-col border-r border-slate-200 bg-[#F6F5F1] lg:flex"
          data-testid="conversation-shell-navigator"
        >
          <NavigatorPanel user={user} tree={tree} capabilityProfile={capabilityProfile} newProjectPath={newProjectHref(scope)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {pageOwnsMobileHeader ? null : (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 lg:hidden">
              <MenuButton onClick={openNavigation} />
              <span className="text-sm font-semibold tracking-tight text-slate-900">PMFreak</span>
            </div>
          )}
          <main
            id="main-content"
            className={`min-h-0 flex-1 ${pageFillsCenter ? "overflow-hidden" : "overflow-y-auto"}`}
            data-testid="conversation-shell-center"
            data-fills-center={pageFillsCenter ? "true" : undefined}
          >
            {pageFillsCenter ? children : <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">{children}</div>}
          </main>
        </div>

        {/* From `lg` the navigator is a permanent column; an open sheet closes there (F3). */}
        <ShellDrawer
          open={navOpen}
          onClose={closeNavigation}
          side="left"
          label="Navigation"
          className="lg:hidden"
          dismissWhen="(min-width: 1024px)"
          focusFallback={focusDesktopNavigator}
        >
          <NavigatorPanel user={user} tree={tree} capabilityProfile={capabilityProfile} newProjectPath={newProjectHref(scope)} onNavigate={closeNavigation} />
        </ShellDrawer>
      </div>
    </ShellNavigationContext.Provider>
  );
}

/** The scopes whose page IS a conversation: the project's Project Brain, PMO Chat and Workspace Chat. */
export function isConversationSurface(scope: ConversationScope | null): boolean {
  if (!scope) return false;
  if (scope.kind === "workspace-chat") return true;
  if (scope.kind === "project") return scope.surface === "home";
  if (scope.kind === "pmo") return scope.surface === "chat";
  return false;
}

export function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation"
      className="-ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 lg:hidden"
    >
      <svg aria-hidden viewBox="0 0 20 20" className="h-5 w-5">
        <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function NavigatorPanel({
  user,
  tree,
  capabilityProfile,
  newProjectPath,
  onNavigate,
}: {
  user: ShellUser;
  tree: ContextTreeData;
  capabilityProfile: CapabilityProfile;
  /** Carries the displayed workspace (F1) — see `newProjectHref`. */
  newProjectPath: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-4">
        <Link href="/workspaces" onClick={onNavigate} className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60">
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-900 text-[11px] font-bold text-white">P</span>
          <span className="truncate text-sm font-semibold tracking-tight text-slate-900">PMFreak</span>
        </Link>
        <Link
          href={newProjectPath}
          onClick={onNavigate}
          data-testid="shell-new-project"
          className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
        >
          + New project
        </Link>
      </div>

      <nav aria-label="Workspaces and projects" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {tree.status === "loading" ? (
          <TreeSkeleton />
        ) : tree.status === "error" ? (
          <div className="mx-2 mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
            Navigation couldn&apos;t be loaded.{" "}
            <button type="button" onClick={() => void tree.retry()} className="font-medium underline underline-offset-2">
              Try again
            </button>
          </div>
        ) : tree.nodes.length === 0 ? (
          <div className="mx-2 mt-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-600">
            You don&apos;t belong to a workspace yet.{" "}
            <Link href="/workspaces/new" onClick={onNavigate} className="font-medium text-cyan-800 underline underline-offset-2">
              Create one
            </Link>
          </div>
        ) : (
          <ContextTreeView nodes={tree.nodes} onToggle={tree.toggle} onRetryBranch={tree.retryBranch} onNavigate={onNavigate} />
        )}
      </nav>

      <MoreNavigation user={user} capabilityProfile={capabilityProfile} hasProjects={tree.hasProjects} onNavigate={onNavigate} />

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-800">{user.fullName}</p>
          <p className="truncate text-[11px] text-slate-500">{user.companyName || user.role}</p>
        </div>
        {/* A mutation, so it is submitted, never navigated to — see OperationalShell. */}
        <form action="/logout" method="post" className="shrink-0">
          <button type="submit" className="rounded-md px-2 py-1 text-[11px] text-slate-500 transition hover:bg-white hover:text-slate-800">
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}

/**
 * The rest of the product, reachable without a second navigation system.
 *
 * The same capability-filtered list the operational rail shows (one derivation,
 * `computeNavigationRail`), minus "Command Center": inside this shell the
 * conversation IS the command interface, and the Command Center's tools sit
 * beside it. Collapsed by default so it never competes with the tree.
 */
function MoreNavigation({
  user,
  capabilityProfile,
  hasProjects,
  onNavigate,
}: {
  user: ShellUser;
  capabilityProfile: CapabilityProfile;
  hasProjects: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The navigator is mounted twice (the desktop column and the mobile sheet), so the
  // disclosure's id must be per instance or `aria-controls` would point at the wrong one.
  const listId = useId();
  const items = useMemo(() => {
    const revealState = computeCapabilityRevealState({
      planTier: "free",
      role: user.role,
      onboardingCompleted: true,
      hasProject: hasProjects,
      firstRun: false,
      evidenceSignals: hasProjects ? 2 : 0,
      operationalMemorySignals: hasProjects ? 1 : 0,
      continuitySignals: hasProjects ? 1 : 0,
      canUseAdvancedAi: true,
      canUsePortfolioMemory: true,
      canUseGovernanceDirectives: user.role === "admin" || user.role === "owner",
    });
    const tiers = new Map(NAVIGATION_HIERARCHY.map((node) => [node.href, node.tier]));
    return computeNavigationRail(revealState, capabilityProfile).filter(
      (item) => item.href !== WORKSPACE_COMMAND_CENTER_LEGACY_PATH && tiers.get(item.href) !== "advanced",
    );
  }, [user.role, hasProjects, capabilityProfile]);

  return (
    <div className="shrink-0 border-t border-slate-200 px-2 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-white/70 hover:text-slate-900"
      >
        <span>More in PMFreak</span>
        <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`}>
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <ul id={listId} hidden={!open} className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} onClick={onNavigate} className="block rounded-lg px-2 py-1.5 text-xs text-slate-600 transition hover:bg-white/70 hover:text-slate-900">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="space-y-2 px-2 pt-2" data-testid="context-tree-skeleton" role="status">
      <span className="sr-only">Loading your workspaces…</span>
      {[72, 56, 64, 48].map((width, index) => (
        <div key={index} aria-hidden className="h-3.5 animate-pulse rounded bg-slate-200/80" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}
