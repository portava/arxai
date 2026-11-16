import { useId } from "react";
import { ARXNativeChart, type ARXNativeChartProps } from "./ARXNativeChart";
import { SYMBOL_REGISTRY } from "@/lib/symbolRegistry";
import { bareSymbol, useChartSymbol } from "@/lib/use-chart-symbol";

function chartSymbol(value: string): string {
  return bareSymbol(value).trim().toUpperCase();
}

function knownChartSymbol(value: string): boolean {
  return SYMBOL_REGISTRY.some(entry => entry.canonicalSymbol === value
    || entry.brokerSymbol?.toUpperCase() === value
    || entry.aliases.some(alias => alias.trim().toUpperCase() === value));
}

/** Selection is view-only. A missing market never substitutes another price series. */
export function SmartChartSymbolSelect({ symbol, onSymbolChange, label = "Chart market", testId }: {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  label?: string;
  testId?: string;
}) {
  const id = useId();
  const selected = chartSymbol(symbol);
  const canonical = SYMBOL_REGISTRY.some(entry => entry.canonicalSymbol === selected);
  const known = knownChartSymbol(selected);
  return <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-xs text-txt-secondary">
    {label}
    <select id={id} value={selected} onChange={event => onSymbolChange(event.target.value)}
      data-testid={testId} className="max-w-full rounded border border-border bg-background px-2 py-1.5 text-foreground">
      {!canonical && <option value={selected} disabled={!known}>{selected || "No market selected"} — {known ? "selected market" : "unavailable"}</option>}
      {SYMBOL_REGISTRY.map(entry => <option key={entry.canonicalSymbol} value={entry.canonicalSymbol}>
        {entry.canonicalSymbol} · {entry.displayName}
      </option>)}
    </select>
  </label>;
}

type SmartChartViewProps = Pick<ARXNativeChartProps, "height" | "mobileHeight" | "timeframe" | "onTimeframeChange" | "mode"> & {
  symbol?: string;
  onSymbolChange?: (symbol: string) => void;
  showSymbolSelect?: boolean;
};

/** Shared Smart Chart on secondary pages; no order actions or external chart scripts. */
export function SmartChartView({ symbol, onSymbolChange, showSymbolSelect = true, ...chartProps }: SmartChartViewProps) {
  const [sharedSymbol, setSharedSymbol] = useChartSymbol();
  const selected = chartSymbol(symbol ?? sharedSymbol);
  const known = knownChartSymbol(selected);
  return <section className="min-w-0 space-y-2" aria-label="Smart Chart">
    {showSymbolSelect && <SmartChartSymbolSelect symbol={selected} onSymbolChange={onSymbolChange ?? setSharedSymbol} />}
    {known
      ? <ARXNativeChart {...chartProps} symbol={selected} showFeedStatus />
      : <p role="status" className="rounded border border-warning/30 bg-warning/10 p-4 text-sm">
          {selected ? `Chart unavailable for ${selected}.` : "Select a market to view its chart."} No substitute market is shown.
        </p>}
  </section>;
}
