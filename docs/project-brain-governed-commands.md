# Project Brain governed command controls (CHAT-GOV-00)

Status: **CHAT-GOV-00 is architecture only.** It ratifies how governed human commands may be
hosted inside the Project Brain conversation ([ADR-PMF-077](adr/ADR-PMF-077-chat-hosted-governed-command-controls.md)).
It adds no route, no migration, no UI control and no runtime behavior. No governed command
control exists in the conversation yet; later CHAT-GOV slices build them inside this contract.

```text
Chat-first ≠ model-controlled execution
conversation (read-only)  +  human command controls  +  existing canonical command endpoints
A tool is something the model can invoke.  A control is something a human operates.
One control = one command = one authority level.
```

Related: [`project-brain-conversation.md`](project-brain-conversation.md) (PB-CHAT-01),
[`project-brain-execution.md`](project-brain-execution.md) (PB-EXEC-00), ADR-PMF-027, ADR-PMF-030,
ADR-PMF-054, ADR-PMF-066, ADR-PMF-071.

---

## 1. Purpose

Project Brain is the primary interaction surface of a project. The governed spine behind it —
Evidence → Signal → Risk/Issue → Governance Event → governed Recommendation → Decision → governed
Material Action → Task → Execution → Outcome — is canonical and auditable, but every human command
on it lives today only in the operational inspector beside the conversation. The user has to know
the persistence model to finish ordinary governed work.

CHAT-GOV makes the conversation the place where that work is done **without** changing who holds
authority, which endpoint enforces it, or what is audited. This document fixes the boundaries every
later CHAT-GOV slice must be built inside.

## 2. Architecture

```text
   MODEL / CONVERSATION  (Channel A — /brain/turns, read-only)
          │
          │  read / explain / cite / suggest
          ▼
   CANONICAL READ MODEL  (GET /api/operational-flow → getOperationalSummary;
          │               shared client read models)
          │  verified canonical ids, current state, legal operations
          ▼
   STRUCTURED HUMAN CONTROL  (Channel B — governed card in the thread)
          │
          │  explicit human click (after the tier's confirmation)
          ▼
   CANONICAL COMMAND API  (POST /api/operational-flow,
          │                POST /api/execution-tasks/internal-execution)
          ▼
   GOVERNED DOMAIN STATE  (SECURITY DEFINER RPCs, canonical tables, audit)

   There is NO arrow from MODEL / CONVERSATION to CANONICAL COMMAND API.
   There is NO arrow from MODEL / CONVERSATION to STRUCTURED HUMAN CONTROL activation.
```

The model's output may influence **what the human is shown** (which verified card appears beside a
reply, which suggestion is displayed). It never influences **what is submitted**: every submitted
field is either server-derived from canonical state or entered/confirmed by the human.

## 3. Two channels

| | Channel A — Conversation | Channel B — Governed command controls |
| --- | --- | --- |
| Endpoint | `POST /api/projects/[id]/brain/turns` (unchanged) | Existing canonical command endpoints: `POST /api/operational-flow`, `POST /api/execution-tasks/internal-execution` |
| Principal | Model (inference) on behalf of a reading human | The human |
| Responsibilities | Explain, summarize, reason, cite, suggest, answer questions | Render current canonical state; expose the legal human operations; invoke canonical server commands; show success, denial and error; refresh canonical projections |
| Writes permitted | `context_messages` transcript rows and normal AI usage metadata (`ai_usage_events`) only | Only what the invoked canonical command writes, through its RPC |
| Canonical project-state mutation | **None** | Exactly one canonical transition per command |
| Governance | `project_brain.converse` (read, human-only, `agentCompatible: false`, low risk) | The command's own route authorization and RPC re-checks |

**The controls may visually live inside the conversation thread but remain architecturally
separate from the model.** Rendering location is not authority.

## 4. Tools versus governed command controls

| | Tool | Governed command control |
| --- | --- | --- |
| Who invokes it | The model | A human |
| Where it is declared | In the model's request (function/tool schema) | In the UI, from canonical state |
| Who chooses the arguments | The model | The server (canonical ids, digests) and the human (rationale, classification) |
| Exists for Project Brain | **No — never** (PB-EXEC-00 §4) | Yes, from CHAT-GOV slices onward |

Rules:

1. `/brain/turns` remains read-only permanently.
2. Project Brain itself receives no write tools, agent identity or grants.
3. The conversation surface MAY host structured human command controls.
4. Those controls are not model tools. No tool, function-call or command schema is ever sent to the
   model, and the model's output schema has no field that names a command.
5. Controls call existing canonical server operations directly, with the same payloads and the same
   authorization as every other surface. There is no chat-specific write endpoint.
6. The model cannot press, select, confirm or submit those controls.
7. The model cannot manufacture canonical IDs.
8. Canonical references rendered beside replies must be verified server-side.

## 5. Canonical references beside replies

A governed card appears beside a reply only through a **server-verified canonical reference**:

- The reply's statements cite per-turn source aliases (`S*`) that the server already resolves to
  stable source identities (PB-CHAT-01 grounding). The server may attach a canonical reference
  (`recommendation`, `decision`, `action`, `task`, `outcome`) only when a cited source resolves to a
  canonical row of that kind in the routed workspace and project.
- The binding is re-verified whenever the transcript is read, like the Execution Brief content hash
  (PB-EXEC-01). A reference whose row is gone, out of scope or unreadable is not rendered.
- Model text that names an id, a code or a title is never a reference and never produces a card.
- A reference is a display binding, not authority. The command endpoint re-validates every id it
  receives.
- A deterministic, non-model query ("what needs me?") may render governed cards straight from the
  canonical read model; it needs no model output at all.

## 6. One command per authority level

No UI control may perform more than one canonical transition. These remain separate commands, each
separately confirmed:

| Transition | Canonical command |
| --- | --- |
| Recommendation → Decision | `record_decision` |
| Decision → Action | `propose_material_action` |
| Action → Task | `dispatch_material_action_to_task` |
| Task → Execution | internal execution `queue` / `start` / `block` / `fail` / `retry` / `complete` (one command each) |
| Execution → Outcome | `ensure_expected_outcome`, then `record_outcome_observation` (separate commands) |

**Prohibited composite operations** (controls and endpoints alike), including but not limited to:

- Accept and create action
- Authorize and dispatch
- Complete task and mark outcome achieved

After a command succeeds, a card may *offer* the next step as a new, separately confirmed control.
An offer is never a default and never pre-submitted. This restates ADR-PMF-030 rules 1–3 and
ADR-PMF-071 rule 7 for the conversation surface.

## 7. Live-card semantics

A governed card must:

- be keyed by a verified canonical entity id;
- render current canonical state, not frozen model output;
- refresh after commands (and on the canonical read model's normal refresh);
- have at most one actionable instance per canonical object;
- collapse stale historical instances into read-only status indicators;
- never treat transcript prose as authoritative canonical state.

A card's available operations and disabled reasons come from the same shared read model the
projections use, so a card and Needs You / In progress / Tasks cannot offer different operations for
the same object. A card shows a disabled operation together with its reason (authority not
satisfied, not the same actor, expired, revoked, awaiting approval, enforcement unavailable, no
eligible evidence, request in flight) rather than hiding it.

Commands are not copied into the transcript. The canonical tables remain the only record of a
command; a thread may show canonical events read-only.

## 8. Natural-language boundary

Composer phrases such as:

- "accept it"
- "go ahead"
- "do it"
- "create the task"
- "yes"

**MUST NEVER directly execute a write.**

A deterministic intent layer (a closed phrase set, not model inference — the same pattern as the
PB-EXEC-01 brief intent) may:

- focus an existing matching card;
- open a confirmation card;
- show a chooser if multiple targets are possible.

It must NOT submit the operation. Confirmation must occur through the structured governed control.
An utterance that matches no target or more than one target is never resolved by letting a model
decide what "it" is. Pressing Enter in the composer never confirms a card.

## 9. Confirmation tiers

| Tier | Meaning | Required |
| --- | --- | --- |
| **T0** | Read/navigation only | No confirmation |
| **T1** | Explicit verb-labelled control for low-consequence state transitions | A single activation of a control that names the operation and the object |
| **T2** | Structured inline confirmation | Exact object; operation; rationale/reason where required; explicit Confirm |
| **T3** | High-consequence structured confirmation | Object; operation; classifications; risk; reversibility; side effect; authority consequences; expiry/digest where relevant; explicit per-field affirmation; no Enter-to-confirm behavior |

**T3 must apply at minimum to:**

- external effects;
- irreversible actions;
- authority mutation;
- critical risk;
- material/high-consequence actions;
- ambiguous/unknown materiality fields.

Additional rules:

- The tier is set by the operation and its classification. The conversation can never lower it.
- A classification value pre-filled as a suggestion is labelled "suggested" at its point of display.
  At T3 each materiality field must be affirmed individually. Fields that trigger T3 are never
  submitted from a suggestion that has not been affirmed.
- A terminal operation says so before confirmation (for example, a terminal Decision cannot be
  changed).
- Authorization copy keeps the canonical distinctions: *authorized does not mean executed*;
  *completion is not an outcome*.

Baseline mapping (a later slice may make it stricter, never looser):

| Operation | Tier |
| --- | --- |
| View recommendation, evidence, lineage, audit | T0 |
| Record Decision (any status; rationale required) | T2 |
| Propose Action, ordinary classification (ordinary business write, low risk, internal, reversible) | T2 |
| Propose Action, any other classification | T3 |
| Revoke Action | T2 |
| Create canonical Task from an authorized Action | T2 |
| Execution `queue` / `start` / `retry` | T1 |
| Execution `block` / `fail` / `complete` | T2 |
| Define expected outcome | T2 |
| Record outcome observation | T2 (T3 for `disputed`/`inconclusive` or when it changes an already observed outcome state) |

## 10. Idempotency and failure behavior

- Every card command uses the idempotency identity the canonical client already uses for that
  command (ADR-PMF-054). A card and a projection acting on the same object share that identity, so
  acting in both is a replay, not a second write.
- A control is disabled while its request is in flight. A network failure is retried by the human
  with the **same** identity; nothing retries automatically.
- A canonical conflict (an idempotency conflict, an already-terminal Decision, a changed digest) is
  shown as "already recorded — view", never retried and never coerced.
- A denial is shown with its human-safe reason. Enforcement-boundary denials stay narrow (no
  internal reason codes).

## 11. Projections

Project Brain / Chat is the primary interaction surface. Other surfaces remain canonical projections
over the same state:

| Surface | Role |
| --- | --- |
| Needs You | Attention / decision queue |
| Evidence | Provenance inspection |
| Tasks | Task and execution projection |
| Monitor | Exceptions / outcomes |
| Audit | Lineage and inspection |

The user should normally be able to complete a governed journey without leaving the conversation,
while still being able to inspect every canonical artifact elsewhere. A command issued from the
conversation is the same canonical command as one issued from a projection and is reflected in both.

## 12. Explicit non-goals

CHAT-GOV does **not**:

- give tools to the Project Brain model;
- allow direct table writes from chat;
- introduce composite decide-and-act endpoints;
- allow natural-language write confirmation;
- use the agent execution runtime as the governed command path;
- merge RAID and governed recommendation semantics;
- infer outcome achievement from task completion;
- delete Needs You / Evidence / Tasks / Monitor / Audit surfaces.

It also does not reintroduce automatic `run_chain` after capture (PR #568): capture and intelligence
remain separate operations.

## 13. Known unresolved gaps

Recorded by the CHAT-GOV audit against `main` at `cfd601f7`. **CHAT-GOV-00 does not resolve any of
them.** A later slice that depends on one must resolve it or state the limitation in its controls.

| # | Gap | Current behavior | Consequence for chat-hosted controls |
| --- | --- | --- | --- |
| G1 | Decision idempotency for non-terminal decisions | `record_operational_decision` takes no idempotency key; terminal Decisions are deduplicated by a unique index and row lock, but a retried `escalated` / `needs_more_evidence` inserts a second row | Double-submission from chat can duplicate non-terminal Decisions |
| G2 | Missing approval operation for `requires_approval` | No command moves a `requires_approval` Material Action forward; the only other operation is revoke | A Material Action proposed by a PM with a material classification dead-ends |
| G3 | Owner/admin self-authorization policy | Owner/admin proposals are `authorized` at proposal time with the proposer's own role approval reference; no four-eyes rule is ratified | "Authorize" by an owner/admin is the proposal itself; policy undecided |
| G4 | Frontera configuration dependency for dispatch | Dispatch asks Frontera first and fails closed; without its authority-store configuration every Task creation is denied | The Task creation control must show an honest enforcement-unavailable state |
| G5 | Outcome observation settlement / overwrite policy | A later observation with a new key changes the Outcome state; there is no settled terminal state | Outcome review has no defined end state |
| G6 | Missing decision/observation audit events | Decisions and observations write their canonical rows but emit no platform/audit event | No event stream to present in the thread beyond the canonical rows |
| G7 | Same-actor continuation restrictions | The decider must propose the Action, the proposer must dispatch, and the dispatcher must transition execution | Another user cannot continue a chain; controls must disable with a reason |
| G8 | Canonical recommendation binding into chat | Project Brain `RECOMMENDATION` statements are chat metadata, not governed Recommendations; no verified canonical reference is attached to replies | No governed card can yet be anchored to a reply (§5) |
| G9 | Audit/lineage product presentation | `GET /api/operational-flow?view=lineage\|audit\|audit_export` exists but has no product UI; `/audit` does not show the operational trail | The audit/provenance disclosure has no UI to reuse |
| G10 | Task → Execution → Outcome SIT not yet revalidated | The spine is proven in production SIT through the governed Material Action; Task, Execution and Outcome are not revalidated in this SIT | Controls for those stages would sit on an unproven segment |

## 14. Slice sequence

CHAT-GOV-00 (this document and ADR-PMF-077) ratifies the architecture. Later slices, each separately
reviewed: SIT revalidation of Task → Execution → Outcome (G10); a shared governed-command client
consolidating the duplicated inspector command logic; decision idempotency and audit events (G1, G6);
verified canonical references in replies (G8); recommendation and decision cards; the deterministic
intent layer; action authorization cards; task and execution cards; outcome review cards (G5); the
governed activity timeline and audit disclosure (G9); an approval operation (G2, G3 — requires its
own ADR). The order may change; the boundaries in §2–§12 may not without a new ADR.

## 15. Decision register

| # | Decision | Status |
| --- | --- | --- |
| C1 | Chat-first = conversation + human command controls + existing canonical command endpoints; never model-controlled execution | Decided (ADR-PMF-077) |
| C2 | `/brain/turns` remains read-only permanently; Project Brain has no tools, identity or grants | Decided (restates PB-CHAT-01, PB-EXEC-00 §4) |
| C3 | Controls are human-operated and call existing endpoints; no chat-specific write endpoint | Decided |
| C4 | Canonical references beside replies are server-verified; the model cannot manufacture ids | Decided |
| C5 | One control = one command = one authority level; composite operations prohibited | Decided (restates ADR-PMF-030, ADR-PMF-071 rule 7) |
| C6 | Live cards: keyed by verified id, current state, one actionable instance, stale instances collapse | Decided |
| C7 | Natural language never confirms a write; deterministic intent may only focus, open or choose | Decided |
| C8 | Confirmation tiers T0–T3 with the T3 floor in §9 | Decided |
| C9 | G1–G10 recorded, not resolved | Recorded |
