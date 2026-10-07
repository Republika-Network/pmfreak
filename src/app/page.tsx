import type { Metadata } from "next";
import Link from "next/link";

import { HeroSection } from "@/components/landing/hero-section";
import { MarketingNavbar } from "@/components/marketing-navbar";

type FooterLink =
  | { label: string; href: string }
  | { label: string; disabled: true };

type FooterColumn = {
  heading: string;
  links: readonly FooterLink[];
};

export const metadata: Metadata = {
  description:
    "PMFreak is an operational command center for project memory, decisions, evidence and AI-assisted execution.",
};

const scatteredSignals = [
  ["Slack", "Stakeholder escalation"],
  ["Meeting", "Architecture changed"],
  ["Docs", "New dependency"],
  ["Email", "Vendor date moved"],
  ["Issue", "Release blocker"],
  ["AI", "Draft recommendation"],
] as const;

const memoryEvents = [
  ["JUL 08", "Scope approved", "Confirmed"],
  ["JUL 14", "Architecture changed", "Current"],
  ["JUL 21", "Vendor dependency introduced", "Current"],
  ["AUG 02", "Decision superseded", "Superseded"],
  ["AUG 07", "Production plan approved", "Current"],
] as const;

const agentRows = [
  ["Research agent", "Evidence + project context", "Complete"],
  ["Planning agent", "Constraints + current decisions", "Working"],
  ["Execution agent", "Approved action boundary", "Waiting"],
] as const;

const footerColumns = [
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
] as const satisfies readonly FooterColumn[];

function FragmentationSection() {
  return (
    <section id="intelligence" className="scroll-mt-28 overflow-hidden border-b border-zinc-200 bg-white">
      <div className="mx-auto grid w-full max-w-[1320px] gap-14 px-5 py-24 md:px-8 lg:grid-cols-[0.75fr_1.25fr] lg:items-center lg:px-12 lg:py-32">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#ff008c]">
            The operating problem
          </p>
          <h2 className="mt-4 max-w-xl text-4xl font-black leading-[0.96] tracking-[-0.045em] text-zinc-950 md:text-6xl">
            Projects don&apos;t fail because they lack tasks.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-8 text-zinc-500">
            They fail when the context behind the work gets fragmented. PMFreak reconnects the signals that explain what changed, why it matters, and what needs attention now.
          </p>
        </div>

        <div className="relative min-h-[540px]">
          <div className="absolute left-1/2 top-1/2 h-[330px] w-[330px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-200 bg-[#faf9f7] shadow-[0_30px_90px_rgba(24,24,27,.09)]">
            <div className="absolute inset-8 rounded-full border border-dashed border-zinc-300" />
            <div className="absolute inset-16 flex flex-col items-center justify-center rounded-full bg-zinc-950 text-center text-white shadow-[0_20px_70px_rgba(24,24,27,.22)]">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">PMFreak</span>
              <span className="mt-2 text-2xl font-black tracking-[-0.04em]">Project Brain</span>
              <span className="mt-2 max-w-[150px] text-xs leading-5 text-zinc-400">Grounded operational context</span>
            </div>
          </div>

          {scatteredSignals.map(([source, signal], index) => {
            const positions = [
              "left-[1%] top-[5%]",
              "right-[2%] top-[12%]",
              "left-[0%] top-[42%]",
              "right-[0%] top-[48%]",
              "left-[10%] bottom-[3%]",
              "right-[9%] bottom-[2%]",
            ];
            return (
              <div
                key={signal}
                className={`absolute w-[190px] rounded-2xl border border-zinc-200 bg-white p-3 shadow-[0_18px_50px_rgba(24,24,27,.09)] ${positions[index]}`}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#ff008c]" />
                  <span className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-400">{source}</span>
                </div>
                <p className="mt-2 text-xs font-bold text-zinc-800">{signal}</p>
              </div>
            );
          })}

          <svg viewBox="0 0 700 540" className="pointer-events-none absolute inset-0 h-full w-full" fill="none" aria-hidden>
            <path d="M132 70 C228 96 250 172 305 220" stroke="rgba(255,0,140,.22)" strokeWidth="1.5" strokeDasharray="5 7" />
            <path d="M574 92 C500 120 466 168 400 220" stroke="rgba(34,211,238,.28)" strokeWidth="1.5" strokeDasharray="5 7" />
            <path d="M125 270 C212 264 252 270 305 270" stroke="rgba(24,24,27,.18)" strokeWidth="1.5" strokeDasharray="5 7" />
            <path d="M578 300 C490 292 451 282 398 272" stroke="rgba(24,24,27,.18)" strokeWidth="1.5" strokeDasharray="5 7" />
            <path d="M174 484 C226 420 267 374 318 320" stroke="rgba(34,211,238,.28)" strokeWidth="1.5" strokeDasharray="5 7" />
            <path d="M532 486 C480 422 438 374 387 320" stroke="rgba(255,0,140,.22)" strokeWidth="1.5" strokeDasharray="5 7" />
          </svg>
        </div>
      </div>
    </section>
  );
}

function CommandCenterSection() {
  return (
    <section id="how-it-works" className="scroll-mt-28 overflow-hidden bg-[#0b0b0d] text-white">
      <div className="mx-auto w-full max-w-[1440px] px-5 py-24 md:px-8 lg:px-12 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-cyan-200">Command Center</p>
            <h2 className="mt-4 text-4xl font-black leading-[0.94] tracking-[-0.05em] md:text-6xl">
              See the project the way it actually is.
            </h2>
          </div>
          <p className="max-w-xl text-base leading-7 text-zinc-400 lg:justify-self-end">
            PMFreak puts current context, attention-worthy signals, decisions and agent activity in one operational surface instead of another undifferentiated dashboard.
          </p>
        </div>

        <div className="relative mt-14 overflow-hidden rounded-[2rem] border border-white/10 bg-[#111114] p-3 shadow-[0_40px_120px_rgba(0,0,0,.5)] md:p-5">
          <div className="pointer-events-none absolute -right-20 top-0 h-72 w-72 rounded-full bg-cyan-300/10 blur-[100px]" />
          <div className="pointer-events-none absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-[#ff008c]/10 blur-[110px]" />

          <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#f8f8f6] text-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="h-3 w-3 rounded-full bg-[#ff008c]" />
                <span className="text-sm font-black">PMFreak / Command Center</span>
              </div>
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-400">Current operational state</span>
            </div>

            <div className="grid min-h-[600px] lg:grid-cols-[0.72fr_1.45fr_0.85fr]">
              <aside className="border-b border-zinc-200 bg-[#efeee9] p-5 lg:border-b-0 lg:border-r">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Workspace</p>
                <div className="mt-5 space-y-2">
                  {[
                    ["Platform migration", "2"],
                    ["ERP rollout", ""],
                    ["Data program", "1"],
                    ["Customer portal", ""],
                  ].map(([label, count], index) => (
                    <div key={label} className={`flex items-center justify-between rounded-xl px-3 py-3 text-xs font-bold ${index === 0 ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-500"}`}>
                      <span>{label}</span>
                      {count ? <span className="rounded-full bg-[#fff0f8] px-2 py-0.5 text-[9px] text-[#c6006c]">{count}</span> : null}
                    </div>
                  ))}
                </div>
                <div className="mt-10 border-t border-zinc-300 pt-5">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Project memory</p>
                  <div className="mt-4 space-y-3 text-xs font-semibold text-zinc-500">
                    <p>Evidence repository</p>
                    <p>Decision history</p>
                    <p>Commitments</p>
                    <p>Outcomes</p>
                  </div>
                </div>
              </aside>

              <div className="p-5 md:p-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#ff008c]">Project intelligence</p>
                    <h3 className="mt-2 text-3xl font-black tracking-[-0.04em]">What changed today?</h3>
                  </div>
                  <span className="rounded-full border border-zinc-200 bg-white px-3 py-2 text-[10px] font-bold text-zinc-500">Evidence grounded</span>
                </div>

                <div className="mt-7 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <p className="text-[9px] font-black uppercase tracking-[0.16em] text-amber-600">Risk changed</p>
                    <p className="mt-2 text-sm font-black">Release confidence decreased</p>
                    <p className="mt-2 text-xs leading-5 text-zinc-500">A vendor date now overlaps the production window.</p>
                  </div>
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <p className="text-[9px] font-black uppercase tracking-[0.16em] text-cyan-700">Commitment</p>
                    <p className="mt-2 text-sm font-black">API validation · Friday</p>
                    <p className="mt-2 text-xs leading-5 text-zinc-500">Owner confirmed. Evidence source attached.</p>
                  </div>
                </div>

                <div className="mt-4 rounded-[1.4rem] border border-zinc-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-400">Operational recommendation</p>
                      <p className="mt-2 max-w-lg text-lg font-black tracking-[-0.025em]">
                        Validate the dependency before keeping the current release date.
                      </p>
                    </div>
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-[#ff008c] shadow-[0_0_18px_rgba(255,0,140,.5)]" />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <span className="rounded-full bg-zinc-950 px-3 py-2 text-[10px] font-bold text-white">Review evidence</span>
                    <span className="rounded-full border border-zinc-200 px-3 py-2 text-[10px] font-bold text-zinc-700">Open decision</span>
                  </div>
                </div>

                <div className="mt-4 rounded-full border border-zinc-200 bg-[#f4f3ef] px-4 py-3 text-xs text-zinc-400">
                  Ask PMFreak what changed, why it matters, or what should happen next...
                </div>
              </div>

              <aside className="border-t border-zinc-200 bg-white p-5 lg:border-l lg:border-t-0">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Needs you</p>
                  <span className="rounded-full bg-[#ff008c] px-2 py-0.5 text-[9px] font-black text-white">2</span>
                </div>

                <div className="mt-5 rounded-2xl border border-[#ffb6dd] bg-[#fff3f9] p-4">
                  <p className="text-[9px] font-black uppercase tracking-[0.16em] text-[#c6006c]">Decision</p>
                  <p className="mt-2 text-sm font-black">Production release</p>
                  <p className="mt-2 text-xs leading-5 text-zinc-600">Evidence changed after the approved plan.</p>
                </div>

                <div className="mt-8">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Agents</p>
                  <div className="mt-4 space-y-2">
                    {agentRows.map(([agent, context, state]) => (
                      <div key={agent} className="rounded-xl border border-zinc-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold">{agent}</span>
                          <span className="text-[9px] font-black uppercase tracking-[0.12em] text-zinc-400">{state}</span>
                        </div>
                        <p className="mt-1 text-[10px] leading-4 text-zinc-500">{context}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-4">
          {[
            ["01", "Grounded in project evidence"],
            ["02", "Knows what changed"],
            ["03", "Escalates what needs judgment"],
            ["04", "Agents work inside project context"],
          ].map(([number, label]) => (
            <div key={number} className="border-t border-white/15 pt-4">
              <p className="text-[10px] font-black text-cyan-200">{number}</p>
              <p className="mt-2 text-sm font-semibold text-zinc-300">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function NeedsYouSection() {
  return (
    <section className="overflow-hidden bg-white">
      <div className="mx-auto grid w-full max-w-[1320px] gap-16 px-5 py-24 md:px-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:px-12 lg:py-32">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#ff008c]">Human judgment</p>
          <h2 className="mt-4 max-w-xl text-5xl font-black leading-[0.92] tracking-[-0.055em] text-zinc-950 md:text-7xl">
            Your attention is the scarce resource.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-8 text-zinc-500">
            PMFreak handles the operational noise and brings forward the moments that need judgment, approval, or a real decision.
          </p>
        </div>

        <div className="relative">
          <div className="space-y-3">
            {[
              ["Evidence classified", "Complete"],
              ["Timeline updated", "Complete"],
              ["Project brief refreshed", "Complete"],
              ["Agent research completed", "Complete"],
              ["Risk state recalculated", "Complete"],
            ].map(([label, state]) => (
              <div key={label} className="flex items-center justify-between border-b border-zinc-200 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-[10px] font-black text-emerald-700">✓</span>
                  <span className="text-sm font-semibold text-zinc-500">{label}</span>
                </div>
                <span className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-300">{state}</span>
              </div>
            ))}
          </div>

          <div className="relative mt-6 overflow-hidden rounded-[1.75rem] border border-zinc-800 bg-zinc-950 p-6 text-white shadow-[0_30px_90px_rgba(24,24,27,.22)] md:p-8">
            <div className="pointer-events-none absolute right-0 top-0 h-36 w-36 rounded-full bg-[#ff008c]/15 blur-3xl" />
            <p className="relative text-[10px] font-black uppercase tracking-[0.2em] text-[#ff77bd]">Decision required</p>
            <div className="relative mt-5 grid gap-6 md:grid-cols-[1fr_0.8fr]">
              <div>
                <h3 className="text-3xl font-black tracking-[-0.04em]">Production release</h3>
                <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">
                  A new dependency was detected after the approved deployment plan.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[9px] font-black uppercase tracking-[0.16em] text-cyan-200">PMFreak recommends</p>
                <p className="mt-2 text-sm font-bold">Delay release until dependency validation is complete.</p>
              </div>
            </div>
            <div className="relative mt-7 flex flex-wrap gap-2">
              <span className="rounded-full bg-white px-4 py-2 text-xs font-bold text-zinc-950">Review evidence</span>
              <span className="rounded-full border border-white/20 px-4 py-2 text-xs font-bold">Decide</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MemorySection() {
  return (
    <section className="border-y border-zinc-200 bg-[#f5f3ee]">
      <div className="mx-auto grid w-full max-w-[1320px] gap-14 px-5 py-24 md:px-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-center lg:px-12 lg:py-32">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#ff008c]">Project memory</p>
          <h2 className="mt-4 text-5xl font-black leading-[0.94] tracking-[-0.05em] text-zinc-950 md:text-6xl">
            Your project shouldn&apos;t forget.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-8 text-zinc-500">
            Keep the history behind decisions, commitments and state changes reachable instead of rebuilding context every time the team changes.
          </p>
        </div>

        <div className="relative rounded-[2rem] border border-zinc-200 bg-white p-5 shadow-[0_28px_90px_rgba(24,24,27,.10)] md:p-7">
          <div className="absolute bottom-10 left-[72px] top-10 w-px bg-zinc-200" />
          <div className="space-y-3">
            {memoryEvents.map(([date, event, state], index) => (
              <div key={date} className="relative grid grid-cols-[58px_1fr_auto] items-center gap-4 rounded-2xl px-2 py-3">
                <span className="font-mono text-[10px] font-bold text-zinc-400">{date}</span>
                <span className="relative pl-7 text-sm font-bold text-zinc-800">
                  <span className={`absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-[3px] border-white shadow-sm ${index === 3 ? "bg-zinc-300" : "bg-[#ff008c]"}`} />
                  {event}
                </span>
                <span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.12em] ${state === "Superseded" ? "bg-zinc-100 text-zinc-500" : state === "Confirmed" ? "bg-cyan-50 text-cyan-700" : "bg-[#fff0f8] text-[#c6006c]"}`}>
                  {state}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-3 border-t border-zinc-100 pt-5 sm:grid-cols-3">
            {[
              ["Source", "Decision record"],
              ["Reason", "Dependency changed"],
              ["Provenance", "Evidence linked"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-[#f7f6f3] p-3">
                <p className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-400">{label}</p>
                <p className="mt-1 text-xs font-bold text-zinc-700">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentsSection() {
  return (
    <section className="overflow-hidden bg-white">
      <div className="mx-auto w-full max-w-[1320px] px-5 py-24 md:px-8 lg:px-12 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#ff008c]">AI-assisted work</p>
          <h2 className="mt-4 text-5xl font-black leading-[0.94] tracking-[-0.05em] text-zinc-950 md:text-6xl">
            Give agents context before giving them work.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-zinc-500">
            Agents operate against project context, evidence and approval boundaries—not a disconnected prompt window.
          </p>
        </div>

        <div className="relative mx-auto mt-16 max-w-5xl">
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-zinc-200 to-transparent" />
          <div className="relative mx-auto flex h-40 w-40 flex-col items-center justify-center rounded-full border border-zinc-200 bg-zinc-950 text-center text-white shadow-[0_24px_70px_rgba(24,24,27,.18)]">
            <span className="text-[9px] font-black uppercase tracking-[0.18em] text-cyan-200">Project Brain</span>
            <span className="mt-2 text-lg font-black">Grounded context</span>
          </div>

          <div className="relative mt-14 grid gap-5 md:grid-cols-3">
            {agentRows.map(([agent, context, state], index) => (
              <div key={agent} className="rounded-[1.5rem] border border-zinc-200 bg-[#f8f7f4] p-5 text-center shadow-sm">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-white text-sm font-black text-[#ff008c] shadow-sm">
                  0{index + 1}
                </div>
                <h3 className="mt-4 text-lg font-black text-zinc-950">{agent}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{context}</p>
                <span className="mt-5 inline-flex rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-zinc-400">{state}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DifferenceSection() {
  return (
    <section className="bg-zinc-950 text-white">
      <div className="mx-auto w-full max-w-[1320px] px-5 py-24 md:px-8 lg:px-12 lg:py-32">
        <p className="text-[11px] font-black uppercase tracking-[0.24em] text-cyan-200">The difference</p>
        <div className="mt-8 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-3xl font-black leading-tight tracking-[-0.04em] text-zinc-500 md:text-5xl">
              Tasks<br />
              Tickets<br />
              Dashboards<br />
              Documents<br />
              Status updates
            </p>
          </div>

          <div className="relative border-l border-white/10 pl-8 md:pl-12">
            <span className="absolute -left-3 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#ff008c] text-xs font-black">→</span>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-[#ff77bd]">PMFreak</p>
            <h2 className="mt-4 text-5xl font-black leading-[0.9] tracking-[-0.055em] md:text-7xl">
              Evidence.<br />
              Context.<br />
              Memory.<br />
              Decisions.<br />
              Execution.
            </h2>
          </div>
        </div>

        <p className="mt-14 max-w-3xl text-xl leading-8 text-zinc-400 md:text-2xl">
          Traditional PM software records work. <span className="font-bold text-white">PMFreak helps teams understand what the work means.</span>
        </p>
      </div>
    </section>
  );
}

function GovernanceSection() {
  return (
    <section id="security" className="scroll-mt-28 bg-[#f6f5f2]">
      <div className="mx-auto grid w-full max-w-[1320px] gap-14 px-5 py-24 md:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:px-12 lg:py-32">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#ff008c]">Governance & control</p>
          <h2 className="mt-4 text-5xl font-black leading-[0.94] tracking-[-0.05em] text-zinc-950 md:text-6xl">
            AI-assisted execution with boundaries.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-8 text-zinc-500">
            Recommendations, decisions, actions and outcomes stay distinct. Sensitive actions can require human approval, while the evidence behind important outputs remains reachable.
          </p>
        </div>

        <div className="relative min-h-[500px] rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-[0_28px_90px_rgba(24,24,27,.09)] md:p-8">
          <div className="grid h-full gap-5 md:grid-cols-[1fr_auto_1fr] md:items-center">
            <div className="space-y-3">
              {["Project context", "Evidence", "Agent proposal"].map((label) => (
                <div key={label} className="rounded-2xl border border-zinc-200 bg-[#f7f6f3] p-4 text-sm font-bold text-zinc-700">
                  {label}
                </div>
              ))}
            </div>

            <div className="flex flex-col items-center gap-3">
              <span className="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-400">Boundary</span>
              <div className="flex h-28 w-28 items-center justify-center rounded-full border border-[#ffb6dd] bg-[#fff2f9] text-center text-[11px] font-black uppercase tracking-[0.12em] text-[#c6006c] shadow-[0_16px_40px_rgba(255,0,140,.12)]">
                Human<br />approval
              </div>
              <span className="text-xl text-zinc-300">→</span>
            </div>

            <div className="rounded-[1.5rem] bg-zinc-950 p-5 text-white">
              <p className="text-[9px] font-black uppercase tracking-[0.16em] text-cyan-200">Governed outcome</p>
              <div className="mt-4 space-y-3">
                {["Decision recorded", "Action authorized", "Evidence preserved"].map((label) => (
                  <div key={label} className="flex items-center gap-3 border-b border-white/10 pb-3 text-sm font-semibold text-zinc-200 last:border-b-0 last:pb-0">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    {label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FoundationSection() {
  return (
    <section className="border-y border-zinc-200 bg-white">
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-8 px-5 py-16 md:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#ff008c]">Governance foundation</p>
          <h2 className="mt-3 text-2xl font-black tracking-[-0.035em] text-zinc-950 md:text-3xl">
            Built on Soberanía Protocol.
          </h2>
        </div>
        <p className="max-w-2xl text-sm leading-7 text-zinc-500">
          PMFreak applies governed identity, authority, approval and evidence concepts to project operations while keeping the product experience focused on the work teams need to run.
        </p>
      </div>
    </section>
  );
}

function FinalCtaSection() {
  return (
    <section className="relative overflow-hidden bg-[#ff008c] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(255,255,255,.35)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.35)_1px,transparent_1px)] [background-size:36px_36px]" />
      <div className="relative mx-auto flex min-h-[520px] w-full max-w-[1320px] flex-col items-center justify-center px-5 py-24 text-center md:px-8 lg:px-12">
        <p className="text-[11px] font-black uppercase tracking-[0.24em] text-white/70">PMFreak</p>
        <h2 className="mt-4 max-w-5xl text-5xl font-black leading-[0.88] tracking-[-0.06em] md:text-8xl">
          Your project already has a brain.
        </h2>
        <p className="mt-6 text-xl font-semibold text-white/80 md:text-2xl">Make it operational.</p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link href="/command-center" className="rounded-full bg-zinc-950 px-6 py-3.5 text-sm font-bold text-white transition hover:-translate-y-0.5">
            Open Command Center
          </Link>
          <Link href="/signup" className="rounded-full border border-white/40 bg-white px-6 py-3.5 text-sm font-bold text-[#c6006c] transition hover:-translate-y-0.5">
            Start Free
          </Link>
        </div>
        <p className="mt-10 text-[10px] font-black uppercase tracking-[0.2em] text-white/60">
          Project intelligence · Memory · Decisions · Agents · Execution
        </p>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="bg-zinc-950 px-5 py-12 text-zinc-400 md:px-8 lg:px-12">
      <div className="mx-auto w-full max-w-[1320px]">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {footerColumns.map((column) => (
            <div key={column.heading}>
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">
                {column.heading}
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"disabled" in link ? (
                      <span className="cursor-default text-zinc-600">{link.label}</span>
                    ) : (
                      <Link href={link.href} className="transition hover:text-white">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-black text-white">PMFreak</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-zinc-500">
              Operational intelligence for project teams.
            </p>
          </div>
          <p className="text-xs text-zinc-600">© {new Date().getFullYear()} PMFreak. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <MarketingNavbar />
      <main className="bg-white text-zinc-950">
        <HeroSection />
        <FragmentationSection />
        <CommandCenterSection />
        <NeedsYouSection />
        <MemorySection />
        <AgentsSection />
        <DifferenceSection />
        <GovernanceSection />
        <FoundationSection />
        <FinalCtaSection />
      </main>
      <LandingFooter />
    </>
  );
}
