// useSymbolLotSpec — the broker's lot and stops rules for one symbol, read from
// the EA-enumerated symbol inventory (useMt5Symbols). Every field is null when
// the EA has not enumerated the symbol yet; the lot helpers then fall back to
// 0.01 steps and the broker enforces its own rules.
import { useMemo } from "react";
import { useMt5Symbols, type Mt5SymbolView } from "@/lib/useMt5Symbols";
import type { LotSpec } from "@/lib/oneClickMode";

export type SymbolTradeSpec = LotSpec & { point: number | null; stopsLevel: number | null };

const norm = (s: string | null | undefined) => (s ?? "").replace(/^.*:/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export function symbolTradeSpec(symbols: Mt5SymbolView[] | undefined, symbol: string): SymbolTradeSpec {
  const want = norm(symbol);
  const hit = want
    ? (symbols ?? []).find((s) => norm(s.brokerSymbol) === want || norm(s.symbol) === want || norm(s.displaySymbol) === want)
    : undefined;
  return {
    volumeMin: hit?.minLot ?? null,
    volumeStep: hit?.lotStep ?? null,
    volumeMax: hit?.maxLot ?? null,
    point: hit?.point ?? null,
    stopsLevel: hit?.stopsLevel ?? null,
  };
}

export function useSymbolLotSpec(symbol: string, enabled: boolean = true): SymbolTradeSpec {
  const q = useMt5Symbols({ includeStale: true, enabled: enabled && !!symbol });
  return useMemo(() => symbolTradeSpec(q.data?.symbols, symbol), [q.data?.symbols, symbol]);
}
