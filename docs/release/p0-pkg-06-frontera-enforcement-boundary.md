# P0-PKG-06 — PMFreak → Frontera enforcement boundary

**Status: READY_FOR_REVIEW — the boundary is built on the reviewed Frontera
1.2.0 successor, is fail-closed, and the Founder journey has been run and passed
on a real local stack. Not merged; that decision is a human's.**

```
PROTOCOL_PACKAGE_INTEGRATION          = PASS
FRONTERA_PACKAGE_INTEGRATION          = PASS      (@aoc-enterprise/runtime 1.2.0)
FRONTERA_PRODUCT_RUNTIME_CONSUMPTION  = PASS
PMFREAK_GOVERNANCE_OWNERSHIP_BOUNDARY = PASS
PMFREAK_FOUNDER_JOURNEY               = PASS      (17/17, Phase E)
THREE_REPOSITORY_INTEGRATION          = PASS
```

`THREE_REPOSITORY_INTEGRATION` is claimed on the strength of Phase E: a real
Chromium journey, on a real local Supabase stack, against Frontera 1.2.0, whose
dispatch carried a Frontera decision id that only the packaged runtime can mint.
The definition was never downgraded to reach it — it was met.

## How to read this document

This increment ran in four phases and the record keeps all of them, including
the one that had to be withdrawn. Phase A concluded **BLOCKED**; Phase C
**superseded** an artifact PMFreak had already integrated. Neither is edited
out — a record rewritten to look like a straight line would be worth less than
the detours were.

```
Phase A   Frontera 1.0.0 had no durable independent authority          -> BLOCKED
Phase B   Frontera 1.1.0 (PR #112) added durable authority; PMFreak
          integrated it and its non-DB gates went green                -> CONSUMED
Phase C   post-merge review of 1.1.0 found ten defects in the durable
          authority world, invalidating its guarantees                 -> 1.1.0 SUPERSEDED
Phase D   Frontera 1.2.0 (PR #113) corrects them; PMFreak adopts the
          reviewed successor                                           -> PASS
Phase E   local DB + real Chromium Founder acceptance, 17/17, against
          1.2.0 on the user's own machine                              -> PASS
```

**PMFreak's 1.1.0 downstream acceptance was ABORTED before any Founder claim was
made.** 1.1.0 was genuinely vendored, genuinely consumed by the product path and
genuinely passed every non-DB gate; what it never reached was the Founder
browser journey, and `THREE_REPOSITORY_INTEGRATION` was never claimed on it. It
is recorded as integrated-then-withdrawn, not as never-integrated.

Sections 1–7 are **Phase A, unchanged**. The Phase B sections that follow
describe the 1.1.0 work as it stood. Phase C, Phase D and Phase E come last.

Phases A–D all ran in a cloud container that could build, install and test but
could not host Supabase or drive a browser, so each of them honestly recorded
`NOT_RUN_ENVIRONMENT` for acceptance. **Phase E is that run**, executed on the
real local Windows/WSL checkout. Those earlier `NOT_RUN` blocks are left as
written and marked superseded where Phase E answers them.

---


## 1. Provenance — frozen artifacts as at Phase A

> **Superseded in Phase C.** The Frontera row below describes 1.0.0, the artifact
> Phase A analysed. The artifact in the tree today is 1.1.0 — see Phase B.

Both artifacts verify byte-for-byte against the values frozen in P0-PKG-04.

| | `@aoc/protocol` | `@aoc-enterprise/runtime` |
|---|---|---|
| version | `0.2.0-rc.0` | `1.0.0` |
| source repo | `Soberania-Protocol/Soberania_Protocol` | `Soberania-Protocol/Soberania-Enterprise` |
| source commit | `dde34517d956156a0c735c18a805763a5e712879` | `11edd06e7d6ea38ae0bc037e91854444b84a50a7` |
| tarball | `vendor/aoc-protocol-0.2.0-rc.0.tgz` | `vendor/aoc-enterprise-runtime-1.0.0.tgz` |
| expected SHA-256 | `dbe8a08f432a0324ad34eb7cb85054b6dcd23c0d9a073914edf23fccd10445e5` | `53d9e6ce4f3ba8fd82bbd90ebe5bc53f8bffb597b0d11bfd22d9a1ba5245a2de` |
| **actual SHA-256** | **identical** | **identical** |
| exports fingerprint | `a67d65b17dcb34c7…` verified | `2b0ee1e3afee7c02…` verified | 
| resolved path | `node_modules/@aoc/protocol/dist/contracts/index.js` | `node_modules/@aoc-enterprise/runtime/dist/src/index.js` |

`npm ci` installed cleanly with no `--force` and no `--legacy-peer-deps`.

---

## 2. The PMFreak execution path, traced

The Founder journey's governed Material Action reaches execution through exactly this
chain. Every hop was read, not inferred from names.

```
Recommendation
  -> src/app/api/operational-flow/route.ts POST  operation="record_decision"
     -> operational-flow-service.ts : recordHumanDecision
        (Decision persisted; creates NO Material Action — P2-14 STEP 10)

  -> route.ts POST  operation="propose_material_action"
     -> operational-flow-service.ts : proposeGovernedMaterialAction
        -> aoc-governance-request-client : createPMFreakMaterialActionProposal
        -> aoc-governance-request-client : evaluatePMFreakMaterialActionGovernance
        -> rpc persist_governed_material_action
        (governance_state='authorized', can_execute=false — authorization is inert)

  -> route.ts POST  operation="dispatch_material_action_to_task"     <-- BOUNDARY
     -> operational-flow-service.ts : dispatchGovernedMaterialActionToTask
        -> canCreateOperationalEvidence(scope.role)        [last in-process gate]
        ===================== FRONTERA_ENFORCEMENT_BOUNDARY_CANDIDATE =====================
        -> rpc dispatch_governed_action_to_internal_task   [security definer, atomic]
             re-checks: membership, actor match, proposal digest, evaluation freshness,
             governance_state IN (authorized, not_required), policy+grant refs present,
             source decision eligible, evidence lineage, project dispatchable
             advisory xact lock + unique expression index -> exactly one Task
  -> Task -> Execution -> Outcome (non-achieved) -> Observation
```

**The candidate boundary is real and it is narrow.** It sits in
`src/lib/operational-flow/operational-flow-service.ts:365`
(`dispatchGovernedMaterialActionToTask`), after PMFreak's role gate and before the
dispatch RPC — the one point where PMFreak has finished its own governance and approval
work but has not yet created the Task.

Two properties of that point matter for everything below:

* **Idempotency lives inside the RPC**, not in TypeScript. The advisory transaction lock
  and the `execution_tasks_governed_action_uidx` unique expression index are what make one
  governed Action yield at most one Task. Anything placed *before* the RPC that has a
  persistent side effect becomes a second, unprotected side-effect boundary.
* **Everything PMFreak holds there is PMFreak-owned.** `scope.workspaceId`,
  `scope.projectId`, `scope.userId`, `scope.role`, `actionId`, `expectedProposalDigest`.
  No canonical Protocol value is in scope. The proposal's `grantReference` is the literal
  string `` `workspace-role-grant:${role}:${userId}` ``.

---

## 3. Selecting the Frontera operation

The frozen artifact exposes **two distinct** authorization surfaces, not one. Both were
read in full and one was executed.

### 3a. The `orchestrateAuthorization` family — rejected

`evaluateEnforcementPipeline`, `enforceEnforcementPipeline` and `orchestrateAuthorization`
are **the same operation**. Proven from the installed artifact, not assumed:

```js
// dist/src/runtime/authorization/index.d.ts
export { evaluateEnforcementPipeline as enforceEnforcementPipeline } from '../enforcement/authorization-pipeline.js';
// dist/src/runtime/enforcement/authorization-pipeline.js
async function evaluateEnforcementPipeline(input, deps) { return orchestrateAuthorization(input, deps); }
```

Its whole decision, from `authorization-evaluator.js`:

```js
const allowed = capabilityAllowed && delegationValid && agentAllowed && policy.allowed;
```

All four operands come from adapters the **caller** supplies
(`CapabilityRegistryAdapter`, `DelegationStoreAdapter`, `AgentAccessEvaluatorAdapter`,
`PolicyDecisionAdapter`), as do `IdentityResolverAdapter` and `AuditSinkAdapter`. If
PMFreak implements all six, Frontera contributes no authority — it is a Frontera-shaped
AND-gate over PMFreak's own answers.

It is also unsatisfiable. `AuthorizationGrantInput` has seven required fields:

| Frontera field | Type | PMFreak source at the boundary | Classification | Lossless | Authority-sensitive | Persistence-sensitive |
|---|---|---|---|---|---|---|
| `requestId` | `string` | `actionId`, or `decision:{id}` correlation | DERIVABLE_LOSSLESS | yes | no | no |
| `actorId` | `string` | `scope.userId` | DIRECT | yes | yes | no |
| `capability` | `@aoc/protocol` `CapabilityToken` | **none** | **NOT_AVAILABLE / UNSAFE_TO_DERIVE** | — | yes | — |
| `consentGrants` | `@aoc/protocol` `ConsentGrant[]` | **none** | **NOT_AVAILABLE** | — | yes | — |
| `access` | `EnterpriseScopedAccessRequest` | `principalId`=userId, `resource`={`targetResourceType`,`targetResourceId`}, `requestedScope`=[`intendedOperation`], `requestedAt`=now | DERIVABLE_WITH_EXPLICIT_ADAPTER | no (`action` unset) | yes | no |
| `tenantId` | `string` | `scope.workspaceId` | DERIVABLE_LOSSLESS | yes | yes | no |
| `orgId` | `string` | **none** | **NOT_AVAILABLE** | — | yes | — |

Three required fields cannot be produced:

**`capability: CapabilityToken`.** The canonical shape requires `tokenId`, `issuer`,
`subject`, `resource: ResourceRef`, `scope: string[]`, `expiresAt`, and
`proof: { proofType: 'jwt'|'mTLS'|'detached-signature'|'custom', issuedAt }`. Searched
exhaustively:

* `@aoc/protocol@0.2.0-rc.0` exports `CapabilityToken` as a **type only**. There is no
  mint, issue, build or validate function for it anywhere in the public surface.
* `@aoc-enterprise/runtime@1.0.0` never issues one either — `createCapabilityClaim`,
  `issueDelegatedCapability` and `issueExecutionGrant` all take `capability: CapabilityToken`
  as *input*.
* PMFreak holds no value of that shape: `grep -rn "tokenId" src/` and
  `grep -rn "proofType" src/` both return **zero** hits.

The nearest PMFreak artifact is `grantReference = "workspace-role-grant:pm:<uuid>"` — a
formatted string derived from a workspace role. Converting it into a `CapabilityToken`
would be exactly the fabrication P0-PKG-06 forbids: minting an authorization artifact out
of a role name and stamping a `proof` on it that no key ever signed.

PMFreak *does* have a genuinely signed capability artifact — `CapabilityClaim` in
`src/lib/governance/authority/capability-claims.ts`, HMAC-SHA256/Ed25519 over a canonical
JSON profile. It does not rescue this, for two independent reasons. It is **not on this
path** (it is issued by `issueExecutionGrant` on the `governance_approval_requests` flow;
the operational-flow module imports only `./authority`, `./types`, `node:crypto` and the
PMFreak material-action contract). And its shape is PMFreak-owned, recorded NO_EQUIVALENCE
by P0-PKG-05: structured `issuer`/`subject` objects against canonical `CanonicalId`
strings, no `tokenId`, optional `resourceType`/`resourceId` against required
`resource.kind`/`resource.id`, and `proof.algorithm ∈ {HMAC-SHA256, Ed25519}` against
`proof.proofType ∈ {jwt, mTLS, detached-signature, custom}` — two vocabularies, and the
claim `version` strings are persisted values that must not change.

**`consentGrants: ConsentGrant[]`.** PMFreak has no consent-grant concept on any governed
path. The only `consent` in the codebase is OAuth connector consent and founder-program
discovery consent — unrelated semantics. An empty array would be *honest*, but it does not
rescue the other two fields.

**`orgId: string`.** PMFreak's tenancy root is the workspace; there is no organization
above it and no `organizations` table. `orgId` is not decorative — the contract threads it
into `hasCapability`, `validateDelegation`, `evaluateAgentAccess`, `evaluatePolicy` and the
audit envelope, as the organizational scope each adapter authorizes *within*. Setting
`orgId = workspaceId` collapses two scopes Frontera keeps distinct. That is semantic loss
on an authority-sensitive field.

**Verdict: rejected.** Unsatisfiable without fabrication, and semantically empty even if
fabricated.

### 3b. The `AocKernel` family — semantically correct, and it works

`@aoc-enterprise/runtime/kernel` exports `createAocKernel`, and
`@aoc-enterprise/runtime/enterprise` exports `createDefaultKernelProviders`. Both are
**declared public export keys**. This is the surface the Phase-4 comparison was for, and it
is a genuinely different thing from 3a — the kernel's own docstring says it "remains the
only component in Soberanía Enterprise that produces a decision."

Its input asks for none of the three impossible fields:

```ts
KernelEvaluationRequest {
  requestId, requestedAt,
  actor:  { id, trustDomainId, principalId?, type? },
  action: { type, resourceScope, capability?: string, riskLevel?, sideEffectType?, ... },
  target?, organization?, context?, correlationId?, idempotencyKey?, expiresAt?
}
```

`action.capability` is an **optional plain string**. `organization` is optional. There are
no consent grants. Tenancy is `trustDomainId`. PMFreak can produce every one of these from
values it already holds at the boundary.

It was executed in-process against the frozen artifact. Reproduce from the repository root:

```js
const ent  = require('@aoc-enterprise/runtime/enterprise');
const kern = require('@aoc-enterprise/runtime/kernel');
const p = ent.createDefaultKernelProviders();
const r = p.recognitionRuntime;
const issuer = r.registerActor({ type: 'organization', displayName: 'PMFreak Issuer' });
const td     = r.createTrustDomain({ name: 'pmfreak', issuerActorId: issuer.id,
                 acceptedIssuerIds: [issuer.id],
                 acceptedActorTypes: ['human','organization','ai_agent'] });
const actor  = r.registerActor({ type: 'human', displayName: 'Founder',
                 issuerId: issuer.id, trustDomainId: td.id });
const pass   = r.issuePassport({ type: 'identity', subjectActorId: actor.id,
                 issuerActorId: issuer.id, trustDomainId: td.id });
const tok    = r.issueCapabilityToken({ subjectActorId: actor.id, principalActorId: actor.id,
                 issuerActorId: issuer.id, trustDomainId: td.id, capability: 'dispatch',
                 actions: ['external_write'], resourceScopes: ['project:p1'] });
const k = kern.createAocKernel({ recognitionProvider: p.recognitionProvider,
                                 clock: p.clock, idGenerator: p.idGenerator });
await k.evaluate({ requestId: 'a', actor: { id: actor.id, trustDomainId: td.id },
                   action: { type: 'external_write', resourceScope: 'project:p1',
                             capability: 'dispatch' },
                   requestedAt: new Date().toISOString(),
                   context: { passportId: pass.id, capabilityTokenId: tok.id } });
```

Observed, verbatim:

| Probe | `status` | `reasonCodes` |
|---|---|---|
| unseeded world | `denied` | `RECOGNITION_ACTOR_UNKNOWN`, `POLICY_ACTION_PROHIBITED` |
| actor + token, **no passport** | `denied` | `RECOGNITION_PASSPORT_INVALID`, `POLICY_ACTION_PROHIBITED` |
| fully seeded, matching scope | **`allowed`** | `ACTION_ALLOWED` |
| fully seeded, `resourceScope: project:OTHER` | `denied` | `AUTHORITY_SCOPE_EXCEEDED` — *"Resource project:OTHER is outside the capability token's resource scopes."* |
| fully seeded, `type: authority_mutation` | `denied` | `AUTHORITY_SCOPE_EXCEEDED` — *"Action authority_mutation is not granted by this capability token."* |
| **second `createDefaultKernelProviders()`, same ids** | `denied` | `RECOGNITION_ACTOR_UNKNOWN` |

This is a real, fail-closed enforcement engine. It discriminates scope and action
correctly, denies by default, and never throws for a governance outcome.

---

## 4. Why Phase A was BLOCKED

Read the last row of that table again.

`createDefaultKernelProviders()` builds, in its own words, "a real, **empty** (no
actors/trust domains/tokens registered) world" that is **in-memory and per-process**. A
second instance in the same process does not recognize an actor the first one registered.
Frontera is explicit about whose job seeding is:

> "Seeding real governance data is a deployment/operations concern, not something this
> Enterprise Host may fabricate on an operator's behalf."

That leaves exactly two ways to wire the kernel into
`dispatchGovernedMaterialActionToTask`, and both are blocked.

**Option 1 — seed the world per request, in-process.** PMFreak registers the issuer,
creates the trust domain, registers the actor, issues the passport and issues the
capability token from its own workspace role, then asks the kernel whether that actor holds
that capability. **The answer is determined by what PMFreak wrote microseconds earlier.**
PMFreak would be issuer, subject, registry and questioner at once. It cannot deny anything
PMFreak has not already decided to deny, so it enforces nothing — while writing
`FRONTERA_ALLOW` reason codes into the audit trail that a reader would take to mean an
independent sovereign authorization occurred. That is worse than no integration: it is a
false provenance claim, and it is precisely the architecture blocker P0-PKG-06 names —
*integration would exist only to satisfy a dependency claim*.

It fails a second, independent test too. Actor registration, passport issuance and token
issuance each emit audit events into the recognition runtime's trail. Placing them before
the dispatch RPC creates a **second side-effect boundary ahead of the idempotency
decision**, which the advisory lock and unique index do not cover.

**Option 2 — seed the world from durable state.** This is the architecture Frontera
intends, and it would be a real boundary: an operator-controlled enterprise registry that
PMFreak does not write, so the kernel can genuinely deny an actor PMFreak believes is fine.
It requires PMFreak to persist enterprise actors, trust domains, passports and capability
tokens, and to reconstitute the world on process start. PMFreak has **none** of those
tables. Creating them means new tables, new RLS policies and a migration.

P0-PKG-06 is not authorized to add persistence. Per its own stop conditions, that is where
this increment ends:

```
DATABASE_SCHEMA_CHANGED = NO
MIGRATION_ADDED         = NO
RLS_CHANGED             = NO
```

### The smallest unresolved decision

> **Does PMFreak acquire a durable, operator-seeded enterprise recognition registry —
> actors, trust domains, passports and capability tokens, persisted and reconstituted per
> process — as its own increment; or does the definition of
> `THREE_REPOSITORY_INTEGRATION` change to stop requiring in-process Frontera enforcement
> on the Material Action path?**

Everything else follows from that answer. It is a founder/architecture decision, not a
packaging one, which is why it is handed forward rather than guessed at.

---

## 5. Upstream gap specification

Recorded for a future Frontera increment. **Neither upstream repository was modified.**

```
required capability/surface =
  Either (a) a public, documented conversion from a host's own signed authorization
  artifact into @aoc/protocol's CapabilityToken, or (b) a documented persistence/
  hydration contract for the AocKernel recognition world (actors, trust domains,
  passports, capability tokens) so a host can reconstitute an operator-seeded world
  from its own durable storage.

current nearest public surface =
  (a) @aoc/protocol/contracts exports CapabilityToken as a TYPE with no issuer.
      @aoc-enterprise/runtime consumes it as input in every operation that mentions it.
  (b) @aoc-enterprise/runtime/enterprise exports createDefaultKernelProviders(), which
      builds an in-memory, per-process, deliberately empty world, plus
      createInMemoryGovernanceStore / createSqliteGovernanceStore — which persist
      DECISION TRACES, not the recognition world itself.

missing semantic =
  (a) provenance: who may issue a CapabilityToken, under what trust anchor, with what
      proof, such that a consumer's issuance is canonical rather than self-asserted.
  (b) continuity: how an operator-seeded recognition world survives a process boundary.

why existing export is insufficient =
  (a) a consumer can only construct a CapabilityToken object literal. Nothing in either
      artifact distinguishes an issued token from a fabricated one, so a host that mints
      its own is asserting authority the Protocol never granted it.
  (b) without hydration, every ALLOW the kernel returns traces back to a registration the
      calling process performed itself, which is not an independent authorization.

minimum upstream change required =
  (a) a Protocol-owned issuing/verifying surface for CapabilityToken (issuer identity,
      proof binding, verification), OR an explicit statement that hosts are the issuers
      and what that obliges them to.
  (b) a Frontera-owned export that serializes and rehydrates the recognition world, or a
      RecognitionProvider port a host can back with its own store.

why PMFreak cannot safely adapt around it =
  every available adaptation requires PMFreak to assert, in canonical vocabulary, an
  authorization fact it has no standing to assert — a token it did not receive, a consent
  grant that does not exist, an organization scope it does not model, or a recognition
  world it seeded for itself moments before asking about it.
```

### Separately: Frontera license metadata (unchanged, out of scope)

`@aoc-enterprise/runtime@1.0.0` still declares no `license` field, nor do its four bundled
private workspaces. Confirmed again here (`require('@aoc-enterprise/runtime/package.json').license === undefined`).
Recorded as upstream packaging debt, exactly as P0-PKG-05 left it. Not this increment's
problem and not fixable from PMFreak.

---

## 6. Verification (Phase A)

Everything below ran from the committed state, on Node v22.22.2 / npm 10.9.7.

| Gate | Result |
|---|---|
| `npm ci` | PASS — no `--force`, no `--legacy-peer-deps` |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors, 620 warnings (baseline) |
| `npm test` | PASS — **13,308 tests, 0 fail, 17 skipped** (13,300 + 8; identical to the P0-PKG-05 baseline) |
| `npm run build` | PASS |
| `npm run check:governance` (full chain) | PASS |
| `check:aoc-boundaries` / `check:governance-boundary` | PASS |
| `check:governance-ownership` | PASS — 44/44 decisions resolved |
| `check:governance-collisions` | PASS |
| `check:packaged-aoc-artifacts` | PASS — both SHA-256 and both exports fingerprints verified; `src/aoc/protocol` and `src/aoc/enterprise` both report `absent (removed)` |
| `check:package-purity` | PASS — no PMFreak source inside either frozen artifact |
| `check:release-readiness` | PASS |
| **Frontera product-consumer gate** | **NOT ADDED** — see below |

**No product-consumer gate was added.** The gate P0-PKG-06 specifies must prove
`FRONTERA_PRODUCT_CONSUMERS >= 1`. There are zero, and adding a gate that asserts zero, or
importing Frontera into a module to make it one, are both dishonest. The gate belongs in
whichever increment produces a real consumer.

### 6a. Database and browser acceptance — not executable here

Unchanged from P0-PKG-05 and re-confirmed: this container cannot run Supabase. Every
container image blob returns `403 Forbidden` through the agent proxy
(`pkg-containers.githubusercontent.com`, `production.cloudfront.docker.com`). The proxy
documentation classifies this as report-don't-work-around, and no bypass was attempted.
Chromium and Playwright are present; the missing piece is the database and auth stack.

```
P2-13 seed / check:p2-13-db / check:p2-14-db      NOT_RUN  (environment)
check:operational-flow-db / check:fresh-db-migrations  NOT_RUN  (environment)
Founder browser journey (17 checkpoints)          NOT_RUN  (environment)
```

This is **not** what blocks P0-PKG-06, and the two must not be conflated. Even on a fully
capable stack, the Founder journey would traverse no Frontera boundary, because none
exists to traverse. The architectural question is upstream of the acceptance question.

---

## 7. Invariants — all preserved

Nothing in this increment touches behaviour, so every invariant holds by construction; the
gate battery above confirms it.

```
Recommendation        != Decision                    preserved
Decision              != Material Action             preserved
Action                != Task                        preserved
Task completion       != Outcome achievement         preserved
DEMO_FIXTURE          != LIVE                        preserved
correlation           != causation                   preserved
PMFreak governance    != Frontera authorization      preserved and reinforced
evaluateGovernancePipeline != evaluateEnforcementPipeline   distinction preserved
```

Authority composition was **not** implemented, because no Frontera call exists to compose
with. The rule it would have had to satisfy is recorded in
[ADR-PMF-076](../adr/ADR-PMF-076-pmfreak-frontera-enforcement-boundary.md) for whichever
increment builds it:

```
PMFREAK_DENY  + FRONTERA_ALLOW = DENY
PMFREAK_ALLOW + FRONTERA_DENY  = DENY
PMFREAK_ALLOW + FRONTERA_ALLOW = eligible to proceed
FRONTERA_ERROR / malformed     = DENY, no dispatch
```

## 8. Upstream impact

```
Protocol modified          = NO
Frontera modified          = NO
Protocol exports widened   = NO
Frontera exports widened   = NO
deep/private upstream imports = NO
packages published         = NO
tags created               = NO
GitHub Releases created    = NO
P2-15 started              = NO
```

---

# Phase B (i) — the upstream gap was closed in Frontera 1.1.0

> **Superseded by Phase C.** The artifact identities in this section describe
> 1.1.0, which is no longer the PMFreak dependency. The reasoning about *why*
> the gap needed closing still stands and is why 1.2.0 exists.

Phase A's gap specification became **P0-PKG-07** in
`Soberania-Protocol/Soberania-Enterprise`, merged as **PR #112**. Verified live
before anything in PMFreak was touched, from a full clone rather than from the
brief:

```
Soberania-Enterprise main HEAD = 8e7ded3b70855a47eb01bf2a9bc466f098b02438
merge commit message           = "Merge pull request #112 … P0-PKG-07: productionize
                                  durable Frontera authority/recognition for external enforcement"
source commit 74308ad1…        = ancestor of the merge commit (git merge-base --is-ancestor)
package.json at 74308ad1       = @aoc-enterprise/runtime 1.1.0
```

P0-PKG-07 added a whole `src/enterprise/kernel-authority/` module — an
append-only store with digest-chained events, a SQLite implementation, world
hydration, a durable provider set, an operator provisioning service and a
recognition bridge. Exactly the two things Phase A specified as missing:

| Phase A gap | P0-PKG-07 answer |
|---|---|
| (b) continuity — an operator-seeded recognition world that survives a process boundary | `createSqliteKernelAuthorityStore` + `createDurableKernelProviders` + `DurableKernelProviderSet.reload()` |
| (a) provenance — who may issue a credential, such that issuance is not self-asserted | Credentials are provisioned by an **operator** context (`system: true`) and resolved by Frontera; `findActorByExternalSubject` binds an external principal read-only |

Gap (a) was answered in a better way than Phase A proposed. Phase A asked for a
conversion into Protocol's `CapabilityToken`. Frontera instead removed the need
for one: `AocKernel`'s request carries no token at all, and the credentials are
Frontera's own durable records. PMFreak therefore never holds, mints or maps a
canonical capability token — the fabrication risk is not mitigated, it is absent.

## Artifact reproduction — bit-for-bit

The tarball was **not** taken on trust and **not** taken from a registry. It was
rebuilt from the frozen source commit in a detached worktree and hashed before
being vendored:

```
git worktree add <tmp> 74308ad1ee21108b9c1964ddf8f7530ba8c5308f
npm ci && npm run build && npm pack .        # node v22.22.2, npm 10.9.7

reproduced SHA-256 = ab4072b7c34971265ba637e63c7fd21bd8a95a5ef342056d59632f8ff6200e60
expected   SHA-256 = ab4072b7c34971265ba637e63c7fd21bd8a95a5ef342056d59632f8ff6200e60   IDENTICAL
sizeBytes  3375780     fileCount 6362 (npm pack's own "total files")
```

`fileCount` uses the same method that reproduces the recorded 6298 for 1.0.0
exactly, so the two rows are comparable rather than coincidentally similar.

**The exports fingerprint is unchanged at `2b0ee1e3afee…`, and that is correct
rather than suspicious.** The fingerprint digests the export *map*; P0-PKG-07
added its surface to the existing `./enterprise` and `./kernel` subpaths without
introducing a new one. It was recomputed from the installed 1.1.0 manifest, not
copied from the 1.0.0 record.

```
@aoc/protocol             0.2.0-rc.0  UNCHANGED  dbe8a08f432a…  a67d65b17dcb…
@aoc-enterprise/runtime   1.1.0       NEW        ab4072b7c349…  2b0ee1e3afee…
```

Protocol was not modified, not re-versioned and not re-packed. Neither upstream
repository was written to.

---

# Phase B (ii) — PMFreak consumed Frontera 1.1.0

> **Withdrawn by Phase C.** Everything below was really built and really passed
> its gates against 1.1.0. Phase D re-established it against 1.2.0; the parts
> that changed are called out there, and the parts that did not are the design
> holding up unchanged across a corrected upstream API.

## The boundary, as built

```
POST /api/operational-flow  { operation: "dispatch_material_action_to_task" }
  route.ts
    -> authorize(projectId, workspaceId, "write")          PMFreak tenancy + role
    -> operational-flow-service.ts : dispatchGovernedMaterialActionToTask
         -> canCreateOperationalEvidence(scope.role)       PMFreak role gate
         ═══════════ FRONTERA ENFORCEMENT BOUNDARY ═══════════
         -> src/lib/integrations/frontera : authorizeFronteraDispatch
              -> createSqliteKernelAuthorityStore(path)              [public export]
              -> store.findActorByExternalSubject({system:false,…})  [read-only]
              -> createDurableKernelProviders({store, organizationId})
              -> createAocKernel(...).evaluate(...)                  [public export]
         -> if (!frontera.allowed) return denied            NO RPC, NO Task
         ═════════════════════════════════════════════════════
         -> rpc dispatch_governed_action_to_internal_task    transaction + idempotency
              advisory xact lock + execution_tasks_governed_action_uidx
  -> exactly one Task
```

`src/lib/integrations/frontera/` is visibly PMFreak-owned. Nothing was placed
under `src/aoc/*`, no canonical namespace was reused, and the barrel deliberately
re-exports only the read/evaluate surface so no product module can obtain
Frontera's provisioning service by importing it.

## Why Frontera is asked on every attempt

The brief prefers skipping the Frontera call for an action PMFreak would itself
refuse. That was implemented and then **deliberately reverted**, because a
pre-check has two defects and asking every time has neither:

* It restates PMFreak governance semantics outside the RPC that owns them — the
  precise duplication ADR-PMF-075 exists to prevent.
* It opens a hole. An action that looked ineligible at read time but passed the
  RPC's own re-check a moment later would dispatch **having never been
  authorized by Frontera at all**. A read cannot be made race-free against a
  transaction it does not participate in.

The cost of the alternative is one read-only evaluation on a rare, high-value
operation. The brief's requirement is stated as "at minimum, the final outcome
must remain DENY and the dispatch RPC must not create a Task", which this
satisfies exactly.

## Mapping matrix — the real `KernelEvaluationRequest`

The obsolete `AuthorizationGrantInput` matrix from Phase A does not apply; that
operation was rejected. This is the contract actually used.

| Frontera field | PMFreak source | Semantics | Classification | Lossless | Authority-sensitive | Persisted source |
|---|---|---|---|---|---|---|
| `requestId` | `input.actionId` | the governed Material Action's identity | DIRECT | YES | no | YES (`material_action_proposals.id`) |
| `actor.id` | `findActorByExternalSubject(...)` → `record.entityId` | **Frontera's** actor id, resolved not assumed | DERIVABLE_WITH_EXPLICIT_ADAPTER | YES | YES | YES (Frontera store) |
| `actor.trustDomainId` | resolved actor record's `trustDomainId` | Frontera's own enforcement boundary | DIRECT (from Frontera) | YES | YES | YES (Frontera store) |
| `action.type` | constant `execute.material-action` | Frontera's documented action for external material-action execution | DIRECT | YES | YES | n/a |
| `action.resourceScope` | `project:${scope.projectId}` | the governed action's project | DERIVABLE_LOSSLESS | YES | YES | YES (`projects.id`) |
| `organization.id` | `scope.workspaceId` | PMFreak's tenancy root | DERIVABLE_LOSSLESS (identity) | YES | YES | YES (`workspaces.id`) |
| `requestedAt` | server clock | evaluation time | DIRECT | YES | no | no |

Nothing is fabricated, and no field is optional-in-Frontera-but-invented-here.
Note what is **absent** compared with Phase A: no `capability`, no
`consentGrants`, no `orgId`-with-no-referent. Those three unsatisfiable fields
were the Phase A blocker and this contract does not ask for them.

### Why each mapping is legitimate

**Organization = workspace.** The workspace is PMFreak's tenancy root:
`workspace_memberships` carries every authority grant, every project belongs to
exactly one workspace, and RLS isolates on it. There is no PMFreak entity above
a workspace, so nothing else is a candidate. It is used as an **identity**, not
a formatted string — a prefix would need parsing back out somewhere, and two
spellings of one tenant boundary is how cross-tenant leaks begin.

**Actor = the authenticated principal, resolved through Frontera.**
`scope.userId` is *not* assumed to be a Frontera actor id. It is presented as
`KernelAuthorityExternalSubject { system: "pmfreak", subjectId: <auth uid> }`
and Frontera returns the actor bound to it, or `null`. `(organizationId, system,
subjectId)` is unique upstream, so the same subject id in two workspaces
resolves to two different actors and never leaks authority between them — proven
by test, not assumed. That the dispatching principal is the right subject is not
guesswork either: the RPC itself refuses when `v_action.proposed_by <> auth.uid()`,
so the dispatcher is necessarily the proposer.

**Action = `execute.material-action`.** Frontera's own documented action for an
external application executing a governed material action
(`AOC_DURABLE_KERNEL_AUTHORITY.md`, "How applications evaluate"). Used because
upstream defines it for this case — not because a PMFreak route or task type was
reshaped to resemble it.

**Resource scope = `project:<projectId>`.** Frontera's grammar is hierarchical
and colon-delimited (`resource === scope || resource.startsWith(scope + ':')`,
`capability-token-service.ts`), and its own tests use the `project:1` form. A
grant on one project therefore cannot reach another — verified by a negative
test, not by reading the code.

**Trust domain comes from Frontera.** Read off the resolved actor record. PMFreak
never invents one and never creates one during dispatch.

## Capability provenance — the Phase A blocker, closed

```
authority store            Frontera-owned SQLite (append-only, digest-chained events)
authority owner            Frontera
actor / passport /
capability / grant         provisioned by an OPERATOR context (system: true)
PMFreak product can
provision                  NO — structurally, see below
fabricated token           NO — PMFreak never holds or constructs a credential
unsafe cast                NO
```

"Structurally" is meant literally. Frontera's `requireKernelAuthorityOperator`
rejects any context without `system: true`, and the product adapter builds
`{ system: false, organizationId }` and nothing else. No organization-scoped
context can reach a write path, so this is a property of the upstream store
rather than a PMFreak convention that could drift. The adapter additionally
never imports `createKernelAuthorityProvisioningService`, and
`check:frontera-consumer` fails if it ever does.

## Authority freshness — no stale ALLOW

Frontera v1's propagation model is single-writer: a world hydrated in one process
does not observe another process's writes until `reload()` or restart. A
long-lived cached provider set would therefore keep answering ALLOW for an actor
an operator had already revoked.

PMFreak opens the store and hydrates the world **per evaluation**, so an
out-of-band revocation is observed on the very next dispatch. This is the point
of the SQLite test below, which crosses a real close/reopen boundary rather than
reusing a handle.

```
single-writer propagation handled by   fresh store + fresh hydration per evaluation
external revocation observed           YES
stale ALLOW after revocation possible  NO
```

Per-workspace isolation follows from the same choice: the provider set is built
for one `organizationId` at evaluation time, so there is no cross-tenant provider
cache to key incorrectly.

## Fail-closed behaviour

Every one of these returns without reaching the dispatch RPC. `authorizeFronteraDispatch`
never throws; every failure resolves to a denial, because the only safe reading of
an exception at this boundary is "do not dispatch".

| Condition | Result | Dispatch RPC calls |
|---|---|---|
| Frontera DENY (wrong project) | `frontera_denied` | **0** |
| Frontera DENY (wrong action) | `frontera_denied` | **0** |
| unknown / unbound external subject | `frontera_actor_unbound` | **0** |
| revoked actor | `frontera_actor_unbound` | **0** |
| revoked capability / authority grant | `frontera_denied` | **0** |
| cross-organization request | `frontera_actor_unbound` | **0** |
| store unavailable / corrupt / config missing | `frontera_unavailable` | **0** |
| provider hydration or reload failure | `frontera_unavailable` | **0** |
| kernel error | `frontera_unavailable` | **0** |
| malformed kernel result | `frontera_malformed_result` | **0** |
| `approval_required` / `indeterminate` | `frontera_denied` | **0** |

There is no `catch { allowAnyway() }`, no "Frontera unavailable → bypass", no
"missing config → allow", and no development bypass. A missing store path is a
denial, not a skip. `check:frontera-consumer` fails the build if a catch block
ever reaches the RPC.

`approval_required` and `indeterminate` are treated as non-allow rather than
rounded up: only an explicit `allowed` proceeds.

## Authority composition

```
PMFREAK_DENY  + FRONTERA_ALLOW = DENY    the RPC still re-checks every PMFreak precondition
PMFREAK_ALLOW + FRONTERA_DENY  = DENY    the RPC is never reached
PMFREAK_ALLOW + FRONTERA_ALLOW = dispatch
FRONTERA_ERROR / malformed     = DENY, no dispatch
```

Frontera can only narrow. A Frontera ALLOW skips, relaxes and pre-satisfies
nothing: the RPC re-runs membership, actor match, proposal digest, evaluation
freshness, `governance_state`, policy/grant references, source-decision
eligibility, evidence lineage and project dispatchability inside its own
transaction afterwards. `PMFreak DENY can be overridden by Frontera = NO`.

## Idempotency

The RPC remains the sole transaction and idempotency boundary. No task creation
was moved into TypeScript and no part of the RPC's logic was reimplemented.

```
one Material Action -> at most one Task    PRESERVED (advisory lock + unique index)
concurrent authorized dispatch             PRESERVED (unchanged RPC)
Frontera denial creates a Task             NO
Frontera failure creates a Task            NO
```

**One behavioural change, characterised rather than glossed.** Frontera is now
consulted before every dispatch attempt, including a retry of an action that
already produced a Task. If an operator revokes authority *after* a successful
dispatch, a subsequent retry returns a Frontera denial instead of replaying the
existing Task. No Task is created, destroyed or duplicated — the exactly-one
invariant is untouched — but the retry's *response* differs from before. This is
the intended reading of fail-closed: an actor whose authority has been withdrawn
should not be able to replay a dispatch. It is recorded here because it is a real
contract change, not because it was discovered late.

## Product consumption proof

```
FRONTERA_PRODUCT_CONSUMERS = 3   (was 0)
```

| file | specifier | export key | purpose |
|---|---|---|---|
| `src/lib/integrations/frontera/enforcement-adapter.ts` | `@aoc-enterprise/runtime/enterprise` | declared | `createSqliteKernelAuthorityStore`, `createDurableKernelProviders`, `KernelAuthorityStore` |
| `src/lib/integrations/frontera/enforcement-adapter.ts` | `@aoc-enterprise/runtime/kernel` | declared | `createAocKernel` |

Reachable product call path:
`/api/operational-flow` → `dispatchGovernedMaterialActionToTask` →
`authorizeFronteraDispatch` → `AocKernel.evaluate()`.

`npm run check:frontera-consumer` proves this structurally rather than by
counting strings. It fails if the Frontera call is removed, moved after the RPC,
stripped of its early return, replaced with the empty in-process world, given a
deep or private import, or if any product file touches the provisioning surface.
**Each of those failure modes has its own negative-control test** in
`tests/frontera-product-consumer-gate.test.ts` — a gate only ever observed to
pass is not evidence.

## Test evidence

`tests/frontera-enforcement-boundary.test.ts` — 10 tests, all against the **real
packaged 1.1.0 runtime**. No test stubs `allowed: true`; the only mock is the
Supabase client, and only so dispatch RPC calls can be counted.

```
ALLOW  -> dispatch RPC called exactly once, Frontera decision id correlated
DENY   (wrong project)            -> 0 RPC calls
DENY   (unknown external subject) -> 0 RPC calls, and the principal stays unbound
DENY   (cross-organization)       -> 0 RPC calls
ERROR  (store unavailable)        -> 0 RPC calls
MALFORMED result                  -> 0 RPC calls
external subject binding          -> Frontera actor id != PMFreak user id
evaluation                        -> provisions nothing, even when it denies
denial                            -> leaks no Frontera reason codes to the caller
SQLite durability                 -> see below
```

The last one is the proof that Phase A's blocker is genuinely closed rather than
relocated:

```
operator process   provision authority in a SQLite store, then CLOSE it
application        fresh store handle, nothing carried in memory -> ALLOW, 1 RPC call
operator process   revoke capability + authority grant out of band, CLOSE
application        fresh store handle -> DENY, 0 RPC calls
```

Authority survives a process boundary, and a revocation written by a different
process is observed on the next dispatch. That is exactly the pair of properties
Phase A found `createDefaultKernelProviders()` could not provide.

## Founder browser acceptance — instrumentation added, run outstanding

`tests/e2e/p2-14-founder-story.spec.ts` keeps all **17 canonical checkpoints**;
none was rewritten, reduced or replaced. STEP 12 gained one assertion: the
dispatch response must carry `fronteraDecisionId`, the opaque id minted by
`AocKernel.evaluate()`. It cannot exist unless that evaluation returned
`allowed`, and PMFreak never mints one — so the browser journey either crosses
the real boundary or fails. No production bypass and no fake marker was added.

Run order for an environment that can host the stack:

```
npm run seed:p2-13-founder          # PMFreak DB state
npm run provision:founder-frontera  # OPERATOR-side Frontera authority
npm run test:e2e:p2-14              # the 17-checkpoint journey
```

`scripts/provision-founder-frontera-authority.mjs` provisions the **minimum**
authority for the one actor that actually dispatches: Tenant A's owner, one
action, one project scope, no wildcard. Tenant B is given **no** Frontera
authority at all — it dispatches nothing in the journey, and provisioning it
"just in case" would weaken the isolation the two-tenant scenario exists to show.
It resolves the real authenticated principal id from the seeded stack and fails
loudly rather than inventing an identity.

## Database impact

```
DATABASE_SCHEMA_CHANGED=NO   MIGRATION_ADDED=NO   RLS_CHANGED=NO
EXISTING_SERIALIZED_VALUES_CHANGED=NO   AUDIT_HISTORY_REWRITTEN=NO
EXISTING_EVENT_VOCABULARY_CHANGED=NO
```

No `.sql` file, no migration and no RLS policy is in the diff. Frontera's
authority state lives in Frontera's own SQLite store and was not copied into
Supabase. No PMFreak authority-mapping table was created — Frontera owns the
external-subject binding, which is why none is needed.

## Audit / evidence lineage

The two systems' evidence is kept distinct and correlated, never merged:

```
Recommendation -> Decision -> Material Action        PMFreak evidence (unchanged tables)
        |
        +-- Frontera authorization decision           Frontera's own audit trail
        |   correlated by requestId = Material Action id
        v
      Task -> Execution -> Outcome -> Observation     PMFreak evidence (unchanged)
```

The Frontera decision id is returned on the dispatch response for correlation
and is **not** written to any PMFreak table — durable cross-system evidence would
need a schema change, which this increment is not authorized to make. That
limitation is recorded rather than worked around. Frontera's reason codes and any
infrastructure diagnostic are logged server-side and deliberately not returned to
the client: they are what an operator needs and precisely what an arbitrary
caller should not learn about another system's authority structure.

> **Correction — 2026-09-19 exact-head reconciliation at `95c928b2`.** Two statements
> above do not hold, as verified on the running system:
>
> 1. **Not reconstructible from Frontera.** The diagram's "Frontera's own audit
>    trail, correlated by requestId" is not reconstructible after the response.
>    `AocKernel.evaluate()` keeps its enforcement decision in a per-request,
>    in-memory store. The durable SQLite authority store holds only operator
>    provisioning: after two full P2-14 runs that minted real ALLOW decisions,
>    each store contained 7 `KernelAuthorityEntityProvisioned` events and no
>    decision.
> 2. **Not in PMFreak either.** No PMFreak table or column holds the decision id.
> 3. **Only denials are logged.** "Logged server-side" applies to refusals only;
>    an ALLOW decision id is not logged.
> 4. **"Recorded" was not true.** "That limitation is recorded" had no matching
>    entry in `residual-risk-register.md`. This note is where it is recorded.
>
> **What is durable.** The Action → Task edge carries the PMFreak AOC-E governance
> pointer: `governanceEvaluationId`, `policyReference` and grant references in the
> immutable `execution_tasks.source_payload`. That pointer is what the P2-20 export
> contract names. Classification: `RESPONSE_ONLY_BUT_NOT_REQUIRED_BY_P2_CONTRACT`.
> Durable Frontera decision lineage would need an additive migration in PMFreak or a
> durable decision record in Frontera, and requires separate authorization.

## Verification (Phase B (ii), against 1.1.0)

```
PMFREAK_FRONTERA_INTEGRATION_SOURCE_COMMIT = b27e7464da65c8af08bf7b5a7b0052dfb61b9a65
```

Every gate below ran from that commit's tree, Node v22.22.2 / npm 10.9.7. This
document is committed separately and contains no application, runtime, schema or
dependency change, so nothing verified above can have moved beneath it.

| Gate | Result |
|---|---|
| `npm ci` from a deleted `node_modules` | PASS — no `--force`, no `--legacy-peer-deps`; resolves 1.1.0 |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors |
| `npm test` | PASS — **13,328 tests, 0 fail, 17 skipped** (baseline 13,308; +20 new) |
| `npm run build` | PASS |
| `npm run check:governance` (full chain) | PASS |
| `npm run check:aoc-boundaries` | PASS |
| `npm run check:packaged-aoc-artifacts` | PASS — 1.1.0 SHA-256 and exports fingerprint verified |
| `npm run check:governance-ownership` | PASS — 44/44 |
| `npm run check:governance-collisions` | PASS |
| `npm run check:package-purity` | PASS |
| `npm run check:release-readiness` | PASS |
| **`npm run check:frontera-consumer`** | **PASS — FRONTERA_PRODUCT_CONSUMERS=3** |
| `npm run compliance:check` | PASS — regenerated; `blocked: 0` |

Two gates needed updating for the artifact swap and were updated rather than
weakened: `check-package-exports.mjs` pinned 1.0.0 (now 1.1.0, and it now also
requires `./kernel` and `./enterprise` to be present), and the compliance
inventory/SBOM were regenerated with the repo's own generators.

`check:packaged-aoc-artifacts` also caught something worth recording: the
negative-control test file contained *literal* deep-import and private-workspace
specifiers as fixtures, and the gate flagged them — correctly, since it cannot
tell a fixture from a real import. The fixtures now compose those strings at
runtime, so the gate stays strict and the negative control stays real. The gate
was not relaxed.

## Database and browser acceptance — NOT RUN (environment)

```
DB_ACCEPTANCE=NOT_RUN_ENVIRONMENT
FOUNDER_BROWSER_ACCEPTANCE=NOT_RUN_ENVIRONMENT
```

> **Superseded by Phase E.** Both were executed on the local checkout at
> `e1264d12`: DB acceptance PASS and the Founder journey 17/17. See
> "Phase E — Local acceptance executed" at the end of this document. This
> section stays as written because it was true of the environment it describes.

Unchanged from Phase A and re-confirmed: no Supabase stack is reachable here.
`OPERATIONAL_FLOW_TEST_*` is unset, the Supabase CLI is absent, and container
image blobs return `403` through the agent proxy. The proxy documentation
classifies this as report-don't-work-around; no bypass was attempted.

This is an environment limitation and is **not** being used to describe an
architectural gap. The architectural question Phase A raised is closed, by
execution against the real artifact.

## Upstream impact (Phase B (ii))

```
Protocol modified          = NO      Frontera modified        = NO
Protocol exports widened   = NO      Frontera exports widened = NO
deep/private upstream imports = NO
packages published         = NO      tags created = NO      GitHub Releases = NO
P2-15 started              = NO
```

The Soberania-Enterprise clone was read-only: a detached worktree, a build and a
pack. Nothing was committed or pushed to either upstream repository.

## Known upstream debt (unchanged)

`@aoc-enterprise/runtime@1.1.0` still declares no `license`, and neither do its
four bundled private workspaces — re-confirmed after the swap
(`REVIEW_REQUIRED`, `blocked: 0`), exactly as recorded for 1.0.0. Upstream
packaging debt, not fixable from PMFreak, and not this increment's subject.

---

# Phase C — Frontera 1.1.0 was superseded by post-merge review

Frontera's own post-merge review of P0-PKG-07 found **ten defects in the durable
Kernel Authority world**, closed by `Republika-Network/Frontera` **PR #113**.
The one that matters most to PMFreak is worth stating plainly, because it
invalidated a guarantee this document had already claimed:

> **1.1.0's `createDurableKernelProviders()` handed the application mutable
> Recognition/Authority engine handles** — `recognitionRuntime`,
> `authorityRuntime`, `approvalRuntime`, `handshakeRuntime` — alongside the
> read-only `recognitionProvider`. Those engines expose `registerActor`,
> `issuePassport`, `issueCapabilityToken`, `registerRootIssuer` and
> `issueAuthorityGrant`. An application holding them could mint itself an actor
> and a covering token in the live world and be allowed, **without ever holding
> an operator context and without the durable store recording anything**.

Phase B (ii) asserted that self-provisioning was "structurally impossible". That
claim was **true of PMFreak's code and false of the surface it was handed**: the
adapter never touched those handles, but nothing except its own restraint stopped
it. The separation held by convention, which is precisely what this whole
increment exists to replace. The claim is corrected here rather than quietly
restated.

```
FRONTERA 1.1.0                     STATUS = SUPERSEDED
version                            1.1.0
source commit                      74308ad1ee21108b9c1964ddf8f7530ba8c5308f
sha256                             ab4072b7c34971265ba637e63c7fd21bd8a95a5ef342056d59632f8ff6200e60
PMFreak downstream acceptance      ABORTED before the Founder claim
THREE_REPOSITORY_INTEGRATION on 1.1.0   NEVER CLAIMED
```

---

# Phase D — PMFreak adopts the reviewed Frontera 1.2.0

## Live verification, before anything was modified

Verified from a clone of the canonical repository, not from the brief:

```
Republika-Network/frontera main HEAD = a937cfb4180ec02de7b736b92039f5f8210152bc
merge commit message                 = "Merge pull request #113 … P0-PKG-07 follow-up:
                                        close ten defects in the durable Kernel Authority world"
merge parents                        = 8e7ded3b (the PR #112 merge)  +  d6031894 (PR #113 head)
frozen source commit 7d9d1f09…       = ancestor of both the PR head and the merge commit
package.json at 7d9d1f09             = @aoc-enterprise/runtime 1.2.0
```

**Repository identity.** The canonical repository is now
`Republika-Network/Frontera`, renamed from `Soberania-Protocol/Soberania-Enterprise`.
Continuity was proven rather than assumed: the 1.1.0 source commit `74308ad1`
and the PR #112 merge commit `8e7ded3b` are both present in this repository, and
`8e7ded3b` is the **first parent** of the PR #113 merge. The same holds for
PMFreak: `Republika-Network/pmfreak` and the old `Soberania-Protocol/pmfreak`
resolve the PR branch to the identical head, so this is one repository under a
new name, not a fork.

**Why 7d9d1f09 and not the PR head.** Two commits sit between them —
"record the corrected successor artifact identity" and "record the confirmed
repository identity" — both evidence-only. The frozen artifact is built from
`7d9d1f09` because that is what the recorded SHA-256 describes; building from a
newer commit merely because it is newer would produce different bytes and a
false provenance record.

## Artifact reproduction — bit-for-bit

```
git worktree add <tmp> 7d9d1f0952e67fb95a653e4815bc9183a10f1c90
npm ci && npm run build && npm pack .        # node v22.22.2, npm 10.9.7

reproduced SHA-256 = 1b59c63d911bd16ec7c1974a9ea7579cfa65a269badc81f0aa2bbdad1bace082
expected   SHA-256 = 1b59c63d911bd16ec7c1974a9ea7579cfa65a269badc81f0aa2bbdad1bace082   IDENTICAL
sizeBytes  3390079     fileCount 6366 (npm pack's own "total files")
```

The exports fingerprint is `2b0ee1e3afee…` — unchanged across 1.0.0, 1.1.0 and
1.2.0, and verified rather than copied. It digests the export *map*, and both
follow-ups changed symbols inside the existing `./enterprise` and `./kernel`
subpaths without adding one.

```
@aoc/protocol             0.2.0-rc.0  UNCHANGED   dbe8a08f432a…  a67d65b17dcb…
@aoc-enterprise/runtime   1.2.0       SUCCESSOR   1b59c63d911b…  2b0ee1e3afee…
```

The superseded 1.1.0 tarball was deleted from `vendor/`, and both version-pinned
gates (`check-tarball-purity.mjs`, `check-package-exports.mjs`) were repinned to
1.2.0 so nothing continues validating an artifact that is no longer installed.

## The corrected API, verified against the installed package

`createDurableKernelProviders()` now returns a `DurableKernelDecisionService`
carrying only what is needed to *ask* a question:

```
keys: authorityStore, clock, idGenerator, organizationId,
      recognitionProvider, records, reload

recognitionRuntime  absent      authorityRuntime  absent
approvalRuntime     absent      handshakeRuntime  absent
```

The mutable world handles moved to `createDurableKernelWorld()`, which is **not
exported** from the package. `DurableKernelProviderSet` survives as a deprecated
alias of the narrowed type.

**PMFreak's adapter required no change to adopt this.** It already consumed only
`recognitionProvider`, `clock` and `idGenerator`, and already passed the typed
`organization` field. The Phase B (ii) design survived a corrected upstream API
untouched — which is the strongest evidence available that it was reading the
boundary correctly, even while the surface it was handed was wider than it
should have been.

What did change is the *proof*. Phase B (ii) could only assert restraint; the
guarantee is now structural, and is asserted three ways:

* a **runtime** contract test that the decision service exposes no mutation
  handle at any depth;
* a **static gate** rule failing any Frontera-importing product file that names
  one, with its own negative control;
* the upstream store's own `requireKernelAuthorityOperator`, which no
  `{ system: false }` context can satisfy.

## Organization is now stated, not inferred — proven empirically

1.2.0 requires a request to name its organization, and will not treat absence as
an implicit match. Probed against the real package:

| request | status |
|---|---|
| typed `organization: { id: workspaceId }` | **allowed** |
| organization omitted | denied |
| wrong organization | denied |
| free-form `context.organizationId` only | denied |
| free-form context + wrong typed organization | denied |

Free-form context cannot substitute for the typed field, because the Kernel
derives the organization solely from `organization`. PMFreak already used the
typed field; the gate now fails if that ever regresses to a context key.

## Downstream contract test for the review fixes

`tests/frontera-1-2-0-contract.test.ts` — 8 tests against the real packaged
1.2.0. Deliberately **not** a copy of Frontera's suite: it asserts only the
behaviours PMFreak's boundary depends on, so a future artifact swap that
regressed one fails here rather than in production.

| Aspect | Result |
|---|---|
| A — persisted payload tampering (a widened resource scope) | raises; PMFreak returns `frontera_unavailable`, **0 dispatch RPC calls** |
| B — lost tail revocation (revocation event deleted) | raises; authority is **not** resurrected, **0 dispatch RPC calls** |
| C — product cannot self-mint authority | no mutation handle on the decision surface, at any depth |
| D — organization omitted | never allowed |
| E — wrong organization / context substitution | denied |
| F — correct organization + valid grant | allowed |
| G — revoked authority | denied, `AUTHORITY_CAPABILITY_REVOKED` |
| H — expired credential alongside a valid covering one | allowed — the expired one does not shadow the live grant |

A and B are the two defects that most directly threatened PMFreak — a tampered
payload could widen a scope, a lost revocation could resurrect withdrawn
authority — and both are asserted **through the real adapter**, so what is proven
is that PMFreak fails closed, not merely that Frontera raises.

## Authority freshness — unchanged and still correct

Per-evaluation hydration is retained and still works through the narrowed
decision service.

```
ALLOW -> operator revokes out of band -> next evaluation DENY -> dispatch RPC calls = 0
STALE_ALLOW_AFTER_REVOCATION = NO
```

## Verification (Phase D)

```
PMFREAK_FRONTERA_1_2_0_SOURCE_COMMIT = 532f7d28a010cf1a9ea318a8006ef00d5a11b8db
product source files changed by the 1.2.0 adoption = 0
```

Every gate below ran from that commit's tree, Node v22.22.2 / npm 10.9.7. This
document is committed separately and changes no application, runtime, schema or
dependency file.

| Gate | Result |
|---|---|
| `npm ci` from a deleted `node_modules` | PASS — no `--force`, no `--legacy-peer-deps`; resolves 1.2.0 |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors |
| `npm test` | PASS — **13,340 tests, 0 fail, 17 skipped** (1.1.0 baseline 13,328; +12) |
| `npm run build` | PASS |
| `npm run check:governance` (full chain) | PASS |
| `npm run check:aoc-boundaries` | PASS |
| `npm run check:packaged-aoc-artifacts` | PASS — 1.2.0 SHA-256 and exports fingerprint verified |
| `npm run check:governance-ownership` | PASS — 44/44 |
| `npm run check:governance-collisions` | PASS |
| `npm run check:package-purity` | PASS |
| `npm run check:frontera-consumer` | PASS — FRONTERA_PRODUCT_CONSUMERS=3 |
| `npm run check:release-readiness` | PASS |
| `npm run compliance:check` | PASS — regenerated for 1.2.0; `blocked: 0`; no 1.1.0 component remains |

### Two things the gates caught

**My own test file broke the build.** The new contract test used `never` casts
and an untyped `better-sqlite3` import, which `Failed to type check` turned into
a build failure. It was repaired properly — the real `KernelAuthorityStore` type,
and a named local shape for the two `better-sqlite3` calls loaded through
`createRequire` — rather than suppressed with `@ts-nocheck` or a new dependency.

**The new mutable-handle rule was initially too broad.** Matching bare
identifiers flagged `src/features/recognition-runtime/`, a **PMFreak-owned**
module tracked since #531 whose methods share names with Frontera's engine by
coincidence of domain vocabulary — the same class of collision P0-PKG-05
catalogued. It imports nothing upstream. The rule is now scoped to files that
actually import Frontera, which is its real intent: the hazard is reaching a
mutable handle *off a Frontera object*. A negative control asserts the PMFreak
module is not flagged, because a gate that cries wolf is one reviewers learn to
ignore.

## Database impact (Phase D)

```
DATABASE_SCHEMA_CHANGED=NO   MIGRATION_ADDED=NO   RLS_CHANGED=NO
EXISTING_SERIALIZED_VALUES_CHANGED=NO   AUDIT_HISTORY_REWRITTEN=NO
EXISTING_EVENT_VOCABULARY_CHANGED=NO
```

## Upstream impact (Phase D)

```
Protocol modified = NO      Frontera modified = NO      exports widened = NO
deep/private upstream imports = NO
packages published = NO     tags created = NO     GitHub Releases = NO     P2-15 started = NO
```

The Frontera clone was read-only: a detached worktree, a build, a pack.

## What remains

```
DB_ACCEPTANCE=NOT_RUN_ENVIRONMENT
FOUNDER_BROWSER_ACCEPTANCE=NOT_RUN_ENVIRONMENT
```

> **Superseded by Phase E.** Both were executed on the local checkout at
> `e1264d12`: DB acceptance PASS and the Founder journey 17/17. See
> "Phase E — Local acceptance executed" at the end of this document. This
> section stays as written because it was true of the environment it describes.

The Phase D adoption was completed in a cloud container, which can build,
install and test but cannot host Supabase or drive Chromium. The Founder journey
must run on the local checkout:

```
npm run seed:p2-13-founder          # PMFreak DB state
npm run provision:founder-frontera  # OPERATOR-side Frontera authority (minimum, no wildcard)
npm run test:e2e:p2-14              # the 17 canonical checkpoints
```

All 17 checkpoints remain intact, and STEP 12 still asserts `fronteraDecisionId`
— now necessarily minted by a **1.2.0** `AocKernel.evaluate()`.

## Known upstream debt (unchanged)

`@aoc-enterprise/runtime@1.2.0` still declares no `license`, re-confirmed after
the swap (`REVIEW_REQUIRED`, `blocked: 0`). Upstream packaging debt, unchanged
across all three artifacts, not fixable from PMFreak.

# Phase E — Local acceptance executed; the Founder journey is closed

Phases A–D closed the architectural question but left one thing genuinely
open: every prior run happened in a cloud container that could build, install
and test but could not host Supabase or drive Chromium. Phase E is that missing
run, and nothing else. No product source, dependency, migration, schema or RLS
policy was touched to obtain it.

```
ACCEPTANCE_PHASE                 = B (local DB + real Chromium)
CANDIDATE_COMMIT                 = e1264d12d13b08b995dc7e9021ae641c5dfc48a0
PRODUCT_SOURCE_CHANGED           = NO
DEPENDENCIES_CHANGED             = NO
MIGRATIONS/SCHEMA/RLS_CHANGED    = NO
FRONTERA_OR_PROTOCOL_MODIFIED    = NO
```

## Where it ran

The real local Windows/WSL checkout, not a cloud one:

```
repo root   C:\Users\Usuario\source\Republika-Network\pmfreak
            (reached as /mnt/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/e27fa1b4...,
             proven the SAME device + inode as /mnt/c/Users/Usuario/source/Republika-Network/pmfreak)
origin      Republika-Network/pmfreak
branch      claude/pmfreak-upstream-packaging-0ojfyc
HEAD        e1264d12d13b08b995dc7e9021ae641c5dfc48a0
worktree    clean at start
```

Node v22.23.1 · npm 10.9.8 · Docker 29.7.2 · Supabase local stack healthy on
54321/54322 · Playwright 1.62.1 with its own `chromium-1234` build. The
`supabase_vector` container restart-loops; it ships logs and takes part in no
gate.

## Frontera artifact actually consumed

```
package               @aoc-enterprise/runtime
version               1.2.0
tarball SHA-256       1b59c63d911bd16ec7c1974a9ea7579cfa65a269badc81f0aa2bbdad1bace082   verified
exports fingerprint   2b0ee1e3afee7c02d600615771eac3fa8aeec680c27bf4189041715729a22438   verified
```

`npm ci` replaced a stale local `node_modules` that still held 1.1.0; every
result below is against the installed 1.2.0.

## Database acceptance

| Gate | Result |
| --- | --- |
| `seed:p2-13-founder preflight` | `LOCAL_ISOLATED`, all signals ok |
| `seed:p2-13-founder reseed` / `verify` | `COMPLETE`, both tenants, P2-14 owns nothing |
| `check:p2-13-db` | PASS |
| `check:p2-14-db` | PASS — 38 assertions |
| `check:operational-flow-db` | PASS |
| `check:fresh-db-migrations` | PASS — 161 migrations applied from empty, 433 tables, 1 pre-existing table without RLS (unrelated) |

The fresh-migration target was an **independent** Postgres 16 container and a
separate database (`pmfreak_fresh_v3`, re-confirmed on a second database
`pmfreak_fresh_v4`) — never the Founder DB. This WSL distro has no `psql`
client, so a shim ran the real `psql` **inside** that container, streaming each
`-f <file>` to stdin; no migration under `supabase/migrations` uses a backslash
meta-command, so the two forms are equivalent. The gate's own logic, ordering
and `ON_ERROR_STOP=1` were not modified.

## Operator-side authority provisioning

`npm run provision:founder-frontera`, run before the browser, in a process the
product cannot reach:

```
frontera version      1.2.0
operator context      system: true
organization          a766e43a-b980-59e8-8861-4e166c5d16e8   (PMFreak workspace = Tenant A)
action                execute.material-action                (one action, no wildcard)
resource scope        project:060659c6-40a3-56d0-982d-80e5fd15ad74   (one project, no wildcard)
Tenant A authority    MINIMUM ONLY
Tenant B authority    NONE — dispatches nothing; isolation is the point
```

## Pre-browser authority matrix — against the real durable store

Evaluated through PMFreak's own adapter with default deps, so the real SQLite
store and the real `AocKernel.evaluate()` answered every case:

| Case | Expected | Actual |
| --- | --- | --- |
| matching actor / action / project / organization | ALLOW | ALLOW, decision id minted |
| wrong project | DENY | DENY — `AUTHORITY_CAPABILITY_MISSING`, `POLICY_ACTION_PROHIBITED` |
| wrong organization | DENY | DENY — `FRONTERA_ACTOR_UNBOUND` |
| organization omitted | never ALLOW | DENY — `FRONTERA_EVALUATION_UNAVAILABLE` |
| unknown principal | DENY | DENY — `FRONTERA_ACTOR_UNBOUND` |
| Tenant B dispatch | DENY | DENY — `FRONTERA_ACTOR_UNBOUND` |

```
FRONTERA_PRE_BROWSER_AUTHORITY_CHECK=PASS
```

## Founder browser acceptance — run, not outstanding

Real Chromium via Playwright against the real application reading the real
durable authority store. No fake adapter, no fake ALLOW, no
`createDefaultKernelProviders()`, no mock dispatch route, no application
self-provisioning.

```
canonical checkpoints   STEP_01 .. STEP_17   =  17/17 PASS
founder-story tests                          =  30/30 PASS
named checkpoints (incl. PRECHECK, negatives,
  accessibility, responsive)                 =  33/33 PASS
```

No test was skipped, no checkpoint count reduced, no expectation rewritten.
STEP 12 retains and passes its `fronteraDecisionId` assertion.

### Correlation IDs from the canonical run

```
Material Action ID     5f60060b-11a8-5ab7-a195-0ed704b5eb19
Frontera Decision ID   enforcement-decision-5ba6c3c2-260b-476f-93a5-f525c15a81b3
Task ID                7ad34e9d-1a91-4728-88a2-2c2acd7ed6d8
```

### That the real boundary was traversed, not run beside

Two independent proofs, neither of which infers traversal from a passing unit
test:

1. **Provenance of the id.** The string `enforcement-decision` appears nowhere
   in `src/`, `scripts/` or `tests/`. It is minted only by
   `@aoc-enterprise/runtime/dist/src/features/action-enforcement/domain/enforcement-decision`.
   PMFreak cannot produce one.

2. **Live revocation against the running application.** With the app serving,
   the same dispatch was driven through `POST /api/operational-flow` while an
   operator process revoked authority out of band between attempts:

   ```
   [1] dispatch                  200, fronteraDecisionId=enforcement-decision-101100c8-...
   [2] operator revokes externally (separate process, Frontera's own store)
   [3] next dispatch             409, disposition=denied, failureClass=frontera_denied,
                                 no decision id, reason=frontera_enforcement_denied
   [4] Tasks after revocation    unchanged — 0 new
   [5] operator re-provisions    200, fronteraDecisionId=enforcement-decision-d4607031-...
   ```

   An application that did not read Frontera's durable store on every attempt
   could not have changed its answer at step [3] and changed it back at [5].

```
Founder browser -> POST /api/operational-flow -> dispatchGovernedMaterialActionToTask
  -> authorizeFronteraDispatch -> findActorByExternalSubject
  -> createDurableKernelProviders -> AocKernel.evaluate -> ALLOW
  -> dispatch_governed_action_to_internal_task -> Task           TRAVERSED
```

## Tenancy negatives

```
TENANCY_NEGATIVES=PASS
```

Tenant A cannot read or mutate Tenant B and Tenant B cannot read or mutate
Tenant A, in both directions and with no cached context leaking across the
switch; Tenant B holds no Frontera dispatch authority; cross-workspace and
cross-project authority both fail at the Frontera boundary; an unknown
principal is unbound. The same-tenant role negatives (PM lacks terminal
Decision authority, viewer may read but not mutate) and the logged-out refusal
also pass.

## Revocation freshness and integrity

```
FRONTERA_REVOCATION_FRESHNESS=PASS
STALE_ALLOW_AFTER_REVOCATION=NO
dispatch RPC calls after revocation = 0
```

The 1.2.0 downstream integrity proofs were re-executed here and all hold:
payload tampering fails closed, tail revocation truncation fails closed, the
self-authorization mutation surface is unreachable at any depth, and an omitted
organization is never an implicit match. No Task dispatch follows any integrity
failure. Revocation in 1.2.0 is terminal — a revoked entity id cannot be
re-granted — so the operator rebuilds rather than re-issues; that is upstream
behaving correctly and is recorded, not worked around.

## Post-journey invariants

```
Material Actions   2   (one dispatched, one denied by the real governance contract)
Tasks              1   one Material Action -> at most one Task
Internal Executions 1  Outcomes 1   Observations 1
```

Retries added no Task, the hard refresh added no Task, and the denied action
produced none. Existing Outcome / Observation semantics are unchanged.

## Final regression battery

Run on a **clean detached worktree of this exact candidate commit** (see
`LOCAL_WORKTREE_CRLF_RESIDUE` below for why that mattered), with its own
`npm ci` resolving 1.2.0:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors (620 pre-existing warnings) |
| `npm test` | PASS — 13,332 tests, **13,315 pass, 0 fail**, 17 skipped; module-mocks 8/8 |
| `npm run build` | PASS |
| `npm run check:governance` | PASS |
| `npm run check:package-purity` | PASS |
| `npm run check:packaged-aoc-artifacts` | PASS |
| `npm run check:governance-ownership` | PASS |
| `npm run check:governance-collisions` | PASS |
| `npm run check:frontera-consumer` | PASS — `FRONTERA_PRODUCT_RUNTIME_CONSUMPTION=PASS` |
| `npm run check:release-readiness` | PASS |
| `npm run compliance:check` | PASS — regeneration is timestamp/commit stamp only, lockfile SHA-256 unchanged |

## Integration status after Phase E

```
PROTOCOL_PACKAGE_INTEGRATION          = PASS
FRONTERA_PACKAGE_INTEGRATION          = PASS
FRONTERA_PRODUCT_RUNTIME_CONSUMPTION  = PASS
PMFREAK_GOVERNANCE_OWNERSHIP_BOUNDARY = PASS
PMFREAK_FOUNDER_JOURNEY               = PASS
THREE_REPOSITORY_INTEGRATION          = PASS
```

This supersedes the `DB_ACCEPTANCE=NOT_RUN_ENVIRONMENT` and
`FOUNDER_BROWSER_ACCEPTANCE=NOT_RUN_ENVIRONMENT` blocks recorded in Phase B (ii)
and Phase D. Those sections stay as written — they were true of the environment
they described, and an evidence document that edits away its own gaps teaches
nothing.

## Two findings, both NON-BLOCKING and OUT OF SCOPE for this PR

### 1. `LOCAL_WORKTREE_CRLF_RESIDUE`

```
classification              = STALE_LOCAL_STATE
product defect              = NO
product code change required = NO
in scope for this PR        = NO
```

4,063 of 4,207 tracked files carry CRLF in the local working tree while **every
committed blob is LF**. `core.autocrlf=input` normalizes on commit, so
`git status` stays clean and the divergence is invisible. Ten source-scanning
tests anchor regexes on `\n` and fail against CRLF; stripping CR makes the
content byte-identical, the same files pass on `origin/main`, and a clean
detached worktree at this exact candidate commit passes **13,315/13,315, 0
fail**. The residue is a property of one local checkout, not of the commit.

The residue has a second, subtler manifestation worth naming, because the
obvious reaction to it is wrong: `compliance:artifacts:drift` fails locally,
reporting that the committed artifacts describe a different `package-lock.json`.
They do not. The lockfile SHA-256 is taken over file bytes, and CRLF changes
them:

```
working-tree bytes (CRLF)   35470a91780bd008...
same file, CR stripped      fac4cf7639cb5bd9...   <- matches
committed blob              fac4cf7639cb5bd9...   <- matches
committed compliance artifact fac4cf7639cb5bd9... <- matches
```

`git status` reports `package-lock.json` unmodified, and `compliance:check`
passes in full on the clean worktree. Regenerating the compliance artifacts
here would bake a CRLF-derived hash into them and break the gate for everyone
else — so they were **not** regenerated.

Repair belongs to the operator's own checkout (`git checkout-index -f -a`).
**A line-ending rewrite is deliberately NOT committed in this PR** — it would
touch thousands of files, bury the evidence diff, and fix nothing about the
candidate.

### 2. `auth-session-continuity.spec.ts` — `GET /logout` RSC assertion

```
classification              = TEST_DEFECT, PRE-EXISTING
introduced by #585          = NO
one of the 17 checkpoints   = NO
product code change required = NO
in scope for this PR        = NO
```

`npm run test:e2e:p2-14` runs the whole `tests/e2e` directory, so it exits
non-zero on one assertion outside the Founder story: `GET /logout` carrying
`RSC: 1` expects `405` directly, but Next.js 16.3.2 first emits its framework-wide
`307 -> ?_rsc=<hash>` normalization before any route handler runs. `/login`
answers with the identical redirect and hash, so this is not logout-specific.

**The security property the test names still holds.** Following the redirect
reaches `405` with `Allow: POST` and **no `Set-Cookie`** — no GET path can end
a session; `GET` performs no session mutation at all. Both
`src/app/logout/route.ts` and the spec are **byte-identical to `main`**, Next is
16.3.2 on both, and no CI workflow runs Playwright, so this assertion has not
been exercised since #584 merged. It reproduces on the clean candidate worktree.

Left for a separate follow-up. Rewriting the expectation here would be exactly
the "get it green" move this PR's gates exist to prevent.
