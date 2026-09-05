/**
 * Next.js server instrumentation — the in-process closed-free-beta environment guard.
 *
 * `register()` is called ONCE when a new Next.js server instance is initiated and
 * must complete before the server is ready to handle requests, so throwing here
 * prevents the beta surface from ever becoming operational.
 *
 * WHY THIS EXISTS. Until now the closed-free-beta environment contract was enforced
 * only by `npm run start:closed-free-beta`, which runs the preflight before
 * `next start`. Any other way of starting the same application — a bare
 * `next start`, or a platform that boots Next.js itself rather than through that
 * npm script — bypassed the contract entirely. Moving the SAME canonical guard
 * inside the runtime makes enforcement independent of which command launched
 * Next.js. See RR-BETA-PREFLIGHT-BYPASSABLE.
 *
 * NOT THE SOLE STARTUP AUTHORITY — DEFENSE IN DEPTH. Next.js skips
 * `registerInstrumentation()` entirely when `NEXT_PHASE=phase-production-build`, and that
 * variable is externally supplied, so this hook alone could be skipped on a real
 * `next start`. The production-server STARTUP boundary therefore lives in
 * `next.config.ts`, which is handed its `phase` by the framework itself and cannot be
 * spoofed through the environment. This file remains the in-process runtime guard behind
 * it — a second boundary, not the only one.
 *
 * WHAT IT DOES NOT CLAIM. This is a RUNTIME boundary, not a deployment-time one.
 * It proves that a certified Next.js server runtime carrying this hook cannot
 * serve the beta surface under an invalid beta environment. It does NOT claim
 * that a deployment is rejected before deploy, nor that every conceivable
 * topology is covered — only the runtime that loads this file.
 *
 * PROFILE SELECTION FAILS CLOSED. In a certified production server runtime the
 * profile must be explicitly `closed-free-beta`; missing, blank or unknown refuses
 * startup rather than skipping validation. It deliberately does NOT
 * invoke `assertProductionEnvSafety()`: that helper requires Stripe secrets the
 * closed free beta intentionally does not have, so wiring it here would refuse to
 * start the very posture P0-LAUNCH-05 accepted. The full-production runtime guard
 * remains uncertified — see RR-PRODUCTION-ENV-GUARD.
 */
export async function register() {
  // The guard reads server-only configuration and must not run on the edge
  // runtime, where that configuration is not present. Next.js calls `register`
  // in every environment, so the runtime is checked explicitly.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // NO NEXT_PHASE ESCAPE HATCH. A previous revision returned early on
  // NEXT_PHASE=phase-production-build as "belt and braces". That was a mistake: the
  // variable is externally supplied, so a stale or spoofed value on a real `next start`
  // re-opened the very bypass this guard exists to close. Worse, the framework applies
  // that same check to decide whether to call this hook AT ALL — which is precisely why
  // the authoritative startup boundary is `next.config.ts`, where the phase comes from
  // Next.js rather than from the environment. Nothing here may re-introduce an
  // environment-variable authorization path.

  // THE RUNTIME SELECTOR IS NODE_ENV, NOT THE PROFILE. Deciding whether to validate
  // PMFREAK_OPERATING_PROFILE by reading PMFREAK_OPERATING_PROFILE is exactly the
  // bypass this guard exists to close: a missing, blank or misspelled profile used to
  // take the early return and disable the only in-process check. `next start` sets
  // NODE_ENV=production and `next dev` does not, so the certified production server
  // runtime is identified independently of the value under test. Development, test
  // and build behaviour are deliberately unchanged.
  if (process.env.NODE_ENV !== "production") return;

  // Imported dynamically so the edge bundle never pulls in server-only code.
  const { assertClosedFreeBetaEnvSafety, CLOSED_FREE_BETA_PROFILE } = await import("@/lib/security/environment");

  // FAIL CLOSED ON PROFILE SELECTION. The repository defines exactly one recognized
  // operating profile; no other is invented here. A certified production server must
  // declare it explicitly, so missing / blank / unknown all refuse startup rather than
  // silently becoming an unvalidated production mode. `evaluateClosedFreeBetaEnvSafety`
  // already classifies this state as `beta_profile_not_selected`; previously the hook
  // returned before ever asking it.
  if (process.env.PMFREAK_OPERATING_PROFILE !== CLOSED_FREE_BETA_PROFILE) {
    // Names the VARIABLE and a stable code. The offending value is never echoed —
    // a misspelled profile can carry anything, including pasted secret material.
    const failure: Error & { guard?: string; code?: string } = new Error(
      `PMFreak refused to start: PMFREAK_OPERATING_PROFILE must be explicitly set to ` +
        `"${CLOSED_FREE_BETA_PROFILE}" for a certified production server runtime. ` +
        `[beta_profile_not_selected]`,
    );
    failure.guard = "instrumentationProfileSelection";
    failure.code = "beta_profile_not_selected";
    throw failure;
  }

  // Deliberately NOT wrapped: an invalid beta environment must fail closed and
  // stop the server from becoming ready. The thrown message names offending
  // VARIABLES only — never their values.
  assertClosedFreeBetaEnvSafety();
}
