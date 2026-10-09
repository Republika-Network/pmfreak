import Link from "next/link";

type FooterLink = { label: string; href: string } | { label: string; disabled: true };

// The public-site footer (landing, pricing). Section anchors point at the landing:
// same-page "#…" links there, "/#…" from every other page. Requires a `.pmf-brand`
// or `.pmf-landing` ancestor for the brand focus ring.
const footerColumns: readonly { heading: string; links: readonly FooterLink[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Product", href: "#intelligence" },
      { label: "How it Works", href: "#how-it-works" },
      { label: "Pricing", href: "/pricing" },
      { label: "Command Center", href: "/command-center" },
    ],
  },
  {
    heading: "Use Cases",
    links: [
      { label: "PMOs", disabled: true },
      { label: "Delivery Teams", disabled: true },
      { label: "Technical PMs", disabled: true },
      { label: "Consulting Teams", disabled: true },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", disabled: true },
      { label: "Contact", disabled: true },
      { label: "Roadmap", disabled: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy Policy", disabled: true },
      { label: "Terms of Service", disabled: true },
      { label: "Security", href: "#security" },
    ],
  },
];

export function MarketingFooter({ onHomepage = false }: { onHomepage?: boolean } = {}) {
  const resolve = (href: string) => (href.startsWith("#") && !onHomepage ? `/${href}` : href);
  return (
    <footer className="pmf-on-dark bg-charcoal py-12 text-off-white/80">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-4">
          {footerColumns.map((column) => (
            <div key={column.heading}>
              <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-off-white">{column.heading}</h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"disabled" in link ? (
                      <span className="cursor-default text-off-white/50">{link.label}</span>
                    ) : (
                      <Link href={resolve(link.href)} className="transition hover:text-mint">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 border-t border-white/10 pt-6">
          <p className="text-sm font-semibold text-off-white">PMFreak</p>
          <p className="mt-1 text-xs text-off-white/70">
            PMFreak helps teams keep, protect, and use what they learn from every project.
          </p>
          <p className="mt-3 text-xs text-off-white/60">© {new Date().getFullYear()} PMFreak. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
