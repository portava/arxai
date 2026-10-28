// One instrument → one display precision on the Smart Chart page.
//
// ARXNativeChart resolves the instrument's display precision with the shared
// rule (lib/instrumentPriceFormat: server-declared precision widened by the
// digits the loaded quotes carry) and applies it to its price axis, header and
// crosshair legend. The panels mounted beside it (Chart Pulse, Diagnostics,
// the open-position legend) print prices for the same symbol; they read the
// precision published here so a level, an entry or a range never prints with a
// different digit count from the axis. Before a chart has published (or after
// it unmounts) readers get null and formatInstrumentPrice falls back to its
// magnitude rule — display only, never an order tick size.

import { useSyncExternalStore } from "react";
import { bareSymbol } from "@/lib/use-chart-symbol";

interface Entry {
  precision: number;
  owner: object;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function chartPrecisionKey(symbol: string | null | undefined): string {
  return bareSymbol((symbol ?? "").trim()).toUpperCase();
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/**
 * Publish (or withdraw with null) the precision `owner` resolved for `symbol`.
 * Returns a cleanup that withdraws it only if `owner` still holds the entry.
 */
export function publishChartPricePrecision(
  symbol: string,
  precision: number | null,
  owner: object,
): () => void {
  const key = chartPrecisionKey(symbol);
  const withdraw = () => {
    const cur = entries.get(key);
    if (cur && cur.owner === owner) {
      entries.delete(key);
      notify();
    }
  };
  if (!key) return () => {};
  if (precision == null || !Number.isSafeInteger(precision) || precision < 0) {
    withdraw();
    return () => {};
  }
  const prev = entries.get(key);
  if (!prev || prev.precision !== precision || prev.owner !== owner) {
    entries.set(key, { precision, owner });
    notify();
  }
  return withdraw;
}

export function readChartPricePrecision(symbol: string | null | undefined): number | null {
  const key = chartPrecisionKey(symbol);
  return key ? entries.get(key)?.precision ?? null : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the chart's published display precision for `symbol`, or null. */
export function useChartPricePrecision(symbol: string | null | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => readChartPricePrecision(symbol),
    () => null,
  );
}

/** Test-only: clear every published precision. */
export function __resetChartPricePrecision(): void {
  entries.clear();
  notify();
}
