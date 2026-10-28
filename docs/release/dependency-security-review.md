# Dependency Security Review — Perillas 11–12 (Beta Release Closure Gate)

Reviewed: 2026-07-10 (Perilla 11 baseline + remediation); updated 2026-07-11
(Perilla 12: RR-XLSX closure). Tooling: `npm audit --json` on a clean
`npm ci` install (Node v22.22.2 / npm 10.9.7). Re-runnable at any time via
`npm run check:dependency-security` (advisory gate inside
`npm run check:beta-release`; exit 0 = clean, 2 = only accepted findings,
1 = unexpected critical/high — and, since Perilla 12, hard failure if the
forbidden `xlsx` package reappears in the tree at any version).

## DEP-01 update (2026-10-26) — Next.js and transitive criticals/highs

Before: `npm audit` → 2 critical, 5 high, 3 moderate. After: **0 critical,
0 high, 3 moderate** (`check:dependency-security`: 3 accepted/below-threshold,
0 unexpected). Patched versions per the GitHub Advisory Database.

| Package | Before → after | Change | Advisories resolved |
|---|---|---|---|
| `next` (+ `@next/*`, `eslint-config-next`) | 16.3.2 → **16.4.3** | direct, exact pin | GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4, GHSA-vcvr-r3jv-pc5j, GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr (critical); GHSA-cjq9-62q9-8jv4, GHSA-p3m5-59mp-jv5r (high); GHSA-3w37-wq28-93x7, GHSA-4jqv-mc3x-m676, GHSA-f87g-xv8r-7p7x, GHSA-mcj8-r9mp-w47p, GHSA-h694-7cp9-m8p3 (moderate); GHSA-39w2-rjm5-chcv (low). Minimum fix 16.4.1. |
| `sharp` (via `next`) | 0.35.3 → 0.35.5 | transitive | GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w (high) |
| `dompurify` (via `jspdf ^3.3.1`) | 3.4.14 → 3.4.17 | lockfile only | GHSA-cg2g-xh64-v4q7 (critical), GHSA-mrv2-3pqr-j5jr (high), GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2, GHSA-c6gr-qvv4-5v3f (low). Not reached at runtime: the only `jspdf` use never calls `.html()`. |
| `zod` (dev, via `eslint-plugin-react-hooks`) | 4.4.3 → 4.6.7 | lockfile only | GHSA-mrhx-c7xc-m3w5 (high) |
| `brace-expansion` | 1.1.18 / 2.1.4 / 5.0.9 → 1.1.21 / 2.1.7 / 5.0.12 | lockfile only | GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p (high), GHSA-q2hr-2g5m-vwhr (moderate) |
| `js-yaml` (dev) | 3.15.1 / 4.3.1 → 3.15.2 / 4.3.2 | lockfile only | GHSA-2883-xcg3-v3hh (high) |
| `source-map-js` | 1.2.1 → 1.2.2 | lockfile only | GHSA-68fv-2mgg-jv7q (high) |

Still open (moderate, unchanged): `uuid`/`exceljs` (accepted, unreachable;
see below) and `qs` 6.15.3 via `stripe` (GHSA-x5fp-wj9c-mxmx,
GHSA-4mjr-xmp4-gh2g; lockfile-only fix to 6.16.0 available, below the
blocking threshold — billing routes are disabled in the closed beta).

## Perilla 12 update — RR-XLSX closed

The accepted-with-condition `xlsx` high below is **resolved by removal**:
`xlsx@0.18.5` was uninstalled and replaced with `exceljs@4.4.0` behind
`src/lib/spreadsheets/` (decision matrix and provenance:
[`xlsx-replacement-decision.md`](./xlsx-replacement-decision.md); boundary
controls: [`../security/spreadsheet-processing-boundary.md`](../security/spreadsheet-processing-boundary.md)).

* `npm ls xlsx` → `(empty)`; `npm audit` → **0 critical, 0 high**.
* Remaining accepted findings: `postcss`/`next` moderates (RR-POSTCSS,
  unchanged) and one new moderate — `uuid` <11.1.1 transitive via exceljs
  (GHSA-w5hq-g745-h8pq, missing buffer bounds check in `v3/v5/v6` when a
  caller supplies `buf`). Classification: **not reachable** — exceljs's
  only uuid call is `uuid.v4()` with no arguments
  (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`); re-verify on every
  exceljs upgrade.
* The `check:dependency-security` allowlist entry for `xlsx` was removed
  and replaced by a `FORBIDDEN_PACKAGES` check that fails the gate if the
  package ever returns; `tests/spreadsheet-dependency-boundary.test.mjs`
  enforces the same at the manifest/lockfile/import level.
* Residual spreadsheet risks and their controls (untrusted parsing, formula
  injection on export, resource exhaustion) are handled at the spreadsheet
  boundary — limits, macro/external-link/OLE rejection, zip-bomb cap,
  pollution canary (retained from Perilla 11 as defense-in-depth), parse
  deadline, sanitized errors.

Everything below this line is the Perilla 11 record, kept for traceability.

## Baseline (before remediation)

`npm audit` reported **9 vulnerabilities: 3 high, 5 moderate, 1 low.**

| Package | Severity | Direct/Transitive | Runtime/Dev | Reachable | Fix Available | Action |
| ------- | -------: | ----------------- | ----------- | --------- | ------------- | ------ |
| next | high | direct | runtime | **yes** — DoS w/ Server Components, middleware/proxy bypass via segment-prefetch routes, SSRF via WebSocket upgrades | 16.2.10 (in-range) | **fixed** — upgraded `next` + `eslint-config-next` to 16.2.10 |
| ws | high | transitive (`@supabase/realtime-js`) | runtime | potentially (websocket handling) | yes | **fixed** via `npm audit fix` |
| xlsx | high | direct | runtime | **yes** — parses untrusted uploaded workbooks (`src/lib/project-evidence/evidence-processor.ts`) | **no npm fix** (SheetJS ships ≥0.19.3/0.20.2 only via cdn.sheetjs.com; that host is unreachable from this build environment) | **mitigated + accepted with condition** — see below |
| dompurify | moderate | transitive (`jspdf`) | runtime (client PDF export) | potentially | yes | **fixed** via `npm audit fix` |
| js-yaml | moderate | transitive (changesets/eslint) | dev-only | no (build tooling) | yes | **fixed** via `npm audit fix` |
| brace-expansion | moderate | transitive (eslint/minimatch) | dev-only | no | yes | **fixed** via `npm audit fix` |
| qs | moderate | transitive (`stripe`) | runtime | potentially (stringify DoS) | yes | **fixed** via `npm audit fix` |
| postcss | moderate | transitive (bundled by `next`) | build-time | no (stringifies our own trusted CSS, never user input) | only in next canary; npm suggests a *downgrade* to next 9 (rejected) | **accepted** — RR-POSTCSS |
| @babel/core | low | transitive | dev-only | no | yes | **fixed** via `npm audit fix` |

## Result (after remediation)

`npm audit`: **3 findings — 1 high (xlsx), 2 moderate (postcss + next flagged
through its bundled postcss). 0 critical. 0 unexpected.** All three are
classified and accepted below; `check:dependency-security` exits 2
(CONDITIONAL).

### RR-XLSX — xlsx@0.18.5 (high, accepted with condition)

* Advisories: prototype pollution (GHSA-4r6h-8v6p-xvw6), ReDoS
  (GHSA-5pgg-2g8v-p4x9).
* Classification: **exploitable in principle** — the evidence-upload path
  parses untrusted workbooks server-side.
* Why not upgraded here: SheetJS stopped publishing to npm at 0.18.5; fixed
  builds are distributed only from `https://cdn.sheetjs.com`, which this
  build environment's egress policy blocks (verified: npm install of
  `xlsx-0.20.3.tgz` → 403 from proxy).
* Mitigations shipped in this perilla (defense-in-depth, not a substitute):
  * The parse now runs inside a **prototype-pollution canary**
    (`src/lib/security/prototype-pollution-guard.ts`): any parse that adds
    properties to `Object.prototype`/`Array.prototype` is rejected and the
    runtime is restored — a crafted workbook fails its own upload instead of
    poisoning the process. Tests: `tests/prototype-pollution-guard.test.mjs`.
  * Pre-existing bounds on the same path: authenticated + workspace-scoped
    access, upload size caps (`UPLOAD_MAX_FILE_SIZE_BYTES` etc.), and abuse
    rate limits (Perilla 9). ReDoS blast radius is one bounded serverless
    invocation.
* **Condition for the pilot** (residual-risk-register RR-XLSX): install the
  official SheetJS build (`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`)
  from an unrestricted network, re-run `npm run check:beta-release`, and drop
  the allowlist entry in `scripts/check-dependency-security.mjs`.

### RR-POSTCSS — postcss bundled by next (moderate, accepted)

* Advisory: XSS via unescaped `</style>` in CSS *stringify* output.
* Classification: **not reachable** — postcss runs at build time over the
  repo's own CSS; no user-controlled CSS is ever stringified.
* No stable `next` release carries the patched postcss yet (the only npm
  "fix" is a downgrade to next 9.3.3, which is nonsensical). Re-check on each
  next patch release; drop the allowlist entry when a stable fix lands.

## Supply-chain controls (B.4)

* `package-lock.json` v3, integrity hashes intact; `npm ci` reproducible from
  clean state (verified twice during this gate).
* No git/URL dependencies; the only non-registry deps are the two
  **intentional** local AOC packages (`file:src/aoc/protocol`,
  `file:src/aoc/enterprise`) — their integrity is enforced by
  `npm run check:publish-integrity` (build reproducibility + package purity +
  tarball purity), which **passed**.
* `npm run check:package-purity`, `check:forbidden-imports`,
  `check:package-exports` — **passed** (see gate results).
* No install scripts from untrusted packages surfaced during `npm ci`; no
  secrets in `.npmrc`/npm configuration (none present in repo).
* Versions pinned exactly for the framework (`next`, `react`,
  `eslint-config-next`); remaining deps use caret ranges guarded by the
  lockfile.
