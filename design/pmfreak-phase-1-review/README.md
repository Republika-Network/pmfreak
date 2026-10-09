# PMFreak Phase 1 — public pages review captures

Before/after screenshots of the public routes moved onto the approved 2026 homepage
system (orange/teal palette, Outfit display type, dual-face mascot). For visual review
of branch `feat/design-system-public-pages`; not used by the app.

## How they were captured

- Real running app (`next dev`, local `.env.local`), headless Chromium via Playwright, full-page.
- Viewports: **desktop** 1440×900, **tablet** 820×1180, **mobile** 390×844.
- Stored as WebP (quality 0.9), matching `../pmfreak-art-direction-pack/renders/`.
- `before/` is `main` at `0359dffa` (PR #634). Its `home-*` files hide the Next.js dev
  badge; the other `before/` files still show it in the lower-left corner.
- `after/` hides the dev badge.

## Files

`<route>-<viewport>.webp`, where `<route>` is:

| Name | URL | Notes |
|---|---|---|
| `home` | `/` | Approved homepage. Only two approved changes: CTA wording ("Get started free", the final-CTA line, navbar "Sign in" / "Get started") and, at 820, the navbar menu button instead of wrapped links. Verified by swapping the old strings back in the DOM: 0 differing pixels against the pre-change render at 1440, 1024, 820 and 390. |
| `pricing` | `/pricing` | |
| `login`, `login-error`, `login-success` | `/login`, `?error=…`, `?success=…` | |
| `login-checkout` | `/login?next=%2Fbilling` | New state: signed-out plan choice. No `before/`. |
| `signup`, `signup-error` | `/signup`, `?error=…` | |
| `signup-checkout` | `/signup?next=%2Fbilling` | New state. No `before/`. |
| `confirm-email` | `/signup/confirm-email?email=…` | |
| `forgot-password`, `reset-password` | `/forgot-password`, `/auth/reset-password` | |

Extra `after/` states: `login-focus-desktop` (keyboard focus on the email field),
`reset-password-mismatch-desktop` (client validation error), `pricing-tablet-menu-open`
(the navbar menu at 820px, opened with the keyboard).
