# ADR-PMF-007: Command Center Is an Operational Experience, Not an Entity

Status: Accepted
Date: 2026-07-18
Decision owners: Founder / Product Authority; PMFreak Architecture
Supersedes: None
Superseded by: None

## Context

PR1 (`docs/product-architecture/01-canonical-domain-model.md`) audited every current use of the phrase "Command Center" in the codebase and found it applied, inconsistently, to five to six distinct objects at different scopes (§9, §11, §13, §22):

1. The `workspaces` table row itself, decorated with a `command_center_type` taxonomy (`company_pmo | team_portfolio | independent | client_portfolio | improvement_program`), plus the `/create-command-center` creation wizard.
2. The `/command-center` route, which is primarily a Project-level execution surface, but also layers in a secondary cross-PMO Workspace-level strip on the same screen (`workspace-pmo-project-hierarchy.md:122-127`).
3. `pmo_command_center_snapshots` — a workspace-scoped executive-rollup table that predates the `pmos` table and has no FK to it.
4. `operational_command_centers` — a project-scoped attention-surface table, unrelated in scope to (3) despite the name overlap.
5. `/pmo-command-center` — an unrelated internal ops dashboard, not reachable from main navigation.
6. A stray `<h1>` reading "Operational Command Center" on the `/projects` list page.

The codebase's own internal design document states the underlying reality plainly: *"A Command Center is not a new table. It is the existing `workspaces` table."* (`docs/architecture/command-center-foundation.md:14`). No `command_centers` table exists anywhere in the schema. PR1 §22 confirms the brief's original hypothesis — *"PMO, Portfolio, Program and Project are entities; Command Center is the operational experience applied over an entity"* — is **substantially validated, with one correction**: the word is not applied to one entity at a time, but reused across the workspace, project, and two unrelated backend-table scopes above without reconciliation.

Crucially, PR1 §11 and §22 identify the sharpest concrete violation of this principle already live in production: the primary "create" call-to-action in the product, `Create Command Center` (`/create-command-center`), does not create a Command Center — it materializes a `pmos` row via `savePmoTenant` (`src/lib/pmo/save-pmo-tenant.ts`). The action's name does not describe the entity it actually creates. Separately, the onboarding wizard (`getting-started-flow.tsx:359-371`) currently blocks the "Create Project" action until "Create Command Center" (i.e., PMO creation) is completed, with tooltip copy reading *"Create a Command Center first to give your projects governance, objectives, and agent context"* — a framing that treats Command Center as a prerequisite gate, i.e., as if it were the entity being provisioned, rather than a view over one.

This ADR formalizes decision D-07 from the founder's ratified canonical hierarchy: Command Center takes no position in the entity hierarchy at all. It is not a level between any two entities; it is a presentation layer that can be applied over any of them.

## Decision

**Command Center is the primary operational experience, or a projection applied over a domain entity — it is never itself an aggregate root, an organizational entity, a data boundary, a tenant, or an object the user creates independently.**

Command Center must not be considered a replacement for Workspace or a replacement for PMO. It can exist, conceptually, as: Enterprise Command Center, Workspace Command Center, PMO Command Center, Portfolio Command Center, Program Command Center, and Project Command Center — each one the same kind of thing (a view/composition applied to that entity), never six different kinds of thing.

The user creates Enterprise, Workspace, PMO, Portfolio, Program, or Project. In every case, the system then *presents* a Command Center to operate or supervise that entity. Any UI action or route literally labeled "Create Command Center" is conceptually incorrect if it actually creates a different entity (today: a PMO) — the action must be named for what it creates, not for the view that will later be rendered over it.

## Domain Rules

1. Command Center is not an aggregate root. It has no independent lifecycle, no identity separate from the entity it is scoped to, and no table of its own is required by its existence.
2. Command Center is not an organizational entity. It cannot be a member of the hierarchy (Enterprise → Workspace → PMO → Portfolio → Program → Project) at any position.
3. Command Center is not a data boundary or a tenant. Tenancy is owned exclusively by Workspace (per ADR-PMF-002); PMO, Portfolio, Program, and Project each own their own scoping within that boundary. Command Center inherits scope from whichever entity it is projected over; it does not define scope itself.
4. Command Center is not a replacement name for Workspace, and not a replacement name for PMO. Where current code or copy uses "Command Center" as a synonym for either (e.g., `command_center_type` as a Workspace column, or "Create Command Center" actually creating a PMO), that is legacy naming to be corrected in a future PR, not evidence that Command Center is one of those entities.
5. A user never "creates a Command Center" as an independent act. A creation action must name the entity it actually creates (Enterprise, Workspace, PMO, Portfolio, Program, or Project); the system, separately, presents that entity's Command Center once the entity exists.
6. Command Center can take the form of: a shell, a dashboard, a projection, a composition of widgets, or a contextual experience — any of these are valid implementations, and more than one may coexist for different entity types, so long as none of them require independent creation, deletion, or identity divorced from the entity underneath.
7. Command Center does not require its own database table unless persistent *view configuration* (e.g., saved widget layout, saved filter set, pinned metrics) needs to survive across sessions.
8. If persistent Command Center configuration is stored, it must be modeled as view configuration scoped to (entity type, entity id, user or role) — never as the governed entity itself, and never as a competing source of identity for the entity it is scoped to.
9. Six named variants (Enterprise/Workspace/PMO/Portfolio/Program/Project Command Center) are anticipated by this hierarchy, but each is the same conceptual kind of object — a view — applied at a different scope. This ADR does not ratify that all six must be built; it ratifies that if and when any is built, it must conform to rules 1–8.

## Alternatives Considered

- **Promote Command Center to a first-class entity with its own table**, unifying the five to six current scattered usages under one real aggregate. Rejected: this would invert the audit's own evidence — the codebase's internal design note already states a Command Center *is* the `workspaces` table, and no current usage requires independent identity, lifecycle, or cross-entity relationships that a plain projection cannot express. Creating a `command_centers` table would introduce a seventh competing representation rather than resolve the existing six.
- **Collapse "Command Center" out of the product vocabulary entirely**, per the unmerged sibling-branch audit's general direction (PR1 §12 C-6). Rejected: the founder's ratification explicitly retains Command Center as "the primary operational experience" across all six hierarchy levels; PR1's own brief states these are legitimate concepts to connect, not delete, and Command Center specifically is confirmed by the audit to already function correctly as a view in its primary usage (`/command-center` as a Project-level execution surface) — the problem is inconsistent scope-labeling, not the concept itself.
- **Keep "Create Command Center" as the literal name of the PMO-creation action**, on the theory that "Command Center" is simply the product's marketing name for what technically is a PMO. Rejected: this is precisely the violation rule 3 in the brief's own hypothesis (restated as rule 5 above) prohibits — a creation action must name the entity it creates. Retaining this naming indefinitely would formalize, rather than fix, the exact confusion PR1 §11/§22 documents (a "create" CTA whose result is invisible under its own label).
- **Treat each of the five to six current "Command Center" objects as permanently independent, unreconciled surfaces**, since each already has real code behind it. Rejected: this ratifies confusion as permanent architecture. The whole point of this decision is to give every future "Command Center" usage a single conceptual test (rules 1–8) rather than accreting a seventh or eighth meaning the next time a scope needs a dashboard.

## Positive Consequences

- Gives engineering and product a single, testable definition: any proposed "Command Center" feature must answer "which entity is this a view over?" before implementation begins, rather than inventing new scope conventions ad hoc.
- Retroactively explains, and validates rather than contradicts, the one already-correct usage in the codebase (`/command-center` as a Project-level execution surface) as the pattern to generalize, not an exception.
- Names, precisely, the one concrete defect this decision requires a future PR to fix: `Create Command Center` must be renamed to describe the entity it actually creates (a PMO today).
- Removes Command Center as a candidate position in the hierarchy entirely, simplifying every other hierarchy ADR (ADR-PMF-001 through -006 and beyond) — none of them need to reason about where Command Center sits, because it does not sit anywhere.
- Establishes a governance test (rules 7–8) for the two existing backend tables that carry "Command Center" in their names (`pmo_command_center_snapshots`, `operational_command_centers`): both must be evaluated as candidate *view-configuration/snapshot* stores, not entity tables, when a future PR reconciles their naming.

## Negative Consequences

- This ADR does not, by itself, resolve any of the five to six current naming collisions PR1 documents; they remain live in the codebase until a future implementation PR executes the renames this decision implies are necessary.
- The onboarding wizard's current gating language ("Create a Command Center first to give your projects governance...") remains contradictory to this decision until a future PR rewrites it; users onboarding today will continue to see Command Center framed as a creatable prerequisite.
- Some engineers and stakeholders may continue to use "Command Center" informally as shorthand for "Workspace" or "PMO" out of habit, since that usage predates this ADR by multiple sprints; the terminology discipline this decision requires will need active reinforcement, not just documentation.

## Risks

- **Rename-scope risk:** the eventual future-PR rename of "Create Command Center" to name the entity it creates (PMO) intersects with ADR-PMF-003's PMO semantics and with any future onboarding-flow ADR; if those efforts are not sequenced together, a partial rename could leave the CTA correct in one place and stale in another.
- **Table-reconciliation ambiguity risk:** rules 7–8 require that any persisted Command Center state be view configuration, not the governed entity — but `pmo_command_center_snapshots` (workspace-scoped, no FK to `pmos`) and `operational_command_centers` (project-scoped) were both built before this ADR and their current schemas were not designed against this test. A future PR must audit both against rules 7–8 explicitly rather than assuming they already comply.
- **Multi-scope UI risk:** the `/command-center` route today mixes Project-level and cross-PMO Workspace-level data on one screen (PR1 §11). This ADR does not resolve whether that is one Command Center projecting two scopes' data, or two Command Centers rendered together; a future PR must decide, but this ADR's rule 3 (scope is inherited, not owned, by Command Center) constrains that decision without making it.

## Security and Data Implications

- No new data boundary is introduced. Tenancy remains exclusively owned by Workspace (ADR-PMF-002); this ADR confirms Command Center is not, and must never become, an alternate or competing scoping mechanism for RLS or any other access-control layer.
- Because Command Center has no independent identity, no new RLS policy is required by this ADR. Any future persisted view-configuration table (rule 7) must be scoped through the entity it configures (workspace_id / pmo_id / project_id, etc.) and inherit that entity's existing RLS pattern — it must not introduce a parallel, Command-Center-specific security boundary.
- This decision reduces long-term security-review surface: because Command Center can never become a data boundary or tenant, no future feature can legitimately justify a Command-Center-scoped bypass of Workspace-level RLS.

## Migration Implications

None of the following is executed by this ADR. They describe what a future implementation PR (PR2 or later) would need to do:

- Rename the `Create Command Center` CTA and the `/create-command-center` route/wizard to name the entity they actually create (a PMO today), per PR1 §11/§22 and consistent with ADR-PMF-003.
- Rewrite the onboarding wizard's gating copy (`getting-started-flow.tsx:359-371`) so it no longer frames Command Center as a creatable prerequisite; this must be reconciled with ADR-PMF-003's rule that a default PMO may not gate Project creation as a universal requirement.
- Reconcile the naming of `pmo_command_center_snapshots` (workspace-scoped, predates `pmos`, no FK to it) and `operational_command_centers` (project-scoped) against this ADR's rules 7–8 — either as legitimate view-configuration/snapshot stores with corrected names and scope-appropriate FKs, or as candidates for consolidation.
- ~~Rename or remove the unrelated `/pmo-command-center` internal ops dashboard~~ **Implemented:** renamed to `/pm-operations`, with `/pmo-command-center` retained as a redirect-only entry point (see ADR-PMF-014 Rule 6 and `src/lib/pm-operations/pm-operations-paths.ts`).
- Remove the stray "Operational Command Center" `<h1>` on `/projects`, so that "Command Center" as a user-facing phrase is reserved for actual entity-scoped operational views. *(Not addressed by the `/pm-operations` rename, which touched no `/projects` surface.)*
- Decide, and implement, whether the `/command-center` route's mixed Project/cross-PMO-Workspace data should be split into two clearly-scoped Command Center views or explicitly documented as one composite view drawing from two scopes.

## UX Implications

- No UI copy, route, navigation, or component is changed by this ADR. It is documentation-only.
- This ADR establishes the target framing for a future PR: every place in the product that surfaces a "Command Center" should make clear, contextually, which entity (Workspace, PMO, Portfolio, Program, or Project) it is a view over — a bare, unscoped "Command Center" label is itself a symptom of the ambiguity this ADR resolves conceptually but does not yet fix in the UI.
- The onboarding flow's current sequencing (block "Create Project" until "Create Command Center"/PMO creation is done) is flagged here as a **current-state contradiction** with this decision, to be corrected in a future PR — not resolved by this ADR, and not to be read as implicitly authorizing the current gating to remain indefinitely.

## Compatibility Implications

- No schema, route, or component changes accompany this ADR; all five to six current "Command Center" usages continue to function exactly as they do today until a future PR acts on the Migration Implications above.
- Any future code or documentation that treats Command Center as an entity with independent identity (a row to fetch by its own ID, a thing with its own foreign keys pointing *to* it from other entities) is, as of this ADR, non-conformant and should be flagged for correction in PR2 planning — it is not grandfathered as an equally valid alternative interpretation.
- This ADR does not invalidate or require rework of `docs/architecture/command-center-foundation.md`; that document's core technical claim ("a Command Center is not a new table, it is the existing `workspaces` table") is the evidentiary basis this ADR ratifies, not a claim it overturns.

## Out of Scope

- Executing any rename, schema change, or copy change described in Migration Implications (future PR2 or later).
- Resolving whether `/command-center`'s mixed Project/Workspace scope should be split into two views (flagged as a risk above, decision deferred).
- Reconciling `pmo_command_center_snapshots` and `operational_command_centers` naming, scope, or FK structure (future PR).
- Defining PMO's own semantics — covered by ADR-PMF-003, treated here as a fixed input (Command Center is not a synonym for PMO).
- Defining Workspace's own semantics — covered by ADR-PMF-002, treated here as a fixed input (Command Center is not a synonym for Workspace).
- Defining Portfolio, Program, or Enterprise Command Center's specific widget/dashboard contents — this ADR ratifies that such views are legitimate *if and when built*, not their design.

## Validation

This ADR is a documentation/ratification artifact; it has no code to test. Its validation criteria are:

- Consistency with the founder-ratified canonical hierarchy: Command Center appears nowhere in the Enterprise → Workspace → PMO → Portfolio → Program → Project spine or its optional shortcuts, and is instead recorded as a 1:1 conceptual/projection relationship from {Project, PMO, Portfolio, Program} (and, by extension, Enterprise and Workspace) — confirmed, this ADR introduces no hierarchy edge for Command Center.
- Accuracy of all current-state claims against `docs/product-architecture/01-canonical-domain-model.md`: every factual claim in Context traces to a specific section (§9 entity inventory, §11 route/UI model, §13 duplication classification, §22 Command Center Decision) and to `docs/architecture/command-center-foundation.md:14`, and was re-read from both source files before being restated here.
- No contradiction introduced with ADR-PMF-003 (PMO semantics): rule 4 and the Migration Implications section explicitly defer to ADR-PMF-003 for how the "Create Command Center" → "Create PMO" rename and onboarding-gating fix should be sequenced.
- Future PR2 acceptance test (not executed here): no route, component, or database table introduced after this ADR's ratification date represents Command Center as an entity with independent identity, its own foreign keys pointed at it by other entities, or its own creation flow that does not name the underlying entity being created.

## References

- `docs/product-architecture/01-canonical-domain-model.md` — PR1 canonical domain model audit; primary current-state evidence source (§9 entity inventory, §11 route/UI model, §12 Contradiction C-3, §13 duplication classification, §22 Command Center Decision).
- `docs/product-architecture/01.1-domain-ratification.md` — PR1.1 ratification document, authored in parallel with this ADR, recording the founder's full set of ratified decisions including D-07.
- `docs/architecture/command-center-foundation.md` — source of the `command_center_type` enum model and the "A Command Center is not a new table. It is the existing `workspaces` table" statement (line 14), and of the current onboarding gating language this ADR flags as contradictory.
- `docs/adr/ADR-PMF-002-workspace-boundary.md` — establishes Workspace as the sole tenancy/data boundary, a fixed input this ADR relies on (rule 3).
- `docs/adr/ADR-PMF-003-pmo-governance-semantics.md` — establishes PMO as a distinct governance entity, a fixed input this ADR relies on (rule 4) and coordinates with for the "Create Command Center" rename.
