/**
 * Route guard registry — Perilla 8 (Route Middleware / Server Guard
 * Consistency Hardening).
 *
 * This is a classification inventory for PMFreak's sensitive routes, pages,
 * and server actions. It is NOT exhaustive over all ~500 files under
 * `src/app/api/**` — most of those are the AOC governance/agent surface,
 * which is already covered as a whole by `@/lib/security/server-authorization`
 * (`requireAuthenticatedUser`/`requireWorkspaceMember`/`requireProjectAccess`/
 * `evaluateCapability`) and audited in `docs/security/local-authority-bypass-audit.md`.
 * This registry instead covers the routes named explicitly by the Perilla 8
 * brief as high-risk categories: billing, webhook, founder/internal,
 * delegation, invite acceptance, upload/evidence, and a representative
 * sample of workspace-/project-scoped routes plus the full public allowlist.
 *
 * See docs/security/route-middleware-server-guard-boundary.md for the
 * category definitions and the guard each category requires.
 *
 * Enforced by tests/route-guard-consistency.test.mjs — that suite fails if:
 *   - a route listed here no longer contains its requiredGuard string,
 *   - a route in PUBLIC_ROUTE_ALLOWLIST starts using service-role or a
 *     forbidden auth pattern,
 *   - a forbidden auth pattern (AuthUserContext.role, user_metadata.role,
 *     body.actorRole/isAdmin/isFounder/isOwner) appears in any server file.
 */

export type RouteClassification =
  | "public"
  | "auth-only"
  | "workspace-scoped"
  | "project-scoped"
  | "billing"
  | "webhook"
  | "founder-internal"
  | "invite-acceptance"
  | "upload-evidence"
  | "aoc-governance"
  | "delegation";

export type RouteKind = "api-route" | "page" | "layout" | "server-action" | "middleware";

export type RouteGuardEntry = {
  readonly file: string;
  readonly kind: RouteKind;
  readonly classification: RouteClassification;
  /** Exact source substring(s) that must appear in the file — the actual guard call. */
  readonly requiredGuard: string;
  readonly dataAccess: readonly string[];
  readonly notes?: string;
};

export const ROUTE_GUARD_REGISTRY: readonly RouteGuardEntry[] = [
  // ── Middleware ─────────────────────────────────────────────────────────
  {
    file: "src/proxy.ts",
    kind: "middleware",
    classification: "auth-only",
    requiredGuard: "isProtectedPageRoute",
    dataAccess: ["session cookie (auth presence only — no onboarding-state claim is read)"],
    notes:
      "Page-route redirect gate only. Makes no onboarding/activation-state " +
      "decisions (see resolveOnboardingState) — those are decided exclusively " +
      "by (protected)/layout.tsx from real DB state. API routes pass through " +
      "untouched ('policy === \"api\" => return response') — every API route " +
      "owns its own server-side guard. Never the sole authorization boundary.",
  },
  {
    file: "src/app/(protected)/layout.tsx",
    kind: "layout",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["auth session", "canonical workspace id"],
    notes:
      "Proves authentication + resolves the caller's own canonical workspace " +
      "for every page under (protected)/**. Does NOT prove access to any " +
      "specific workspaceId/projectId taken from a URL param or query string " +
      "— routes/pages that accept one must still guard it themselves.",
  },

  // ── Billing ────────────────────────────────────────────────────────────
  {
    file: "src/app/api/billing/create-checkout-session/route.ts",
    kind: "api-route",
    classification: "billing",
    requiredGuard: "requireBillingManageMembership",
    dataAccess: ["company_subscriptions", "stripe"],
  },
  {
    file: "src/app/api/billing/create-portal-session/route.ts",
    kind: "api-route",
    classification: "billing",
    requiredGuard: "requireBillingManageMembership",
    dataAccess: ["company_subscriptions", "stripe"],
  },
  {
    file: "src/app/api/billing/state/route.ts",
    kind: "api-route",
    classification: "billing",
    requiredGuard: "getAuthUser",
    dataAccess: ["company_subscriptions (own company only)", "company_usage"],
    notes: "Read-only, self-scoped to the caller's own companyId — no billing-manage mutation, so auth-only is sufficient.",
  },
  {
    file: "src/app/(protected)/billing/page.tsx",
    kind: "page",
    classification: "billing",
    requiredGuard: "requireAuthUser",
    dataAccess: ["company_subscriptions (own company only)"],
  },

  // ── Stripe webhook ─────────────────────────────────────────────────────
  {
    file: "src/app/api/billing/webhook/route.ts",
    kind: "api-route",
    classification: "webhook",
    requiredGuard: "verifyStripeWebhookEvent",
    dataAccess: ["company_subscriptions", "billing_webhook_events"],
    notes: "Signature verified before any service-role client is created; idempotency via billing_webhook_events.",
  },

  // ── Founder / internal ─────────────────────────────────────────────────
  {
    file: "src/app/api/early-access/summary/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["early_access_invites", "trial_licenses", "workspace_activations", "early_access_events"],
  },
  {
    file: "src/app/api/early-access/founder-actions/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["early_access_invites", "trial_licenses"],
  },
  {
    file: "src/app/api/early-access/invites/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["early_access_invites"],
  },
  {
    file: "src/app/(protected)/early-access/page.tsx",
    kind: "page",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["early_access_invites", "trial_licenses", "workspace_activations", "early_access_events"],
  },
  {
    file: "src/app/(protected)/internal/governance-lab/page.tsx",
    kind: "page",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["operational_decision_records", "material_actions", "material_action_evaluations", "evidence (DEMO / FIXTURE lineage)"],
    notes:
      "UX-P0-02. Hosts the P2-06 / AOC-E Material Action certification panel and the " +
      "DEMO / FIXTURE capture path, both of which used to render inside ordinary " +
      "customer UX. Ordinary authenticated customers get notFound(), so the surface is " +
      "indistinguishable from a route that does not exist.",
  },
  {
    file: "src/app/operational-flow/page.tsx",
    kind: "page",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["operational_decision_records", "material_actions", "outcomes", "outcome_observations"],
    notes:
      "UX-P0-02. Previously guarded by requireAuthenticatedUser alone, which is not a " +
      "boundary for a certification surface — every ordinary customer is authenticated. " +
      "It renders the same MaterialActionPanel, so it carries the same founder/internal gate.",
  },

  // ── Founder Circle Program (Sprint 01) ─────────────────────────────────
  // Operator surfaces: requireFounderProgramOperator = program-enabled gate
  // + getAuthUser + isFounderOrInternalUser BEFORE body parse, with
  // founder_program_denied telemetry (src/lib/founder-program/authz.ts).
  {
    file: "src/app/api/founder-program/operator/invitations/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_invitations", "founder_participants"],
    notes: "Invite links are returned exactly once and never persisted or logged; token_hash is never selected in list responses.",
  },
  {
    file: "src/app/api/founder-program/operator/participants/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_participants"],
  },
  {
    file: "src/app/api/founder-program/operator/participants/actions/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_participants", "founder_membership_transitions", "pilot_agreement_acceptances", "workspaces"],
    notes: "All state changes flow through the founder_program_transition SECURITY DEFINER function (capacity + CAS).",
  },
  {
    file: "src/app/api/founder-program/operator/feedback/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_feedback"],
  },
  {
    file: "src/app/api/founder-program/operator/discovery-sessions/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_discovery_sessions", "founder_participants"],
  },
  {
    file: "src/app/api/founder-program/operator/decisions/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_program_decisions", "founder_participants"],
  },
  {
    file: "src/app/api/founder-program/operator/dashboard/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "requireFounderProgramOperator",
    dataAccess: ["founder_participants", "founder_invitations", "founder_membership_transitions", "founder_onboarding_checkpoints", "founder_feedback", "founder_discovery_sessions", "founder_program_decisions", "founder_program_events"],
  },
  {
    file: "src/app/(protected)/founder-program/page.tsx",
    kind: "page",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["founder_program_settings (via loadFounderProgramConfig)"],
  },
  // Participant surfaces: requireFounderProgramParticipantContext =
  // program-enabled gate + getAuthUser; every query self-scopes by the
  // resolved user id on top of RLS self-select policies.
  {
    file: "src/app/api/founder-program/invitation/[token]/route.ts",
    kind: "api-route",
    classification: "invite-acceptance",
    requiredGuard: "requireFounderProgramParticipantContext",
    dataAccess: ["founder_invitations (by token hash)", "founder_participants"],
    notes: "Token is a bearer credential resolved by sha256 only; unknown/revoked/expired are indistinguishable; per-IP+token abuse limit.",
  },
  {
    file: "src/app/api/founder-program/application/route.ts",
    kind: "api-route",
    classification: "invite-acceptance",
    requiredGuard: "requireFounderProgramParticipantContext",
    dataAccess: ["founder_invitations", "founder_participants", "founder_applications"],
    notes: "Email binding: invitation email must equal the authenticated account email.",
  },
  {
    file: "src/app/api/founder-program/application/withdraw/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireFounderProgramParticipantContext",
    dataAccess: ["founder_participants", "founder_applications"],
  },
  {
    file: "src/app/api/founder-program/status/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireFounderProgramParticipantContext",
    dataAccess: ["founder_participants", "founder_onboarding_checkpoints"],
  },
  {
    file: "src/app/api/founder-program/feedback/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireFounderProgramParticipantContext",
    dataAccess: ["founder_feedback", "founder_participants"],
    notes: "Participant reads exclude internal triage fields (projection + column-scoped grant).",
  },
  {
    file: "src/app/api/runtime/hardening/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["in-memory runtime health/invariant/assertion state"],
    notes: "Perilla 8 fix: previously unauthenticated; exposes degraded-mode/invariant diagnostics useful for attacker reconnaissance.",
  },
  {
    file: "src/app/api/governance/trust/handshakes/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["capability_verifier_handshakes"],
    notes: "Perilla 8 fix: cross-tenant admin listing (registry reason \"admin_review\") had no guard at all.",
  },
  {
    file: "src/app/api/governance/trust/handshakes/[id]/approve/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["capability_verifier_handshakes", "capability_verifier_policies"],
    notes:
      "Perilla 8 critical fix: previously no auth check at all, and approverUserId was taken from " +
      "the request body — any unauthenticated caller could approve a federation trust handshake, " +
      "granting an external verifier standing capability authority. Actor id now always comes from " +
      "requireAuthUser()'s session.",
  },
  {
    file: "src/app/api/governance/trust/handshakes/[id]/reject/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["capability_verifier_handshakes"],
    notes: "Perilla 8 fix: same class of gap as approve/revoke — see that entry.",
  },
  {
    file: "src/app/api/governance/trust/handshakes/[id]/revoke/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["capability_verifier_handshakes"],
    notes: "Perilla 8 fix: same class of gap as approve/reject — see that entry.",
  },
  {
    file: "src/app/api/governance/trust/events/route.ts",
    kind: "api-route",
    classification: "founder-internal",
    requiredGuard: "isFounderOrInternalUser",
    dataAccess: ["capability_trust_events"],
    notes:
      "Perilla 8 fix: human-facing cross-tenant event browser had no auth at all (distinct from the " +
      "machine-to-machine POST .../events/import route, which authenticates via a signed handshake token).",
  },

  // ── Delegation (governance capability delegation chain) ───────────────
  {
    file: "src/app/api/v1/delegations/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "requireWorkspaceRole",
    dataAccess: ["governance_delegations"],
    notes:
      "Perilla 8 critical fix: POST previously trusted body.delegatorRole directly for the " +
      "owner/admin/pm action-eligibility check, and never confirmed the caller belonged to the " +
      "target workspaceId at all, before a service-role insert. delegatorRole is now always " +
      "resolved server-side from workspace_memberships for that exact workspaceId.",
  },
  {
    file: "src/app/api/v1/delegations/[id]/revoke/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "requireDelegationRevokeActor",
    dataAccess: ["governance_delegations"],
    notes:
      "Perilla 8 critical fix: previously any authenticated user could revoke (and cascade-revoke) " +
      "any workspace's delegation chain by supplying its id — no ownership check at all. Now requires " +
      "the caller be the original delegator or an owner/admin of the delegation's own workspace.",
  },
  {
    file: "src/app/api/governance/delegations/issue/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "requireWorkspaceRole",
    dataAccess: ["governance_delegations"],
    notes: "Perilla 8 fix: same class of gap as /api/v1/delegations POST — see that entry.",
  },
  {
    file: "src/app/api/governance/delegations/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "getAuthUser",
    dataAccess: ["governance_delegations"],
    notes:
      "GET list, no explicit app-layer workspace filter beyond auth — acceptable because it uses the " +
      "RLS-scoped client (createSupabaseServerClient, not service-role); delegations_owner_admin_read/" +
      "delegations_delegator_read/delegations_delegatee_read RLS policies restrict visible rows to the " +
      "caller's own workspace/delegator/delegatee scope regardless of the requested workspaceId.",
  },
  {
    file: "src/app/api/governance/delegations/consume/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "getAuthUser",
    dataAccess: ["governance_delegations"],
    notes:
      "actorUserId always comes from the authenticated session; consumeDelegatedCapability's underlying " +
      "validateDelegatedCapability rejects any workspaceId/action/permission/resource/delegatee mismatch, " +
      "so a caller can only consume delegations actually addressed to them.",
  },
  {
    file: "src/app/api/v1/delegations/evaluate/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "getAuthUser",
    dataAccess: ["governance_delegations"],
    notes: "Read-only dry-run evaluation (no mutation); same actorUserId/identity-matching guarantee as the consume route above.",
  },
  {
    file: "src/app/api/governance/delegations/revoke/route.ts",
    kind: "api-route",
    classification: "delegation",
    requiredGuard: "requireDelegationRevokeActor",
    dataAccess: ["governance_delegations"],
    notes: "Perilla 8 fix: same class of gap as /api/v1/delegations/:id/revoke — see that entry.",
  },
  {
    file: "src/app/api/sdk/policies/evaluate/route.ts",
    kind: "api-route",
    classification: "workspace-scoped",
    requiredGuard: "getAuthUser",
    dataAccess: ["capability_policies", "capability_grants"],
    notes:
      "Perilla 8 fix: a client-supplied body.actor with actorType !== \"user\" previously skipped " +
      "authentication entirely. getAuthUser() is now called unconditionally before any body.actor is honored.",
  },
  {
    file: "src/app/api/sdk/agents/evaluate/route.ts",
    kind: "api-route",
    classification: "workspace-scoped",
    requiredGuard: "requireWorkspaceMember",
    dataAccess: ["ai_agents", "ai_agent_scopes"],
    notes: "Perilla 8 fix: previously had no application-layer guard at all, relying solely on RLS.",
  },

  // ── Federation ingestion ───────────────────────────────────────────────
  {
    file: "src/app/api/federation/events/route.ts",
    kind: "api-route",
    classification: "workspace-scoped",
    requiredGuard: "requireWorkspaceMember",
    dataAccess: ["in-memory federation ingress events"],
    notes: "Perilla 8 fix: workspaceId was previously taken from the query string with no membership check.",
  },
  {
    file: "src/app/api/federation/pulse/route.ts",
    kind: "api-route",
    classification: "workspace-scoped",
    requiredGuard: "requireWorkspaceMember",
    dataAccess: ["in-memory federation ingress events"],
    notes: "Perilla 8 fix: same class of gap as .../federation/events — see that entry.",
  },
  {
    file: "src/app/api/federation/webhooks/[connectorId]/route.ts",
    kind: "api-route",
    classification: "webhook",
    requiredGuard: "requireSystemOrWebhookSecret",
    dataAccess: ["in-memory federation ingress events"],
    notes:
      "Perilla 8 critical fix: 'authorized' previously meant only that an Authorization header started " +
      "with the literal string \"Bearer \" — the token value itself was never checked against anything, " +
      "so any caller could impersonate a federation connector for any workspaceId. Now verified against " +
      "FEDERATION_WEBHOOK_SECRET and fails closed if that secret is unset.",
  },

  // ── AI / project-scoped ────────────────────────────────────────────────
  {
    file: "src/app/api/ai/project-state/route.ts",
    kind: "api-route",
    classification: "project-scoped",
    requiredGuard: "requireProjectAccess",
    dataAccess: ["derived project-state signals"],
    notes: "Perilla 8 fix: projectId from query string previously had no access check.",
  },
  {
    file: "src/app/api/ai/suggestions/route.ts",
    kind: "api-route",
    classification: "project-scoped",
    requiredGuard: "requireProjectAccess",
    dataAccess: ["project_suggestions"],
    notes: "Perilla 8 fix: same class of gap as .../ai/project-state — see that entry.",
  },
  {
    file: "src/app/api/ai/escalation-guide/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["AI module output (no persisted workspace/project data — context is always {})"],
    notes: "Perilla 8 fix: previously fully unauthenticated, allowing anonymous AI-inference invocation.",
  },
  {
    file: "src/app/api/ai/meetings/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["AI module output (context is always {})"],
    notes: "Perilla 8 fix: same class of gap as .../ai/escalation-guide — see that entry.",
  },
  {
    file: "src/app/api/ai/political-risk/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["AI module output (context is always {})"],
    notes: "Perilla 8 fix: same class of gap as .../ai/escalation-guide — see that entry.",
  },
  {
    file: "src/app/api/ai/project-memory/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["AI module output (context is always {})"],
    notes: "Perilla 8 fix: same class of gap as .../ai/escalation-guide — see that entry.",
  },
  {
    file: "src/app/api/ai/stakeholder-intel/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["AI module output (context is always {})"],
    notes: "Perilla 8 fix: same class of gap as .../ai/escalation-guide — see that entry.",
  },
  {
    file: "src/app/api/ai/pmfreak-brain/route.ts",
    kind: "api-route",
    classification: "auth-only",
    requiredGuard: "requireAuthUser",
    dataAccess: ["forwards to /api/ai/meta-intelligence, /api/copilot, /api/ai/message-nudges"],
    notes: "Perilla 8 fix: added a local auth check as defense-in-depth on top of the downstream routes it forwards to.",
  },
  {
    file: "src/app/api/intelligence/execution-risk/route.ts",
    kind: "api-route",
    classification: "project-scoped",
    requiredGuard: "requireAuthenticatedUser",
    dataAccess: ["execution risk snapshot"],
    notes: "Perilla 8 fix: the no-projectId branch previously had no baseline authentication at all.",
  },
  {
    file: "src/app/api/intelligence/operational-live/route.ts",
    kind: "api-route",
    classification: "project-scoped",
    requiredGuard: "requireAuthenticatedUser",
    dataAccess: ["mock operational intelligence snapshot"],
    notes: "Perilla 8 fix: same class of gap as .../intelligence/execution-risk — see that entry.",
  },

  // ── Upload / evidence ───────────────────────────────────────────────────
  {
    file: "src/app/api/upload/route.ts",
    kind: "api-route",
    classification: "upload-evidence",
    requiredGuard: "getAuthUser",
    dataAccess: ["storage (workspace-scoped path)", "company_usage"],
  },
  {
    file: "src/app/api/project-evidence/route.ts",
    kind: "api-route",
    classification: "upload-evidence",
    requiredGuard: "requireProjectAccess",
    dataAccess: ["project evidence records", "storage"],
  },
  {
    file: "src/app/api/project-evidence-content/route.ts",
    kind: "api-route",
    classification: "upload-evidence",
    requiredGuard: "requireProjectAccess",
    dataAccess: ["project evidence content"],
  },

  // ── Invite acceptance ───────────────────────────────────────────────────
  {
    file: "src/app/api/early-access/accept/route.ts",
    kind: "api-route",
    classification: "invite-acceptance",
    requiredGuard: "acceptEarlyAccessInvite",
    dataAccess: ["early_access_invites", "trial_licenses", "workspace_activations"],
  },
  {
    file: "src/app/(protected)/accept-invite/[token]/page.tsx",
    kind: "page",
    classification: "invite-acceptance",
    requiredGuard: "acceptWorkspaceInvite",
    dataAccess: ["workspace_invitations", "workspace_memberships"],
  },
  {
    file: "src/app/(protected)/team/actions.ts",
    kind: "server-action",
    classification: "workspace-scoped",
    requiredGuard: "requireWorkspaceRole",
    dataAccess: ["workspace_invitations (via inviteWorkspaceMember)"],
  },
] as const;

/**
 * Public routes: no auth guard is expected, and any of these must never
 * read a sensitive table or use a service-role/privileged Supabase client
 * without that being explicitly justified below (test-enforced).
 */
export type PublicRouteEntry = {
  readonly file: string;
  readonly reason: string;
  readonly usesServiceRole: boolean;
  readonly serviceRoleJustification?: string;
};

export const PUBLIC_ROUTE_ALLOWLIST: readonly PublicRouteEntry[] = [
  { file: "src/app/api/build-info/route.ts", reason: "Deploy-verification: commit SHA/branch/env only, no secrets or user data.", usesServiceRole: false },
  { file: "src/app/api/health/route.ts", reason: "Conventional health-check surface: status/version/adapter names only.", usesServiceRole: false },
  { file: "src/app/api/ready/route.ts", reason: "Readiness probe (Perilla 11): pass/fail per dependency check and missing env NAMES only — no values, no secrets, no tenant data.", usesServiceRole: false },
  { file: "src/app/api/route-debug/route.ts", reason: "Deploy-verification: commit/branch/env and static redirect targets only.", usesServiceRole: false },
  { file: "src/app/api/login/route.ts", reason: "Auth entry point; validates redirect target via isSafeContinuationRoute.", usesServiceRole: false },
  {
    file: "src/app/api/governance/trust/.well-known/capability-issuer/route.ts",
    reason: "Federation discovery document (OIDC-discovery-style). External verifiers need this without a PMFreak session.",
    usesServiceRole: true,
    serviceRoleJustification: "Only returns domainKey/issuerApp/status/verificationMode/activeKeyIds/rotatedKeyIds — no secret key material.",
  },
  {
    file: "src/app/api/governance/trust/keys/route.ts",
    reason: "Public-key discovery for external verifiers, analogous to a JWKS endpoint.",
    usesServiceRole: true,
    serviceRoleJustification: "Filters to algorithm === \"Ed25519\" before returning publicJwk/publicPem; HMAC symmetric key material is never exposed.",
  },
  {
    file: "src/app/api/governance/trust/handshakes/request/route.ts",
    reason:
      "External verifier requests a handshake (self-registration step, analogous to requesting an API key). Only inserts a " +
      'status:"requested" row — no standing authority granted until an internal founder approves it. The route file itself ' +
      "calls only requestTrustHandshake(); the privileged client is created inside that lib function " +
      "(src/lib/security/trust-handshakes.ts, already registered in privileged-access-registry.ts), not directly in the route.",
    usesServiceRole: false,
  },
  {
    file: "src/app/api/governance/trust/events/import/route.ts",
    reason: "Machine-to-machine trust-event sync, not a user session. Authenticated via a signed handshake token + cryptographic event-signature verification instead.",
    usesServiceRole: true,
    serviceRoleJustification: "consumeOrAssertHandshake + verifyTrustEvent both run before the privileged insert.",
  },
  {
    file: "src/app/api/governance/capabilities/verify/route.ts",
    reason: "External capability-claim/signature verifier — external verifiers need to validate claims without a PMFreak session, analogous to a public token-introspection endpoint.",
    usesServiceRole: false,
  },
] as const;
