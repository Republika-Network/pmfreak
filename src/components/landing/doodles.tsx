import Image from "next/image";

// Hand-drawn marks in the mascot's punk/tattoo register: thick round-capped
// strokes, slightly off-true, orange on the freaked side and teal on the calm side.
// Decorative only — every use is aria-hidden.

type DoodleProps = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 3.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Stress marks: three short burst lines. */
export function Burst({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 40 40" className={className}>
      <path {...stroke} d="M6 22 L15 20 M10 8 L17 15 M22 4 L22.5 13" />
    </svg>
  );
}

/** Four-point sparkle, the calm side's mark. */
export function Sparkle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 40 40" className={className}>
      <path {...stroke} strokeWidth={2.6} d="M20 3 C21.5 14 25 18.5 37 20 C25 21.5 21.5 26 20 37 C18.5 26 15 21.5 3 20 C15 18.5 18.5 14 20 3 Z" />
    </svg>
  );
}

export function SquiggleArrow({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 120 70" className={className}>
      <path {...stroke} d="M6 10 C40 4 58 22 46 38 C36 52 18 40 34 30 C52 18 84 30 108 58" />
      <path {...stroke} d="M92 56 L109 59 L104 42" />
    </svg>
  );
}

export function TaskDoodle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={className}>
      <path {...stroke} d="M10 12 C24 10 40 11 52 12 C53 26 53 40 52 53 C38 54 24 54 11 53 C10 40 10 26 10 12 Z" />
      <path {...stroke} strokeWidth={4.2} d="M20 32 L29 41 L47 20" />
    </svg>
  );
}

export function DecisionDoodle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={className}>
      <path {...stroke} d="M32 8 L32 56 M32 20 L52 20 L57 26 L52 32 L32 32 M32 36 L13 36 L8 42 L13 48 L32 48" />
    </svg>
  );
}

export function RiskDoodle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={className}>
      <path {...stroke} d="M32 7 C40 22 49 37 58 53 C41 55 23 55 6 53 C14 37 23 22 32 7 Z" />
      <path {...stroke} strokeWidth={4.2} d="M32 24 L32 39 M32 46 L32 46.5" />
    </svg>
  );
}

export function LinkDoodle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={className}>
      <path {...stroke} d="M27 37 C21 43 17 47 14 50 C9 55 2 48 7 43 L20 30 C25 25 31 27 33 31" />
      <path {...stroke} d="M37 27 C43 21 47 17 50 14 C55 9 62 16 57 21 L44 34 C39 39 33 37 31 33" />
    </svg>
  );
}

export function QuestionMark({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 40 56" className={className}>
      <path {...stroke} strokeWidth={4.5} d="M8 16 C8 6 20 2 28 7 C36 12 32 22 24 26 C20 28 20 32 20 36 M20 46 L20 47" />
    </svg>
  );
}

export function PaperDoodle({ className = "" }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={className}>
      <path {...stroke} d="M14 8 L42 6 L52 16 L54 56 L16 58 Z M42 6 L42 16 L52 16 M22 26 L44 25 M22 35 L45 34 M22 44 L36 44" />
    </svg>
  );
}

/**
 * The canonical split-face mascot (palette-2026 recolor), never a redraw.
 * The artwork is transparent inside its outlines, so on dark surfaces it needs
 * an off-white backing until a designer-made dark-surface master exists.
 */
export function Mascot({
  size,
  onDark = false,
  className = "",
  alt = "",
  preload = false,
}: {
  size: number;
  onDark?: boolean;
  className?: string;
  alt?: string;
  preload?: boolean;
}) {
  const image = (
    <Image
      src="/brand/palette-2026/pmfreak-face-trimmed.png"
      alt={alt}
      width={size}
      height={Math.round((size * 606) / 665)}
      preload={preload}
      className="h-full w-full object-contain"
    />
  );
  if (!onDark) return <div className={className}>{image}</div>;
  return (
    <div className={`rounded-full border-[5px] border-charcoal! flex items-center justify-center bg-off-white p-3 shadow-[0_0_0_2px_rgba(127,225,193,0.55),0_18px_40px_rgba(0,0,0,0.55)] ${className}`}>
      {image}
    </div>
  );
}
