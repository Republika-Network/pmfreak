// CP-5 — routes that load pdf.js must ship @napi-rs/canvas.
//
// pdf.js polyfills DOMMatrix/Path2D/ImageData from @napi-rs/canvas through a runtime require
// that file tracing cannot see. When the package is missing from a Vercel function, evaluating
// the route module throws "DOMMatrix is not defined" and every request to the route is a 500,
// before authentication or authorization runs (RELEASE-01 smoke S05/S06). next.config.ts lists
// the package in outputFileTracingIncludes for each such route; this test keeps that list equal
// to the set of routes whose static import graph reaches pdf-parse or pdfjs-dist.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import nextConfigModule from "../next.config.ts";

// next.config.ts compiles as CommonJS here, so its default export may arrive wrapped.
const config = typeof nextConfigModule === "function" ? nextConfigModule : nextConfigModule.default;

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const PDF_PACKAGES = /^(pdf-parse|pdfjs-dist)(\/|$)/;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const resolveLocal = (from, spec) => {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

// Static and dynamic import()/export-from specifiers; type-only imports are erased at build time.
const specifiersOf = (file) => {
  const text = readFileSync(file, "utf8");
  const specs = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/g)) if (!m[2]) specs.push(m[3]);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
};

const reachesPdfJs = (entry) => {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (PDF_PACKAGES.test(spec)) return true;
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const next = resolveLocal(file, spec);
        if (next) stack.push(next);
      }
    }
  }
  return false;
};

const routePathOf = (file) =>
  "/" + relative(join(SRC, "app"), dirname(file)).split("/").filter((segment) => !/^\(.*\)$/.test(segment)).join("/");

const traceIncludes = config(PHASE_PRODUCTION_BUILD).outputFileTracingIncludes ?? {};

test("every route that loads pdf.js ships @napi-rs/canvas, and only those routes", () => {
  const pdfRoutes = walk(join(SRC, "app"))
    .filter((file) => /\/route\.tsx?$/.test(file))
    .filter(reachesPdfJs)
    .map(routePathOf)
    .sort();
  assert.ok(pdfRoutes.includes("/api/upload"), "the scan must find the upload route (guards the scanner itself)");
  assert.deepEqual(Object.keys(traceIncludes).sort(), pdfRoutes);
});

test("each include names the canvas package and its Linux glibc binary, and both exist", () => {
  for (const [route, globs] of Object.entries(traceIncludes)) {
    for (const pkg of ["@napi-rs/canvas", "@napi-rs/canvas-linux-x64-gnu"]) {
      assert.ok(globs.includes(`./node_modules/${pkg}/**`), `${route} must include ${pkg}`);
      assert.ok(existsSync(join(ROOT, "node_modules", pkg, "package.json")), `${pkg} must be installed`);
    }
  }
});

test("the traced canvas binary is the one pdf-parse's canvas dependency loads on linux-x64-gnu", () => {
  const parse = JSON.parse(readFileSync(join(ROOT, "node_modules/pdf-parse/package.json"), "utf8"));
  const canvas = JSON.parse(readFileSync(join(ROOT, "node_modules/@napi-rs/canvas/package.json"), "utf8"));
  assert.equal(parse.dependencies["@napi-rs/canvas"], canvas.version);
  assert.ok(Object.hasOwn(canvas.optionalDependencies ?? {}, "@napi-rs/canvas-linux-x64-gnu"));
});
