"use client";

export default function ProtectedError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const requestId = error.digest ?? null;
  return <main className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm">
    <h2 className="text-xl font-semibold">We hit a protected-area error</h2>
    <p className="mt-2 text-slate-800">Please retry. If this continues, contact support with the request ID.</p>
    {requestId ? <p className="mt-2 text-xs text-slate-700">Request ID: {requestId}</p> : null}
    <div className="mt-4 flex gap-2"><button className="rounded bg-slate-50 px-3 py-2" onClick={() => reset()}>Retry</button><a className="rounded bg-slate-50 px-3 py-2" href="/command-center">Go to Command Center</a></div>
  </main>;
}
