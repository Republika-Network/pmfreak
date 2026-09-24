# Service-Role Risk Register (Phase 4.6)

## Audit summary (2026-05-15)

- **Total service role consumers:** 28 files
- **Legitimate consumers:** 28 files (all usages determined to be legitimate)
- **Reduced consumers:** 0 (no usages swapped to scoped client — all are genuinely required)
- **Registry file:** `src/lib/security/privileged-access-registry.ts`

## Active privileged surfaces

### HIGH risk (17 files)

| File | Purpose |
|------|---------|
| `src/lib/security/agent-attestation.ts` | Nonce replay protection primitive — must bypass RLS so a compromised token cannot suppress its own revocation record |
| `src/lib/security/telemetry.ts` | Security audit trail — must persist events even when user session is invalid; actor must not control their own audit log |
| `src/lib/security/governance-runtime.ts` | Approval request persistence — system writes on behalf of requesting actor |
| `src/lib/security/trust-domains.ts` | Trust domain and signing key lifecycle — cross-tenant, cannot be governed by single-tenant RLS |
| `src/lib/security/trust-handshakes.ts` | External verifier handshake protocol — cross-tenant by design |
| `src/lib/security/trust-coordination.ts` | Revocation registry, trust graph, policy lifecycle — must be authoritative cross-tenant |
| `src/aoc/enterprise/runtime/execution-grants.ts` | Governance execution grants — spans approval, actor, and resource tables across user RLS boundaries |
| `src/aoc/enterprise/runtime/delegated-capabilities.ts` | Delegation chains — traverse records owned by multiple actors |
| `src/app/api/governance/approvals/[id]/approve/route.ts` | Governance approval decision (approve) — cross-ownership reads and grant issuance |
| `src/app/api/governance/trust/handshakes/route.ts` | Admin handshake listing — cross-tenant view |
| `src/app/api/governance/trust/events/route.ts` | Cross-verifier trust event listing — cross-tenant sync data |
| `src/app/api/governance/trust/events/import/route.ts` | Trust event ingestion from external verifiers — cross-tenant with external origin |
| `src/lib/billing.ts` | Stripe webhook idempotency guard — no user session context available |
| `src/lib/workspaces.ts` | Workspace bootstrap on first login — user has no workspace yet; RLS would block |
| `src/lib/feature-gates.ts` | `auth.admin.getUserById()` — only available via service role; no scoped alternative |
| `src/lib/db/supabase-server.ts` | Legacy admin client factory — bypasses PrivilegedAccessContext tracking; no active external callers confirmed |

### MEDIUM risk (7 files, after Phase 3c swaps)

| File | Purpose |
|------|---------|
| `src/app/(protected)/layout.tsx` | Trial status enforcement — system writes trial expiry across workspace boundaries |
| `src/app/(protected)/accept-invite/[token]/page.tsx` | Invitation acceptance — user not yet a member of target workspace |
| `src/app/(protected)/early-access/page.tsx` | Founder early access dashboard — cross-workspace read-only view |
| `src/app/api/early-access/summary/route.ts` | Founder summary API — cross-workspace system operation |
| `src/lib/early-access.ts` | Early access invite/trial lifecycle — system-managed records |
| `src/lib/first-user-telemetry.ts` | First-user onboarding telemetry — may run before authenticated session |
| `src/app/api/governance/trust/keys/route.ts` | Public key discovery — reads public key metadata for external verifiers |
| `src/app/api/governance/trust/.well-known/capability-issuer/route.ts` | Capability issuer discovery — public .well-known metadata endpoint |

## Controls in place

- Explicit privileged context contract (`routeId`, `operation`, `reason`, and either `actorUserId` or `systemActor`) enforced by `assertContext` in `createPrivilegedSupabaseClient`.
- `privileged_client_used` telemetry event logged on every service role client acquisition (except recursion-bypass path).
- `PRIVILEGED_ACCESS:` inline comment above every HIGH risk usage site.
- `AUDIT_REF: service-role-risk-register.md` cross-reference on every HIGH risk usage.
- Authoritative inventory at `src/lib/security/privileged-access-registry.ts` with `assertPrivilegedAccessJustified(file)` guard for future security reviews.
- Governance permission checks on all member/billing control paths.
- Webhook actor set to `systemActor: "stripe_webhook"` for audit trail isolation.

## Remaining risks

- Service-role blast radius remains high if server runtime is compromised — the registry and context contract reduce but cannot eliminate this risk without additional infrastructure controls (e.g., per-operation IAM roles, network-level egress filtering).
- `src/lib/db/supabase-server.ts` defines a legacy client (`createSupabaseAdminClient`) that bypasses context tracking. No active external callers confirmed; this should be deleted once confirmed unused.
- Replay prevention for agent attestation is implemented via nonce-based persistence in `agent_attestation_nonces`. Each token's SHA-256 hash is recorded on first use; subsequent uses are rejected with `replay_detected`. Expired rows can be purged via `purge_expired_nonces()`.

---

## Second Pass — Strict Criteria Re-audit (2026-05-16)

Re-audit of all 28 first-pass entries against strict legitimacy criteria:

- **L1** Cross-tenant read/write where RLS would block by design
- **L2** System bootstrap before any authenticated session (webhooks, cron, first-login)
- **L3** The operation itself IS the trust enforcement mechanism (nonces, revocation, audit log)
- **L4** Genuine aggregation across multiple tenants in a single query

A usage is **not** legitimate under strict criteria if it reads/writes only the authenticated user's own data, could use `auth.uid()` in an RLS policy, or uses service role for convenience rather than necessity.

### Second-pass results

| Classification | Count | Files |
|---|---|---|
| **SWAP** (scoped client sufficient; service role removed) | 1 | `approve/route.ts` |
| **NEEDS_RLS** (strict criteria not met; swap blocked by missing/broken RLS) | 4 | `reject/route.ts`, `governance/delegations/route.ts`, `v1/delegations/route.ts`, `workspace-team.ts` |
| **KEEP** (strict criteria confirmed) | 23 | All others |

### SWAP — service role removed

| File | Reason for swap | Criterion that was NOT met |
|------|----------------|---------------------------|
| `src/app/api/governance/approvals/[id]/approve/route.ts` | `governance_approval_requests` has RLS allowing workspace owner/admin to SELECT and UPDATE; approver is always a workspace admin (enforced by `requireGovernancePermission`). `issueExecutionGrant` has its own internal privileged client. Scoped client is sufficient for this route. | L1 not met — RLS policy covers this read/write pattern |

### NEEDS_RLS — TODO comments added; service role retained pending migration fix

| File | Blocking issue | Required fix before swap |
|------|---------------|--------------------------|
| `src/app/api/governance/approvals/[id]/reject/route.ts` | `governance_execution_grants` UPDATE is **revoked** for the `authenticated` role in the RLS migration; a scoped client cannot perform the grant revocation write. | Add an UPDATE policy on `governance_execution_grants` allowing workspace owner/admin to revoke grants in their workspace. |
| `src/app/api/governance/delegations/route.ts` | `governance_delegations` SELECT policy references `public.workspace_members` — a non-existent table (correct name: `public.workspace_memberships`). All scoped reads fail silently. | Fix the migration to reference `public.workspace_memberships`. |
| `src/app/api/v1/delegations/route.ts` | Same `governance_delegations` RLS bug as above. | Same fix: correct the table name in the migration. |
| `src/lib/workspace-team.ts` | `workspace_memberships` has no RLS enabled. Seat snapshot reads this table without a policy restricting results to workspace members. | Add a SELECT policy on `workspace_memberships` using `is_workspace_member(workspace_id)`. |

### KEEP — strict criteria confirmed (24 files)

| File | Criterion | Justification |
|------|-----------|---------------|
| `src/lib/security/agent-attestation.ts` | L3 | Nonce replay protection IS the security primitive |
| `src/lib/security/telemetry.ts` | L3 | Audit trail must not be suppressible by the actor being logged |
| `src/lib/security/governance-runtime.ts` | L1 | `governance_approval_requests` INSERT revoked for authenticated role |
| `src/lib/project-brain/conversation/assistant-message-writer.ts` | L1 | PB-CHAT-01: assistant-row INSERT into PROJECT conversations denied to authenticated role; replies are written by the system after project-scoped governance |
| `src/lib/security/trust-domains.ts` | L3 | Trust domain lifecycle IS the security primitive |
| `src/lib/security/trust-handshakes.ts` | L3 | Handshake protocol IS the trust establishment mechanism |
| `src/lib/security/trust-coordination.ts` | L3 | Revocation registry IS the security primitive |
| `src/aoc/enterprise/runtime/execution-grants.ts` | L1 | `governance_execution_grants` INSERT/UPDATE/DELETE revoked for authenticated role |
| `src/aoc/enterprise/runtime/delegated-capabilities.ts` | L1 | Delegation chain traverses records owned by multiple actors |
| `src/app/api/governance/trust/handshakes/route.ts` | L1 | Admin view spans all trust domains — no single-tenant scope possible |
| `src/app/api/governance/trust/events/route.ts` | L1 | Cross-verifier event listing spans all trust domains |
| `src/app/api/governance/trust/events/import/route.ts` | L1 | External-origin trust events — cross-tenant by definition |
| `src/lib/billing.ts` | L2 | Stripe webhook has no user session |
| `src/lib/workspaces.ts` | L2 | First-login bootstrap — user has no workspace yet |
| `src/lib/feature-gates.ts` | L1 | `auth.admin.getUserById()` only available via service role |
| `src/lib/db/supabase-server.ts` | — | No active callers confirmed; pending deletion; no queries executed by factory itself |
| `src/app/(protected)/layout.tsx` | L1 | Trial expiry writes cross workspace boundaries |
| `src/app/(protected)/accept-invite/[token]/page.tsx` | L2 | Invited user not yet a member of target workspace |
| `src/app/(protected)/early-access/page.tsx` | L1 | Reads all workspaces — no single-tenant scope possible |
| `src/app/api/early-access/summary/route.ts` | L4 | Aggregates across all invites, trials, and activations |
| `src/lib/early-access.ts` | L1 | System-managed records span all tenants |
| `src/lib/first-user-telemetry.ts` | L2 | May run before authenticated session exists |
| `src/app/api/governance/trust/keys/route.ts` | L1 | Public key metadata spans all trust domains |
| `src/app/api/governance/trust/.well-known/capability-issuer/route.ts` | L1 | Trust domain metadata spans all trust domains |

### Net blast-radius reduction

- **Before second pass:** 28 active service role consumers
- **After SWAP:** 27 consumers (approve route now uses scoped client)
- **NEEDS_RLS debt:** 4 consumers blocked from swap pending migration fixes; TODO comments mark each call site with the specific blocking issue

### Registry changes

`src/lib/security/privileged-access-registry.ts` updated:
- `approve/route.ts` entry **removed** (no longer uses service role)
- New field `strictCriteriaMet?: "L1" | "L2" | "L3" | "L4"` on all KEEP entries with confirmed criteria
- New field `needsRlsBeforeSwap: boolean` on all entries (`true` for 4 NEEDS_RLS, `false` for 23 KEEP)

---

## Phase 3c — RLS Fixes (2026-05-15)

All 4 NEEDS_RLS consumers resolved. Migration `20260515100000_rls_governance_fixes.sql` added the missing policies; each call site swapped to `createSupabaseServerClient`.

| File | RLS fix applied |
|---|---|
| `src/app/api/governance/approvals/[id]/reject/route.ts` | `governance_execution_grants` UPDATE policy added; UPDATE re-granted to `authenticated` role |
| `src/app/api/governance/delegations/route.ts` | `governance_delegations` SELECT policy fixed (`workspace_members` → `workspace_memberships`) |
| `src/app/api/v1/delegations/route.ts` | Same delegation SELECT policy fix |
| `src/lib/workspace-team.ts` | `workspace_memberships` RLS enabled + SELECT policies added |

**Registry after Phase 3c:** 23 entries (27 − 4 NEEDS_RLS removed), all `needsRlsBeforeSwap: false`.  
**Migration:** `supabase/migrations/20260515100000_rls_governance_fixes.sql`
