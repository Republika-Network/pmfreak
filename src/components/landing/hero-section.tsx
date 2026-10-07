import Link from "next/link";

const inputSignals = [
  ["Decision", "Architecture baseline approved"],
  ["Risk", "Vendor dependency changed"],
  ["Commitment", "API owner · Friday"],
] as const;

const timeline = [
  ["09:14", "Evidence connected"],
  ["09:18", "Risk state changed"],
  ["09:21", "Recommendation prepared"],
] as const;

export function HeroSection() {
  return (
    <section className="relative isolate overflow-hidden border-y border-zinc-200 bg-[#f7f6f3]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_12%,rgba(255,0,140,0.12),transparent_27%),radial-gradient(circle_at_62%_78%,rgba(34,211,238,0.14),transparent_30%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.42] [background-image:linear-gradient(rgba(24,24,27,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.045)_1px,transparent_1px)] [background-size:34px_34px]" />

      <div className="relative mx-auto grid min-h-[760px] w-full max-w-[1440px] gap-14 px-5 py-16 md:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:px-12 lg:py-24">
        <div className="max-w-xl">
          <div className="mb-7 flex items-center gap-3 text-[11px] font-black uppercase tracking-[0.24em] text-zinc-500">
            <span className="h-2 w-2 rounded-full bg-[#ff008c] shadow-[0_0_18px_rgba(255,0,140,.7)]" />
            Operational intelligence for project teams
          </div>

          <h1 className="text-[clamp(3.4rem,7vw,6.9rem)] font-black leading-[0.86] tracking-[-0.065em] text-zinc-950">
            Run projects with an
            <span className="block text-[#ff008c]">operational brain.</span>
          </h1>

          <p className="mt-8 max-w-lg text-base leading-7 text-zinc-600 md:text-lg">
            PMFreak turns project activity, evidence, decisions and AI-assisted work into continuously grounded operational context.
          </p>

          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              href="/command-center"
              className="rounded-full bg-zinc-950 px-6 py-3.5 text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-zinc-800"
            >
              Open Command Center
            </Link>
            <Link
              href="/signup"
              className="rounded-full border border-zinc-300 bg-white/80 px-6 py-3.5 text-sm font-bold text-zinc-950 backdrop-blur transition hover:-translate-y-0.5 hover:border-zinc-400"
            >
              Start Free
            </Link>
          </div>

          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-zinc-500">
            <span>Project memory</span>
            <span>Decision support</span>
            <span>Human approval</span>
            <span>Evidence trails</span>
          </div>
        </div>

        <div className="relative min-h-[600px] lg:min-h-[660px]">
          <div className="absolute left-[4%] top-[8%] w-[78%] rotate-[-1.5deg] rounded-[2rem] border border-zinc-200 bg-white p-3 shadow-[0_40px_120px_rgba(24,24,27,.18)] md:p-4">
            <div className="overflow-hidden rounded-[1.45rem] border border-zinc-200 bg-[#fbfbfa]">
              <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Project</p>
                  <p className="mt-1 text-sm font-bold text-zinc-950">Platform migration</p>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700">Live context</span>
              </div>

              <div className="grid min-h-[430px] md:grid-cols-[0.72fr_1.35fr_0.8fr]">
                <div className="border-b border-zinc-200 bg-zinc-50 p-4 md:border-b-0 md:border-r">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Projects</p>
                  <div className="mt-4 space-y-2">
                    {["Platform migration", "ERP rollout", "Data program"].map((item, index) => (
                      <div
                        key={item}
                        className={`rounded-xl px-3 py-2.5 text-xs font-semibold ${index === 0 ? "bg-zinc-950 text-white" : "text-zinc-500"}`}
                      >
                        {item}
                      </div>
                    ))}
                  </div>

                  <p className="mt-8 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Memory</p>
                  <div className="mt-3 space-y-2 text-[11px] font-medium text-zinc-500">
                    <p>Evidence</p>
                    <p>Decisions</p>
                    <p>Commitments</p>
                    <p>Outcomes</p>
                  </div>
                </div>

                <div className="relative p-4 md:p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#ff008c]">Project Brain</p>
                      <h2 className="mt-1 text-lg font-black tracking-[-0.03em] text-zinc-950">What changed?</h2>
                    </div>
                    <span className="h-9 w-9 rounded-full border border-zinc-200 bg-white shadow-sm" />
                  </div>

                  <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-400">Signal detected</p>
                        <p className="mt-1 text-sm font-bold text-zinc-950">Deployment dependency changed</p>
                      </div>
                      <span className="rounded-full bg-amber-50 px-2 py-1 text-[9px] font-black uppercase tracking-[0.12em] text-amber-700">Review</span>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-zinc-500">
                      The approved rollout plan references a dependency whose delivery date moved beyond the release window.
                    </p>
                    <div className="mt-4 h-px bg-zinc-100" />
                    <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-400">Grounded in 4 evidence items</p>
                  </div>

                  <div className="mt-4 rounded-2xl bg-zinc-950 p-4 text-white shadow-[0_18px_50px_rgba(24,24,27,.18)]">
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-cyan-200">Recommendation</p>
                    <p className="mt-2 text-sm font-bold">Hold release until dependency validation is complete.</p>
                    <div className="mt-4 flex gap-2">
                      <span className="rounded-full bg-white px-3 py-1.5 text-[10px] font-bold text-zinc-950">Review evidence</span>
                      <span className="rounded-full border border-white/20 px-3 py-1.5 text-[10px] font-bold text-white">Decide</span>
                    </div>
                  </div>

                  <div className="absolute bottom-5 left-5 right-5 rounded-full border border-zinc-200 bg-white px-4 py-3 text-xs font-medium text-zinc-400 shadow-sm">
                    Ask PMFreak about this project...
                  </div>
                </div>

                <div className="border-t border-zinc-200 bg-[#f5f4f1] p-4 md:border-l md:border-t-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Needs you</p>
                  <div className="mt-4 rounded-2xl border border-[#ffb3db] bg-[#fff2f9] p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#c6006c]">Decision</p>
                    <p className="mt-1 text-xs font-bold text-zinc-950">Production release</p>
                    <p className="mt-2 text-[11px] leading-4 text-zinc-600">Evidence changed after approval.</p>
                  </div>

                  <p className="mt-7 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-400">Agents</p>
                  <div className="mt-3 space-y-2">
                    {[
                      ["Research", "Done"],
                      ["Planning", "Working"],
                      ["Execution", "Waiting"],
                    ].map(([name, state]) => (
                      <div key={name} className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-3 py-2">
                        <span className="text-[11px] font-semibold text-zinc-700">{name}</span>
                        <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-400">{state}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="absolute right-[2%] top-[3%] w-[42%] rotate-[3deg] rounded-2xl border border-zinc-200 bg-white/95 p-4 shadow-[0_24px_70px_rgba(24,24,27,.14)] backdrop-blur">
            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-400">Incoming signals</p>
            <div className="mt-3 space-y-2">
              {inputSignals.map(([type, value]) => (
                <div key={value} className="rounded-xl bg-zinc-50 px-3 py-2.5">
                  <p className="text-[9px] font-black uppercase tracking-[0.14em] text-[#ff008c]">{type}</p>
                  <p className="mt-1 text-[11px] font-semibold text-zinc-700">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="absolute bottom-[2%] left-[18%] w-[48%] rotate-[1.5deg] rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-white shadow-[0_28px_80px_rgba(24,24,27,.24)]">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-black uppercase tracking-[0.18em] text-cyan-200">Operational trail</p>
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
            </div>
            <div className="mt-3 space-y-2">
              {timeline.map(([time, label]) => (
                <div key={time} className="flex items-center gap-3 text-[10px]">
                  <span className="font-mono text-zinc-500">{time}</span>
                  <span className="h-px w-5 bg-white/15" />
                  <span className="font-semibold text-zinc-200">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
