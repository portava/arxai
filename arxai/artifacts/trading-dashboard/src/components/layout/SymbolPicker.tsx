import React, { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { ChevronsUpDown, Search } from "lucide-react";
import { useActiveSymbol } from "@/lib/symbol-context";
import { useChartSymbol, setChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { useResolvedSymbols, type ResolvedSymbol } from "@/lib/useMt5Symbols";
import { cn } from "@/lib/utils";

// The top-bar symbol picker lists the merged APPROVED symbol universe
// (/api/me/symbols → useResolvedSymbols): the ARX Focus markets (EURUSD, V75, …)
// are ALWAYS present so the picker is never empty, and each row is enriched with
// the broker's enumerated metadata when it exists. Picking a row stores its
// EXACT brokerSymbol on the shared chart-symbol bus when the broker has
// enumerated it, else the canonical ARX symbol (the chart/data routers resolve
// canonical approved symbols). Tradeability is honest — a row shown here that
// the broker has not confirmed still re-gates fully at the trade ticket.

// Badge colour by enumeration confidence (broker-confirmed vs pending sync).
const BADGE_STYLE = {
  CONFIRMED: "text-emerald-300 border-emerald-700/40 bg-emerald-950/30",
  STALE: "text-amber-300 border-amber-700/40 bg-amber-950/30",
  PENDING: "text-zinc-400 border-zinc-700/50 bg-zinc-900/40",
} as const;

function friendlyName(v: ResolvedSymbol): string {
  return v.displayName || v.symbol;
}

export function SymbolPicker({ compact = false }: { compact?: boolean }) {
  // The shared chart-symbol bus (use-chart-symbol) is the single source of
  // truth the scanner chart, Ruby chart-read, and trade ticket all read. The
  // picker WRITES to it so a selection propagates everywhere immediately; we
  // also keep writing the legacy SymbolProvider so the recent list and any
  // legacy consumer stay in sync, and we DISPLAY the chart bus so the picker
  // label never drifts from a selection made elsewhere (e.g. the explorer).
  const { setActive, recent } = useActiveSymbol();
  const [chartSym] = useChartSymbol();
  const active = bareSymbol(chartSym);
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useResolvedSymbols();
  const symbols = data?.symbols ?? [];
  const enumeratedCount = data?.enumerationStatus.count ?? 0;
  const enumerationAvailable = data?.enumerationStatus.available ?? false;

  // Overall broker-confirmation badge: PENDING when nothing enumerated,
  // CONFIRMED when fresh enumerated specs exist, STALE otherwise.
  const badge = useMemo(() => {
    if (!enumerationAvailable || enumeratedCount === 0) {
      return { key: "PENDING" as const, label: "Pending sync" };
    }
    const anyFresh = symbols.some((s) => s.brokerSymbol && s.freshness === "FRESH");
    return anyFresh
      ? { key: "CONFIRMED" as const, label: `${enumeratedCount} live` }
      : { key: "STALE" as const, label: `${enumeratedCount} stale` };
  }, [symbols, enumeratedCount, enumerationAvailable]);

  // Group symbols by their display category, preserving the registry's tier/
  // category order within each group (resolver returns approved order already).
  const groups = useMemo(() => {
    const map = new Map<string, ResolvedSymbol[]>();
    for (const v of symbols) {
      const cat = (v.category && v.category.trim()) || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(v);
    }
    return Array.from(map.entries());
  }, [symbols]);

  // Lookup from any known label (broker, ARX key, display) → the resolved row.
  // Used to map legacy localStorage "recent" strings back onto a concrete row.
  const byKey = useMemo(() => {
    const m = new Map<string, ResolvedSymbol>();
    for (const v of symbols) {
      m.set(v.symbol.toLowerCase(), v);
      if (v.brokerSymbol) m.set(v.brokerSymbol.toLowerCase(), v);
      if (v.displayName) m.set(v.displayName.toLowerCase(), v);
    }
    return m;
  }, [symbols]);

  // Resolve recents against the approved universe; drop any that are no longer
  // approved so we never re-emit a stale/unapproved symbol onto the buses.
  const recentViews = useMemo(() => {
    const out: ResolvedSymbol[] = [];
    const seen = new Set<string>();
    for (const s of recent) {
      const hit = byKey.get(bareSymbol(s).toLowerCase());
      if (!hit) continue;
      const key = hit.brokerSymbol ?? hit.symbol;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
    return out;
  }, [recent, byKey]);

  // Picking a concrete row → store its EXACT brokerSymbol when the broker has
  // enumerated it, else the canonical ARX symbol (routers resolve canonical).
  function choose(view: ResolvedSymbol) {
    const target = view.brokerSymbol ?? view.symbol;
    setActive(target);
    setChartSymbol(target);
    setOpen(false);
  }

  const showEmpty = !isLoading && symbols.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          size="sm"
          className={cn("font-mono justify-between gap-2", compact ? "w-32" : "w-48")}
          data-testid="button-symbol-picker"
        >
          <span className="truncate">{active}</span>
          <ChevronsUpDown className="opacity-50 shrink-0" size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter>
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <CommandInput placeholder="Search symbol..." className="border-0 focus:ring-0" />
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                BADGE_STYLE[badge.key],
              )}
              title={
                badge.key === "PENDING"
                  ? "Broker enumeration pending — showing approved markets. Tradeability confirms after MT5 sync."
                  : `Broker-confirmed instruments: ${enumeratedCount}`
              }
              data-testid="symbol-picker-freshness"
            >
              {badge.label}
            </span>
          </div>
          <CommandList>
            {isLoading && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="symbol-picker-loading">
                Loading symbols…
              </div>
            )}
            {showEmpty ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="symbol-picker-empty">
                No approved symbols found. The ARX market universe could not be
                loaded — check your connection and try again.
              </div>
            ) : (
              <>
                <CommandEmpty>No symbol found.</CommandEmpty>
                {!enumerationAvailable && symbols.length > 0 && (
                  <div
                    className="px-3 py-2 text-[10px] leading-snug text-muted-foreground border-b"
                    data-testid="symbol-picker-pending-note"
                  >
                    Showing approved markets. Broker tradeability confirms after
                    MT5 symbol sync on the MT5 Setup page.
                  </div>
                )}
                {recentViews.length > 0 && (
                  <CommandGroup heading="Recent">
                    {recentViews.map((v) => {
                      const key = v.brokerSymbol ?? v.symbol;
                      return (
                        <CommandItem
                          key={`r-${key}`}
                          value={`recent ${friendlyName(v)} ${key} ${v.symbol}`}
                          onSelect={() => choose(v)}
                          className="flex items-center justify-between gap-2 text-xs"
                          data-testid={`symbol-recent-${v.symbol}`}
                        >
                          <span className="truncate">{friendlyName(v)}</span>
                          <SymbolMeta v={v} />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {groups.map(([cat, items]) => (
                  <CommandGroup key={cat} heading={cat}>
                    {items.map((v) => (
                      <CommandItem
                        key={v.symbol}
                        value={`${friendlyName(v)} ${v.symbol} ${v.brokerSymbol ?? ""} ${cat}`}
                        onSelect={() => choose(v)}
                        className="flex items-center justify-between gap-2 text-xs"
                        data-testid={`symbol-option-${v.symbol}`}
                      >
                        <span className="truncate">{friendlyName(v)}</span>
                        <SymbolMeta v={v} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Right-aligned meta: an honest broker-confirmation dot + the exact broker
// string when it differs from the friendly name. A filled emerald dot = the
// broker enumerated this instrument as tradable; a hollow dot = approved for
// viewing/scanning, tradeability confirms after MT5 sync.
function SymbolMeta({ v }: { v: ResolvedSymbol }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {v.brokerSymbol && v.brokerSymbol !== friendlyName(v) && (
        <span className="font-mono text-[10px] text-muted-foreground">{v.brokerSymbol}</span>
      )}
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          v.tradeable ? "bg-emerald-400" : "border border-zinc-500/70",
        )}
        title={
          v.tradeable
            ? "Broker-confirmed tradable"
            : "Approved for viewing — broker confirmation required before trading"
        }
        data-testid={`symbol-tradeable-${v.symbol}`}
      />
    </span>
  );
}
