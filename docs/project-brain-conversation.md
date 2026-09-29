# Project Brain conversation (PB-CHAT-01)

One persisted, project-isolated, generative conversation per Project, hosted in the
Project Command Center. It is **read-only with respect to project state**.

```
CONVERSATION  ≠  PROJECT KNOWLEDGE  ≠  EVIDENCE  ≠  DECISION  ≠  ACTION
```

PB-CHAT-01 builds only the first box. Relevance classification (PB-CHAT-02) and
promotion into canonical project state (PB-CHAT-03) are out of scope.

## What it replaced

PB-CHAT-00 found three competing conversational architectures. PB-CHAT-01 composes
their strongest parts instead of keeping any one wholesale:

| Kept | From | Retired |
| --- | --- | --- |
| Transcript tables `context_conversations` / `context_messages` | Context Chat | The deterministic project responder (`/api/context-chat` now answers `410` for `contextType=project`) and the separate `/projects/[id]/chat` screen (now a redirect) |
| The visible Command Center surface | Command Center chat | The `CommandFeed` UI, its slash-command menu, its "deterministic rules" disclosure and the client adapter to `/api/command-center/chat` (the route remains, UI-less, for its own contract tests) |
| `runInference()` and the provider router | Copilot | Everything about the `/api/copilot` route behaviour: its governance path, memory sources and write-back |

## Surfaces

- **Command Center** (`CommandCenterLayout`, the project-scoped Command Center experience):
  the Project Brain panel is open by default, after the attention sections, keyed by the
  active project.
- **Canonical Project Command Center** (`/workspaces/[w]/projects/[p]/command-center`): the
  same component and the same thread, near the top of the page.
- `/projects/[id]/chat` redirects to the canonical Project Command Center; the Project tab
  strip has no Chat tab.
- Workspace Chat (`/chat`) and PMO Chat are unchanged and remain deterministic. They are
  not Project Brain and are future/demoted surfaces.

## API

`src/app/api/projects/[id]/brain/turns/route.ts`

| Method | Body | Behaviour |
| --- | --- | --- |
| `GET` | — | Ordered transcript (`message_seq`), `generativeAvailable` (provider configured **and** this user entitled) and `limitedModeReason` (`not_included` / `unavailable` / `null`). **Never creates a conversation.** |
| `POST` | `{ clientMessageId: uuid, text, retry? }` | One idempotent turn. `200 completed` / `202 pending` / `409` on id reuse. |

Scope comes only from the route: the project id is the path segment and the workspace is
`projects.workspace_id`, resolved by `requireProjectPermission(projectId, "read")`.
Bodies carrying `workspaceId`, `projectId` or `attachments` are refused (`400`). An
unknown project and an inaccessible one are the same `403`.

Both handlers bootstrap the runtime authority themselves (`bootstrapRuntimeConsumer()`,
idempotent, before the first access check), so the route never depends on another route
having run first in the same process — the first request a fresh server or serverless
instance serves works. A bootstrap failure refuses the request; it is never a way around
authorization (`tests/module-mocks/pb-chat-01-cold-runtime-*.test.mjs`).

## Governance

`project_brain.converse` (`GOVERNANCE_POLICY_REGISTRY`): project-scoped, `read`
permission, humans only, `riskLevel: low`, no approval rule. It authorizes conversational
inference over one project and nothing else — no project write, no tool execution, no
Evidence or operational mutation. `ai.execute` is unchanged and still requires human
approval. Every turn is audited (`governance_action_allowed`) and remains subject to the
provider layer's per-workspace request/cost ceilings and concurrency bound, plus a
per-user limit (`ai.module_output.project_brain_turn`, 120/hour).

## Generative entitlement (`generative-access.ts`)

Generative Project Brain is billable inference. Whether a turn may call the provider is
decided on the server, per request, after project read access and `project_brain.converse`:

- **`PMFREAK_OPERATING_PROFILE=closed-free-beta`** — generative Project Brain conversation
  is **included for the controlled closed-beta cohort**, although the ordinary commercial
  Free plan does not grant Advanced AI. This is an explicit beta entitlement for Project
  Brain only; it is **not** the normal Free-plan product contract, and no plan capability
  (`ai_analysis`, `advanced_ai_actions`, …) or other AI route changes.
- **Any other profile** — the canonical commercial entitlement applies (`canUseAdvancedAi`
  → `advanced_ai_actions`, i.e. Pro/PMO).

A user who is not entitled still converses: the question is persisted and answered in
deterministic limited mode (`reason: not_entitled`) **without any provider call**, and the
panel says full generative answers are not included in their plan. Any user with project
read access — including `viewer` — may converse; the conversation writes no project state.
Every entitled turn still passes the per-user limit and `runInference`'s per-workspace
request/cost ceilings and concurrency bound. Nothing in the request body affects the
decision.

## Persistence (`20260915000000_pb_chat_01_project_brain_conversation.sql`)

Additive only. Historical rows are preserved and backfilled.

- `message_seq` — the transcript order, **assigned by the database**: a `BEFORE INSERT`
  trigger always takes `nextval()` (a caller-supplied value is ignored), and for customer
  roles (`anon`/`authenticated`) `created_at` is the database clock. Globally unique
  (`context_messages_message_seq_uidx`). Historical rows are ranked by `(created_at, id)`
  with a window function — independent of heap order or the UPDATE plan — and the sequence
  is then positioned above the historical maximum.
- `client_message_id` — user-turn idempotency, unique per conversation.
- `reply_to_message_id` + `brain_mode` (`generative` | `degraded`) — at most one reply per
  (user turn, mode).
- **Append-only**: no member UPDATE/DELETE on messages or conversations (policies replaced,
  grants revoked).
- A member inserts user turns only as themselves. Assistant rows in a **project** thread are
  written only by the service-role writer (`assistant-message-writer.ts`) after governance,
  so no member can forge a sourced "Project Brain" reply.

**Residual boundary.** PMFreak has no per-project ACL: project read access is workspace
membership with a role that holds `read`. The database boundary is therefore the workspace;
the project boundary is the API (project-scoped governance, every read filtered by the
routed project id) plus the scope-shape and same-workspace triggers.

## Turn semantics (`turn-service.ts`)

State is read from persisted rows only:

- user row, no reply, younger than 60 s → `pending` (another request is generating; no
  second model call);
- user row, no reply, older → recovered by generating now;
- generative reply → completed (replay returns it, no inference, no billing);
- degraded reply only → completed; an explicit `retry: true` may add one generative reply.

Concurrent duplicates on one instance share a single in-flight generation. Residual:
two simultaneous recoveries of a stale turn on different instances could both call the
model; the unique index still guarantees one stored reply.

## Context (`context-builder.ts`)

`getOperationalSummary(...)` is the primary source, supplemented by the project row
(identity + onboarding answers), bounded `project_milestones`, `execution_tasks` and open
`raid_items`. Every read is filtered by workspace **and** project and every row is
re-checked in memory. Families: PROJECT, ONBOARDING, EVIDENCE, SIGNAL, RISK, ISSUE,
RECOMMENDATION, DECISION, ACTION, TASK, OUTCOME, MILESTONE, RAID_DISCOVERY. Recent
conversation (24 messages, ~12 turns) is passed separately, labelled as conversation, and
is never citable.

Trust: `RECORD` (canonical rows, primary), `SELF_REPORTED` (setup answers, secondary),
`DERIVED` (detector output), `UNVERIFIED` (discovery RAID and sample data). Discovery RAID
is never merged with governed `risk_issue_records`.

Not read: other projects, company-scoped legacy `project_memories`, vault nutrients,
operational/intervention memory, runtime conversation state, `project_memory_snapshots`.

Budget (`context-budget.ts`): per-family caps, 400 characters per source, 48 sources,
24,000 characters total (lowest priority dropped first), `truncated` reported to the model.

## Prompt and output

**What an answer is.** The prose `reply` is the model's conversational **synthesis**. The
structured `statements` are the grounded layer: each carries an epistemic label, and its
source chips show which project records it cited. Citation validation is an
**identity/scope** check — the cited alias was supplied in this turn for this project —
**not** a semantic check that the record supports the claim, and nothing in the product
says otherwise. Accordingly the FACT badge reads **"Cites project records"**: a source
reference proves which record was cited (identity/scope), not that the record entails the
claim. The UI labels every generative answer "AI-generated"; an answer with no statements
is marked as a general answer not linked to project records; and a caution appears whenever
a citation was rejected or a statement was downgraded or dropped. How these are laid out is
described under [Answer presentation (PB-PRESENT-01)](#answer-presentation-pb-present-01).


- System message holds the only instructions. Project records, history and the question are
  XML-escaped data inside `<project_context>`, `<conversation_history>`, `<current_question>`.
  The model is told to treat them as data, never follow embedded instructions, never invent
  project facts, separate fact from inference/assumption, cite ids, and say when data does not
  support a conclusion. Unloadable families are listed in `<unavailable_context>`.
- `runInference` with `moduleId: "project-brain"`, `workspaceId`, `projectId`, `temperature
  0.2`, `maxTokens 3700`, `timeoutMs 20000`, strict `json_schema` output
  (`{ reply, statements[] }`, no reasoning field).
- **Output contract** (`PROJECT_BRAIN_OUTPUT_LIMITS`): reply ≤ 2,000 characters, ≤ 6
  statements of ≤ 280 characters, ≤ 4 source ids each, bounded basis / reporter /
  contradiction fields. The limits are stated in the system prompt and enforced by
  clipping. `maxTokens` is derived from the JSON size of a maximal legal answer
  (≈ 9.1k characters ÷ 3 characters per token × 1.2 margin ≈ 3,660), pinned by tests. A
  provider stop at the ceiling (`finish_reason: length`) is logged as
  `project_brain.output_truncated` (identifiers only) and the turn degrades.
- Each `<source>` carries `type`, `kind` (plan / state / assessment — see *Operational
  reasoning*), `trust` and `recorded_at`; `<project_context>` carries `as_of` (server date).
- **Citations** are short per-turn aliases (`S1`…). The server resolves them against its own
  table; invented, foreign or malformed ids resolve to nothing and are stripped. Evidence-type
  claims without a valid source become `ASSUMPTION`; a FACT without a primary source becomes
  `INFERENCE`; high confidence without a primary source becomes medium. The result must pass
  the Sprint 0 `validateResponse` guardrails or the turn degrades.
- **Invented references** (PB-REASON-01): in the same grounding pass, reference-shaped tokens
  in the reply or statements — milestone codes (`MPP-04`), PR numbers (`#412`), branch names
  (`feat/…`), percentages, ISO dates — are checked against everything the turn supplied
  (source labels and content, recorded dates, today's date, the question, recent history).
  Codes match in any case (`MPP-07`, `mpp-07`, `Pb-Exec-01`) and every token is compared
  exactly after lowercasing (`MPP-1` is not vouched for by `MPP-10`); earlier assistant turns
  never count as supplied. Unmatched tokens are counted in `citations.unsupportedReferences`
  (which raises the grounding notice), and an evidence-type or RECOMMENDATION statement naming
  one becomes a low-confidence `ASSUMPTION`. A reply with **no** statements (a general or
  off-topic answer) is checked only for project-shaped references — PR numbers, branch names,
  and codes from one of the project's own identifier families (`mpp-07` when the records use
  `MPP-…`) — so "50%" or a historical date in a general answer raises no project-grounding
  warning. A false positive only adds caution; it never upgrades anything.
- Persisted metadata: `projectBrain { mode, statements, sources, citations, context summary,
  provider, model }`. Never the prompt, keys, raw provider payload or reasoning.

## Operational reasoning (PB-REASON-01)

Project Brain answers the user's **intent**, not a summary of its records. It is the same
single inference call per turn, the same strict `{ reply, statements }` contract and the same
grounding; there is no classifier call, no intent field and no schema, auth or persistence
change. What changed is what the model is told and what it can see:

- **Intent first.** The system prompt has the model decide silently what is being asked —
  next step / next milestone / what to do today / prioritization, status, blockers, decision
  support, another project question, or off-topic — and shape the answer for it. The category
  is never shown to the user.
- **Next-target reasoning.** For "what next?"-type questions: establish the current position
  from state records → separate completed / active / unresolved → earliest material unresolved
  item → executable now or blocked → ONE concrete next target and why → if the records cannot
  identify it, the exact missing fact. Suggested ordering where evidence supports it: blocked
  prerequisite → unresolved decision → correctness/safety gap → incomplete committed milestone
  → verification gap → execution → polish. Project evidence always overrides it.
- **Plan vs current state.** Every source carries a server-derived `kind`
  (`SOURCE_KIND_BY_FAMILY` in `context-types.ts`): `plan` (setup answers — intentions, target
  dates, contractual milestones), `state` (project, milestone, task, decision, outcome,
  evidence records) or `assessment` (risks, issues, signals, recommendations, proposed actions,
  discovery). `<project_context as_of="…">` gives today's date from the server clock. The
  model is told a plan is not a position, a target date does not choose the next task, a plan
  step the state records have moved past is done or superseded, completion that cannot be
  verified is reported as unverified, and matching work to a planned milestone by name is an
  inference, never a FACT.
- **Answer shape.** Lead with the answer; brief reasoning; only material blockers or gaps. No
  mission/architecture recap, record inventory or opening disclaimer. A blocker must be
  recorded as blocking (open issue, impediment, decision needed, unmet dependency) — a todo
  task or a risk is not one; with none, the answer says "No blocker is confirmed in the
  project records". Missing information becomes an actionable gap: the precise fact to
  establish, not "not enough information".
- **No fake precision.** The model is told never to invent milestone numbers, branches, PR
  numbers, percentages, owners, deadlines, test or deployment state, blockers or dependencies,
  and the invented-reference check above enforces the reference-shaped part deterministically.
- **Boundaries unchanged.** Conversation history is still what was *said*, never a citable
  source. A recommended next target is a `RECOMMENDATION` (requires human approval) and the
  missing fact an `OPEN_QUESTION`. The conversation stays read-only.
- **Future execution boundary.** PB-REASON-01 answers *what* should happen next and *why*,
  and the prompt forbids implementation steps (branches, files, commands) unless asked for and
  supported by the records. Packaging a next target for an execution agent is a separate,
  not-yet-built increment; it would consume this reasoning, not replace it (see
  [Execution boundary (PB-EXEC)](#execution-boundary-pb-exec)).

Verification: `tests/pb-reason-01-intent-first-reasoning.test.ts` (deterministic behaviour on
the shared fixtures in `tests/fixtures/pb-reason-01-projects.ts`) and
`scripts/pb-reason-01/eval-real-provider.ts` (manual real-provider evaluation of the same
fixtures through the real turn service, pinned to the fixtures' clock `FIXTURE_NOW`
(2026-09-26T12:00:00Z) and reporting the `as_of` and the model that answered; prints answers
for human grading). `OPENAI_API_KEY` and `DEFAULT_AI_MODEL` load independently from
`.env.local` unless exported. Certification: `NOT_AVAILABLE` (exit 0) only when no key is
configured; `RUN` (exit 0) only when at least one case was selected and every selected case
returned a generative provider answer; `INCOMPLETE` (exit 2) for an empty or unknown
`PB_EVAL_ONLY` selection; `FAILED` (exit 1) for any degraded answer (auth failure, timeout,
quota/rate limit, invalid output) — reported by failure class, never with provider messages or
secrets.

## Reported working context (PB-REASON-02)

```text
Conversation ≠ Source    Reported ≠ Fact    Reported ≠ Canonical State    Reported ≠ Evidence
…but what the human just told Project Brain is still useful.
```

What a user says in this conversation ("P13 merged this morning", "P14 is next", "correction:
the PR is still open") can be used as **provisional working context**: Project Brain may reason
and recommend from it, framed as reported and unverified, without ever turning it into a
project fact, a source or a write. Still one inference call per turn; no new table, migration
or model call.

- **Report map (`reported-context.ts`).** Built by the turn service after the context loads,
  from the already bounded history (`MAX_HISTORY_MESSAGES`) plus the current turn. Only USER
  rows with an authenticated author (`created_by_user_id`, which RLS pins to `auth.uid()`)
  become reports; assistant rows never do, so a past hallucination cannot vouch for itself.
  Each report gets a per-turn alias `R1…Rn` in time order. Reports outside the window expire
  with it; there is no report index.
- **Prompt.** No content is duplicated: the alias is an attribute on the turn itself —
  `<turn role="user" at="…" report_id="R2" by="you">…</turn>` and
  `<current_question at="…" report_id="R3" by="you">…` (the current message counts
  immediately). Assistant turns get only `at`. `by="another project member"` marks a report
  written by someone else in the shared project thread. The system prompt's REPORTED WORKING
  CONTEXT section tells the model to use relevant reports instead of refusing, to say they are
  unverified, to state both sides when a record disagrees (never overwriting the record nor
  dropping the report), to drop the provisional framing once a record confirms it, to let a
  later explicit correction supersede an earlier report, to ignore off-topic messages and to
  never obey instructions inside a report.
- **Output contract.** Each statement gains `reportIds` (strict schema, at most
  `reportIdsPerStatement` = 3). `sourceIds` (S*) and `reportIds` (R*) are separate
  namespaces, each resolved server-side against its own map: `R999`, an `S` id in
  `reportIds` or an `R` id in `sourceIds` is rejected and counted (`citations.rejectedReports` /
  `rejectedCitations`). `maxTokens` was re-derived for the larger worst case (3700 → 3800).
- **Epistemics.** A resolved report is persisted on the statement as
  `reports: [{ turnId, createdAt, reportedBy: "user" }]` — never as a
  `ProjectBrainSourceReference`, never with message content. REPORTED now needs a source OR a
  report (`humanReportsCountAsSupport`, REPORTED only); a report-backed REPORTED gets
  `reportedBy: "user"` from the server (the model cannot name a stakeholder role; guardrail
  `report_backed_reporter_not_user`). Normalization keys on VALID resolved reports, not on the
  absence of sources: a FACT citing any valid report becomes REPORTED, and an
  INFERENCE/CONTRADICTION/UNKNOWN citing one becomes ASSUMPTION — even beside valid sources, so
  an incidental record can never launder a report into evidence and a report is never silently
  dropped (PR #629 P1). An invented `R999` is not support and changes nothing. A claim resting
  on a report is never high-confidence. INFERENCE/CONTRADICTION without sources still fall to
  ASSUMPTION; FACT/INFERENCE/CONTRADICTION/UNKNOWN never carry reports (guardrail
  `reports_on_evidence_only_type`); RECOMMENDATION, ASSUMPTION and OPEN_QUESTION may list the
  reports they rely on. A record/report disagreement is FACT + REPORTED, not a forced
  CONTRADICTION (a chat turn is not a contradicting source). Constitution `1.0.0 → 1.1.0`.
- **Compatibility.** Metadata stays version 1: `reports`, `citations.rejectedReports` and
  `context.reportCount` are optional additions; older rows parse and render unchanged. The UI
  labels a report-backed REPORTED claim "Reported in chat · not verified".
- **Not in scope:** memory promotion (PB-CHAT-03), relevance/materiality classification
  (PB-CHAT-02), progressive disclosure UI (PB-PRESENT-01), execution briefs (PB-EXEC-*).

Verification: `tests/pb-reason-02-reported-working-context.test.ts` (cases A–O plus guardrails,
on `tests/fixtures/pb-reason-02-projects.ts`), browser scenario SIT-R in
`tests/e2e/pb-chat-01-project-brain.spec.ts` (the stub answers from `report_id`s and also cites
an invented `R999`), and `scripts/pb-reason-02/certify-reported-context.ts` — the PB-REASON-01
certification contract (reused `loadEvalEnv` / `certifyEvaluation`) over multi-turn cases with
seeded prior turns, plus deterministic structural checks that turn a violation into `FAILED`.

## Answer presentation (PB-PRESENT-01)

**Answer first.** An assistant turn shows its prose and ONE compact disclosure row beneath
it — "Sources & verification · 3 records". The structured claims (with their epistemic
labels) and the cited-record chips open from that row. It is a native `<details>`/`<summary>`
(keyboard and screen-reader operable, closed by default); its open state is UI-only — never
persisted, never in conversation metadata — and resets on reload.

**Material cautions stay visible while closed** (`answer-disclosure.ts`, a pure derivation
from the transcript view model), in this order of salience, amber from the existing palette:

| Condition (view model) | Collapsed row |
| --- | --- |
| a statement with `epistemicType = CONTRADICTION` | "Project records conflict" |
| `groundingAdjusted` | "Some claims need review" (the precise notice is inside) |
| statements with `reportedTurnIds` (PB-REASON-02) | "uses N reported chat updates · not verified" |
| otherwise | "Sources & verification · N records" (or "· N claims" with no record cited) |

Record counts are the view model's deduplicated `sources`; reported counts are distinct
turns. No internal alias (`S*`/`R*`), counter or turn id is shown.

**Stays outside the disclosure:** "Limited mode" and its retry; the general-answer note
("AI-generated · General answer — not linked to this project's records.") — a general
answer gets no disclosure at all, since there is nothing to disclose; a grounding notice on
an answer that has nothing to open; the legacy "Earlier rule-based Project Chat reply" label.

**Inside:** the grounding, conflict and reported-context notes; every structured claim with
a sentence-case label ("Cites project records", "Inference", "Reported in chat · not
verified", "Suggestion · needs your approval", "Open question", "Records conflict",
"Unverified", "Not known yet"); any other claim that rests on a chat report is
additionally tagged "Uses a chat report · not verified"; the cited-record chips (family,
label, recorded-date tooltip, `data-source-id` — meaning unchanged); and the boundary line "A
citation shows which record a claim points to; it is not proof of every sentence." The panel
contains structured claims and provenance — never model reasoning, and it is never labelled
as such.

**The AI label.** ADR-PMF-066 §5 (Accepted) requires a visible "AI-generated" label at the
point of display of any AI-generated text, so the per-answer label stays — reworded from
"AI-written answer" to the literal "AI-generated" and moved from above the prose into the
quiet disclosure row (or the general-answer note). Limited-mode and legacy replies are
deterministic and are not labelled AI-generated. The composer footer is shown in every mode —
generative and limited — so it is worded to be true in all of them: "Generative Project Brain
answers are AI-generated and can use this project's records and what is said in this
conversation. When an answer has project support, its sources & verification open beneath it;
a citation is not proof of every sentence. Project Brain cannot change the project." It never
says every answer is AI-generated (limited-mode replies are not) or that every answer has a
details panel (general and bare limited-mode answers have none).

**Governance scope.** ADR-PMF-066 §4 (provenance never behind an extra click) governs domain
Recommendation records, Agent Proposals, Project Memory and Enterprise Knowledge records. A
Project Brain statement typed `RECOMMENDATION` is structured chat metadata — no approval control,
no domain Recommendation is created or mutated — so it is not in that rule's scope. ADR-PMF-071
§6 (claim evidence reachable within one interaction) is met: one activation of the disclosure
shows every claim and cited record.

**Presentation only.** One renderer (`ProjectBrainAnswer`) serves the `surface` and `panel`
layouts. No prompt, output contract, grounding, normalization, persistence, API, migration or
provider change; opening details issues no request and no model call and writes nothing;
AI token/cost delta is zero. Pinned by `tests/pb-present-01-progressive-disclosure.test.mjs`
(real renders via `tests/pb-present-01-harness.tsx`, plus a diff guard over the reasoning,
grounding and API files) and browser scenarios P1–P5 in
`tests/e2e/pb-chat-01-project-brain.spec.ts`.

## Execution boundary (PB-EXEC)

Architecture: [`project-brain-execution.md`](project-brain-execution.md) (PB-EXEC-00 —
architecture and contract; PB-EXEC-01 — implemented as described below).

- **Project Brain reasoning remains read-only.** Project Brain is a governed conversational
  reasoning surface — not an Agent Definition, not an Agent Run, never a requester or an
  authority for execution. `project_brain.converse` stays human-only, `agentCompatible: false`,
  low risk; `/brain/turns` never becomes an execution endpoint.
- **PB-EXEC creates a separate governed execution boundary.** Execution authority lives only in
  PMFreak governance (policy, human approval, single-use execution grants) — never in a prompt,
  a brief, a chat report or repository content. `reason < prepare < delegate < merge < deploy`:
  each step is a separate command with separate authority.
- **PB-EXEC-01 (implemented) prepares briefs only — reason → prepare.** Each RECOMMENDATION
  of a generative answer carries a "Prepare execution brief" control bound to its exact
  `{ assistantTurnId, statementId }`. `POST /brain/turns` accepts `intent: "execution_brief"`
  and a closed `targetRef`; an explicit target is validated from persisted rows before anything
  is written (`400 invalid_execution_target`), a typed "prepare it for Claude" resolves only
  when the latest generative answer has exactly one recommendation and otherwise returns
  `needs_target` with nothing persisted and no model call. A brief turn runs the dedicated
  `project_brain.execution_brief` operation *instead of* the answer inference (one call),
  and persists a canonical, executor-neutral `ExecutionBriefV1` in the reply's
  `metadata.projectBrain.executionBrief` — stable source ids and user-turn ids only (no
  `S*`/`R*` alias), `contextFingerprint` + `briefContentHash`, server-computed readiness, and
  a constant handoff (`manual`, `executionAuthorized: false`, `delegationEligible: false`).
  The user row stores its operation identity (`metadata.projectBrainRequest`); a reused
  `clientMessageId` with another operation or target is a `409`. A brief turn has its own
  pending window (120 s, derived from its whole budget) and starts its provider call only
  inside an inference lease. For a selected Recommendation the server owns the target: it is
  the Recommendation's exact text, supported by that Recommendation's still-current, unchanged
  sources and reports; the model cannot rewrite it, and a brief whose support changed asks to
  reconfirm it (`needs_input`) instead of being retargeted. The transcript API shows a stored brief only after recomputing its content
  hash and binding it to its row and the route's workspace and project. The brief card renders the
  same canonical brief as Generic, Claude Code or Codex text **in the browser** (no request, no
  model call, no write) and copies it after a credential check. There is no execute, delegate,
  PR, merge or deploy control. It does not use the agent execution runtime. It reads no
  repository and calls no SCM. An Execution Brief is not an authorization to execute and nothing runs.
  Module: `src/lib/project-brain/execution-brief/`. Pinned by
  `tests/pb-exec-01-execution-brief.test.ts`, `tests/pb-exec-01-brief-presentation.test.mjs`,
  `tests/e2e/pb-exec-01-brief-card.spec.ts` and `tests/e2e/pb-exec-01-project-brain.spec.ts`;
  certified against the real provider by `scripts/pb-exec-01/certify-execution-brief.ts`.
- **PB-EXEC-02 (future) will delegate** to an external executor under an explicit human grant,
  after repository binding, an executor adapter and the runtime prerequisites exist.
- **PB-EXEC-03 (future) will address governed autonomy**, and requires a new ADR revisiting
  ADR-PMF-027/030.

PB-EXEC-01 is implemented. PB-EXEC-02 and PB-EXEC-03 are not implemented: there is no delegated
execution, no repository integration and no Claude Code or Codex integration — the product
prepares and copies text only.

## Degraded mode

Not entitled (no provider call), provider not configured, timeout, circuit open, quota/cost ceiling or invalid output →
a deterministic reply that starts "Project Brain is temporarily operating in limited mode",
lists only what this turn's project-scoped context loaded (and says "I couldn't check" for a
family whose read failed — never "none"), and is stored with `brain_mode = degraded`.
`OPENAI_API_KEY` stays optional in production (repository philosophy): without it the panel
shows a limited-mode notice up front and every turn is honestly degraded.

## No write-back

The only writes behind a turn are the two transcript rows and the AI usage row that
`runInference` records. No project state, Evidence, RAID, Recommendation, Decision, Task,
Outcome, Project Memory, vault nutrient, operational or intervention memory write exists on
this path — pinned by `tests/pb-chat-01-project-brain-conversation.test.ts` (static and
behavioural) and by the browser scenario's before/after row counts.

## Verification

- `tests/pb-chat-01-project-brain-conversation.test.ts` — idempotency, degraded mode,
  citations, context isolation/budget, prompt boundaries, governance, no writes.
- `scripts/check-pb-chat-01-db.mjs` — live RLS/index/upgrade proof on a disposable local stack,
  including an ADVERSARIAL upgrade (legacy rows written out of chronological order, and a
  timestamp tie written high-id first) and Data API attempts to forge `message_seq` /
  `created_at`.
- `tests/e2e/pb-chat-01-project-brain.spec.ts` — browser SIT scenarios A, B, G, H, I, degraded,
  legacy redirect, SIT-R (reported context) and PB-PRESENT-01's P4 (390px) and P5
  (disclosure stays in place, no request). Run with `scripts/pb-chat-01/openai-stub.mjs` when no provider key is
  available (stub replies are marked `[stub model]`).
