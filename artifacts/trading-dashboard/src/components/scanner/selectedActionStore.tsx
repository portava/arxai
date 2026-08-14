import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PublishedScannerAction } from "@/lib/scannerActionability";

// selectedActionStore — page-scoped store for the ONE selected-symbol action
// verdict (Task #600). The Focus-tab scalp card computes the setup-aware
// `ScannerActionability` for the symbol/timeframe it actually read (the scalp
// engine reads M1 → bus "1m") and lifts it here; the header strip's Action cell
// reads it back via `resolveSelectedSymbolActionability` so the header can never
// disagree with the selected-symbol card. Keyed by bare symbol (uppercased) AND
// timeframe, mirroring the rubyReadStore convention exactly: publishers pass the
// engine's bare symbol + the bus timeframe they read; readers pass
// `bareSymbol(chartSym)` + `coerceVisibleTimeframe(selectedTimeframe)`. Keying by
// timeframe is what stops a stale cross-timeframe verdict masquerading as the
// selected timeframe's truth (e.g. an M1 scalp verdict showing in the header
// while the user views the 15m chart). When no card has published for THIS
// symbol+timeframe (other tabs, loading, mid-switch, or a non-matching
// timeframe), `get` returns null and the header falls back to its own data-only
// consolidated verdict for that timeframe.

function keyOf(symbol: string, timeframe: string): string {
  return `${(symbol || "").toUpperCase()}|${timeframe || ""}`;
}

interface SelectedActionStore {
  get: (symbol: string, timeframe: string) => PublishedScannerAction | null;
  set: (symbol: string, timeframe: string, action: PublishedScannerAction | null) => void;
}

const SelectedActionStoreContext = createContext<SelectedActionStore>({
  get: () => null,
  set: () => {},
});

export function SelectedActionStoreProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, PublishedScannerAction | null>>({});

  const get = useCallback(
    (symbol: string, timeframe: string): PublishedScannerAction | null =>
      map[keyOf(symbol, timeframe)] ?? null,
    [map],
  );

  // `set` is stable (no deps) so consumers can safely depend on it in effects;
  // it no-ops when the value is unchanged to avoid needless re-renders.
  const set = useCallback(
    (symbol: string, timeframe: string, action: PublishedScannerAction | null) => {
      setMap((m) => {
        const k = keyOf(symbol, timeframe);
        if (m[k] === action) return m;
        return { ...m, [k]: action };
      });
    },
    [],
  );

  const value = useMemo<SelectedActionStore>(() => ({ get, set }), [get, set]);

  return (
    <SelectedActionStoreContext.Provider value={value}>
      {children}
    </SelectedActionStoreContext.Provider>
  );
}

export function useSelectedActionStore(): SelectedActionStore {
  return useContext(SelectedActionStoreContext);
}
