/**
 * UX-W2 Codex remediation — Ask PMFreak collapse lifecycle.
 *
 * This one needs a REAL client render, not a server render. The defect it guards is a
 * mount/unmount question — collapsing the copilot panel used to unmount `CommandFeed`, and
 * an unsent draft is `CommandFeed`'s own local state, so it vanished. Server rendering
 * produces markup and no lifecycle at all, so it cannot observe that. Neither can source
 * reading: "CommandFeed still appears in the file" says nothing about whether it survives a
 * toggle.
 *
 * So this mounts the real components into a real DOM (jsdom) with `react-dom/client`, types
 * into the real composer, drives the real collapse control, and reports what the composer
 * holds afterwards. It is the narrowest harness that can exercise the actual lifecycle.
 *
 * Executed by `tests/ux-w2-attention-first-command-center.test.mjs` through tsx.
 */

import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AskPmfreakPanel } from "../src/modules/workspace/presentation/command-center/ask-pmfreak-panel";
import { CommandFeed } from "../src/modules/workspace/presentation/command-center/command-feed";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "https://pmfreak.test/command-center",
  pretendToBeVisual: true,
});

// React reads these off the global scope at module evaluation, so they are installed before
// react-dom is imported below.
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so it is redefined rather than
// assigned. React reads `navigator.userAgent` during client rendering.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
// React 19 checks this flag to decide whether `act` may be used.
g.IS_REACT_ACT_ENVIRONMENT = true;

// React and the components under test touch no DOM at module scope, so they import
// statically. `react-dom/client` does, and is loaded inside `main()` after the globals
// above exist.

type ChatMessage = { id: string; role: "assistant" | "user"; content: string };

const INITIAL_MESSAGES: ChatMessage[] = [
  { id: "welcome", role: "assistant", content: "ERP Transformation is ready." },
];

const DRAFT = "What changed with the vendor milestone?";

/** Records every message the panel would have sent, so an accidental submit is observable. */
const submitted: string[] = [];

/**
 * The real composition: the screen owns the open flag and the transcript, exactly as
 * `CommandCenterLayout` does, and `CommandFeed` is handed to the panel as its child.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  const [messages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  return (
    <AskPmfreakPanel open={open} onToggle={setOpen} messageCount={messages.length}>
      <CommandFeed
        messages={messages}
        onSendMessage={(text: string) => submitted.push(text)}
        onSourceClick={() => {}}
        onActionClick={() => {}}
      />
    </AskPmfreakPanel>
  );
}

async function main() {
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  await act(async () => {
    root.render(<Harness />);
  });

  const composer = () => container.querySelector("input") as HTMLInputElement | null;
  const regionHidden = () =>
    (container.querySelector('[data-testid="cc-ask-pmfreak-region"]') as HTMLElement | null)?.hasAttribute("hidden") ?? null;
  const feedCount = () => container.querySelectorAll('[data-testid="chat-determinism-disclosure"]').length;
  const buttonByText = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) as HTMLButtonElement | undefined;

  /** Types into the real composer the way a person does: a native input event React sees. */
  async function type(value: string) {
    const input = composer();
    if (!input) throw new Error("composer is not in the DOM");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  // ── The lifecycle under test ─────────────────────────────────────────────────

  const initiallyCollapsed = {
    regionHidden: regionHidden(),
    composerMounted: composer() !== null,
    feedInstances: feedCount(),
  };

  // 1. open Ask PMFreak
  await click(buttonByText("Ask PMFreak about this project")!);
  const opened = { regionHidden: regionHidden(), composerMounted: composer() !== null, feedInstances: feedCount() };

  // 2-3. enter a draft and do NOT send it
  await type(DRAFT);
  const drafted = { composerValue: composer()?.value ?? null, submitted: [...submitted] };

  // 4. collapse
  await click(buttonByText("Collapse")!);
  const collapsed = {
    regionHidden: regionHidden(),
    composerMounted: composer() !== null,
    composerValue: composer()?.value ?? null,
    feedInstances: feedCount(),
    submitted: [...submitted],
    // display:none is what removes it from the tab order and the accessibility tree.
    composerDisplay: composer() ? dom.window.getComputedStyle(composer()!).display : null,
    regionDisplay: (() => {
      const region = container.querySelector('[data-testid="cc-ask-pmfreak-region"]') as HTMLElement | null;
      return region ? dom.window.getComputedStyle(region).display : null;
    })(),
  };

  // 5-6. reopen
  await click(buttonByText("Ask PMFreak about this project")!);
  const reopened = {
    regionHidden: regionHidden(),
    composerValue: composer()?.value ?? null,
    feedInstances: feedCount(),
    submitted: [...submitted],
    transcriptCount: container.querySelectorAll("[data-testid='cc-ask-pmfreak-region'] .rounded-tl-sm").length,
  };

  process.stdout.write(
    JSON.stringify(
      {
        draft: DRAFT,
        initiallyCollapsed,
        opened,
        drafted,
        collapsed,
        reopened,
        transcriptAtStart: INITIAL_MESSAGES.length,
      },
      null,
      2
    )
  );

  await act(async () => {
    root.unmount();
  });
}

void main();
