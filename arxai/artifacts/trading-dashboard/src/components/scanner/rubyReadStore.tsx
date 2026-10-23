// Page-level shared Ruby-read store (Task #600).
//
// The Scanner renders the Ruby Chart Read panel in TWO places — under the chart
// (ScannerChartPanel) and inside scalp cards (ScalpSignalCard) — and the header
// strip shows a Ruby cell for the selected symbol. Before this store the panel
// owned its server read in local state, so the header's Ruby cell could not see
// it and the two could disagree (header "Full read" while the panel's actual
// read came back gated/insufficient).
//
// This lifts the server read to a page-level store KEYED BY symbol+timeframe so
// every surface looking at the same market shares ONE read, while different
// markets (e.g. a GBPUSD scalp card vs the EURUSD chart) stay independent.
// Switching the selected symbol/timeframe naturally reads a different key — an
// empty key means "no read yet", which is the honest pre-read state.
//
// The default context value is a no-op so the panel still renders standalone
// (e.g. in render-proof tests with no provider): `get` returns null and `set` is
// ignored, which is exactly the pre-read state.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ChartRead } from "@/lib/rubyReadPanelState";

function keyOf(symbol: string, timeframe: string): string {
  return `${(symbol || "").toUpperCase()}|${timeframe || ""}`;
}

interface RubyReadStore {
  /** The lifted server read for a symbol/timeframe, or null when none has run. */
  get: (symbol: string, timeframe: string) => ChartRead | null;
  /** Publish (or clear with null) the server read for a symbol/timeframe. */
  set: (symbol: string, timeframe: string, read: ChartRead | null) => void;
}

const RubyReadStoreContext = createContext<RubyReadStore>({
  get: () => null,
  set: () => {},
});

export function RubyReadStoreProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, ChartRead | null>>({});
  const get = useCallback(
    (symbol: string, timeframe: string): ChartRead | null =>
      map[keyOf(symbol, timeframe)] ?? null,
    [map],
  );
  const set = useCallback(
    (symbol: string, timeframe: string, read: ChartRead | null) => {
      setMap((m) => ({ ...m, [keyOf(symbol, timeframe)]: read }));
    },
    [],
  );
  const value = useMemo<RubyReadStore>(() => ({ get, set }), [get, set]);
  return (
    <RubyReadStoreContext.Provider value={value}>
      {children}
    </RubyReadStoreContext.Provider>
  );
}

export function useRubyReadStore(): RubyReadStore {
  return useContext(RubyReadStoreContext);
}
