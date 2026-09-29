/**
 * PB-EXEC-01 — browser entry for tests/e2e/pb-exec-01-brief-card.spec.ts.
 *
 * Bundled by esbuild and loaded into a real Chromium page. It mounts the REAL
 * `ProjectBrainAnswer` (and therefore the real `ExecutionBriefCard`) for message views
 * that the spec built on the Node side through the real turn service and transcript view.
 * No server, no network: the page's only request is its own document.
 */

import { createRoot } from "react-dom/client";
import { ProjectBrainAnswer } from "../src/components/pmfreak/project-brain/project-brain-conversation";
import type { ProjectBrainMessageView } from "../src/lib/project-brain/conversation/transcript-view";

declare global {
  interface Window {
    __PB_EXEC_CASES__: Record<string, ProjectBrainMessageView>;
    __PB_EXEC_PREPARED__: string[];
  }
}

window.__PB_EXEC_PREPARED__ = [];
const root = document.getElementById("root")!;
createRoot(root).render(
  <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
    {Object.entries(window.__PB_EXEC_CASES__).map(([name, view]) => (
      <div key={name} data-case={name}>
        <ProjectBrainAnswer
          message={view}
          variant="light"
          layout="surface"
          onPrepareBrief={(statement) => window.__PB_EXEC_PREPARED__.push(statement.id)}
          initialRenderer={name === "codexPreferred" ? "codex" : undefined}
        />
      </div>
    ))}
  </div>,
);
