import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ActionDirection, PublishedScannerAction } from "@/lib/scannerActionability";

// selectedActionStore — page-scoped store for the ONE selected-symbol action
// verdict (Task #600). The Focus-tab scalp card computes the setup-aware
// `ScannerActionability` for the symbol/timeframe it actually read (the scalp
// engine reads M5 → bus "5m") and lifts it here; the header strip's Action cell
// reads it back via `resolveSelectedSymbolActionability` so the header can never
// disagree with the selected-symbol card. Keyed by bare symbol (uppercased) AND
// timeframe, mirroring the rubyReadStore convention exactly: publishers pass the
// engine's bare symbol + the bus timeframe they read; readers pass
// `bareSymbol(chartSym)` + `coerceVisibleTimeframe(selectedTimeframe)`. Keying by
// timeframe is what stops a stale cross-timeframe verdict masquerading as the
// selected timeframe's truth (e.g. an M5 scalp verdict showing in the header
// while the user views the 15m chart). When no card has published for THIS
// symbol+timeframe (other tabs, loading, mid-switch, or a non-matching
// timeframe), `get` returns null and the header falls back to its own data-only
// consolidated verdict for that timeframe.

function keyOf(symbol: string, timeframe: string): string {
  return `${(symbol || "").toUpperCase()}|${timeframe || ""}`;
}

interface SelectedActionStore {
  get: (symbol: string, timeframe: string) => PublishedScannerAction | null;
  /**
   * The trade side the publishing card read for this key (its own scalp
   * direction), or null when it published none. Readers use it only to drop a
   * contradicting side from the action label — never to add one.
   */
  getSide: (symbol: string, timeframe: string) => ActionDirection;
  set: (
    symbol: string,
    timeframe: string,
    action: PublishedScannerAction | null,
    side?: ActionDirection,
  ) => void;
}

interface StoredAction {
  action: PublishedScannerAction | null;
  side: ActionDirection;
}

const SelectedActionStoreContext = createContext<SelectedActionStore>({
  get: () => null,
  getSide: () => null,
  set: () => {},
});

export function SelectedActionStoreProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, StoredAction>>({});

  const get = useCallback(
    (symbol: string, timeframe: string): PublishedScannerAction | null =>
      map[keyOf(symbol, timeframe)]?.action ?? null,
    [map],
  );

  const getSide = useCallback(
    (symbol: string, timeframe: string): ActionDirection =>
      map[keyOf(symbol, timeframe)]?.side ?? null,
    [map],
  );

  // `set` is stable (no deps) so consumers can safely depend on it in effects;
  // it no-ops when the value is unchanged to avoid needless re-renders.
  const set = useCallback(
    (
      symbol: string,
      timeframe: string,
      action: PublishedScannerAction | null,
      side: ActionDirection = null,
    ) => {
      setMap((m) => {
        const k = keyOf(symbol, timeframe);
        const nextSide: ActionDirection = action == null ? null : side;
        const prev = m[k];
        if (prev && prev.action === action && prev.side === nextSide) return m;
        if (!prev && action == null) return m;
        return { ...m, [k]: { action, side: nextSide } };
      });
    },
    [],
  );

  const value = useMemo<SelectedActionStore>(() => ({ get, getSide, set }), [get, getSide, set]);

  return (
    <SelectedActionStoreContext.Provider value={value}>
      {children}
    </SelectedActionStoreContext.Provider>
  );
}

export function useSelectedActionStore(): SelectedActionStore {
  return useContext(SelectedActionStoreContext);
}
