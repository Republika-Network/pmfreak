/**
 * OPERATOR-SIDE Frontera authority for the P2-07 / P2-08 / P2-09 live verifiers.
 *
 * THIS IS NOT PRODUCT CODE and must never be imported from `src/**`
 * (`npm run check:frontera-consumer` enforces that). It lets a disposable local
 * verifier act as the enterprise operator, out of band, exactly as
 * `scripts/provision-founder-frontera-authority.mjs` does for the Founder
 * journey — and for the same reason: PMFreak itself can never provision the
 * authority it then asks Frontera about.
 *
 * It adds no authority vocabulary of its own. Every write goes through
 * `provisionPmfreakDispatchAuthority` / `revokePmfreakDispatchAuthority`, so a
 * verifier can grant nothing wider than one principal, one workspace, one
 * project and `execute.material-action`. It never manufactures a verdict: the
 * only way a verifier observes ALLOW is the running PMFreak process asking the
 * real `AocKernel.evaluate()` against this same durable store.
 *
 * The store is opened and closed around every operator step. That keeps the
 * operator a genuinely separate writer — the product rehydrates per evaluation,
 * so a grant or revocation committed here is only observed if the product really
 * re-reads durable authority on its next attempt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openOperatorStore,
  provisionPmfreakDispatchAuthority,
  revokePmfreakDispatchAuthority,
  PMFREAK_EXTERNAL_SUBJECT_SYSTEM,
} from "./frontera-authority-provisioning.mjs";

const STORE_ENV = "AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH";

/**
 * An ALLOW decision id as the packaged runtime mints it: the enforcement
 * decision service's `nextId('enforcement-decision')` through the durable
 * providers' `<prefix>-<uuid>` generator. A PMFreak Material Action id is a bare
 * uuid, so a decision id can never be mistaken for the request correlation it is
 * tied to, and a hand-built `{ allowed: true }` carries no id of this shape.
 */
export const FRONTERA_DECISION_ID_PATTERN =
  /^enforcement-decision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isGenuineFronteraDecisionId(decisionId, actionId) {
  return (
    typeof decisionId === "string" &&
    FRONTERA_DECISION_ID_PATTERN.test(decisionId) &&
    decisionId !== actionId
  );
}

function abort(label, message) {
  console.error(`SAFETY ABORT (${label}): ${message}`);
  process.exit(2);
}

/**
 * The durable authority store these verifiers write to must be provably local
 * and disposable. It is the SAME file the PMFreak process under test reads, so
 * it is named by Frontera's own configuration variable rather than a verifier
 * synonym; the verifier then proves the two agree by observing an unbound
 * refusal turn into an ALLOW only after its own out-of-band provisioning.
 */
export function requireDisposableFronteraStore(label, env = process.env) {
  const raw = env[STORE_ENV]?.trim();
  if (!raw) {
    abort(label, `${STORE_ENV} must name the disposable local Frontera authority store the running PMFreak process reads.`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    abort(label, `${STORE_ENV} must be a local file path, not a URL or connection string.`);
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    abort(label, `${STORE_ENV} must not be a network share.`);
  }
  if (!path.isAbsolute(raw)) {
    abort(label, `${STORE_ENV} must be an absolute path, so the verifier and the app cannot resolve it differently.`);
  }
  if (!/\.(sqlite3?|db)$/i.test(raw)) {
    abort(label, `${STORE_ENV} must name a SQLite file (.sqlite, .sqlite3 or .db).`);
  }
  if (/(^|[^a-z])(prod|production|staging|hosted|shared)([^a-z]|$)/i.test(raw)) {
    abort(label, `${STORE_ENV} looks like a non-disposable authority store.`);
  }
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(raw));
  } catch {
    abort(label, `${STORE_ENV} parent directory does not exist.`);
  }
  const tmp = fs.realpathSync(os.tmpdir());
  if (parent !== tmp && !parent.startsWith(tmp + path.sep)) {
    abort(label, `${STORE_ENV} must live under the OS temporary directory (${tmp}); these verifiers only write to a disposable store.`);
  }
  const subjectSystem = env.PMFREAK_FRONTERA_EXTERNAL_SUBJECT_SYSTEM?.trim();
  if (subjectSystem && subjectSystem !== PMFREAK_EXTERNAL_SUBJECT_SYSTEM) {
    abort(label, `PMFREAK_FRONTERA_EXTERNAL_SUBJECT_SYSTEM must be unset or "${PMFREAK_EXTERNAL_SUBJECT_SYSTEM}" to match operator provisioning.`);
  }
  return path.resolve(raw);
}

export function createVerifierFronteraOperator({ storePath, operatorActorId }) {
  async function withStore(fn) {
    const store = await openOperatorStore(storePath);
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  }

  return {
    /** Minimum authority: one principal, one workspace, one project, one action. */
    provision: ({ workspaceId, principalUserId, projectId }) =>
      withStore(async (store) => {
        const provisioned = await provisionPmfreakDispatchAuthority(store, {
          organizationId: workspaceId,
          principalUserId,
          projectId,
          operatorActorId,
        });
        return { actorId: provisioned.actorId, trustDomainId: provisioned.trustDomainId };
      }),

    /** Terminal: a revoked grant/token id is never re-provisioned (Frontera refuses). */
    revoke: ({ workspaceId, principalUserId, projectId, reason }) =>
      withStore((store) =>
        revokePmfreakDispatchAuthority(store, {
          organizationId: workspaceId,
          principalUserId,
          projectId,
          reason,
          operatorActorId,
        }),
      ),

    /**
     * Read-only: the principal's actor binding in ONE organization, or null.
     * Uses the same organization-scoped `system: false` context the product
     * uses, so it can observe but never write.
     */
    binding: ({ workspaceId, principalUserId }) =>
      withStore(async (store) => {
        const record = await store.findActorByExternalSubject(
          { system: false, organizationId: workspaceId },
          workspaceId,
          { system: PMFREAK_EXTERNAL_SUBJECT_SYSTEM, subjectId: principalUserId },
        );
        return record ? { actorId: record.entityId, status: record.status } : null;
      }),
  };
}
