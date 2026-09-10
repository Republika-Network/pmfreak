# ADR-PMF-014: Command Center Naming Is Always Entity-Qualified, Never Bare

Status: Accepted
Date: 2026-07-19
Decision owners: Founder / Product Authority; PMFreak Architecture
Supersedes: None
Superseded by: None

## Context

ADR-PMF-007 ratified that Command Center is a projection/experience applied over a governed entity — never an entity itself, never independently created. It named, precisely, the sharpest concrete violation of that principle already live in production: the primary "create" call-to-action in the product, `Create Command Center` (`/create-command-center`), does not create a Command Center — it materializes a `pmos` row (PR1 §11, §22; ADR-PMF-007 Context). ADR-PMF-007 fixed *what Command Center is*; it explicitly deferred the naming fix itself ("Rename the `Create Command Center` CTA... to name the entity it actually creates" — ADR-PMF-007 Migration Implications) to a future PR, and to whatever document would carry the product's naming authority forward.

This ADR is that naming fix, at the ratification level. It formalizes, as binding naming policy, exactly how "Command Center" may and may not appear anywhere in PMFreak — in copy, in navigation, in documentation — building on ADR-PMF-007's semantic ruling and ADR-PMF-013's establishment of `docs/product-architecture/02-canonical-product-language.md` as the naming authority. It does not reopen or change ADR-PMF-007's domain ruling; it narrows specifically to the naming/copy rule that ruling implied but did not itself state as a checkable, literal rule.

## Decision

**"Command Center" is never shown to a user without being qualified by the specific entity it projects over, and it is never used as the label of a creation action.** The valid forms are exactly: Enterprise Command Center, Workspace Command Center, PMO Command Center, Portfolio Command Center, Program Command Center, and Project Command Center. A bare, unqualified "Command Center" — in a button, a heading, a breadcrumb, or documentation — is non-conformant with this ADR the moment it appears without a named entity attached, because an unqualified Command Center is indistinguishable from the entity-confusion ADR-PMF-007 already ruled against.

Creation actions are named for the entity they create, never for Command Center: `Create PMO`, not `Create Command Center`, is the correct label for the action that materializes a `pmos` row, consistent with ADR-PMF-003's PMO semantics and ADR-PMF-007's rule that "a user never creates a Command Center as an independent act."

## Domain Rules

1. Every user-facing appearance of "Command Center" must be immediately qualified with its entity: "Project Command Center," "PMO Command Center," etc. — never bare.
2. No button, menu item, or CTA is ever labeled "Create Command Center." A creation action is labeled for the entity it creates (`Create PMO`, `Create Project`, `Create Enterprise`, etc.).
3. Once an entity is created, the system may present "Open [Entity] Command Center" or "[Entity] Command Center" as a navigation/CTA label for viewing that entity's operational experience — this is the only context in which "Command Center" legitimately appears attached to a button.
4. Breadcrumbs place the entity-qualified Command Center only as the terminal node of a breadcrumb trail, never as an intermediate hierarchy level (per `02-canonical-product-language.md` §11).
5. Backend tables or internal identifiers carrying "Command Center" in their name (`pmo_command_center_snapshots`, `operational_command_centers`) are not user-facing vocabulary and must never be surfaced verbatim in copy; if surfaced conceptually, they must be presented as view-configuration for their qualified entity, per ADR-PMF-007 rules 7–8.
6. Internal/ops-only surfaces (e.g., the current `/pmo-command-center` internal dashboard, distinct in scope from the user-facing PMO Command Center) must not use the same unqualified phrase as a user-facing feature; if retained, such surfaces need their own, clearly internal name, to avoid a seventh meaning for the same words.
7. Documentation, marketing, and support copy follow the same entity-qualification rule as in-product copy; "Command Center" is never used generically to mean "the product" or "the main screen."

## Alternatives Considered

- **Allow "Command Center" to stand alone when context makes the entity "obvious."** Rejected: this is precisely the ambiguity PR1 documented across five to six different objects (§9, §11, §22); "obvious from context" was the exact justification under which the ambiguity accumulated in the first place. A literal, checkable rule (always qualify) is what closes the gap; a judgment call reopens it.
- **Rename "Create Command Center" to "Set Up Command Center" or similar softened language, without naming the actual entity created.** Rejected: this repeats the original defect in a new form — the CTA still would not name what it creates (a PMO). Rule 2 requires the entity name itself, not a euphemism for the same ambiguity.
- **Retire "Command Center" from user-facing language entirely, using only entity names + "workspace"/"dashboard."** Rejected: ADR-PMF-007 already ratified Command Center as the legitimate, retained name for PMFreak's operational-experience concept across all six hierarchy levels; retiring it would contradict that decision rather than fix its naming discipline. The problem PR1 found was inconsistent scope-labeling, not the word itself.
- **Leave internal table names (`pmo_command_center_snapshots`, etc.) unaddressed, treating them as invisible to this ADR's scope.** Rejected in part: while renaming those tables is explicitly out of scope (a future schema PR), this ADR does still rule (Rule 5) that they must never leak into user-facing copy verbatim, since "Command Center" appearing as a raw table name in an error message or debug view would itself violate the entity-qualification rule.

## Positive Consequences

- Gives engineering and copy review a single, mechanically checkable test: does every occurrence of "Command Center" name its entity? This is testable in a way "use good judgment about Command Center" is not.
- Directly resolves the single most concrete, evidenced naming defect PR1 found (`Create Command Center` creating a PMO), at the ratification level, ahead of the implementation PR that will execute the actual rename.
- Prevents the internal-dashboard/`pmo_command_center_snapshots`/`operational_command_centers` naming collisions from ever surfacing to end users, even before those tables are reconciled at the schema level (ADR-PMF-007 Migration Implications).
- Gives future documentation and marketing copy an unambiguous rule, closing a channel through which the ambiguity could otherwise re-enter the product via non-code surfaces.

## Negative Consequences

- Does not, by itself, rename `Create Command Center` in the running application — the actual defect remains live until a future implementation PR executes it (tracked in `02-canonical-product-language.md` §27, Migration Recommendations).
- Requires every future screen introducing a Command Center variant to carry slightly more verbose copy ("PMO Command Center" vs. bare "Command Center"), a minor but real UX cost traded for disambiguation.
- The internal `/pmo-command-center` ops dashboard's naming collision with the ratified user-facing "PMO Command Center" is flagged (Rule 6) but not resolved by this ADR; until a future PR renames or removes it, an internal document or support conversation could still conflate the two if this ADR is not consulted. **Since implemented:** the dashboard was renamed to `/pm-operations`, joining the internal `pm-*` family it is built from; `/pmo-command-center` is retained as a redirect-only entry point holding no copy of the screen. The two surfaces no longer share an unqualified label, so the conflation this bullet describes is closed. The reasoning — including the evidence that this route never was the PMO Command Center — is recorded in `src/lib/pm-operations/pm-operations-paths.ts`.

## Risks

- **Partial-rename risk:** if a future PR renames the CTA but not the onboarding tooltip copy that currently reads "Create a Command Center first..." (`getting-started-flow.tsx:359-371`, cited in ADR-PMF-007), the product would end up with the CTA correct and the surrounding copy stale — this ADR's Rule 2 applies to that tooltip exactly as much as to the button itself.
- **Internal-surface leakage risk:** because internal table names carrying "Command Center" are common in the codebase, a future debug view, log message, or admin tool could surface them verbatim, violating Rule 5, unless engineering review explicitly checks for this.
- **Documentation drift risk:** existing architecture documentation (`docs/architecture/command-center-foundation.md`) predates this ADR and uses "Command Center" in ways consistent with its own scope at the time; this ADR does not require that document to be rewritten (see Compatibility Implications), but any *new* documentation must follow this ADR's rule, and readers should not assume the older document is in scope for retroactive compliance.

## Security and Data Implications

None beyond what ADR-PMF-007 already established: Command Center is not a data boundary and this ADR does not change that. Ensuring internal table names never leak into user-facing surfaces (Rule 5) has a minor information-disclosure benefit (avoiding exposure of internal schema naming to end users) but is not itself a security control.

## Migration Implications

No migration is executed by this ADR. A future implementation PR should, per this ADR and ADR-PMF-007's own Migration Implications:

- Rename the `Create Command Center` CTA and `/create-command-center` route/wizard to `Create PMO`.
- Rewrite the onboarding wizard's gating copy (`getting-started-flow.tsx:359-371`) to remove "Command Center" as the object being created, reconciled with ADR-PMF-003's no-mandatory-default-PMO rule.
- Audit all existing UI surfaces for bare, unqualified "Command Center" occurrences and add the entity qualifier.
- ~~Rename or clearly re-scope the internal `/pmo-command-center` ops dashboard so it does not share an unqualified label with the user-facing PMO Command Center.~~ **Implemented:** renamed to `/pm-operations`, with `/pmo-command-center` retained as a redirect-only entry point.

## UX Implications

No UI, navigation, route, or copy is changed by this ADR. It fixes the rule a future UX/copy PR must conform to: every Command Center mention is entity-qualified; every creation action names its entity, never "Command Center."

## Compatibility Implications

Backward compatible: no existing route, component, or table is renamed by this ADR. `docs/architecture/command-center-foundation.md` is not required to be rewritten retroactively; its core technical claim ("a Command Center is not a new table, it is the existing `workspaces` table") remains the evidentiary basis this ADR (via ADR-PMF-007) builds on, not a claim it overturns.

## Out of Scope

- Executing the `Create Command Center` → `Create PMO` rename, or any other copy/route change (future PR3+).
- Renaming `pmo_command_center_snapshots` or `operational_command_centers` at the schema level (future PR, per ADR-PMF-007).
- Resolving whether `/command-center`'s mixed Project/Workspace scope should be split into two views (ADR-PMF-007 risk, still undecided).
- Any change to PMO's own domain semantics (ADR-PMF-003) or Command Center's own entity-vs-projection status (ADR-PMF-007) — both are fixed inputs to this naming-only ADR.

## Validation

- This decision is validated by ratification, resolving the naming-execution gap ADR-PMF-007 explicitly deferred ("Rename the `Create Command Center` CTA... to name the entity it actually creates").
- No code, schema, or test changes accompany this ADR; the applicable check is documentary: every Command Center reference in `docs/product-architecture/02-canonical-product-language.md` (§4, §7, §8, §9, §11) was checked against Rules 1–7 above before this ADR was finalized, and none appears bare/unqualified or as a creation-action label.
- Future PR2/PR3 acceptance test (not executed here): a text search of the shipped product's user-facing strings for the literal phrase "Create Command Center" should return zero matches, and every remaining "Command Center" string should be immediately preceded or followed by a named entity.

## References

- `docs/adr/ADR-PMF-007-command-center-operational-experience.md` — establishes Command Center as a projection/experience, the domain ruling this ADR's naming rule is built on.
- `docs/adr/ADR-PMF-003-pmo-governance-semantics.md` — PMO semantics; the entity the current mislabeled CTA actually creates.
- `docs/adr/ADR-PMF-013-canonical-product-language.md` — establishes `02-canonical-product-language.md` as the naming authority this ADR operates under.
- `docs/product-architecture/02-canonical-product-language.md` — §4 (Canonical Vocabulary), §7 (Command Center definition), §8–§11 (UX/Button/Navigation/Breadcrumb rules).
- `docs/product-architecture/01-canonical-domain-model.md` — PR1 §9, §11, §22, the original evidence base for the five-to-six-meaning Command Center problem.
