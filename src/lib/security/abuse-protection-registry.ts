/**
 * Abuse protection registry — Perilla 9 (Invite / Signup / Billing Abuse
 * Protection Hardening).
 *
 * Declarative inventory of PMFreak's public, semi-public, and authenticated
 * cost/state/token surfaces and the abuse policy each one uses. This is the
 * abuse-protection counterpart to src/lib/security/route-guard-registry.ts
 * (Perilla 8) — that registry answers "is this route authorized correctly";
 * this one answers "can this authorized route still be spammed, brute-forced,
 * replayed, or used to run up cost."
 *
 * `enforced: true` entries call `enforceAbuseLimit` (or an equivalent
 * cooldown/idempotency check) directly in the listed file — grep for
 * `enforceAbuseLimit(` there to see the exact call.
 *
 * `enforced: false` entries are documented residuals: routes considered
 * low-risk (public read-only discovery data, or already protected by a
 * narrower control such as a signed handshake token) where adding a rate
 * limit was judged unnecessary for this perilla. Each has a `residualNote`
 * explaining why.
 *
 * Enforced by tests/abuse-protection-boundary.test.mjs.
 * See docs/security/abuse-protection-boundary.md.
 */

export type AbuseClassification =
  | "public-state-creating"
  | "public-auth-attempt"
  | "public-read-low-risk"
  | "public-machine-to-machine"
  | "auth-only-cost"
  | "founder-internal-cost"
  | "billing-cost"
  | "project-scoped-ai-cost"
  | "upload-evidence-cost"
  | "webhook-invalid-attempt";

export type AbuseRegistryEntry = {
  readonly id: string;
  readonly file: string;
  readonly classification: AbuseClassification;
  readonly requiredProtection: string;
  readonly windowSeconds: number;
  readonly maxAttempts: number;
  readonly enforced: boolean;
  readonly residualNote?: string;
};

export const ABUSE_PROTECTION_REGISTRY: readonly AbuseRegistryEntry[] = [
  // ── Signup / auth ──────────────────────────────────────────────────────
  {
    id: "signup.create_account",
    file: "src/app/signup/actions.ts",
    classification: "public-state-creating",
    requiredProtection: "per-ip+email rate limit",
    windowSeconds: 3600,
    maxAttempts: 8,
    enforced: true,
  },
  {
    id: "auth.login_attempt",
    file: "src/app/login/actions.ts",
    classification: "public-auth-attempt",
    requiredProtection: "per-ip+email rate limit (defense-in-depth on top of Supabase Auth's own throttling)",
    windowSeconds: 900,
    maxAttempts: 10,
    enforced: true,
  },

  // ── Workspace invites ─────────────────────────────────────────────────
  {
    id: "workspace.invite_create",
    file: "src/app/(protected)/team/actions.ts",
    classification: "auth-only-cost",
    requiredProtection: "per-actor rate limit + per-workspace+email cooldown (rejects re-invite spam of the same address)",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },
  {
    id: "workspace.invite_accept",
    file: "src/app/(protected)/accept-invite/[token]/page.tsx",
    classification: "public-state-creating",
    requiredProtection: "per-ip rate limit + per-token attempt limit (token itself is hashed before use as the rate-limit identifier)",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },

  // ── Early access invites / trials ────────────────────────────────────
  {
    id: "early_access.invite_create",
    file: "src/app/api/early-access/invites/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-actor rate limit",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
  // ── Founder Circle Program (Sprint 01) ─────────────────────────────────
  {
    id: "founder_program.invitation_view",
    file: "src/app/api/founder-program/invitation/[token]/route.ts",
    classification: "public-state-creating",
    requiredProtection: "per-ip+token rate limit (enumeration/brute-force resistance on top of 192-bit tokens; auth still required)",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
  {
    id: "founder_program.application_submit",
    file: "src/app/api/founder-program/application/route.ts",
    classification: "auth-only-cost",
    requiredProtection: "per-user rate limit (one application per invitation is enforced by unique constraints; the limit bounds retry spam)",
    windowSeconds: 3600,
    maxAttempts: 5,
    enforced: true,
  },
  {
    id: "founder_program.application_withdraw",
    file: "src/app/api/founder-program/application/withdraw/route.ts",
    classification: "auth-only-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 5,
    enforced: true,
  },
  {
    id: "founder_program.feedback_submit",
    file: "src/app/api/founder-program/feedback/route.ts",
    classification: "auth-only-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },
  {
    id: "founder_program.operator_invitation",
    file: "src/app/api/founder-program/operator/invitations/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-operator+action rate limit (create/create_batch/revoke/resend; batches additionally capped by DB-configured max_invitations_per_batch)",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
  {
    id: "founder_program.operator_participant_action",
    file: "src/app/api/founder-program/operator/participants/actions/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-operator+action rate limit (review/activate/pause/resume/revoke/complete)",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "founder_program.operator_feedback_triage",
    file: "src/app/api/founder-program/operator/feedback/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-operator rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "founder_program.operator_discovery_record",
    file: "src/app/api/founder-program/operator/discovery-sessions/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-operator rate limit",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
  {
    id: "founder_program.operator_decision_record",
    file: "src/app/api/founder-program/operator/decisions/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-operator rate limit (decision records are append-only)",
    windowSeconds: 3600,
    maxAttempts: 10,
    enforced: true,
  },
  {
    id: "early_access.founder_action",
    file: "src/app/api/early-access/founder-actions/route.ts",
    classification: "founder-internal-cost",
    requiredProtection: "per-actor+action rate limit (covers approve/revoke/resend/extend for both invites and trials)",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
  {
    id: "early_access.accept",
    file: "src/app/api/early-access/accept/route.ts",
    classification: "public-state-creating",
    requiredProtection: "per-ip rate limit + per-token attempt limit",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },

  // ── Billing checkout / portal ────────────────────────────────────────
  {
    id: "billing.create_checkout_session",
    file: "src/app/api/billing/create-checkout-session/route.ts",
    classification: "billing-cost",
    requiredProtection: "per-user+workspace cooldown",
    windowSeconds: 60,
    maxAttempts: 5,
    enforced: true,
  },
  {
    id: "billing.create_portal_session",
    file: "src/app/api/billing/create-portal-session/route.ts",
    classification: "billing-cost",
    requiredProtection: "per-user+workspace cooldown",
    windowSeconds: 60,
    maxAttempts: 5,
    enforced: true,
  },

  // ── Trust handshake / federation ─────────────────────────────────────
  {
    id: "governance.trust.handshake_request",
    file: "src/app/api/governance/trust/handshakes/request/route.ts",
    classification: "public-state-creating",
    requiredProtection: "per-ip+issuer rate limit",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },
  {
    id: "governance.trust.well_known_discovery",
    file: "src/app/api/governance/trust/.well-known/capability-issuer/route.ts",
    classification: "public-read-low-risk",
    requiredProtection: "none enforced — read-only discovery document (issuer/status/key ids only, no secret material)",
    windowSeconds: 3600,
    maxAttempts: 1200,
    enforced: false,
    residualNote: "External verifiers must be able to fetch this without a PMFreak session; content is non-sensitive and cheap to serve. No rate limit wired for this perilla.",
  },
  {
    id: "governance.trust.keys_discovery",
    file: "src/app/api/governance/trust/keys/route.ts",
    classification: "public-read-low-risk",
    requiredProtection: "none enforced — public-key (JWKS-style) discovery",
    windowSeconds: 3600,
    maxAttempts: 1200,
    enforced: false,
    residualNote: "Analogous to a JWKS endpoint; cheap, non-sensitive, expected to be polled by external verifiers. No rate limit wired for this perilla.",
  },
  {
    id: "governance.capabilities.verify",
    file: "src/app/api/governance/capabilities/verify/route.ts",
    classification: "public-read-low-risk",
    requiredProtection: "none enforced — bounded local signature verification",
    windowSeconds: 3600,
    maxAttempts: 1200,
    enforced: false,
    residualNote: "Signature verification is bounded local compute (no external calls, no DB writes). Acceptable residual for this perilla; revisit if abuse is observed.",
  },
  {
    id: "governance.trust.events_import",
    file: "src/app/api/governance/trust/events/import/route.ts",
    classification: "public-machine-to-machine",
    requiredProtection: "none additionally enforced — already gated by consumeOrAssertHandshake (signed handshake token) + verifyTrustEvent (cryptographic signature) before any write",
    windowSeconds: 3600,
    maxAttempts: 1200,
    enforced: false,
    residualNote:
      "A caller must already hold a valid, individually-issued handshake token (itself rate-limited at issuance via governance.trust.handshake_request) and a correctly-signed event — brute-forcing this route means brute-forcing a signature, not a request-flood problem. No additional rate limit wired for this perilla.",
  },
  {
    id: "federation.webhook_invalid_attempt",
    file: "src/app/api/federation/webhooks/[connectorId]/route.ts",
    classification: "webhook-invalid-attempt",
    requiredProtection: "per-ip+connector rate limit, applied only to requests that fail FEDERATION_WEBHOOK_SECRET verification",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },

  // ── Upload / evidence ─────────────────────────────────────────────────
  {
    id: "upload.document",
    file: "src/app/api/upload/route.ts",
    classification: "upload-evidence-cost",
    requiredProtection: "per-user+project rate limit (defense-in-depth on top of the existing plan-based reserveUploadQuota check)",
    windowSeconds: 3600,
    maxAttempts: 20,
    enforced: true,
  },
  {
    id: "project_evidence.read",
    file: "src/app/api/project-evidence/route.ts",
    classification: "upload-evidence-cost",
    requiredProtection: "per-user+project rate limit",
    windowSeconds: 3600,
    maxAttempts: 300,
    enforced: true,
  },
  {
    id: "project_evidence.delete",
    file: "src/app/api/project-evidence/route.ts",
    classification: "upload-evidence-cost",
    requiredProtection: "per-user+project rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "project_evidence_content.read",
    file: "src/app/api/project-evidence-content/route.ts",
    classification: "upload-evidence-cost",
    requiredProtection: "per-user+project rate limit",
    windowSeconds: 3600,
    maxAttempts: 300,
    enforced: true,
  },

  // ── AI expensive routes ───────────────────────────────────────────────
  {
    id: "ai.suggestions",
    file: "src/app/api/ai/suggestions/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-ip+project rate limit",
    windowSeconds: 3600,
    maxAttempts: 120,
    enforced: true,
  },
  {
    id: "ai.project_state",
    file: "src/app/api/ai/project-state/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-ip+project rate limit",
    windowSeconds: 3600,
    maxAttempts: 120,
    enforced: true,
  },
  {
    id: "ai.module_output.escalation_guide",
    file: "src/app/api/ai/escalation-guide/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.module_output.meetings",
    file: "src/app/api/ai/meetings/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.module_output.political_risk",
    file: "src/app/api/ai/political-risk/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.module_output.project_memory",
    file: "src/app/api/ai/project-memory/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.module_output.stakeholder_intel",
    file: "src/app/api/ai/stakeholder-intel/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.module_output.message_nudges",
    file: "src/app/api/ai/message-nudges/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    // PB-CHAT-01: interactive Project Brain turns. Generous per-user ceiling for
    // conversation; runInference additionally enforces the per-workspace daily
    // request/cost ceilings and concurrency bound.
    id: "ai.module_output.project_brain_turn",
    file: "src/app/api/projects/[id]/brain/turns/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 120,
    enforced: true,
  },
  {
    id: "ai.module_output.meta_intelligence",
    file: "src/app/api/ai/meta-intelligence/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit",
    windowSeconds: 3600,
    maxAttempts: 60,
    enforced: true,
  },
  {
    id: "ai.pmfreak_brain",
    file: "src/app/api/ai/pmfreak-brain/route.ts",
    classification: "project-scoped-ai-cost",
    requiredProtection: "per-user rate limit (fans out to 3 downstream AI calls per request, so limited lower than a single-module route)",
    windowSeconds: 3600,
    maxAttempts: 30,
    enforced: true,
  },
] as const;
