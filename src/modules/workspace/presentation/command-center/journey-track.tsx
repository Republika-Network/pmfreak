import {
  JOURNEY_PHASES,
  JOURNEY_PHASE_LABELS,
  describePhaseMark,
  type DecisionJourney,
  type JourneyPhase,
  type JourneyPhaseMark,
} from "./decision-journey";

/**
 * UX-W4 — the human loop indicator.
 *
 *     Decide -> Do -> Verify -> Learn
 *
 * A PRESENTATION model over `DecisionJourney.marks`. Nothing here is persisted, and no
 * phase is inferred from anything this component can see — it renders the marks the pure
 * derivation produced from canonical rows.
 *
 * Accessibility is the point of the markup, not decoration on top of it. The phase is
 * carried three ways that all survive losing colour:
 *
 *   - a text glyph per phase, so a monochrome or high-contrast display still separates
 *     done from current from not started;
 *   - `aria-current="step"` on the current phase;
 *   - a visually hidden sentence per phase ("Do: current step"), so a screen reader hears
 *     the state rather than a bare word whose styling carried the meaning.
 *
 * It is an ordered list because it is one: the phases have a sequence, and a list conveys
 * that to assistive technology without any ARIA at all.
 */

/** Text glyphs, not colour. `not_expected` is an explicit dash — a phase that will never
 *  happen must not look like one that has not happened yet. */
const MARK_GLYPHS: Readonly<Record<JourneyPhaseMark, string>> = Object.freeze({
  complete: "✓",
  current: "●",
  upcoming: "○",
  not_expected: "—",
});

const MARK_CLASSES: Readonly<Record<JourneyPhaseMark, string>> = Object.freeze({
  complete: "text-emerald-300",
  current: "text-sky-300 font-semibold",
  upcoming: "text-zinc-500",
  not_expected: "text-zinc-600",
});

export function JourneyTrack({
  journey,
  className = "",
}: {
  journey: DecisionJourney;
  className?: string;
}) {
  return (
    <ol
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}
      data-testid="cc-journey-track"
      data-journey-phase={journey.phase}
      data-journey-closure={journey.closure}
    >
      {JOURNEY_PHASES.map((phase: JourneyPhase, index) => {
        const mark = journey.marks[phase];
        return (
          <li key={phase} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-[11px] ${MARK_CLASSES[mark]}`}
              data-testid={`cc-journey-phase-${phase}`}
              data-mark={mark}
              {...(mark === "current" ? { "aria-current": "step" as const } : {})}
            >
              <span aria-hidden="true">{MARK_GLYPHS[mark]}</span>
              <span aria-hidden="true">{JOURNEY_PHASE_LABELS[phase]}</span>
              {/* The whole meaning, in words, for anyone not reading the styling. */}
              <span className="sr-only">{describePhaseMark(phase, mark)}</span>
            </span>
            {index < JOURNEY_PHASES.length - 1 && (
              <span aria-hidden="true" className="text-[10px] text-zinc-600">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
