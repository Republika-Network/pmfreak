import type { MemoryItem, RepositoryItem } from "./types";
import { REPOSITORY_ICONS } from "./icons";
import { SectionEmptyState } from "./section-empty-state";

export function ProjectRepository({
  items,
  onAddNotes,
  onSelect,
}: {
  items: RepositoryItem[];
  onAddNotes?: () => void;
  /** Opens a source's detail. Without it the rows are a plain inventory. */
  onSelect?: (item: RepositoryItem) => void;
}) {
  const total = items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Project Repository</p>
      </div>
      {total === 0 ? (
        <SectionEmptyState
          title="No project signals yet"
          description="PMFreak learns from your project updates, notes and decisions. Nothing has been recorded for this project."
          ctaLabel="Add first project notes"
          onCta={onAddNotes}
        />
      ) : (
        <>
          <p className="mt-1 px-1 text-[11px] leading-relaxed text-slate-500">Everything the project knows lives here.</p>
          <ul className="mt-2 space-y-0.5">
            {items.map((item) => {
              const Icon = REPOSITORY_ICONS[item.icon];
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={onSelect ? () => onSelect(item) : undefined}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-100"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {item.count !== undefined && <span className="shrink-0 text-xs text-slate-500">{item.count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function ProjectMemory({
  items,
  open,
  onToggle,
  onAddNotes,
}: {
  items: MemoryItem[];
  open: boolean;
  onToggle: () => void;
  onAddNotes?: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-700"
      >
        <span>Project Memory</span>
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open &&
        (items.length === 0 ? (
          <SectionEmptyState
            title="No project memory available yet"
            description="Memory builds up from recorded decisions, risks and commitments as you work."
            ctaLabel="Add notes through Vault Intake"
            onCta={onAddNotes}
          />
        ) : (
          <ul className="mt-2 space-y-0.5">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * When this project last saw real activity, from `deriveLastUpdatedLabel` — the
 * server-anchored freshness the Command Center's top bar used to state. Renders
 * nothing when no trustworthy answer exists; it never says "just now" by default.
 */
export function LastUpdatedNote({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <p className="px-1 text-[11px] text-slate-500" data-testid="cc-last-updated">
      Updated {label}
    </p>
  );
}
