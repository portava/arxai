import { useState } from "react";
import { useListRichJournalEntries, getListRichJournalEntriesQueryKey } from "@workspace/api-client-react";
import { JournalEntryDetail } from "./JournalEntryDetail";

// Build I — top-level journal page: list on the left, detail on the right.
export function TradeJournalPanel() {
  const { data } = useListRichJournalEntries({ limit: 50 }, { query: { queryKey: getListRichJournalEntriesQueryKey({ limit: 50 }), refetchInterval: 15_000 } });
  const [sel, setSel] = useState<number | null>(null);
  const entries = data?.entries ?? [];
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-txt-muted">Journal entries</div>
        {entries.length === 0 && <div className="rounded-lg border border-border bg-background/50 p-3 text-xs text-txt-muted">No entries yet.</div>}
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => setSel(e.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                  sel === e.id ? "border-success/40 bg-success/10 text-success" : "border-border bg-background/50 text-txt-secondary hover:bg-card"
                }`}>
                <div className="font-medium">{e.symbol} · {e.direction}</div>
                <div className="text-[10px] text-txt-muted">{new Date(e.createdAtIso).toLocaleString()}</div>
                {(e.mistakeTags.length > 0 || e.strengthTags.length > 0) && (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    {e.mistakeTags.slice(0, 2).map((t) => <span key={t} className="rounded-full bg-danger/15 px-1.5 text-danger">{t}</span>)}
                    {e.strengthTags.slice(0, 2).map((t) => <span key={t} className="rounded-full bg-success/15 px-1.5 text-success">{t}</span>)}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section>
        {sel == null ? (
          <div className="rounded-lg border border-border bg-background/50 p-6 text-sm text-txt-muted">Select an entry to review.</div>
        ) : (
          <JournalEntryDetail entryId={sel} />
        )}
      </section>
    </div>
  );
}
