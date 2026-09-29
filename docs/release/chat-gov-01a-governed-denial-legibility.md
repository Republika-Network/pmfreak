# CHAT-GOV-01a — Governed denial legibility and safe Frontera readiness

**Status:** implemented, awaiting review. **Scope:** response shaping, client error parsing,
failure placement in the PM Execution Center, and a non-mutating Frontera readiness report.

## Why

CHAT-GOV-01 found that clicking **Create canonical internal task** in production "appeared to
do nothing". The canonical contracts were behaving correctly — dispatch fails closed — but the
refusal was illegible:

* `dispatch_material_action_to_task` and `/api/execution-tasks/internal-execution` answered a
  governed refusal with `409 { disposition, failureClass, reason }` and **no `error` key**;
* the client therefore fell back to *"Operational flow action failed."*;
* the alert rendered at the bottom of the branch, below five stage rows, with no focus move.

Relation to CHAT-GOV-00 gap **G4** (`docs/project-brain-governed-commands.md`): this slice
delivers G4's stated consequence — *"the Task creation control must show an honest
enforcement-unavailable state"* — and does not close G4 itself, whose cause (the authority
substrate) remains open.

## What this slice changes

| Layer | Change |
|---|---|
| `src/lib/operational-flow/governed-denial-contract.ts` | New. Pure translation: failure class → `{ code, error, recovery }`. Unknown classes resolve to `governed_operation_refused` — still a refusal, never a leak. |
| `dispatchGovernedMaterialActionToTask` | Mints a server `referenceId` for every refusal and writes it into the log line (Frontera refusals keep their existing warn line, now with the reference; canonical-contract refusals gain one). The Frontera call, the RPC name and its arguments are unchanged. |
| `POST /api/operational-flow` (`dispatch_material_action_to_task`) | Refusal body = the contract's own fields + `error`, `code`, `recovery`, `referenceId`. Statuses unchanged (201 / 200 / 409). |
| `POST /api/execution-tasks/internal-execution` | Same shape for `denied` / `conflict` (409) and a `referenceId` on the 500 persistence failure, logged through the redacting logger. |
| `operational-data.ts` | One shared parser (`requestGovernedJson` / `describeOperationFailure`) for both routes: understands `error`, `code`, `recovery`, `referenceId`; handles non-JSON bodies and network failure without claiming either outcome. |
| `execution-chain-panel.tsx` | The failure renders **inside the stage whose control failed**, directly under that control, as `role="alert"` with `tabIndex=-1`, and receives focus. No automatic retry. |
| `GET /api/ready` | Adds an informational `frontera: { configured, available, status }`. It does **not** gate `status` — see below. |

## Safe error contract

```json
{ "disposition": "denied", "failureClass": "frontera_unavailable", "reason": "frontera_enforcement_denied",
  "error": "The governance enforcement service is not available for this action.",
  "code": "frontera_unavailable",
  "recovery": "Try again after the workspace governance service is available. Nothing was created.",
  "referenceId": "<uuid>" }
```

Only a fixed allowlist of the contract's own fields is carried (`failureClass`, `reason`,
`governanceState`, `executionState`, `actionId`, `proposalDigest`). Frontera reason codes,
Frontera decision ids on a refusal, and the adapter's `diagnostic` stay in the server log.

`recovery` in this contract is a human sentence. The older P2-15 intake conflict contract uses
machine tokens (`reload_recorded_state`); the client renders a recovery only when it is a
sentence, so tokens are never shown as prose.

## Frontera readiness

`/api/ready` now reports:

```json
"frontera": { "configured": true, "available": false, "status": "unavailable" }
```

* `not_configured` — `AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH` is unset or blank.
* `unavailable` — configured, but no readable SQLite database is at that location.
* `ready` — a readable file carrying the SQLite 3 header exists there.

**Non-mutating by construction.** The packaged `createSqliteKernelAuthorityStore` creates the
directory and file, switches to WAL, runs its schema and inserts a version row, so the probe
never calls it. It opens the path with flag `"r"` and reads 16 bytes.

**Limitation.** `ready` does not prove the native driver loads on the host, that Frontera's
schema is present, or that any principal is provisioned. Only a real dispatch evaluation proves
those. `unavailable` and `not_configured` are conclusive.

**Advisory, not gating.** Frontera is a dependency of governed *dispatch*, not of serving the
product, so it is reported beside `checks` rather than inside them: a missing authority store
must not withdraw an instance that still serves every other surface. Dispatch itself remains
fail-closed in `authorizeFronteraDispatch` whatever readiness reports. This is consistent with
`RR-READINESS-NOT-A-GOVERNED-GATE`.

The report names no environment value, path, filename, subject mapping, provisioning fact or
policy content.

## Deployment limitation — unchanged by this slice

> **CHAT-GOV-01a only makes Frontera readiness and governed denials visible. It does NOT make
> the SQLite authority store serverless-safe. Production dispatch is not certified until a
> durable Frontera authority substrate is selected and provisioned (FRONTERA-PROD-00).**

The Frontera authority store is a local SQLite file (P0-LAUNCH-03 §5). That model is sound for
a long-lived Node.js server; it is not assumed portable to ephemeral or serverless hosting,
where the filesystem is per-instance, often read-only outside a scratch directory, and not
shared with the operator process that provisions authority. On such a host dispatch fails
closed with `frontera_unavailable` (or `frontera_actor_unbound` against an empty store), and the
PM now sees that stated plainly with a failure reference. Tracked as
`RR-FRONTERA-SERVERLESS-SUBSTRATE` in `residual-risk-register.md`.

## Not changed

Governance decisions, canonical dispatch eligibility, the P2-07/P2-08 RPCs, the Frontera
adapter's fail-closed behaviour, migrations, and chat cards. No fallback dispatch path exists.
