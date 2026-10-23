import { PlaybookEntryCard } from "./PlaybookEntryCard";
import type { PlaybookEntry } from "./types";

const BEST_TYPES = new Set(["BEST_SETUP", "STRENGTH_PATTERN"]);

export function BestSetupsSection({ entries, onToggle }:
  { entries: PlaybookEntry[]; onToggle?: (id: number, next: boolean) => void }) {
  const items = entries.filter((e) => BEST_TYPES.has(e.entryType));
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-emerald-200">✓ Best setups & strengths ({items.length})</h2>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-slate-700 p-3 text-center text-xs text-slate-500">
          No best setups yet — accept AI suggestions or add a strength manually.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((e) => <li key={e.id}><PlaybookEntryCard entry={e} onToggle={onToggle} /></li>)}
        </ul>
      )}
    </section>
  );
}
