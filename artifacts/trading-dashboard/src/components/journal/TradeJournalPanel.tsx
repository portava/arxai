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
        <div className="text-xs uppercase tracking-wide text-zinc-500">Journal entries</div>
        {entries.length === 0 && <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-500">No entries yet.</div>}
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => setSel(e.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                  sel === e.id ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100" : "border-zinc-800 bg-zinc-950/50 text-zinc-300 hover:bg-zinc-900"
                }`}>
                <div className="font-medium">{e.symbol} · {e.direction}</div>
                <div className="text-[10px] text-zinc-500">{new Date(e.createdAtIso).toLocaleString()}</div>
                {(e.mistakeTags.length > 0 || e.strengthTags.length > 0) && (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    {e.mistakeTags.slice(0, 2).map((t) => <span key={t} className="rounded-full bg-rose-500/15 px-1.5 text-rose-300">{t}</span>)}
                    {e.strengthTags.slice(0, 2).map((t) => <span key={t} className="rounded-full bg-emerald-500/15 px-1.5 text-emerald-300">{t}</span>)}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section>
        {sel == null ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-6 text-sm text-zinc-500">Select an entry to review.</div>
        ) : (
          <JournalEntryDetail entryId={sel} />
        )}
      </section>
    </div>
  );
}
