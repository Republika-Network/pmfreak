import Link from "next/link";

const ACTION_LABELS: Record<string, string> = {
  "ai.execute": "Run AI action",
  "document.upload": "Upload document",
  "billing.manage": "Manage billing",
  "members.manage": "Manage team members",
  "ai.manage": "Configure AI settings",
  "workspace.manage": "Manage workspace",
  "project.read": "Read project",
  "project.write": "Edit project",
  "memory.read": "Read memory",
  "memory.write": "Write memory",
  "executive.view": "View executive dashboard",
  "privileged.use": "Privileged system access",
  "knowledge.ratify": "Ratify project knowledge",
  "knowledge.reject": "Reject learning candidate",
  "knowledge.revoke": "Revoke project knowledge",
};

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return "just now";
  const diffMin = Math.floor(diffS / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} hour${diffH === 1 ? "" : "s"} ago`;
  const d = new Date(iso);
  const currentYear = new Date().getFullYear();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const base = `${months[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === currentYear ? base : `${base}, ${d.getFullYear()}`;
}

function formatExpiry(iso: string): { text: string; expired: boolean } {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = then - now;
  if (diffMs <= 0) {
    const ago = formatRelative(iso);
    return { text: `Expired ${ago}`, expired: true };
  }
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return { text: `Expires in ${diffMin} minute${diffMin === 1 ? "" : "s"}`, expired: false };
  const diffH = Math.floor(diffMin / 60);
  return { text: `Expires in ${diffH} hour${diffH === 1 ? "" : "s"}`, expired: false };
}

const RISK_BADGE: Record<string, string> = {
  critical: "bg-rose-500/20 border border-rose-400/40 text-rose-200",
  high: "bg-amber-500/20 border border-amber-400/40 text-amber-200",
  medium: "bg-yellow-500/20 border border-yellow-400/40 text-yellow-200",
  low: "bg-slate-500/20 border border-slate-400/40 text-slate-300",
};

interface ApprovalCardProps {
  id: string;
  action: string;
  riskLevel: string;
  actorLabel: string;
  reason: string;
  status: string;
  requestedAt: string;
  expiresAt?: string | null;
  grantStatus?: string | null;
}

export function ApprovalCard({
  id,
  action,
  riskLevel,
  actorLabel,
  reason,
  status,
  requestedAt,
  expiresAt,
  grantStatus,
}: ApprovalCardProps) {
  const actionLabel = ACTION_LABELS[action] ?? null;
  const badgeClass = RISK_BADGE[riskLevel] ?? RISK_BADGE.low;
  const truncatedReason = reason && reason.length > 300 ? reason.slice(0, 300) + "…" : reason;

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-100">
          {actionLabel ?? <span className="font-mono">{action}</span>}
        </p>
        <span className={`rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wide ${badgeClass}`}>
          {riskLevel}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-400">
        Requested by {actorLabel} · {formatRelative(requestedAt)}
      </p>

      {truncatedReason ? (
        <p className="mt-3 text-base leading-relaxed text-slate-200">{truncatedReason}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {status === "pending_approval" ? (
          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-200">
            Pending
          </span>
        ) : status === "approved" ? (
          <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200">
            Approved
          </span>
        ) : status === "rejected" ? (
          <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-medium text-rose-200">
            Rejected
          </span>
        ) : status === "expired" ? (
          <span className="rounded-full border border-slate-400/30 bg-slate-500/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
            Expired
          </span>
        ) : (
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
            {status}
          </span>
        )}

        {grantStatus ? (
          <span className="text-xs text-slate-400">Grant: {grantStatus}</span>
        ) : null}

        <Link href="/audit" className="ml-auto text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors">
          View audit trace →
        </Link>
      </div>

      {expiresAt && status === "pending_approval" ? (() => {
        const { text, expired } = formatExpiry(expiresAt);
        return (
          <p className={`mt-1 text-xs ${expired ? "text-rose-300" : "text-slate-400"}`}>{text}</p>
        );
      })() : null}

      {status === "pending_approval" ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <form action={`/api/governance/approvals/${id}/approve`} method="post" className="flex-1 sm:flex-none">
            <button
              className="w-full rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/25 sm:w-auto"
              type="submit"
            >
              Approve
            </button>
          </form>
          <form action={`/api/governance/approvals/${id}/reject`} method="post" className="flex-1 sm:flex-none">
            <button
              className="w-full rounded-lg border border-rose-400/35 bg-rose-500/15 px-4 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-500/25 sm:w-auto"
              type="submit"
            >
              Reject
            </button>
          </form>
        </div>
      ) : null}
    </article>
  );
}
