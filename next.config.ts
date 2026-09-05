import type { NextConfig } from "next";
import { PHASE_PRODUCTION_SERVER } from "next/constants";
import { assertClosedFreeBetaEnvSafety, getRuntimeEnvironment } from "./src/lib/security/environment";
import { getSecurityHeaders } from "./src/lib/security/security-headers";

// Dev/Codespaces-only Server Action origins. Trusting these in production
// would let a request claiming to come from localhost or a stale *.github.dev
// preview pass Next's Server Action origin check — see
// docs/security/production-deployment-boundary.md.
const DEV_ONLY_SERVER_ACTION_ORIGINS = ["localhost:3000", "127.0.0.1:3000", "*.app.github.dev", "*.github.dev"];
const STATIC_SERVER_ACTION_ORIGINS = ["pmfreak-mu.vercel.app"];

const runtimeEnvironment = getRuntimeEnvironment();

const nextConfig: NextConfig = {
  // Next defaults this to false; pinned explicitly so a future change can't
  // silently start publishing source maps in production without review.
  productionBrowserSourceMaps: false,
  experimental: {
    serverActions: {
      allowedOrigins: runtimeEnvironment === "production" ? STATIC_SERVER_ACTION_ORIGINS : [...STATIC_SERVER_ACTION_ORIGINS, ...DEV_ONLY_SERVER_ACTION_ORIGINS],
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(getSecurityHeaders({ environment: runtimeEnvironment })).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

/**
 * PRODUCTION-SERVER STARTUP BOUNDARY.
 *
 * `src/instrumentation.ts` cannot be the sole startup authority: Next.js skips
 * `registerInstrumentation()` entirely when `process.env.NEXT_PHASE` is
 * `phase-production-build` (see next/dist/server/lib/router-utils/
 * instrumentation-globals.external.js), and that variable is externally supplied. A
 * stale or spoofed value on a real `next start` therefore meant the in-process guard was
 * never invoked at all — no code inside the instrumentation file could close that class.
 *
 * The config function is the right surface because NEXT.JS ITSELF SUPPLIES `phase`. It is
 * an argument from the framework, not an environment variable a deployment can set, so a
 * spoofed `NEXT_PHASE` cannot make a running production server look like a build. This
 * code deliberately never reads `process.env.NEXT_PHASE`.
 *
 * Only the export boundary changes; `nextConfig` and every configuration semantic above
 * are returned unmodified for every phase, so builds, dev and tooling are unaffected.
 * The canonical `assertClosedFreeBetaEnvSafety` is reused rather than re-implemented, so
 * there is no second list of required beta variables and no duplicated profile text —
 * missing, blank, unknown and misspelled profiles all surface its
 * `beta_profile_not_selected` diagnostic. `assertProductionEnvSafety()` is deliberately
 * NOT called: it remains outside the closed-beta boundary (RR-PRODUCTION-ENV-GUARD).
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) {
    // Fails closed: a certified production server must not become operational with an
    // unrecognized operating profile or an invalid closed-beta environment.
    assertClosedFreeBetaEnvSafety();
  }
  return nextConfig;
}
