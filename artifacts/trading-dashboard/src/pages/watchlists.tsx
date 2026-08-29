import React, { useState } from "react";
import { useGetWatchlists, useCreateWatchlist, useDeleteWatchlist, useAddWatchlistItem, useDeleteWatchlistItem, useToggleWatchlistItemFavorite, getGetWatchlistsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Star, Plus, Trash2, ListChecks } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { STATUS_COLORS, directionTone } from "@/lib/design-tokens";
import {
  suggestApprovedSymbols, groupByMarketType, SYMBOL_REGISTRY,
  type ResolvedSymbol, type MarketType,
} from "@/lib/symbolRegistry";

// RANK 92 — both of these lists were hand-written and disagreed with the server.
//
//   * CATEGORIES offered "Stocks", and MARKET_TYPES offered "stock". The server
//     rejects any symbol outside the 43-market ARX Focus registry, which
//     contains no equities — so a user could create a "Stocks" watchlist and
//     then have every symbol they tried to add refused, with no explanation for
//     why the category existed.
//   * MARKET_TYPES omitted "metals" entirely, although the server seeds XAUUSD
//     with that type — so gold could be listed but not added by hand.
//   * The spellings were wrong too: the registry's types are plural
//     ("indices", "stocks", "metals"), not "index"/"stock".
//
// Both are DERIVED from the one source of truth now (ARX_FOCUS_MARKETS via
// SYMBOL_REGISTRY), so a market the server will not accept can never appear as
// an option. Pinned by watchlistMarkets.test.ts.
const MARKET_TYPES: MarketType[] = (Object.entries(groupByMarketType(SYMBOL_REGISTRY)) as [MarketType, unknown[]][])
  .filter(([, entries]) => entries.length > 0)
  .map(([type]) => type)
  .sort();

const MARKET_TYPE_LABEL: Record<string, string> = {
  forex: "Forex", metals: "Metals", indices: "Indices", crypto: "Crypto",
  stocks: "Stocks", energy: "Energy", commodities: "Commodities", synthetic: "Synthetics",
};

// Categories are just folder names, but they must not advertise a market ARX
// does not support. "Custom" plus one label per market type ARX actually has.
const CATEGORIES = ["Custom", ...MARKET_TYPES.map((t) => MARKET_TYPE_LABEL[t] ?? t)];

export default function Watchlists() {
  const { data: lists, isLoading } = useGetWatchlists({ query: { queryKey: getGetWatchlistsQueryKey(), refetchInterval: 10000 } });
  const create = useCreateWatchlist();
  const del = useDeleteWatchlist();
  const addItem = useAddWatchlistItem();
  const delItem = useDeleteWatchlistItem();
  const fav = useToggleWatchlistItemFavorite();
  const qc = useQueryClient();

  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("Custom");
  const [adding, setAdding] = useState<Record<number, { sym: string; type: string }>>({});
  const [addError, setAddError] = useState<Record<number, string | null>>({});
  const [addSuggestions, setAddSuggestions] = useState<Record<number, ResolvedSymbol[]>>({});

  const refresh = () => qc.invalidateQueries({ queryKey: getGetWatchlistsQueryKey() });

  const onCreate = async () => {
    if (!newName.trim()) return;
    await create.mutateAsync({ data: { name: newName.trim(), category: newCat } });
    setNewName("");
    refresh();
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 animate-in fade-in duration-500">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <ListChecks className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Watchlists</h1>
          <p className="text-sm text-muted-foreground">Track symbols across multiple markets with live signals.</p>
        </div>
      </div>

      <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold tracking-tight">Create Watchlist</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="Name (e.g. My Setup)" value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-1" data-testid="input-new-watchlist-name" />
          <Select value={newCat} onValueChange={setNewCat}>
            <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-new-category"><SelectValue /></SelectTrigger>
            <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={onCreate} disabled={create.isPending || !newName.trim()} data-testid="button-create-watchlist" className="gap-2">
            <Plus size={16} /> Create
          </Button>
        </div>
      </div>

      {/* RANK 92: a first-time visitor saw the Create box above an empty void —
          no list, no explanation, nothing to indicate the page was working. */}
      {isLoading ? <Skeleton className="h-64 w-full" /> : (lists ?? []).length === 0 ?
        <EmptyState
          icon={ListChecks}
          title="You have no watchlists yet."
          description="Create one above, then add symbols to it. Watchlists are private to your account, and only ARX-approved markets can be added."
          data-testid="watchlists-empty"
        /> :
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
          {(lists ?? []).map((wl) => {
            const a = adding[wl.id] ?? { sym: "", type: MARKET_TYPES[0] ?? "forex" };
            const suggestions = addSuggestions[wl.id] ?? [];
            const onAdd = async (symbol?: string, marketType?: string) => {
              const sym = (symbol ?? a.sym).trim();
              if (!sym) return;
              const type = marketType ?? a.type;
              setAddError({ ...addError, [wl.id]: null });
              try {
                await addItem.mutateAsync({ id: wl.id, data: { symbol: sym.toUpperCase(), marketType: type } });
                setAdding({ ...adding, [wl.id]: { sym: "", type: a.type } });
                setAddSuggestions({ ...addSuggestions, [wl.id]: [] });
                refresh();
              } catch (e) {
                const data = (e as { data?: { message?: string; error?: string } })?.data;
                // Surface the closest approved markets (from the ambiguous
                // resolver) as one-tap suggestions. Never a non-approved market.
                const near = suggestApprovedSymbols(sym);
                setAddError({
                  ...addError,
                  [wl.id]: data?.message ?? "That symbol isn't in the approved market list.",
                });
                setAddSuggestions({ ...addSuggestions, [wl.id]: near });
              }
            };
            return (
              <div key={wl.id} className="rounded-xl border border-card-border bg-card p-6 shadow-sm">
                <div className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <h3 className="text-base font-semibold tracking-tight">{wl.name}</h3>
                    <Badge variant="outline" className="mt-1 text-xs">{wl.category}</Badge>
                  </div>
                  <Button variant="ghost" size="icon" onClick={async () => { await del.mutateAsync({ id: wl.id }); refresh(); }} data-testid={`button-delete-watchlist-${wl.id}`}>
                    <Trash2 size={16} className="text-danger" />
                  </Button>
                </div>
                <div>
                  <div className="space-y-1 mb-3">
                    {wl.items.length === 0 ? (
                      <EmptyState
                        icon={ListChecks}
                        title="Your watchlist is empty."
                        description="Add a symbol above to start tracking. Watchlists are private to your account."
                        className="py-6"
                      />
                    ) :
                      wl.items.map((it) => (
                        <div key={it.id} className="flex items-center gap-2 rounded-md bg-muted/40 p-2" data-testid={`watchlist-item-${it.id}`}>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={async () => { await fav.mutateAsync({ id: it.id }); refresh(); }} data-testid={`button-favorite-${it.id}`}>
                            <Star size={14} className={it.favorite ? "fill-warning text-warning" : "text-muted-foreground"} />
                          </Button>
                          <span className="font-mono font-bold text-sm flex-1">{it.symbol}</span>
                          <Badge variant="outline" className="text-[10px]">{it.marketType}</Badge>
                          {it.signal ? <Badge className={`text-[10px] tabular-nums ${STATUS_COLORS[directionTone(it.signal)].badge}`}>{it.signal} {it.confidence}%</Badge> : null}
                          {it.newsRisk && it.newsRisk !== "none" ? <Badge variant="outline" className="text-[10px] text-warning border-warning/25">News: {it.newsRisk}</Badge> : null}
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={async () => { await delItem.mutateAsync({ id: it.id }); refresh(); }} data-testid={`button-delete-item-${it.id}`}>
                            <Trash2 size={12} className="text-muted-foreground" />
                          </Button>
                        </div>
                      ))
                    }
                  </div>
                  <div className="flex gap-2">
                    <Input placeholder="Symbol" value={a.sym} onChange={(e) => setAdding({ ...adding, [wl.id]: { ...a, sym: e.target.value } })} className="flex-1" data-testid={`input-add-symbol-${wl.id}`} />
                    <Select value={a.type} onValueChange={(v) => setAdding({ ...adding, [wl.id]: { ...a, type: v } })}>
                      <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                      <SelectContent>{MARKET_TYPES.map((m) => <SelectItem key={m} value={m}>{MARKET_TYPE_LABEL[m] ?? m}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button onClick={() => onAdd()} disabled={!a.sym.trim() || addItem.isPending} data-testid={`button-add-item-${wl.id}`}><Plus size={16} /></Button>
                  </div>
                  {addError[wl.id] ? (
                    <p className="mt-2 text-xs text-danger" data-testid={`add-item-error-${wl.id}`}>{addError[wl.id]}</p>
                  ) : null}
                  {suggestions.length > 0 ? (
                    <div className="mt-2" data-testid={`add-item-suggestions-${wl.id}`}>
                      <div className="mb-1 text-xs text-txt-muted">Did you mean:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {suggestions.map((s) => (
                          <Button
                            key={s.canonicalSymbol}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={addItem.isPending}
                            onClick={() => onAdd(s.canonicalSymbol, s.marketType)}
                            data-testid={`add-item-suggestion-${wl.id}-${s.canonicalSymbol}`}
                          >
                            <span className="font-mono">{s.canonicalSymbol}</span>
                            <span className="ml-1.5 truncate max-w-[160px] text-txt-secondary">{s.displayName}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      }
    </div>
  );
}
