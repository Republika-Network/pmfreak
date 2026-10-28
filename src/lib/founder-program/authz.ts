import { NextResponse } from "next/server";
import { getAuthUser, isFounderOrInternalUser, type AuthUserContext } from "@/lib/auth";
import { loadFounderProgramConfig, type FounderProgramConfig, type FounderProgramFlags } from "@/lib/founder-program/config";
import { logSecurityEvent } from "@/lib/security/telemetry";

/**
 * Founder Circle Program — route-layer authorization and fail-closed gating.
 *
 * Operator identity is founder/internal: the GoTrue-verified user id must be
 * listed in FOUNDER_OPERATOR_USER_IDS and its email confirmed (F6, see
 * `evaluateFounderOrInternalAccess`) — never an email domain, never
 * client-supplied fields. Authorization is enforced BEFORE request bodies
 * are parsed. Disabled program surfaces answer with controlled responses,
 * never ambiguous 500s.
 */

/** Controlled response when the program (or a sub-feature) is unavailable. */
export function founderProgramDisabledResponse(): NextResponse {
  // 404 keeps a disabled program surface indistinguishable from a
  // nonexistent one for ordinary users; operators see the real flag state
  // in the operator console, which reads the config server-side.
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export function founderProgramFeatureDisabledResponse(feature: keyof FounderProgramFlags): NextResponse {
  return NextResponse.json(
    { error: "This part of the founder program is currently disabled.", code: "founder_program_feature_disabled", feature },
    { status: 503 },
  );
}

export type FounderProgramGate =
  | { readonly ok: true; readonly config: Extract<FounderProgramConfig, { enabled: true }> }
  | { readonly ok: false; readonly response: NextResponse };

/** Master gate: env flag + DB settings, fail-closed (see config.ts). */
export async function requireFounderProgramEnabled(): Promise<FounderProgramGate> {
  const config = await loadFounderProgramConfig();
  if (!config.enabled) {
    return { ok: false, response: founderProgramDisabledResponse() };
  }
  return { ok: true, config };
}

export type FounderOperatorGate =
  | { readonly ok: true; readonly user: AuthUserContext; readonly config: Extract<FounderProgramConfig, { enabled: true }> }
  | { readonly ok: false; readonly response: NextResponse };

/**
 * Operator gate for every /api/founder-program/operator/** route: program
 * enabled → authenticated → founder/internal. Denials are logged as
 * `founder_program_denied` security events.
 */
export async function requireFounderProgramOperator(routeId: string): Promise<FounderOperatorGate> {
  const enabled = await requireFounderProgramEnabled();
  if (!enabled.ok) return enabled;

  const user = await getAuthUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Authentication required." }, { status: 401 }) };
  }
  if (!isFounderOrInternalUser(user)) {
    await logSecurityEvent("founder_program_denied", {
      actorUserId: user.id,
      routeId,
      denied_permission: "founder_program.operate",
    });
    return { ok: false, response: NextResponse.json({ error: "Founder access is required." }, { status: 403 }) };
  }
  return { ok: true, user, config: enabled.config };
}

export type FounderParticipantGate =
  | { readonly ok: true; readonly user: AuthUserContext; readonly config: Extract<FounderProgramConfig, { enabled: true }> }
  | { readonly ok: false; readonly response: NextResponse };

/** Participant gate: program enabled → authenticated. Self-scoping happens per query. */
export async function requireFounderProgramParticipantContext(): Promise<FounderParticipantGate> {
  const enabled = await requireFounderProgramEnabled();
  if (!enabled.ok) return enabled;

  const user = await getAuthUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Authentication required." }, { status: 401 }) };
  }
  return { ok: true, user, config: enabled.config };
}
