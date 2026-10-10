# PMFreak — logo repetition cleanup (review captures)

Uses the dual-face mascot more selectively on the public pages. Targeted refinement of
the Phase 1 design (`../pmfreak-phase-1-review/`), not a redesign.

| Page | Change |
|---|---|
| Login (and the other auth pages sharing `AuthShell`) | Corner logo lockup removed. The large face now sits beside a large PMFreak wordmark, with "Same brain. Just more clarity." under it; the pair is the link home. On phones the brand band shows that same pairing, centered, as the page's one mark. |
| Homepage hero | Round mascot beside "Same brain. Just more clarity." replaced with the brain illustration from the earlier login design (`public/Brain-Transparente.png`). |
| Pricing hero | Right-side mascot removed; heading, subtitle and the "paid plans aren't available yet" note are centered. |

## Captures

`before/` = main at `aefe8d0b`; `after/` = branch `feat/public-pages-logo-cleanup`.
Desktop 1440×900, tablet 820×1180, mobile 390×844, full page, Next.js dev badge hidden,
billing release control OFF (as in production). `after/login-laptop` is 1024×768, the
tightest width for the face + wordmark pairing.

Homepage captures scroll the page first so lazy images load as for a real visitor.
Outside the hero, the homepage is pixel-identical to `before/` (the navbar icon differs by
image resampling only).
