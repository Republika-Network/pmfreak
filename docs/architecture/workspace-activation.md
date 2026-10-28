# Guided Workspace Onboarding — Activation Architecture

Date: 2026-07-21
Follows: `docs/architecture/zero-state-ux-refactor-audit.md` (Zero State UX sprint)

## Product rule

The onboarding is not an isolated tutorial. It is a real representation of the
workspace's operational state. **Every step derives from evidence in the
database.** There is no manual "mark as complete" path and no
`onboardingComplete` source-of-truth flag. Dismissing the guide hides it —
it never claims the workspace is configured.

## Architecture

```
src/lib/workspace-activation/
  types.ts                            — stages, step ids, evidence, result, preference types
  activation-rules.ts                 — PURE rules: evidence → steps/stage/result (no I/O)
  evaluate-workspace-activation.ts    — evidence collection (RLS-scoped presence probes)
  onboarding-preferences.ts           — per-user display preferences (validation + persistence)
  index.ts

src/app/api/workspace-activation/route.ts   — GET activation state · PATCH display preferences
src/components/pmfreak/onboarding/
  workspace-onboarding-panel.tsx      — client panel (SWR, collapse/dismiss/skip, ready state)
  workspace-onboarding-copy.ts        — ALL user-facing copy (domain returns ids only)
  mark-insights-viewed.tsx            — first-view interaction beacon (populated surfaces only)
src/app/(protected)/workspace-setup/page.tsx — persistent reopen surface (nav: Workspace Setup)

supabase/migrations/20260829000000_workspace_onboarding_preferences.sql
```

Separation of concerns: **evaluation** (pure rules) / **evidence** (queries)
/ **presentation** (copy + panel) / **navigation** (routes on steps) /
**permissions** (real membership role → `actionAllowed` per step).

## Derived vs persisted state

- **Derived (never stored):** step completion, stage, counts, readiness.
  Recomputed from real rows on every GET.
- **Persisted (display only):** `workspace_onboarding_preferences` —
  `collapsed`, `dismissed_at`, `skipped_step_ids` (non-essential ids only,
  validated against a closed set), `onboarding_version`,
  `insights_first_viewed_at` (the one sanctioned interaction event). Unique
  per `(workspace_id, user_id)`, RLS: own row + workspace membership.

## Activation stages

```
workspace_created → project_created → execution_started → signals_available → insights_available
```

- `execution_started` (= *operationally started*, the minimal activation
  path): workspace + ≥1 non-archived project + ≥1 real `execution_tasks` row.
- `signals_available`: any real `raid_items` / `governance_signals` /
  `recommended_actions` row exists.
- `insights_available`: a real `recommended_actions` row exists (a reviewable
  executive insight).

`workspaceReady` = all applicable **essential** steps completed. First value
moment = `execution_started` ("Execution tracking is active") — it never
waits for AI intelligence.

## Step matrix

| Step | Phase | Required | Evidence (real rows) | CTA route | Min. role for CTA | Blocked by |
|---|---|---|---|---|---|---|
| `workspace_created` | Foundation | essential | workspace + valid membership (evaluation context) | — | — | — |
| `pmo_created` | Foundation | essential (team) / optional (individual) | `pmos` with `status='active'` | `/create-command-center` | admin | — |
| `member_invited` | Foundation | optional; n/a for solo `owner_type='personal'` | 2nd `workspace_memberships` row, or `workspace_invitations` `status='pending'` (shows "pending acceptance" note) | `/team` | admin | — |
| `project_created` | Execution | essential | `projects` with `status != 'archived'` | `/projects/new` | pm | — |
| `task_created` | Execution | essential | `execution_tasks` row | `/command-center` | pm | project |
| `milestone_created` | Execution | optional | `project_milestones` row | `/command-center` | pm | project |
| `raid_registered` | Execution | optional | `raid_items` row | `/command-center` | pm | project |
| `conversation_started` | Execution | recommended | `context_messages` with `role='user'` | `/chat` | viewer | — |
| `execution_signal_generated` | Operational Value | recommended | `raid_items` OR `governance_signals` OR `recommended_actions` | `/input-hub` | pm | project |
| `insights_reviewed` | Operational Value | optional | `recommended_actions` row **and** persisted `insights_first_viewed_at` (set only when a POPULATED executive surface renders) | `/executive` | viewer | signal |

Individual vs team mode is derived from existing concepts only:
`workspaces.owner_type`, real membership count, real pending invitations
(`deriveWorkspaceActivationMode`). No new roles, no new mode flag.

## Security & tenancy

- API requires an authenticated user; `workspaceId` query param is validated
  (UUID) and checked against `workspace_memberships` — non-members get 403.
  Without the param, the canonical preferred-workspace resolution is used.
- Every evidence probe filters `workspace_id` explicitly AND runs on the
  RLS-scoped anon server client (defense in depth). Failed probes read as
  *absent* — evaluation can only under-report, never fabricate.
- Preferences RLS: `user_id = auth.uid() AND is_workspace_member(workspace_id)`
  for select/insert/update; no delete policy. Viewers may write their own
  display preferences; nothing role-restricted is writable here.
- `actionAllowed` per step mirrors the real membership role (viewer never
  sees creation CTAs); server actions/RLS remain the enforcement layer.

## Reactivity

The panel and empty-state consumers use SWR (`refreshInterval` 30s +
revalidate-on-focus/mount). Creation flows navigate (server-action redirect);
on return, server components re-render with fresh data and the panel
revalidates — steps move `blocked → available → completed` without manual
reload. Preference writes `mutate()` immediately.

## Empty-state integration (Zero State UX preserved)

- `EmptyProjects` / `EmptyPortfolio` / `EmptyDashboard` accept `canCreate`;
  a viewer sees "A workspace administrator or project manager must create the
  first project." instead of a dead-end CTA.
- `EmptyExecution` accepts `hasProject`: with a project → "Add task" →
  `/command-center`; without → "Create project" → `/projects/new` (no CTA
  when unknown). All empty states remain calm, data-free invitations.

## Guardrails

`tests/workspace-onboarding-guardrails.test.mjs` pins: no fabrication strings
(from the Zero State audit) in the onboarding surface, deterministic rules
(no randomness/clock completion), no `onboardingComplete` flag, display-only
migration (no progress columns; RLS asserted), membership-checked API,
workspace-scoped probes, textual (non-color-only) progress.

Unit coverage: `tests/workspace-activation-rules.test.ts` (31 scenarios:
modes, blocking, permissions, stages, full/partial workspaces),
`tests/workspace-activation-evidence.test.mjs` (tenancy scoping, honest
exclusions, fail-closed), `tests/workspace-onboarding-preferences.test.mjs`
(skip validation — essential steps unskippable).

## Telemetry

No product-analytics SDK exists in the repo (`FirstUserTelemetryEvent` is the
only, single-purpose beacon). Onboarding events are therefore documented but
NOT mocked. If real analytics lands, instrument:
`workspace_onboarding_viewed`, `workspace_onboarding_step_clicked`,
`workspace_onboarding_step_completed`, `workspace_onboarding_collapsed`,
`workspace_onboarding_dismissed`, `workspace_activation_stage_changed`,
`workspace_first_value_reached` — with workspace id, role, step id,
previous/new stage, timestamp, surface; never project names or message
content.

## Known gaps / pending decisions

- `src/features/enterprise-ux/onboarding/*` is an earlier, manually-completed
  checklist model with **zero consumers**; superseded by this evidence-derived
  system. Candidate for deletion in a cleanup sprint.
- "Add task" CTA lands on `/command-center` (tasks are created by converting
  drafts from the RAID → recommended-action loop). A direct quick-add task
  form is a product decision, not taken here.
- External connector step intentionally omitted: integrations are not
  user-facing yet (`/api/intelligence/operational-live` returns empty).
- `pmo_created` for individual mode is optional; the default PMO created by
  `ensureDefaultPmo` during project creation legitimately completes it (it is
  a real row from the canonical flow, not checklist-driven fabrication).
