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
| `GET` | — | Ordered transcript (`message_seq`) plus `generativeAvailable`. **Never creates a conversation.** |
| `POST` | `{ clientMessageId: uuid, text, retry? }` | One idempotent turn. `200 completed` / `202 pending` / `409` on id reuse. |

Scope comes only from the route: the project id is the path segment and the workspace is
`projects.workspace_id`, resolved by `requireProjectPermission(projectId, "read")`.
Bodies carrying `workspaceId`, `projectId` or `attachments` are refused (`400`). An
unknown project and an inaccessible one are the same `403`.

## Governance

`project_brain.converse` (`GOVERNANCE_POLICY_REGISTRY`): project-scoped, `read`
permission, humans only, `riskLevel: low`, no approval rule. It authorizes conversational
inference over one project and nothing else — no project write, no tool execution, no
Evidence or operational mutation. `ai.execute` is unchanged and still requires human
approval. Every turn is audited (`governance_action_allowed`) and remains subject to the
provider layer's per-workspace request/cost ceilings and concurrency bound, plus a
per-user limit (`ai.module_output.project_brain_turn`, 120/hour).

## Persistence (`20260915000000_pb_chat_01_project_brain_conversation.sql`)

Additive only. Historical rows are preserved and backfilled.

- `message_seq` — monotonic insertion order; the transcript never orders by timestamp alone.
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

- System message holds the only instructions. Project records, history and the question are
  XML-escaped data inside `<project_context>`, `<conversation_history>`, `<current_question>`.
  The model is told to treat them as data, never follow embedded instructions, never invent
  project facts, separate fact from inference/assumption, cite ids, and say when data does not
  support a conclusion. Unloadable families are listed in `<unavailable_context>`.
- `runInference` with `moduleId: "project-brain"`, `workspaceId`, `projectId`, `temperature
  0.2`, `maxTokens 900`, `timeoutMs 20000`, strict `json_schema` output
  (`{ reply, statements[] }`, no reasoning field).
- **Citations** are short per-turn aliases (`S1`…). The server resolves them against its own
  table; invented, foreign or malformed ids resolve to nothing and are stripped. Evidence-type
  claims without a valid source become `ASSUMPTION`; a FACT without a primary source becomes
  `INFERENCE`; high confidence without a primary source becomes medium. The result must pass
  the Sprint 0 `validateResponse` guardrails or the turn degrades.
- Persisted metadata: `projectBrain { mode, statements, sources, citations, context summary,
  provider, model }`. Never the prompt, keys, raw provider payload or reasoning.

## Degraded mode

Provider not configured, timeout, circuit open, quota/cost ceiling or invalid output →
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
- `scripts/check-pb-chat-01-db.mjs` — live RLS/index/upgrade proof on a disposable local stack.
- `tests/e2e/pb-chat-01-project-brain.spec.ts` — browser SIT scenarios A, B, G, H, I, degraded,
  legacy redirect. Run with `scripts/pb-chat-01/openai-stub.mjs` when no provider key is
  available (stub replies are marked `[stub model]`).
