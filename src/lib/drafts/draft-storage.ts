/**
 * Unsaved wizard drafts in the browser, scoped to one user and one workspace (PD-21).
 *
 * localStorage belongs to the browser profile, not to the signed-in user: on a shared
 * browser the next person who signs in reads the same storage. The project wizard and the
 * Command Center wizard used to keep their drafts under one global key each, so the next
 * user's wizard pre-filled the previous user's confidential text.
 *
 * A draft now lives under `pmfreak.draft.v2.<kind>.<owner>.<scope>`, where owner and scope
 * are opaque digests of the user id and the workspace id computed on the server
 * (draft-scope.ts) — so a different user, or the same user in another workspace, reads a
 * different key and gets nothing. That holds however the session ended; sign-out cleanup
 * (clearDraftsOwnedBy) only additionally removes the leaving user's text from the device.
 *
 * Client-safe: no Node imports. Storage is a convenience — every access is guarded.
 */

export const DRAFT_KEY_PREFIX = "pmfreak.draft.v2.";

/**
 * Pre-PD-21 global keys. Their owner cannot be known, so they are deleted unread, never
 * migrated: `pmfreak.pmo.tenant` was a write-only cache of the activated Command Center.
 */
export const LEGACY_DRAFT_KEYS = ["pmfreak.project.draft", "pmfreak.pmo.tenant.draft", "pmfreak.pmo.tenant"] as const;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function purgeLegacyDrafts(): void {
  const store = storage();
  if (!store) return;
  for (const key of LEGACY_DRAFT_KEYS) {
    try {
      store.removeItem(key);
    } catch {}
  }
}

/** A null key means the scope is unknown: nothing is read or written. */
export function loadScopedDraft<T>(key: string | null | undefined): T | null {
  purgeLegacyDrafts();
  const store = storage();
  if (!store || !key?.startsWith(DRAFT_KEY_PREFIX)) return null;
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveScopedDraft(key: string | null | undefined, data: unknown): void {
  const store = storage();
  if (!store || !key?.startsWith(DRAFT_KEY_PREFIX)) return;
  try {
    store.setItem(key, JSON.stringify(data));
  } catch {}
}

export function clearScopedDraft(key: string | null | undefined): void {
  const store = storage();
  if (!store || !key?.startsWith(DRAFT_KEY_PREFIX)) return;
  try {
    store.removeItem(key);
  } catch {}
}

/**
 * Removes every draft owned by `ownerTag` (all kinds, all workspaces) and the legacy keys.
 * Called as the user signs out; other users' drafts on this browser are left alone.
 */
export function clearDraftsOwnedBy(ownerTag: string | null | undefined): void {
  purgeLegacyDrafts();
  const store = storage();
  if (!store || !ownerTag) return;
  try {
    const owned = Object.keys(store).filter((key) => key.startsWith(DRAFT_KEY_PREFIX) && key.slice(DRAFT_KEY_PREFIX.length).split(".")[1] === ownerTag);
    for (const key of owned) store.removeItem(key);
  } catch {}
}
