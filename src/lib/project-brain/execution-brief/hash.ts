// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — hashing (PB-EXEC-01, §9.8). SERVER ONLY.
//
// Node crypto is imported here and nowhere else in the module, so the browser
// bundle (render.ts, credential-guard.ts, validate.ts) never pulls it in. Hashes are
// "sha256:<64 lowercase hex>" over the UTF-8 bytes of canonicalJson(value).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

export function sha256Tag(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
