/**
 * Workspace module — public entry point.
 *
 * Per `07-frontend-module-boundaries.md` §2 (`modules/workspace`), this module
 * owns the Workspace Command Center screen. Consumers import from this barrel
 * only — never reach into `screens/`, `presentation/`, `features/`, or
 * `contracts/` internals (§3).
 *
 * PR9 step 3 (cohesive move): the Command Center screen composition roots live
 * under `screens/command-center/` and their presentation cluster under
 * `presentation/command-center/`. `features/` and `contracts/` are skeleton
 * layers reserved for later migration steps. No business logic lives here —
 * re-exports only. See
 * `docs/product-architecture/command-center-frontend-module-boundary.md`.
 */

export { CommandCenterClient } from "./screens/command-center/command-center-client";
export { CommandCenterEmptyState } from "./screens/command-center/command-center-empty-state";
// CHAT-SHELL-01: the Command Center's operational state and tools, rendered one tool
// at a time in the project conversation's right-hand inspector.
export { ProjectOperationsInspector, OPERATIONAL_TOOLS } from "./screens/command-center/command-center-layout";
export type { OperationalToolKey } from "./screens/command-center/command-center-layout";

// View-model types that describe the screen's public props vocabulary.
export type { ProjectListItem, ToneBadge, StatusTone } from "./presentation/command-center/types";
