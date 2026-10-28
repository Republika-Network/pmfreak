/**
 * Supported operator boundary: admit ONE participant to a closed-free-beta tenant.
 *
 *   npm run beta:invite-participant -- --workspace <uuid> --email <address> --role <pm|admin|viewer> --inviter <email|uuid>
 *
 * It creates a real, inspectable `workspace_invitations` row through the
 * product's own invitation domain (`createWorkspaceInvitationRecord`), so the
 * duplicate refusal, role gate, token hashing, expiry and audit event are the
 * SAME ones the in-app path uses. It writes no SQL and repairs nothing.
 *
 * Authority: the inviter must already hold an owner/admin membership in the
 * target workspace, checked by the product's own `requireWorkspaceInviteActor`.
 *
 * OPERATOR_INVITE_FRONTERA_GOVERNED=NO. This boundary is NOT Frontera-governed,
 * and that is stated rather than implied. The workspace-scoped Frontera evaluator
 * re-resolves its actor from HTTP request context, so it cannot truthfully
 * authorize this non-request operator boundary without a governance-architecture
 * change that is deliberately out of scope. What protects this command instead:
 * it refuses any non-local/non-isolated target BEFORE privileged access, the
 * inviter identity must already exist, the inviter must already hold owner/admin
 * membership in the exact target workspace, and role assignment still runs the
 * shared invitation policy so "owner" can never be granted. It is an operator-only
 * boundary, not a hosted/production or self-service admission API.
 * See RR-BETA-OPERATOR-FRONTERA-BOUNDARY.
 *
 * BETA_OPERATOR_SEAT_POLICY=OPERATOR_CONTROLLED_NOT_SUBSCRIPTION_GATED.
 * Subscription seat capacity is deliberately NOT enforced here: the closed free
 * beta has no billing surface and admission count is controlled by the operator
 * cohort. OPERATOR_INVITE_SUBSCRIPTION_SEAT_GATED=NO.
 * See RR-NORMAL-INVITE-SEAT-MODEL.
 *
 * The accept path contains the ONLY copy of the plaintext token and is printed
 * only with --emit-accept-path, for out-of-band delivery to the participant.
 */
import { createClient } from "@supabase/supabase-js";
import { requireWorkspaceInviteActor } from "../src/lib/workspace-access.ts";
import { createWorkspaceInvitationRecord } from "../src/lib/workspace-team.ts";
import { assertIsolatedTarget, GUARD_MODES, LOCAL_ISOLATED } from "./p2-13/isolation-guard.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fail = (failureClass, message) => {
  process.stderr.write(`${JSON.stringify({ ok: false, failureClass, message })}\n`);
  process.exitCode = 1;
};

const workspaceId = arg("workspace");
const email = arg("email");
const role = arg("role");
const inviter = arg("inviter");
const emitAcceptPath = process.argv.includes("--emit-accept-path");

if (!workspaceId || !email || !role || !inviter) {
  fail("invalid_operator_request", "Required: --workspace <uuid> --email <address> --role <pm|admin|viewer> --inviter <email|uuid>");
} else {
  // Never a hosted or production target. The repository's own guard, before any
  // privileged access — an operator admission script must not be usable to write
  // into a real tenant by mistake.
  //
  // `assertIsolatedTarget` THROWS for a non-local, unknown, or prerequisite-missing
  // target, so the documented `non_isolated_target` envelope below was previously
  // unreachable and the command died with a raw stack trace instead. The guard
  // itself is unchanged and is NOT weakened — only its refusal is converted into
  // the stable structured envelope, and still before any privileged client exists.
  let isolation = null;
  let isolationRefusal = null;
  try {
    isolation = assertIsolatedTarget(process.env, { mode: GUARD_MODES.SEED });
  } catch (error) {
    isolationRefusal = error instanceof Error ? error.message : String(error);
  }

  if (isolationRefusal !== null || isolation === null || isolation.classification !== LOCAL_ISOLATED) {
    fail(
      "non_isolated_target",
      `Refusing to admit a participant against a non-local target: ${isolationRefusal ?? JSON.stringify(isolation?.target ?? null)}`,
    );
  } else {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let inviterUser = null;
    if (/^[0-9a-f-]{36}$/i.test(inviter)) {
      const { data } = await supabase.auth.admin.getUserById(inviter);
      inviterUser = data?.user ?? null;
    } else {
      const wanted = inviter.trim().toLowerCase();
      for (let page = 1; page <= 20 && !inviterUser; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
        if (error) break;
        inviterUser = data.users.find((user) => (user.email ?? "").toLowerCase() === wanted) ?? null;
        if (data.users.length < 200) break;
      }
    }

    if (!inviterUser) {
      fail("inviter_not_found", "The inviting operator identity does not exist. This script never invents an identity.");
    } else {
      const getClient = async () => supabase;
      try {
        // The product's OWN actor gate: owner/admin membership in this workspace.
        const actor = await requireWorkspaceInviteActor({ userId: inviterUser.id, workspaceId }, getClient);
        // company_id belongs to the inviting user: their own id (feature-gates.getCompanyIdByUserId),
        // never user_metadata.company_id, which is user-editable (F1).
        const companyId = inviterUser.id;

        const created = await createWorkspaceInvitationRecord(
          { workspaceId, companyId, inviterUserId: inviterUser.id, actorRole: actor.role, email, role },
          getClient,
        );

        const { data: inspectable } = await supabase
          .from("workspace_invitations")
          .select("id, workspace_id, email, role, status, expires_at")
          .eq("workspace_id", workspaceId)
          .eq("email", email.trim().toLowerCase())
          .eq("status", "pending")
          .maybeSingle();

        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            boundary: "beta:invite-participant",
            invitation: inspectable ?? null,
            expiresAt: created.expiresAt,
            // The plaintext token exists exactly once, here. Withheld unless asked for.
            acceptPath: emitAcceptPath ? created.acceptPath : "(withheld — pass --emit-accept-path to print)",
          })}\n`,
        );
      } catch (error) {
        fail("invitation_refused", error?.message ?? String(error));
      }
    }
  }
}
