import { PlaybookEntryCard } from "./PlaybookEntryCard";
import type { PlaybookEntry } from "./types";

const RULE_TYPES = new Set(["RULE", "RISK_RULE", "ENTRY_RULE", "EXIT_RULE", "MARKET_CONDITION", "SESSION_NOTE"]);

export function PersonalRulesSection({ entries, onToggle }:
  { entries: PlaybookEntry[]; onToggle?: (id: number, next: boolean) => void }) {
  const items = entries.filter((e) => RULE_TYPES.has(e.entryType));
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-sky-200">📜 Personal rules ({items.length})</h2>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-slate-700 p-3 text-center text-xs text-slate-500">
          No rules added yet. Use the form above.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((e) => <li key={e.id}><PlaybookEntryCard entry={e} onToggle={onToggle} /></li>)}
        </ul>
      )}
    </section>
  );
}
