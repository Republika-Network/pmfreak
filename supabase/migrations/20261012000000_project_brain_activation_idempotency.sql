-- Project Brain activation idempotency.
--
-- saveProjectOnboarding (src/lib/projects/save-project-onboarding.ts) now
-- records the wizard's activation key in projects.onboarding_payload under
-- `brainActivation.requestId` (src/lib/projects/brain-activation-state.ts) and,
-- before creating a project, resumes the project an earlier attempt of the same
-- activation created. That lookup alone handles sequential retries; this index
-- makes "one project per user per activation" hold under concurrent attempts
-- too: the second insert fails with 23505 and the action resumes the winner's
-- project instead of creating a duplicate.
--
-- Partial: rows without an activation key (every project created before this
-- change, and projects created by other paths) are not constrained.
--
-- Additive only: no column, data, RLS, policy or function change. The
-- application tolerates this index being absent (it is a backstop, not a
-- dependency), so it can be applied before or after the code deploys.

create unique index if not exists projects_brain_activation_request_uidx
  on public.projects (user_id, ((onboarding_payload -> 'brainActivation' ->> 'requestId')))
  where (onboarding_payload -> 'brainActivation' ->> 'requestId') is not null;
