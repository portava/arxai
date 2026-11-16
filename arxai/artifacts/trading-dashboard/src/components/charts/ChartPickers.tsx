import { CHART_INTERVALS, type ChartRequestedInterval } from "@/lib/chart-engine/chartIntervals";
import { SYMBOL_REGISTRY, groupByMarketType, type MarketType } from "@/lib/symbolRegistry";

const SELECT_CLASS = "h-7 max-w-[12rem] rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-100";

const MARKET_GROUP_LABEL: Record<MarketType, string> = {
  forex: "Forex", metals: "Metals", indices: "Indices", crypto: "Crypto", stocks: "Stocks",
  energy: "Energy", commodities: "Commodities", synthetic: "Synthetic indices",
};

/** The Focus-registry market the chart shows, or null when it is not one. */
function canonicalOf(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  const hit = SYMBOL_REGISTRY.find(e => e.canonicalSymbol === s
    || e.brokerSymbol?.toUpperCase() === s
    || e.aliases.some(a => a.trim().toUpperCase() === s));
  return hit?.canonicalSymbol ?? null;
}

/**
 * Market dropdown for the chart header. View-only: it changes which market the
 * chart shows and never substitutes another series for a missing one. A chart
 * showing a market outside the registry keeps that market selected (labelled)
 * rather than silently snapping to the first entry.
 */
export function ChartMarketSelect({ symbol, onSelect, className = "" }: {
  symbol: string;
  onSelect: (canonicalSymbol: string) => void;
  className?: string;
}) {
  const canonical = canonicalOf(symbol);
  const value = canonical ?? symbol.trim().toUpperCase();
  const groups = Object.entries(groupByMarketType()) as [MarketType, typeof SYMBOL_REGISTRY][];
  return (
    <select
      aria-label="Chart market"
      title="Choose the market shown on this chart"
      data-testid="arx-native-market-select"
      className={`${SELECT_CLASS} font-semibold ${className}`}
      value={value}
      onChange={e => { if (e.target.value && e.target.value !== value) onSelect(e.target.value); }}
    >
      {!canonical && <option value={value} disabled>{value || "No market selected"} — not in the market list</option>}
      {groups.filter(([, entries]) => entries.length > 0).map(([type, entries]) => (
        <optgroup key={type} label={MARKET_GROUP_LABEL[type]}>
          {entries.map(e => <option key={e.canonicalSymbol} value={e.canonicalSymbol}>{e.canonicalSymbol} · {e.displayName}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

const TIMEFRAME_GROUPS: { label: string; test: (id: string) => boolean }[] = [
  { label: "Minutes", test: id => id.startsWith("M") && id !== "MN1" },
  { label: "Hours", test: id => id.startsWith("H") },
  { label: "Days and longer", test: id => id === "D1" || id === "W1" || id === "MN1" },
];

/** Every native interval in one dropdown; it always shows the current one. */
export function ChartTimeframeSelect({ timeframe, onSelect, className = "" }: {
  timeframe: ChartRequestedInterval;
  onSelect: (timeframe: (typeof CHART_INTERVALS)[number]) => void;
  className?: string;
}) {
  return (
    <select
      aria-label="Chart timeframe"
      title="All native broker intervals, including calendar weeks and months"
      data-testid="arx-native-tf-select"
      className={`${SELECT_CLASS} ${className}`}
      value={timeframe}
      onChange={e => {
        const next = CHART_INTERVALS.find(id => id === e.target.value);
        if (next && next !== timeframe) onSelect(next);
      }}
    >
      {TIMEFRAME_GROUPS.map(g => (
        <optgroup key={g.label} label={g.label}>
          {CHART_INTERVALS.filter(g.test).map(id => <option key={id} value={id}>{id}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
