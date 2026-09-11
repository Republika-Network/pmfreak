"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyPMO } from "@/components/pmfreak/empty-states";
import { pmoChatPath, pmoHomePath } from "@/lib/pmos/pmo-paths";

export type PmoAdminProject = { id: string; name: string; status: string };
export type PmoAdminPmo = {
  id: string;
  /**
   * The PMO's OWN parent workspace, straight off its `pmos` row (it is part of
   * `PMO_SELECTABLE_COLUMNS`, so both the server props and `GET /api/pmos` already
   * carry it).
   *
   * This is what makes the canonical links below honest. The alternative — asking
   * the shell which workspace it thinks it is in — would rebuild the exact defect
   * this route family removes: a PMO's link would depend on the viewer's current
   * context instead of on the PMO, so the same row could point at two different
   * URLs. `pmos.workspace_id` is the only authority for a PMO's parent, and it
   * travels with the row.
   */
  workspace_id: string;
  name: string;
  description: string | null;
  pmo_type: string;
  icon: string | null;
  color: string | null;
  status: string;
  projects: PmoAdminProject[];
};

const PMO_TYPE_OPTIONS = [
  { value: "company_pmo", label: "Corporate PMO" },
  { value: "team_portfolio", label: "Team Portfolio" },
  { value: "independent", label: "Independent" },
  { value: "client_portfolio", label: "Client Portfolio" },
  { value: "improvement_program", label: "Improvement Program" },
  { value: "personal", label: "Personal Projects" },
] as const;

const ICON_OPTIONS = ["🏛️", "🏢", "🧭", "📁", "🛠️", "🌐", "🏦", "🎯", "🧪", "🤝"] as const;
const COLOR_OPTIONS = ["#22d3ee", "#818cf8", "#34d399", "#fbbf24", "#f472b6", "#f87171", "#a3e635", "#94a3b8"] as const;

type EditorState = {
  name: string;
  description: string;
  pmoType: string;
  icon: string;
  color: string;
};

const emptyEditor: EditorState = { name: "", description: "", pmoType: "company_pmo", icon: "🏛️", color: "#22d3ee" };

export function PmoAdminClient({ initialPmos }: { initialPmos: PmoAdminPmo[] }) {
  const router = useRouter();
  const [pmos, setPmos] = useState<PmoAdminPmo[]>(initialPmos);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/pmos?includeArchived=true", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { pmos?: PmoAdminPmo[] };
      setPmos(data.pmos ?? []);
    }
    router.refresh();
  }

  async function callApi(input: RequestInfo, init?: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(input, init);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Request failed.");
      }
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setCreating(true);
    setEditingId(null);
    setEditor(emptyEditor);
  }

  function openEdit(pmo: PmoAdminPmo) {
    setCreating(false);
    setEditingId(pmo.id);
    setEditor({
      name: pmo.name,
      description: pmo.description ?? "",
      pmoType: pmo.pmo_type,
      icon: pmo.icon ?? "🏛️",
      color: pmo.color ?? "#22d3ee",
    });
  }

  async function submitEditor() {
    if (!editor.name.trim()) {
      setError("PMO name is required.");
      return;
    }
    const payload = {
      name: editor.name.trim(),
      description: editor.description.trim() || null,
      pmoType: editor.pmoType,
      icon: editor.icon,
      color: editor.color,
    };
    const ok = creating
      ? await callApi("/api/pmos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await callApi(`/api/pmos/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (ok) {
      setCreating(false);
      setEditingId(null);
      setEditor(emptyEditor);
    }
  }

  const editorOpen = creating || editingId !== null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{pmos.length} PMO{pmos.length === 1 ? "" : "s"} in this workspace</p>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]"
        >
          New PMO
        </button>
      </div>

      {error ? <p className="rounded-xl border border-rose-300/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-800">{error}</p> : null}

      {editorOpen ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <h3 className="text-base font-semibold text-slate-900">{creating ? "Create PMO" : "Edit PMO"}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1.5 text-xs uppercase tracking-[0.14em] text-zinc-600">
              Name
              <input
                value={editor.name}
                onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))}
                placeholder="Banco Popular PMO"
                className="block w-full rounded-xl border border-slate-200 bg-[#FCFBF9]/75 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-500"
              />
            </label>
            <label className="space-y-1.5 text-xs uppercase tracking-[0.14em] text-zinc-600">
              Type
              <select
                value={editor.pmoType}
                onChange={(e) => setEditor((s) => ({ ...s, pmoType: e.target.value }))}
                className="block w-full rounded-xl border border-slate-200 bg-[#FCFBF9]/75 px-3 py-2.5 text-sm text-slate-900"
              >
                {PMO_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1.5 text-xs uppercase tracking-[0.14em] text-zinc-600">
            Description
            <input
              value={editor.description}
              onChange={(e) => setEditor((s) => ({ ...s, description: e.target.value }))}
              placeholder="Portfolio governed for this client / division"
              className="block w-full rounded-xl border border-slate-200 bg-[#FCFBF9]/75 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-500"
            />
          </label>
          <div className="flex flex-wrap items-center gap-6">
            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-600">Icon</p>
              <div className="flex flex-wrap gap-1.5">
                {ICON_OPTIONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    onClick={() => setEditor((s) => ({ ...s, icon }))}
                    className={`rounded-lg border px-2 py-1 text-base ${editor.icon === icon ? "border-cyan-300/60 bg-cyan-400/10" : "border-slate-200 bg-white hover:border-slate-200"}`}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-600">Color</p>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_OPTIONS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Color ${color}`}
                    onClick={() => setEditor((s) => ({ ...s, color }))}
                    className={`h-7 w-7 rounded-full border-2 ${editor.color === color ? "border-slate-200" : "border-transparent"}`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitEditor()}
              className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16] disabled:opacity-50"
            >
              {creating ? "Create PMO" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setEditingId(null); }}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:border-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {pmos.length === 0 ? (
          <div className="md:col-span-2">
            <EmptyPMO />
          </div>
        ) : (
          pmos.map((pmo) => (
            <article key={pmo.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4" style={{ borderLeftColor: pmo.color ?? undefined, borderLeftWidth: pmo.color ? 3 : undefined }}>
              <div className="flex items-start justify-between gap-3">
                <Link href={pmoHomePath(pmo.workspace_id, pmo.id)} className="group min-w-0">
                  <p className="truncate text-lg font-semibold text-cyan-900 group-hover:text-cyan-950">
                    <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
                    {pmo.name}
                  </p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                    {PMO_TYPE_OPTIONS.find((o) => o.value === pmo.pmo_type)?.label ?? pmo.pmo_type}
                    {pmo.status === "archived" ? " · Archived" : ""}
                    {" · "}{pmo.projects.length} project{pmo.projects.length === 1 ? "" : "s"}
                  </p>
                </Link>
              </div>
              {pmo.description ? <p className="mt-2 line-clamp-2 text-sm text-zinc-700">{pmo.description}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Link href={pmoHomePath(pmo.workspace_id, pmo.id)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-800 hover:border-cyan-300/40">Open</Link>
                <Link href={pmoChatPath(pmo.workspace_id, pmo.id)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-800 hover:border-cyan-300/40">Chat</Link>
                <button type="button" disabled={busy} onClick={() => openEdit(pmo)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-800 hover:border-cyan-300/40 disabled:opacity-50">Edit</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void callApi(`/api/pmos/${pmo.id}/duplicate`, { method: "POST" })}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-800 hover:border-cyan-300/40 disabled:opacity-50"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void callApi(`/api/pmos/${pmo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: pmo.status === "archived" ? "active" : "archived" }) })}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-800 hover:border-amber-300/40 disabled:opacity-50"
                >
                  {pmo.status === "archived" ? "Restore" : "Archive"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const projectNote = pmo.projects.length > 0 ? ` Its ${pmo.projects.length} project(s) will be kept and left unassigned.` : "";
                    if (window.confirm(`Delete PMO "${pmo.name}"? This cannot be undone.${projectNote}`)) {
                      void callApi(`/api/pmos/${pmo.id}`, { method: "DELETE" });
                    }
                  }}
                  className="rounded-lg border border-rose-300/25 px-2.5 py-1.5 text-rose-800 hover:border-rose-300/50 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
