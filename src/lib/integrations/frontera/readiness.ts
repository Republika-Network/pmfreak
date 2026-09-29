/**
 * CHAT-GOV-01a — safe, non-mutating readiness of the Frontera enforcement boundary.
 *
 * OWNERSHIP: PMFreak. Reports whether dispatch COULD reach Frontera's authority store. It
 * decides nothing and authorizes nothing: dispatch still fails closed in
 * `authorizeFronteraDispatch` whatever this reports.
 *
 * Why this does not open the store. `createSqliteKernelAuthorityStore` (packaged runtime,
 * `dist/src/enterprise/kernel-authority/sqlite-kernel-authority-store.js`) creates the
 * parent directory, creates a missing database file, switches it to WAL, runs its
 * `CREATE TABLE IF NOT EXISTS` schema and inserts a store-version row. A readiness probe
 * that opened it would therefore MINT an empty authority store on a misconfigured host.
 * Even a read-only SQLite connection may create WAL side files. The probe stays at the
 * filesystem instead: it opens the configured path with flag "r" and reads the 16-byte
 * SQLite header, and nothing more.
 *
 * Limitation, stated rather than implied: `available: true` means "a readable SQLite
 * database exists at the configured location". It does NOT prove the native driver loads
 * on this host, that Frontera's schema is present, or that any principal is provisioned —
 * those are only proven by a real dispatch evaluation. `available: false` is conclusive.
 *
 * What is returned is three fields of fixed vocabulary. No environment value, path,
 * filename, subject mapping, provisioning fact or policy content is ever included.
 */
import { open } from "node:fs/promises";

export type FronteraReadinessStatus = "ready" | "not_configured" | "unavailable";

export type FronteraReadiness = {
  readonly configured: boolean;
  readonly available: boolean;
  readonly status: FronteraReadinessStatus;
};

/** Every SQLite 3 database file begins with these 16 bytes. */
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "latin1");

export type FronteraReadinessDeps = {
  /** Test seam: read the first bytes of a file without writing to it. */
  readonly readHeader?: (path: string) => Promise<Buffer>;
};

async function readHeaderReadOnly(path: string): Promise<Buffer> {
  // "r" never creates, truncates or writes.
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, SQLITE_HEADER.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Never throws. Any failure to confirm the store is `unavailable`, never `ready`. */
export async function checkFronteraReadiness(
  // Only `AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH` is read from it.
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: FronteraReadinessDeps = {},
): Promise<FronteraReadiness> {
  // The same variable `resolveFronteraEnforcementConfig` reads, read the same way, so
  // readiness and enforcement can never disagree about whether it is configured.
  const storePath = env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH?.trim();
  if (!storePath) return { configured: false, available: false, status: "not_configured" };

  try {
    const header = await (deps.readHeader ?? readHeaderReadOnly)(storePath);
    const isSqlite = header.length === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
    return isSqlite
      ? { configured: true, available: true, status: "ready" }
      : { configured: true, available: false, status: "unavailable" };
  } catch {
    // Missing, unreadable, a directory, a permission error: the reason stays unreported,
    // because the reason names the host's filesystem.
    return { configured: true, available: false, status: "unavailable" };
  }
}
