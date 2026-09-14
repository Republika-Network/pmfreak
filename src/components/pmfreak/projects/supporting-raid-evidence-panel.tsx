"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "@/components/pmfreak/ui/drawer";
import type { SupportingRaidPanelRecord } from "@/lib/projects/project-command-center-projection";

/**
 * The Evidence Panel of `08-ai-interaction-patterns.md` §5, and the ONLY client
 * code on the Project Command Center.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * §5 wants the panel "reachable in exactly one interaction from wherever the
 * claim is shown". `08-accessibility-guidelines.md` §2 says what that interaction
 * owes a keyboard or screen-reader user: the panel "opens without stealing focus
 * unexpectedly, and its dismissal returns focus to the control that opened it".
 *
 * The previous version was an `<a href="#recommendation-evidence-…">` landing on
 * a plain `<li>`. It moved the VIEWPORT and left FOCUS on the Recommendation, and
 * it had no dismissal to return from — so it satisfied §5 and failed §2. Focus
 * management is behaviour, behaviour needs a client boundary, and a fragment is a
 * scroll instruction that cannot be made to do either.
 *
 * WHAT IS AND IS NOT ON THIS SIDE OF THE BOUNDARY
 * ----------------------------------------------
 * Only the open / close / focus interaction. The server page performs every
 * authorization (`resolveRoutedProject`, `evaluateCapabilityAccess`) and every
 * read (`projectSupportingRaidQuery`, guarded again by
 * `selectSupportingRaidRecords`), and hands down one `SupportingRaidPanelRecord` —
 * governed presentation text, already scoped to this workspace and this project.
 *
 * So there is deliberately NO fetch, no route handler call, no database client,
 * no identifier and no query of any kind in this file. The panel cannot widen
 * what the page already decided a reader may see, and it stays read-only: the
 * decision controls (Accept / Reject / Defer) arrive in a later slice with the
 * authorization review they deserve.
 *
 * WHY `Drawer` RATHER THAN A NEW PRIMITIVE
 * ----------------------------------------
 * `components/pmfreak/ui/drawer.tsx` already ships the whole §2 contract and is
 * already used by Task Detail — focus moves into the panel on open, the panel is
 * a `role="dialog"` with an accessible name, an explicit Close control exists,
 * Escape closes, and the effect's cleanup returns focus to whatever was focused
 * when it opened, which is this trigger. Reused rather than reimplemented, so no
 * UI dependency was added. Its focus trap is the dialog pattern's own requirement
 * and is implemented there, not invented here.
 */
export function SupportingRaidEvidencePanel({
  label,
  record,
}: {
  /**
   * The named evidence input, exactly as the Evidence line reads it — governed
   * noun plus the stored title. The trigger's accessible name IS this text and
   * the panel's title restates it, so activating "Risk — Vendor approval may
   * delay launch" opens a panel announced as that same record.
   */
  label: string;
  record: SupportingRaidPanelRecord;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        A real control, styled as the evidence link it replaces: Tab reaches it,
        Enter and Space activate it, and `focus-visible` gives it a ring that is
        not carried by colour alone (§3's focus-appearance rule). `aria-haspopup`
        plus `aria-expanded` tell an assistive technology what it opens and
        whether it is currently open — neither of which the old anchor could say.
      */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="rounded-sm text-cyan-800 underline underline-offset-2 hover:text-cyan-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
      >
        {label}
      </button>
      {/*
        Portalled to `document.body`, for the reason any overlay is: this trigger
        sits inside the Evidence line's running text, and a block-level dialog is
        not valid content inside a paragraph — the parser would reparent it out
        from under the claim it belongs to. The portal also keeps the
        fixed-position panel clear of any ancestor that might later establish a
        containing block and clip it. It is reached only when `open`, which a
        server render can never be, so `document` is always there when it runs.

        Dismissal — the Close control, Escape, or the scrim — unmounts the Drawer,
        whose cleanup returns focus to this exact trigger. Portalling changes none
        of that: the effect captured the trigger before focus moved, and one panel
        is open at a time, so two Recommendations citing one record never disagree
        about where focus goes back to.
      */}
      {open
        ? createPortal(
            <Drawer title={record.panelTitle} onClose={() => setOpen(false)} testId="supporting-raid-evidence-panel">
              <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{record.categoryLabel}</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{record.title}</p>
              <p className="mt-1 text-xs text-slate-600">{record.description}</p>
              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600">
                <div>
                  {/*
                    The stored value under a label saying so. This panel is
                    historical inspection, not a queue, so a closed or resolved
                    record reads exactly as it is stored and nothing here implies
                    it has to be looked at now.
                  */}
                  <dt className="inline text-zinc-500">Recorded status: </dt>
                  <dd className="inline">{record.status}</dd>
                </div>
                <div>
                  {/*
                    The RAID item's OWN number, read from the row rather than from
                    the producer's frozen copy — the same source the Evidence line
                    that opened this panel now uses, which is what stops one screen
                    stating two different detection confidences for one record.
                  */}
                  <dt className="inline text-zinc-500">Detection confidence: </dt>
                  <dd className="inline">
                    {record.detectionConfidence === null ? "not recorded" : `${record.detectionConfidence}%`}
                  </dd>
                </div>
                {record.occurrenceCount !== null ? (
                  <div>
                    <dt className="inline text-zinc-500">Times detected: </dt>
                    <dd className="inline">{record.occurrenceCount}</dd>
                  </div>
                ) : null}
                {record.lastDetected ? (
                  <div>
                    <dt className="inline text-zinc-500">Last detected: </dt>
                    <dd className="inline">{record.lastDetected}</dd>
                  </div>
                ) : null}
              </dl>
              {record.autoGenerated ? (
                <p className="mt-3 text-[11px] text-zinc-500">
                  Detected automatically from this project&apos;s documents. Not a human-certified governance record.
                </p>
              ) : null}
              <p className="mt-3 text-[11px] text-zinc-500">
                Shown for inspection, exactly as stored — a record here may already be closed or resolved.
              </p>
            </Drawer>,
            document.body,
          )
        : null}
    </>
  );
}
