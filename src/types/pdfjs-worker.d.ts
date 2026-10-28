// pdfjs-dist ships no types for its worker entry. It is imported only for its side effect —
// registering globalThis.pdfjsWorker so pdf.js runs the worker in-process (PD-22,
// src/lib/project-evidence/evidence-processor.ts) — so no exports are declared.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
