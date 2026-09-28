// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — canonical JSON (PB-EXEC-01, §9.8)
//
// One deterministic serialization for everything that is hashed:
//   * object keys in stable (code-unit) order, at every depth;
//   * arrays keep their order — order is meaning in a brief (acceptance criteria,
//     verification plan, scope). Set-like collections are sorted by the CALLER
//     (canonicalSet) where a fingerprint needs set semantics, never here;
//   * `undefined` object members are omitted (as JSON.stringify does); a top-level
//     or array `undefined`, a function, a symbol, a bigint or a non-finite number is
//     refused rather than silently coerced;
//   * no whitespace, no runtime-dependent formatting. Strings use JSON escaping,
//     so the result is plain UTF-8 text for the hasher.
//
// Pure; no Node API — the hasher itself lives in hash.ts (server only).
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalJson(value: unknown): string {
  return serialize(value, 0);
}

function serialize(value: unknown, depth: number): string {
  if (depth > 32) throw new Error("canonicalJson: structure too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => {
          if (item === undefined) throw new Error("canonicalJson: undefined array member");
          return serialize(item, depth + 1);
        }).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, depth + 1)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** A set-like collection in canonical order: deduplicated and sorted by its canonical JSON. */
export function canonicalSet<T>(items: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(canonicalJson(item), item);
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}
