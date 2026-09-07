/**
 * UX-W0 review remediation harness.
 *
 * Executed by `tests/ux-w0-public-launch-blockers.test.mjs` through tsx, the way this
 * repository runs REAL behaviour rather than source scanning (same pattern as
 * `tests/p2-11-attention-harness.tsx`).
 *
 * It server-renders both customer LIVE capture surfaces in their initial state and prints
 * one JSON document describing what a PM would actually see on open: which option each
 * canonical vocabulary select has selected, what the confidence field holds, and whether
 * the submit control is disabled. Source reading cannot prove "the form opens unanswered";
 * rendering it can.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { VaultIntakePanel } from "../src/modules/workspace/presentation/command-center/vault-intake-panel";
import { TextCaptureModal } from "../src/components/pmfreak/intelligence-inbox/text-capture-modal";

const noop = () => {};

/** Every `<select>` in the markup, as { options, selected } — selected is the option value
 *  React marked as chosen, or null when nothing is. */
function selects(markup: string) {
  return [...markup.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)].map((match) => {
    const body = match[1];
    const options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((opt) => ({
      value: /value="([^"]*)"/.exec(opt[1])?.[1] ?? "",
      selected: /\bselected\b/.test(opt[1]),
      disabled: /\bdisabled\b/.test(opt[1]),
      label: opt[2],
    }));
    return {
      options: options.map((o) => o.value),
      selected: options.find((o) => o.selected)?.value ?? null,
      placeholderDisabled: options.find((o) => o.value === "")?.disabled ?? false,
    };
  });
}

/** The confidence number input's rendered value, or null when the input is absent. */
function numberInputValue(markup: string) {
  const match = /<input\b[^>]*type="number"[^>]*>/.exec(markup);
  if (!match) return null;
  return /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
}

/** True when every submit-shaped button in the markup is disabled. */
function submitDisabled(markup: string, labelPattern: RegExp) {
  const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const submits = buttons.filter((b) => labelPattern.test(b[2]));
  if (submits.length === 0) return null;
  return submits.every((b) => /\bdisabled\b/.test(b[1]));
}

const panelMarkup = renderToStaticMarkup(
  <VaultIntakePanel workspaceId="ws-1" projectId="pr-1" onClose={noop} onIntakeComplete={noop} />,
);

const modalMarkup = renderToStaticMarkup(
  <TextCaptureModal mode="paste" workspaceId="ws-1" projectId="pr-1" onClose={noop} onCaptured={noop} />,
);

process.stdout.write(
  JSON.stringify(
    {
      vaultIntakePanel: {
        selects: selects(panelMarkup),
        confidenceValue: numberInputValue(panelMarkup),
        submitDisabled: submitDisabled(panelMarkup, /Capture and derive Evidence/),
      },
      textCaptureModal: {
        selects: selects(modalMarkup),
        confidenceValue: numberInputValue(modalMarkup),
        submitDisabled: submitDisabled(modalMarkup, /Capture, then derive Evidence/),
      },
    },
    null,
    2,
  ),
);
