// Shared live forming-bar tip for the selected scanner market (symbol +
// timeframe). The scanner chart applies each tick-stream frame to its price
// axis; it also publishes the tip close here so the page header and the chart
// badge read the SAME observation the axis shows, instead of the 15s poll's
// close (owner screenshots 2026-10-27: badge 33588.0069 vs axis 33575.37).
//
// Writer: ScannerChartPanel only — it publishes on a live, non-frozen frame and
// clears the tip on a frozen frame, a symbol/timeframe switch, a poll that
// replaces the tip on the axis, or when the display stops being live.
// Readers must still gate on their own live status; a tip never upgrades a
// non-live surface. Display only.

import { useSyncExternalStore } from "react";

const tips = new Map<string, number>();
const listeners = new Set<() => void>();

export function scannerTipKey(symbol: string, timeframe: string): string {
  return `${symbol.trim().toUpperCase()}|${timeframe}`;
}

/** Publish (or clear with null) the tip close; listeners fire only on change. */
export function publishScannerTip(key: string, close: number | null): void {
  const prev = tips.get(key);
  if (close == null || !Number.isFinite(close)) {
    if (prev === undefined) return;
    tips.delete(key);
  } else {
    if (prev === close) return;
    tips.set(key, close);
  }
  for (const l of [...listeners]) l();
}

export function readScannerTip(key: string): number | null {
  return tips.get(key) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the current live tip close for this key, or null. */
export function useScannerTip(key: string | null): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? readScannerTip(key) : null),
    () => null,
  );
}
