import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SYMBOL_REGISTRY,
  groupByMarketType,
  searchSymbols,
  resolveSymbol,
  suggestApprovedSymbols,
  type MarketType,
  type SymbolEntry,
  type ResolvedSymbol,
} from "@/lib/symbolRegistry";

/**
 * Unified Symbol Explorer — search + horizontal category chips +
 * click-to-switch.
 *
 * Categories appear as horizontally scrollable chips with count badges
 * (Favorites · Forex · Metals · Indices · Crypto · Stocks · Synthetic …).
 * Only one category is active at a time; tapping a chip expands its
 * symbols in a compact grid below. Synthetic Indices stays visible even
 * when the Deriv feed is not configured — the status appears as a small
 * inline note inside the expanded area, not as a giant pill beside the
 * row.
 *
 * No trading decisions are made here. BUY/SELL still runs through the
 * existing live pipeline + server safety gates.
 */

const ACTIVE_KEY = "arx.symbolExplorer.activeCat.v1";
const RECENT_KEY = "arx.symbolExplorer.recent.v1";
const FAV_KEY = "arx.symbolExplorer.favs.v1";
const MAX_RECENT = 8;

type CategoryId = "favorites" | MarketType;

const CATEGORY_ORDER: Array<{ id: MarketType; label: string }> = [
  { id: "forex", label: "Forex" },
  { id: "metals", label: "Metals" },
  { id: "indices", label: "Indices" },
  { id: "crypto", label: "Crypto" },
  { id: "stocks", label: "Stocks" },
  { id: "energy", label: "Energy" },
  { id: "commodities", label: "Commodities" },
  { id: "synthetic", label: "Synthetic" },
];

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, val: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / private mode → silently ignore */
  }
}

export interface SymbolExplorerProps {
  activeSymbol: string;
  onSelect: (canonicalSymbol: string, entry: ResolvedSymbol) => void;
  /** When false, synthetic symbols stay selectable but are flagged. */
  derivFeedConfigured?: boolean;
  derivFeedConnected?: boolean;
  derivFeedConnecting?: boolean;
  /** Show dev-only diagnostics row (typed/resolved/source). */
  showDiagnostics?: boolean;
}

export function SymbolExplorer(props: SymbolExplorerProps) {
  const { activeSymbol, onSelect, derivFeedConfigured = true, derivFeedConnected = false, derivFeedConnecting = false } = props;
  const showDiagnostics = props.showDiagnostics ?? import.meta.env.DEV;

  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadJson<string[]>(RECENT_KEY, []));
  const [favs, setFavs] = useState<string[]>(() => loadJson<string[]>(FAV_KEY, []));
  // null = grid collapsed. Default to collapsed on mount so the selected
  // market pill stays the dominant surface; tapping a chip expands it.
  const [activeCat, setActiveCat] = useState<CategoryId | null>(null);

  useEffect(() => saveJson(RECENT_KEY, recent), [recent]);
  useEffect(() => saveJson(FAV_KEY, favs), [favs]);
  useEffect(() => {
    if (activeCat !== null) saveJson(ACTIVE_KEY, activeCat);
  }, [activeCat]);

  function toggleFav(sym: string) {
    setFavs((f) => (f.includes(sym) ? f.filter((x) => x !== sym) : [sym, ...f].slice(0, 16)));
  }
  function commitSelect(canonical: string, entry: ResolvedSymbol) {
    setRecent((r) => [canonical, ...r.filter((x) => x !== canonical)].slice(0, MAX_RECENT));
    // Collapse the expanded symbol grid after a successful selection so
    // the selected-market pill stays the dominant surface. The horizontal
    // category chip row stays visible; the user can tap any chip to
    // reopen the grid.
    setActiveCat(null);
    onSelect(canonical, entry);
  }

  const suggestions: ResolvedSymbol[] = useMemo(
    () => (query.trim() ? searchSymbols(query, { limit: 10, derivFeedConfigured }) : []),
    [query, derivFeedConfigured],
  );
  const exactSuggestion = suggestions[0];
  // Approved near-matches for a typed token that didn't match anything in the
  // fuzzy search (e.g. an ambiguous alias). Only the approved Top-250
  // candidates surface — never a non-approved market.
  const nearMatches: ResolvedSymbol[] = useMemo(
    () => (query.trim() && suggestions.length === 0 ? suggestApprovedSymbols(query, { derivFeedConfigured }) : []),
    [query, suggestions.length, derivFeedConfigured],
  );
  const groups = useMemo(() => groupByMarketType(SYMBOL_REGISTRY), []);

  // Combined favorites/recent set used as the "Favorites" category.
  const favRecentSymbols = useMemo(
    () => Array.from(new Set([...favs, ...recent])).slice(0, 16),
    [favs, recent],
  );

  const categories = useMemo(() => {
    const out: Array<{ id: CategoryId; label: string; count: number; symbols: string[] }> = [];
    if (favRecentSymbols.length > 0) {
      out.push({
        id: "favorites",
        label: "Favorites",
        count: favRecentSymbols.length,
        symbols: favRecentSymbols,
      });
    }
    for (const g of CATEGORY_ORDER) {
      const items = groups[g.id];
      if (!items || items.length === 0) continue;
      out.push({
        id: g.id,
        label: g.label,
        count: items.length,
        symbols: items.map((e) => e.canonicalSymbol),
      });
    }
    return out;
  }, [favRecentSymbols, groups]);

  // If the currently active category disappears (e.g. favorites empties),
  // collapse back to no selection. We never auto-open a category — the
  // user must tap a chip explicitly.
  useEffect(() => {
    if (activeCat !== null && !categories.some((c) => c.id === activeCat)) {
      setActiveCat(null);
    }
  }, [categories, activeCat]);

  const active = activeCat === null ? null : categories.find((c) => c.id === activeCat) ?? null;
  // Show the synthetic-feed note when (a) it's not configured, or (b) it's
  // configured but still connecting / connected — so users see live status.
  const showDerivNote = active?.id === "synthetic" && (!derivFeedConfigured || derivFeedConnecting || derivFeedConnected);

  function submitTyped() {
    const q = query.trim();
    if (!q) return;
    const hit = resolveSymbol(q, { derivFeedConfigured });
    if (hit) commitSelect(hit.canonicalSymbol, hit);
  }
  function onPickSuggestion(s: ResolvedSymbol) {
    commitSelect(s.canonicalSymbol, s);
    setQuery("");
  }

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2" data-testid="symbol-explorer">
      {/* Search row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-txt-muted" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submitTyped(); }
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search any market — EURUSD, gold, V75, btc, nas…"
            className="pl-7"
            data-testid="input-symbol-search"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button onClick={submitTyped} disabled={!query.trim()} data-testid="btn-symbol-load">
          Load
        </Button>
      </div>

      {/* Live suggestions while typing */}
      {query.trim().length > 0 && (
        <div className="rounded-md border border-border bg-background/60 p-2" data-testid="symbol-suggestions">
          {suggestions.length === 0 ? (
            <NoMatch query={query} nearMatches={nearMatches} onPick={onPickSuggestion} />
          ) : (
            <ul className="text-sm divide-y divide-border/60">
              {suggestions.map((s) => (
                <li key={s.canonicalSymbol}>
                  <button
                    type="button"
                    onClick={() => onPickSuggestion(s)}
                    className="w-full flex flex-wrap items-center gap-2 py-1.5 px-1 text-left hover:bg-card rounded"
                    data-testid={`suggestion-${s.canonicalSymbol}`}
                  >
                    <span className="font-mono text-foreground">{s.canonicalSymbol}</span>
                    <span className="text-xs text-txt-secondary flex-1 truncate">{s.displayName}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">{s.marketType}</Badge>
                    {s.unavailableReason === "DERIV_FEED_NOT_CONFIGURED" && (
                      <Badge variant="outline" className="text-[10px] text-warning border-warning/40">
                        Synthetic feed setup pending
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Horizontal category chips — swipeable on mobile, wraps on desktop. */}
      <div
        className="flex md:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 py-1"
        role="tablist"
        aria-label="Market categories"
        data-testid="category-chip-row"
      >
        {categories.map((c) => {
          const isActive = active?.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveCat((prev) => (prev === c.id ? null : c.id))}
              data-testid={`category-chip-${c.id}`}
              className={
                "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-2 min-h-[36px] text-xs font-medium transition-colors touch-manipulation " +
                (isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background/40 text-foreground border-border hover:bg-card")
              }
            >
              {c.id === "favorites" && <Star className="h-3 w-3" />}
              <span>{c.label}</span>
              <span
                className={
                  "rounded-full px-1.5 text-[10px] tabular-nums " +
                  (isActive ? "bg-primary-foreground/20" : "bg-secondary text-txt-secondary")
                }
              >
                {c.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active category symbols */}
      {active && (
        <div
          className="rounded-md border border-card bg-background/40 px-2 py-2"
          role="tabpanel"
          aria-label={`${active.label} symbols`}
          data-testid={`category-panel-${active.id}`}
        >
          {showDerivNote && (
            <div className="mb-2 text-[11px] text-warning/90" data-testid="deriv-feed-note">
              {derivFeedConnecting
                ? "Connecting to live feed for synthetic indices…"
                : derivFeedConnected
                  ? "Live feed connected for synthetic indices."
                  : "Synthetic-index live feed isn't active yet — these markets are visible for selection but won't show live prices until the feed is set up."}
            </div>
          )}
          <ChipRow
            symbols={active.symbols}
            active={activeSymbol}
            favs={favs}
            onSelect={(sym) => {
              const hit = resolveSymbol(sym, { derivFeedConfigured });
              if (hit) commitSelect(hit.canonicalSymbol, hit);
            }}
            onToggleFav={toggleFav}
          />
        </div>
      )}

      {/* Diagnostics (dev / admin only) */}
      {showDiagnostics && query.trim() && (
        <div
          className="text-[10px] text-txt-muted font-mono border-t border-card pt-1"
          data-testid="symbol-diagnostics"
        >
          <span>typed=<span className="text-foreground">{query}</span></span>
          {exactSuggestion && (
            <>
              {" · "}<span className="text-foreground">{exactSuggestion.canonicalSymbol}</span>
              {" · broker "}<span className="text-foreground">{exactSuggestion.brokerSymbol ?? exactSuggestion.canonicalSymbol}</span>
              {" · "}<span className="text-foreground">{exactSuggestion.marketType}</span>
              {" · via "}<span className="text-foreground">{exactSuggestion.dataProvider}</span>
              {" · "}<span className="text-foreground">{exactSuggestion.isAvailable ? "available" : "unavailable"}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NoMatch({
  query,
  nearMatches,
  onPick,
}: {
  query: string;
  nearMatches: ResolvedSymbol[];
  onPick: (s: ResolvedSymbol) => void;
}) {
  return (
    <div className="text-xs text-txt-secondary" data-testid="symbol-no-match">
      "{query.trim().toUpperCase()}" isn't in the approved market list. Try a broker symbol, forex pair,
      crypto, index, or synthetic alias
      (e.g. <span className="font-mono">EURUSD</span>, <span className="font-mono">gold</span>, <span className="font-mono">V75</span>, <span className="font-mono">volatility 75 1s</span>).
      {nearMatches.length > 0 && (
        <div className="mt-2" data-testid="symbol-near-matches">
          <div className="mb-1 text-txt-muted">Did you mean:</div>
          <div className="flex flex-wrap gap-1.5">
            {nearMatches.map((s) => (
              <Button
                key={s.canonicalSymbol}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onPick(s)}
                data-testid={`near-match-${s.canonicalSymbol}`}
              >
                <span className="font-mono">{s.canonicalSymbol}</span>
                <span className="ml-1.5 text-txt-secondary truncate max-w-[160px]">{s.displayName}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-1 text-txt-muted">
        Only markets in the approved list can be searched, charted, scanned, or traded.
      </div>
    </div>
  );
}

function ChipRow(props: {
  symbols: string[];
  active: string;
  favs: string[];
  onSelect: (sym: string) => void;
  onToggleFav: (sym: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const VISIBLE = 18;
  const shown = showAll ? props.symbols : props.symbols.slice(0, VISIBLE);
  const more = props.symbols.length - shown.length;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((sym) => {
          const isActive = props.active === sym;
          const isFav = props.favs.includes(sym);
          return (
            <div key={sym} className="relative inline-flex items-center">
              <Button
                size="sm"
                variant={isActive ? "default" : "outline"}
                className="text-xs h-7 pr-7"
                onClick={() => props.onSelect(sym)}
                data-testid={`chip-symbol-${sym}`}
              >
                {sym}
              </Button>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); props.onToggleFav(sym); }}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-secondary"
                aria-label={isFav ? `Remove ${sym} from favorites` : `Add ${sym} to favorites`}
                data-testid={`fav-toggle-${sym}`}
              >
                <Star className={`h-3 w-3 ${isFav ? "fill-warning text-warning" : "text-txt-muted"}`} />
              </button>
            </div>
          );
        })}
      </div>
      {more > 0 && !showAll && (
        <button
          type="button"
          className="text-[11px] text-txt-secondary mt-1 hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          Show {more} more…
        </button>
      )}
      {showAll && props.symbols.length > VISIBLE && (
        <button
          type="button"
          className="text-[11px] text-txt-secondary mt-1 hover:text-foreground"
          onClick={() => setShowAll(false)}
        >
          Show less
        </button>
      )}
    </div>
  );
}

// Re-export for tests / external usage convenience.
export type { ResolvedSymbol, SymbolEntry, MarketType };
