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
claim. The UI labels the prose as AI-written; an answer with no statements is
marked as a general answer not linked to project records; and a notice appears whenever a
citation was rejected or a statement was downgraded or dropped.


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
- **Citations** are short per-turn aliases (`S1`…). The server resolves them against its own
  table; invented, foreign or malformed ids resolve to nothing and are stripped. Evidence-type
  claims without a valid source become `ASSUMPTION`; a FACT without a primary source becomes
  `INFERENCE`; high confidence without a primary source becomes medium. The result must pass
  the Sprint 0 `validateResponse` guardrails or the turn degrades.
- Persisted metadata: `projectBrain { mode, statements, sources, citations, context summary,
  provider, model }`. Never the prompt, keys, raw provider payload or reasoning.

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
  legacy redirect. Run with `scripts/pb-chat-01/openai-stub.mjs` when no provider key is
  available (stub replies are marked `[stub model]`).
