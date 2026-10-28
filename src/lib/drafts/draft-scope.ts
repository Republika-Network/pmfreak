import { createHash } from "node:crypto";
import { DRAFT_KEY_PREFIX } from "@/lib/drafts/draft-storage";

/**
 * Server-side half of PD-21's scoped drafts: derives the storage key a wizard may use.
 * Only server code imports this (node:crypto); the client receives finished keys and tags.
 *
 * Owner and scope are truncated SHA-256 digests, so key names on a shared browser reveal
 * neither user ids nor workspace ids. They are separation tags, not secrets: the isolation
 * comes from each signed-in user being handed only their own key by the server.
 */

export type DraftKind = "project" | "command-center";

const tag = (domain: string, value: string) => createHash("sha256").update(`pmfreak.draft.${domain}:${value}`).digest("hex").slice(0, 24);

export function draftOwnerTag(userId: string): string {
  return tag("owner", userId);
}

/** The draft key for this user in this workspace; null when the workspace is unknown. */
export function draftStorageKey(kind: DraftKind, userId: string, workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  return `${DRAFT_KEY_PREFIX}${kind}.${draftOwnerTag(userId)}.${tag("scope", workspaceId)}`;
}
