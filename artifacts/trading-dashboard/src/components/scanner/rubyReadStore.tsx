// Page-level shared Ruby-read store (Task #600).
//
// The Scanner renders the Ruby Chart Read panel in TWO places — under the chart
// (ScannerChartPanel) and inside scalp cards (ScalpSignalCard) — and the header
// strip shows a Ruby cell for the selected symbol. Before this store the panel
// owned its server read in local state, so the header's Ruby cell could not see
// it and the two could disagree (header "Full read" while the panel's actual
// read came back gated/insufficient).
//
// This lifts the server read and request lifecycle to a page-level store KEYED BY symbol+timeframe so
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
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChartRead } from "@/lib/rubyReadPanelState";
import { validateRubyChartRead } from "@/lib/rubyChartReadResponse";
import { rubyChartReadKey as keyOf } from "@/lib/rubyChartReadContext";

// Transport deadline only, not a market-evidence expiry or freshness claim.
export const CHART_READ_REQUEST_TIMEOUT_MS = 30_000;

interface ReadRequestState { loading: boolean; error: string | null }
const IDLE: ReadRequestState = { loading: false, error: null };
function withheld(reason: string): ChartRead {
  return { gated: true, dataQuality: "insufficient", readLayer: "INSUFFICIENT", liveSetupWithheld: true, canShowLiveTradeSetup: false, blockedReason: reason };
}

interface RubyReadStore {
  /** The lifted server read for a symbol/timeframe, or null when none has run. */
  get: (symbol: string, timeframe: string) => ChartRead | null;
  /** Publish (or clear with null) the server read for a symbol/timeframe. */
  set: (symbol: string, timeframe: string, read: ChartRead | null) => void;
  requestState: (symbol: string, timeframe: string) => ReadRequestState;
  request: (symbol: string, timeframe: string, load: (signal: AbortSignal) => Promise<unknown>) => Promise<void>;
}

const RubyReadStoreContext = createContext<RubyReadStore>({
  get: () => null,
  set: () => {},
  requestState: () => IDLE,
  request: async () => {},
});

export function RubyReadStoreProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, ChartRead | null>>({});
  const [requests, setRequests] = useState<Record<string, ReadRequestState>>({});
  // Synchronous tickets prevent an older completion (including its error or
  // finalizer) from changing a newer request, even within one React batch.
  const tickets = useRef(new Map<string, AbortController>());
  useEffect(() => () => {
    const pending = [...tickets.current.values()];
    tickets.current.clear();
    pending.forEach(controller => controller.abort());
  }, []);
  const get = useCallback(
    (symbol: string, timeframe: string): ChartRead | null =>
      map[keyOf(symbol, timeframe)] ?? null,
    [map],
  );
  const set = useCallback(
    (symbol: string, timeframe: string, read: ChartRead | null) => {
      const key = keyOf(symbol, timeframe);
      const previous = tickets.current.get(key);
      tickets.current.delete(key);
      previous?.abort();
      setRequests(m => ({ ...m, [key]: IDLE }));
      setMap((m) => ({ ...m, [key]: read }));
    },
    [],
  );
  const requestState = useCallback((symbol: string, timeframe: string) => requests[keyOf(symbol, timeframe)] ?? IDLE, [requests]);
  const request = useCallback(async (symbol: string, timeframe: string, load: (signal: AbortSignal) => Promise<unknown>) => {
    const key = keyOf(symbol, timeframe);
    const previous = tickets.current.get(key);
    const ticket = new AbortController();
    tickets.current.set(key, ticket);
    previous?.abort();
    setRequests(m => ({ ...m, [key]: { loading: true, error: null } }));
    // Keep all shared consumers restricted during refresh; null would restore
    // their pre-read capability and could upgrade the header prematurely.
    setMap(m => ({ ...m, [key]: withheld("Chart read is being refreshed; the previous assessment is withheld.") }));
    let abortListener!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("Chart read did not finish. Please try again."));
      ticket.signal.addEventListener("abort", abortListener, { once: true });
    });
    const timeout = setTimeout(() => ticket.abort(), CHART_READ_REQUEST_TIMEOUT_MS);
    try {
      // The race settles even when a transport/mock ignores its abort signal.
      const response = await Promise.race([load(ticket.signal), interrupted]);
      if (tickets.current.get(key) !== ticket) return;
      const read = validateRubyChartRead(response, { symbol, timeframe });
      setMap(m => ({ ...m, [key]: read }));
      setRequests(m => ({ ...m, [key]: IDLE }));
    } catch (error) {
      if (tickets.current.get(key) !== ticket) return;
      setMap(m => ({ ...m, [key]: withheld("The latest chart read failed; the previous assessment is withheld. Try reading this chart again.") }));
      setRequests(m => ({ ...m, [key]: { loading: false, error: error instanceof Error ? error.message : "network error" } }));
    } finally {
      clearTimeout(timeout);
      ticket.signal.removeEventListener("abort", abortListener);
      if (tickets.current.get(key) === ticket) tickets.current.delete(key);
    }
  }, []);
  const value = useMemo<RubyReadStore>(() => ({ get, set, requestState, request }), [get, set, requestState, request]);
  return (
    <RubyReadStoreContext.Provider value={value}>
      {children}
    </RubyReadStoreContext.Provider>
  );
}

export function useRubyReadStore(): RubyReadStore {
  return useContext(RubyReadStoreContext);
}
