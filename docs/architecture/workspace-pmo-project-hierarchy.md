# Workspace → PMO → Project Hierarchy

Status: implemented (UX Architecture Refactoring Sprint), validated
(Acceptance, Migration & Context Isolation Validation Sprint — see
`artifacts/validation-sprint-2026-07-16/EXECUTIVE-REPORT.md`). The
validation sprint found and fixed a PMO-backfill concurrency race, a
database-layer gap allowing cross-workspace `pmo_id`/`project_id`
assignment via direct SQL (closed with triggers), a context-chat scope
derivation bug, and two authorization gaps in PMO/project mutation routes
— see the report for full details and re-verified evidence.

PMFreak's conceptual root used to be the Project: the sidebar listed projects
flat, the "PMO" was a governance JSON blob 1:1 with the workspace, and the
live chat was ephemeral and unscoped. This refactor corrects the product
hierarchy to:

```
Workspace          (the whole organization; a user can belong to many)
  └── PMO          (governs a set of projects; a workspace can hold many)
        └── Project (owns its own isolated operational context)
```

## Data model

Migration: `supabase/migrations/20260828000001_workspace_pmo_project_hierarchy.sql`.

| Table / column | Purpose |
| --- | --- |
| `pmos` | First-class PMO entity: `workspace_id` FK, `name`, `description`, `pmo_type` (the five Command Center types + `personal`), `icon`, `color`, `status` (`active\|archived`). |
| `projects.pmo_id` | Parent PMO. Nullable (legacy compatibility), `ON DELETE SET NULL` so deleting a PMO never destroys projects. Backfilled for every existing workspace. |
| `projects.methodology/icon/color` | Project administration metadata (Change 4). |
| `context_conversations` | One isolated conversation per scope. `context_type in ('workspace','pmo','project')` with a CHECK constraint enforcing the scope shape and a partial unique index (one active conversation per scope). |
| `context_messages` | Messages for a context conversation, workspace-scoped for RLS. |

All new tables carry membership-chain RLS (`workspace_memberships`), matching
the rest of the schema. The columns are declared in
`src/lib/db/database-contract.ts` and enforced by
`scripts/check-db-schema-contract.mjs` (new tables registered there).

### Backfill / compatibility

- Every workspace with projects or an activated PMO tenant receives a default
  `pmos` row named from `workspace_governance.governance_jsonb->identity->pmoName`
  (falling back to the workspace name), and its projects are attached.
- `savePmoTenant` (the Create Command Center wizard) now also materializes a
  `pmos` row, idempotently. The governance JSON remains the tenant config.
- `resolveOnboardingState` accepts either a `pmos` row or the legacy
  schema-v2 governance tenant as proof a PMO exists.
- Every project-creation path (`createProjectAction`, `saveProjectOnboarding`,
  `activateContextAction`, `/api/getting-started`) attaches a PMO — an
  explicit `pmoId` when given, else the workspace's default PMO via
  `ensureDefaultPmo`.

## Context isolation (Change 12)

`src/lib/context/context-scope.ts` defines the canonical `ContextScope` and
`contextIdFor()`:

- `workspace:<workspaceId>`
- `pmo:<pmoId>`
- `project:<projectId>`

`src/lib/chat/context-chat-service.ts` persists conversations keyed by the
full scope shape (never `workspace_id` alone), and
`src/lib/chat/context-chat-responder.ts` grounds answers strictly in the
scope's own rows:

- workspace chat → every PMO/project in the workspace
- PMO chat → only `projects.pmo_id = <pmo>`
- project chat → only that project

The responder is deterministic (no LLM), consistent with the existing
Command Center gateway: answers are assembled from `projects`, `raid_items`,
and `execution_tasks` aggregates belonging to the scope.

API: `/api/context-chat` (GET history, POST message). Scope authorization
pins each level to a real row in the caller's workspace (`getPmoById`,
`requireProjectAccess`) before any read/write.

> **PB-CHAT-01 update.** The PROJECT scope is no longer served by this
> deterministic responder. A project's conversation is the persisted, generative
> Project Brain (`/api/projects/[id]/brain/turns`, see
> `docs/project-brain-conversation.md`), hosted in the Project Command Center.
> `/api/context-chat` answers `410` for `contextType=project`; workspace and PMO
> chats are unchanged.

## Navigation (Changes 2, 8, 9)

- Sidebar (`operational-shell.tsx`) now renders a Workspace block (active
  workspace + "+ New" → `/workspaces/new`) and a **PMO tree**
  (`sidebar-pmo-tree.tsx`): PMOs with nested projects, per-PMO collapse,
  "+ New PMO" and per-PMO "new project" affordances. PMOs are never mixed
  with a flat project list.
- Nav registry (`navigation-hierarchy.ts`) adds `/chat` (Workspace Chat),
  `/workspaces`, `/pmos`; the shell partitions items by declared tier
  instead of style-string matching.
- Route policy registry registers `/workspaces`, `/pmos`, `/chat` as
  workspace-contextual.
- Projects open on **Overview** (`/projects/[id]`) with a section tab bar
  (`project-tab-nav.tsx`). (PB-CHAT-01 removed the Chat tab: the project
  conversation is Project Brain inside the Project Command Center.) Existing surfaces (Execution,
  Documents, Meetings, Evidence, Risks, Reports…) are reused via
  `?projectId=` links rather than rebuilt (Change 13).
- Project creation now lands on the project Overview, not the Command
  Center chat.

## Screens

| Route | Purpose |
| --- | --- |
| `/workspaces`, `/workspaces/new` | Workspace list/switch (cookie-persisted preference) and explicit creation — Create Workspace → Create PMO → Create Project. |
| `/pmos` | PMO administration: create, edit (name/type/icon/color), archive/restore, duplicate, delete. |
| `/pmos/[pmoId]` | PMO Overview: portfolio stats + project list + New Project. |
| `/pmos/[pmoId]/chat` | PMO chat (scoped to that PMO's projects). |
| `/pmos/[pmoId]/reports` | Scoped portfolio report + links to the executive reporting suite. |
| `/pmos/[pmoId]/settings` | PMO settings + members/agents/templates entry points. |
| `/chat` | Workspace chat / executive console across all PMOs. |
| `/projects/[id]` | Project Overview (landing view). |
| `/projects/[id]/chat` | Compatibility redirect (PB-CHAT-01) to the canonical Project Command Center, whose Project Brain panel holds the project's one conversation. |
| `/projects/[id]/settings` | Project admin: rename, status, methodology, move between PMOs, icon/color, duplicate, delete. |

## Active workspace selection

`resolvePreferredWorkspace` (`src/lib/workspaces/preferred-workspace.ts`)
reads the `pmfreak.workspaceId` cookie and validates it against real
memberships via `resolveCanonicalWorkspace` (stale/missing → oldest active
membership, exactly the previous behavior). `switchWorkspaceAction` /
`createWorkspaceAction` set the cookie.

## Command Center (Change 10)

`/command-center` keeps its per-project execution surface but now resolves
the preferred workspace and renders a cross-PMO operations strip (PMO count,
portfolio size, links to `/pmos` and `/chat`), making it consume the whole
workspace rather than assuming a single implicit portfolio.

## Tests

`tests/workspace-pmo-project-hierarchy.test.mjs` — migration shape, RLS,
scope CHECK constraint, contract declarations, context-id derivation, chat
scope filters, admin surfaces, creation-path PMO attachment, navigation
registration, and the Overview-first landing rule.
