# ADR-PMF-077: Chat-Hosted Governed Command Controls

Status: Accepted
Date: 2026-09-29
Decision owners: Founder / Product Authority; PMFreak Architecture
Supersedes: None
Superseded by: None
Builds on: ADR-PMF-027, ADR-PMF-030, ADR-PMF-054, ADR-PMF-066, ADR-PMF-071
Clarifies: `docs/project-brain-execution.md` (PB-EXEC-00) §4, §12.2, §14; `docs/project-brain-conversation.md` (PB-CHAT-01)
Architecture: [`docs/project-brain-governed-commands.md`](../project-brain-governed-commands.md) (CHAT-GOV-00)

## Context

Project Brain (PB-CHAT-01) is the project's primary conversation. It is ratified as read-only:
`POST /api/projects/[id]/brain/turns` writes only transcript rows and AI usage, and PB-EXEC-00 §4
decides that Project Brain "gains no tools, no agent identity, no scopes, no grants — in any
PB-EXEC level".

The product direction is that a user should normally complete a governed journey — decide on a
governed Recommendation, authorize a governed Action, create the canonical Task, progress its
execution, review the Outcome — without leaving that conversation. Today every one of those human
commands lives only in the operational inspector (Needs You, In progress, Tasks), beside the
conversation, and the user must understand the persistence model to move between them.

Two readings of "chat-first" are possible, and only one is compatible with the ratified
architecture:

- **Model-controlled execution** — the model decides, selects or submits commands. Forbidden by
  ADR-PMF-027 (agents never issue operational Commands), ADR-PMF-030 (human authority over domain
  mutation) and PB-EXEC-00 §4.
- **Human command controls hosted in the conversation** — structured controls a human operates,
  rendered inside the thread, calling the same canonical command endpoints the inspector calls.

Without a decision, a future slice could implement the first while describing it as the second,
or could refuse the second because PB-EXEC-00 §14 says execution belongs on a "separate surface".
This ADR fixes which reading is ratified and what "separate" means.

## Decision

**Chat-first means conversation plus human-operated governed command controls plus the existing
canonical command endpoints. It never means model-controlled execution.** The Project Brain
conversation surface MAY host structured human command controls. Those controls are not model
tools. `/brain/turns` remains read-only permanently.

"Project Brain has no tools" and "Project Brain hosts governed human command controls" are
compatible because they speak about different principals:

- A **tool** is an operation the *model* can invoke. Project Brain has none, and gains none.
- A **governed command control** is a UI control a *human* operates. It is rendered next to the
  model's reply, but the model can neither see it as a capability nor act through it.

"Separate surface" in PB-EXEC-00 §4/§12.2/§14 means a separate **command endpoint with separate
authority**, never `/brain/turns`. It does not require a separate screen.

## Domain Rules

1. **The conversation channel is read-only permanently.** `/brain/turns` never creates, updates
   or deletes canonical project state. Its only writes remain the user and assistant
   `context_messages` rows and the AI usage row (`ai_usage_events`). No new operation added to
   `/brain/turns` may change this.
2. **Project Brain receives no write tools, no agent identity and no governance grants.**
   `project_brain.converse` stays human-only, `agentCompatible: false`, low risk.
3. **Controls are human-operated.** A governed command control is invoked only by an explicit
   human interaction (a click or an equivalent accessible activation) on a control that names the
   exact object and the exact operation. The model cannot press, select, confirm or submit a
   control, and no model output is ever interpreted as a control activation.
4. **Controls call the existing canonical command endpoints directly** — primarily
   `POST /api/operational-flow` and `POST /api/execution-tasks/internal-execution` — with the
   same payloads, the same server-side authorization and the same RPCs as every other surface.
   There is no chat-specific write endpoint and no direct table write from chat.
5. **The model cannot manufacture canonical ids.** A canonical reference rendered beside a reply
   (a governed Recommendation, Decision, Action, Task or Outcome) is attached by the server only
   after it verifies that the id is a canonical row in the routed workspace and project that the
   reply's cited sources resolve to. Model text naming an id is never a reference.
6. **One command per authority level.** No control performs more than one canonical transition.
   Recommendation → Decision, Decision → Action, Action → Task, Task → Execution and
   Execution → Outcome are separate commands, each separately confirmed. Composite controls such as
   "Accept and create action", "Authorize and dispatch" or "Complete task and mark outcome
   achieved" are prohibited, as are composite endpoints (restating ADR-PMF-030 rules 1–3 and
   ADR-PMF-071 rule 7 for the conversation surface).
7. **Natural language never confirms a write.** Composer text such as "accept it", "go ahead",
   "do it", "create the task" or "yes" never executes a command. A deterministic intent layer may
   focus a matching control, open its confirmation, or show a chooser when more than one target
   matches; it never submits.
8. **Controls render live canonical state.** A governed card is keyed by a verified canonical
   entity id, renders current canonical state from the canonical read model (never frozen model
   output or transcript prose), refreshes after every command, and has at most one actionable
   instance per canonical object; older instances collapse to read-only status indicators.
9. **Confirmation is tiered** (T0–T3, defined in the architecture document) and the tier is set
   by the operation and its classification, never lowered by the conversational context. T3 applies
   at minimum to external effects, irreversible actions, authority mutation, critical risk,
   material or high-consequence actions, and any unknown materiality field.
10. **AI suggestions stay distinguishable from human classification.** A value the model or a
    heuristic pre-fills is labelled as a suggestion at its point of display (ADR-PMF-066 rule 5,
    ADR-PMF-071 rule 5); only the value the human confirms is submitted, and it is the human's
    classification.
11. **Projections remain.** Needs You, Evidence, Tasks, Monitor and Audit remain canonical
    projections over the same state; acting in the conversation or in a projection is the same
    command and is reflected in both.

## Alternatives Considered

- **Give Project Brain tools behind confirmation ("the model proposes the call, the human clicks
  OK").** Rejected: the model would choose the operation and its arguments, making the prompt an
  authority input (forbidden by ADR-PMF-027 rule 1 and *04-AI* principle 8) and turning
  `/brain/turns` into an execution endpoint (forbidden by PB-EXEC-00 §14).
- **A chat-specific command endpoint (e.g. `/brain/commands`).** Rejected: it would duplicate
  authorization and business rules already enforced by the canonical routes and RPCs, and create a
  parallel path that could drift from them.
- **Record commands as transcript rows.** Rejected: transcript content is not canonical state and
  must never be read as such; canonical tables remain the only record of a command.
- **Keep commands only in the inspector.** Rejected as the product direction: it forces users to
  learn the persistence model. It remains available — projections are not removed.

## Positive Consequences

- The user can complete a governed journey inside the conversation without any change to who holds
  authority, which endpoint enforces it, or what is audited.
- One set of command endpoints, one set of RPCs, one read model: chat and projections cannot
  disagree about what is legal.
- The PB-CHAT-01 "no write-back" guarantee and the PB-EXEC-00 read-only guarantee stay literally
  true of `/brain/turns`.

## Negative Consequences

- A journey still takes one explicit, separately confirmed step per authority level; chat does not
  remove clicks that ADR-PMF-030 requires.
- Verified canonical references and live cards require server-side binding and a shared client
  read model before any control ships (later slices).

## Risks

- **Reflex confirmation.** Conversational speed invites click-through. Mitigated by tiered
  confirmation, no pre-selected dangerous fields and no Enter-to-confirm.
- **Suggestion anchoring.** Users may accept a suggested classification unread. Mitigated by
  per-field suggestion labels and explicit per-field affirmation at T3.
- **Scope creep toward model control.** Any proposal that lets model output select, fill-and-submit
  or confirm a control conflicts with this ADR and requires a new ADR revisiting ADR-PMF-027/030.

## Security and Data Implications

- Authorization is unchanged: every command is authorized by the canonical route and re-checked
  in its SECURITY DEFINER RPC under the human's own session.
- A canonical reference is a display binding, not authority; the command endpoint re-validates
  every id it receives.

## API Implications

- No new write endpoint. `/brain/turns` gains no write operation. The `/brain/turns` request body
  gains no field that names a command.

## UX Implications

- The conversation may render recommendation, decision, action authorization, task creation,
  execution, outcome review and audit/provenance cards inline. Each is a governed card under
  rules 3–10.

## Migration Implications

None. This ADR changes no schema and no runtime behavior.

## Out of Scope

The known gaps G1–G10 recorded in the architecture document (decision idempotency, the missing
approval operation, owner/admin self-authorization, the Frontera dispatch dependency, outcome
settlement, missing audit events, same-actor continuation, recommendation binding, audit
presentation, Task → Execution → Outcome revalidation). They are recorded, not resolved.

## Validation

`tests/chat-gov-00-governed-command-architecture.test.mjs` pins this ADR's rules, the architecture
document, the PB-CHAT-01/PB-EXEC-00 amendments, and the code facts they rely on (Project Brain's
server path imports no canonical command).

## References

- `docs/project-brain-governed-commands.md` (CHAT-GOV-00 architecture)
- `docs/project-brain-conversation.md` (PB-CHAT-01), `docs/project-brain-execution.md` (PB-EXEC-00)
- `docs/adr/ADR-PMF-027-governed-ai-agent-execution.md`, `ADR-PMF-030-human-authority-domain-mutation.md`,
  `ADR-PMF-054-idempotency-concurrency.md`, `ADR-PMF-066-governed-ai-agent-experience.md`,
  `ADR-PMF-071-human-ai-interaction-model.md`
