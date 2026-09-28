# 00 — Birth of the Project Brain (Sprint 0)

Status: Implemented (foundation layer only — see limitations below)
Code: `src/lib/project-brain/`, `src/components/pmfreak/project-brain/project-brain-statement-card.tsx`
Tests: `tests/project-brain-foundation.test.mjs`

## What Sprint 0 Established

Sprint 0's mission was to define the Project Brain's "constitution" — the
behavioral contract every future cognitive capability (Listener, Historian,
Detective, Skeptic, Investigator, PM, Advisor, Strategist, Executive) builds
on, instead of each one inventing its own voice, epistemic model, or
fabrication guardrails.

It intentionally did **not** implement any real analysis, extraction, or LLM
reasoning. It implemented the *contract* such reasoning will later use.

### 1. The Constitution (`constitution.ts`)

A versioned (`PROJECT_BRAIN_CONSTITUTION_VERSION`, `1.0.0` at birth; `1.1.0` since PB-REASON-02), data-only
object: identity/voice, five non-negotiable principles (evidence before
assertion, never fabricate, express uncertainty explicitly, clearly separate
knowledge types, always preserve provenance), the fabrication blocklist, the
eight epistemic type definitions, the confidence language ladder, and the
project-context boundary statement. This is the single source language and
UI code read from — no component hardcodes its own voice.

### 2. The Epistemic Model (`types.ts`)

Eight classifications, matching the sprint's product principle that the
Project Brain must always distinguish what it knows from what it infers,
assumes, or doesn't know at all:

| Type | Meaning |
|---|---|
| `FACT` | Directly supported by authoritative evidence |
| `REPORTED` | Stated by a stakeholder, not independently verified |
| `INFERENCE` | A conclusion derived from evidence |
| `ASSUMPTION` | An explicit working assumption |
| `OPEN_QUESTION` | An unresolved question |
| `CONTRADICTION` | Two or more evidence items conflict |
| `RECOMMENDATION` | A proposed action, always requiring human approval |
| `UNKNOWN` | Not enough evidence to classify |

### 3. Provenance Model (`source-reference.ts`)

`ProjectBrainSourceReference` — evidence id, source system, title, type,
timestamp, excerpt, author, authority level (primary/secondary/unverified),
link, and primary/secondary flag. Pure adapters (`sourceReferenceFromEvidenceItem`,
`sourceReferenceFromProjectEvidence`) reshape rows already in the existing
`evidence_items` / `project_evidence` tables — no new evidence storage was
created.

### 4. Uncertainty Model

Confidence is qualitative-first (`high | medium | low | unknown`). A numeric
score is only ever allowed alongside a documented `method` and `scoredBy` —
never a bare percentage (`language.ts`'s `formatConfidenceCaption`).

### 5. Guardrails (`guardrails.ts`)

Runtime validators (`validateStatement`, `validateResponse`) enforce the
constitution against untrusted input — important because a future LLM-driven
capability will produce statements that types alone can't police:

- `FACT` requires ≥1 primary source.
- `REPORTED` requires a named reporter.
- `INFERENCE` requires a stated reasoning basis.
- `CONTRADICTION` requires ≥2 claims, each traceable to a source.
- `RECOMMENDATION` always requires `requiresHumanApproval: true`.
- `UNKNOWN` cannot carry sources or non-`"unknown"` confidence.
- No source may cross a project/workspace boundary.
- High confidence requires a primary source, for every evidence-derived type.

### 6. UI Pattern (`project-brain-statement-card.tsx`)

Renders one `ProjectBrainStatement` in the mandatory disclosure order
(epistemic badge → text → evidence → confidence → approval gate for
Recommendations), following the existing Intelligence Inbox card
conventions and `docs/product-architecture/08-ai-interaction-patterns.md`.

## Limitations As Shipped In Sprint 0

- Not wired into any real screen — existed only as a domain library and an
  unused component. **Closed by Sprint 0.5**, see `00-5-foundation-integration.md`.
- No deterministic or LLM-driven derivation logic existed yet.
- No knowledge-gap model beyond a bare `{ id, scope, question }` shape.

## Relationship To Prior Documentary Architecture

Sprint 0 implements, rather than re-derives, prose already specified in
`docs/product-architecture/05-memory-knowledge-ai-persistence.md` (§4:
"inference is not evidence"; §5: provenance/lineage) and
`docs/product-architecture/08-ai-interaction-patterns.md` (§2: mandatory
Recommendation disclosure order; §2.1: confidence is never a bare number).
