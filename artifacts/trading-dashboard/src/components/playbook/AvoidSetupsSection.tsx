import { PlaybookEntryCard } from "./PlaybookEntryCard";
import type { PlaybookEntry } from "./types";

const AVOID_TYPES = new Set(["AVOID_SETUP", "MISTAKE_PATTERN"]);

export function AvoidSetupsSection({ entries, onToggle }:
  { entries: PlaybookEntry[]; onToggle?: (id: number, next: boolean) => void }) {
  const items = entries.filter((e) => AVOID_TYPES.has(e.entryType));
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-danger">⚠ Avoid these setups & mistakes ({items.length})</h2>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-border p-3 text-center text-xs text-txt-muted">
          No mistake patterns logged — keep debriefing and patterns will surface.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((e) => <li key={e.id}><PlaybookEntryCard entry={e} onToggle={onToggle} /></li>)}
        </ul>
      )}
    </section>
  );
}
