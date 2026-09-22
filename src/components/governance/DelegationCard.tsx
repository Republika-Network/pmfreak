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

interface DelegationCardProps {
  id: string;
  action: string;
  requestedPermission: string;
  delegateeLabel: string;
  workspaceId: string;
  projectId?: string | null;
  usesCount: number;
  maxUses: number | null;
  expiresAt?: string | null;
  status: string;
}

export function DelegationCard({
  id,
  action,
  requestedPermission,
  delegateeLabel,
  workspaceId,
  usesCount,
  maxUses,
  expiresAt,
  status,
}: DelegationCardProps) {
  const actionLabel = ACTION_LABELS[action] ?? null;
  const usagePct = maxUses ? Math.min((usesCount / maxUses) * 100, 100) : null;
  const expiry = expiresAt ? formatExpiry(expiresAt) : null;

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-100">
          {actionLabel ?? <span className="font-mono">{action}</span>}
        </p>
        {status === "active" ? (
          <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200">
            Active
          </span>
        ) : status === "revoked" ? (
          <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-medium text-rose-200">
            Revoked
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
      </div>

      <p className="mt-1 text-xs text-slate-400">
        Delegated to {delegateeLabel} · Permission: {requestedPermission}
      </p>

      <div className="mt-3">
        {maxUses === null ? (
          <p className="text-xs text-slate-400">Unlimited uses</p>
        ) : (
          <div>
            <p className="mb-1 text-xs text-slate-400">{usesCount} of {maxUses} uses</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/50">
              <div
                className="h-full rounded-full bg-cyan-500/30"
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {expiry ? (
        <p className={`mt-2 text-xs ${expiry.expired ? "text-rose-300" : "text-slate-400"}`}>
          {expiry.text}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3">
        <Link href="/audit" className="text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors">
          View delegation lineage →
        </Link>

        {status === "active" ? (
          <form action="/api/governance/delegations/revoke" method="post">
            <input type="hidden" name="delegationId" value={id} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <button
              className="rounded-lg border border-amber-300/35 bg-amber-400/15 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/25"
              type="submit"
            >
              Revoke
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}
