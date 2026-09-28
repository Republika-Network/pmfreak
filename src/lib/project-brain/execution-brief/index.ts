// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief (PB-EXEC-01) — SERVER barrel.
//
// Browser code imports the pure modules directly (types, render, validate,
// credential-guard, target) and never this barrel, which re-exports the server-only
// hasher, assembler and generation operation.
//
// PB-EXEC-01 is reason → prepare only. Nothing in this module imports the agent
// runtime (src/lib/agents/**), calls /api/agents/**, reads or writes a repository,
// runs git or a shell, or writes project state or memory.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./types";
export * from "./policy";
export * from "./canonical-json";
export * from "./credential-guard";
export * from "./schema";
export * from "./target";
export * from "./ground";
export * from "./repository-context";
export * from "./validate";
export * from "./render";
export * from "./prompt";
export * from "./assemble";
export * from "./generate";
export { sha256Tag } from "./hash";
