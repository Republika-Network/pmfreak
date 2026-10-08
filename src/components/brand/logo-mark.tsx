import Image from "next/image";
import Link from "next/link";

const sizeClasses = {
  small: "h-9 w-9",
  navbar: "h-[120px] w-[120px]",
  large: "h-28 w-28",
} as const;

// "palette2026" is the original split-face artwork with only its accent hues
// swapped to the 2026 palette (pink -> Freak Orange, cyan -> Calm Teal). It is
// opt-in while the recolor awaits approval; the original stays the default.
const logoSources = {
  original: "/assets/nuevologoletras.png",
  palette2026: "/brand/palette-2026/pmfreak-logo-wordmark.png",
} as const;

type LogoMarkProps = {
  size?: keyof typeof sizeClasses;
  href?: string;
  priority?: boolean;
  className?: string;
  imageClassName?: string;
  variant?: keyof typeof logoSources;
};

export function LogoMark({ size = "navbar", href = "/", priority = false, className = "", imageClassName = "", variant = "original" }: LogoMarkProps) {
  const shellClass = `relative inline-flex items-center justify-center   from-[#fffcf4] to-[#f1e8d8]   ${sizeClasses[size]} ${className}`;

  return (
    <Link href={href} aria-label="PMFreak Home" className={shellClass}>
      <span className="absolute inset-0  " aria-hidden />
      <Image
        src={logoSources[variant]}
        alt="PM Freak"
        width={96}
        height={96}
        priority={priority}
        className={`relative h-full w-full object-contain ${imageClassName}`}
      />
    </Link>
  );
}

/**
 * Horizontal lockup for dark surfaces (the 2026 landing navbar). Both images are
 * pixel crops of the palette-2026 wordmark artwork, not redraws. The face is
 * transparent inside its outlines, so it sits on an off-white disc on charcoal.
 */
export function LogoLockupOnDark({ href = "/", preload = false }: { href?: string; preload?: boolean }) {
  return (
    <Link href={href} aria-label="PMFreak Home" className="inline-flex items-center gap-2.5">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-off-white p-1 ring-2 ring-mint/60">
        <Image src="/brand/palette-2026/pmfreak-face-trimmed.png" alt="" width={80} height={73} preload={preload} className="h-full w-full object-contain" />
      </span>
      <Image src="/brand/palette-2026/pmfreak-lettering-trimmed.png" alt="PMFreak" width={142} height={39} preload={preload} className="h-8 w-auto" />
    </Link>
  );
}
