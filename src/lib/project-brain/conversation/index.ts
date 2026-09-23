// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — server surface (PB-CHAT-01)
//
// Server-only: this barrel re-exports the service-role reply writer. Client
// components import types from ./transcript-view directly, never from here.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./context-budget";
export * from "./context-types";
export * from "./context-builder";
export * from "./prompt";
export * from "./output";
export * from "./degraded";
export * from "./turn-service";
export * from "./transcript-view";
export { insertProjectBrainReply } from "./assistant-message-writer";
export { resolveProjectBrainGenerativeAccess, type ProjectBrainGenerativeAccess } from "./generative-access";
