// One page-level assessment store. Exact plans share their own read/request;
// market-level header/chart consumers receive only a conservative summary.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChartRead } from "@/lib/rubyReadPanelState";
import { validateRubyChartRead } from "@/lib/rubyChartReadResponse";
import { rubyChartReadKey as keyOf, rubyChartReadPlanKey, type RubyChartDraft } from "@/lib/rubyChartReadContext";

// Transport deadline only, not a market-evidence expiry or freshness claim.
export const CHART_READ_REQUEST_TIMEOUT_MS = 30_000;
interface ReadRequestState { loading: boolean; error: string | null }
const IDLE: ReadRequestState = { loading: false, error: null };
function withheld(reason: string): ChartRead {
  return { gated: true, dataQuality: "insufficient", readLayer: "INSUFFICIENT", liveSetupWithheld: true, canShowLiveTradeSetup: false, blockedReason: reason };
}
const INVALID_PLAN = withheld("The plan contains invalid values. Choose a valid side and finite entry, stop and target before reading it.");
const CHANGED_PLAN = withheld("The plan changed; the previous assessment is withheld. Read this plan again.");
const DIFFERENT_PLANS = withheld("Different plans are displayed for this market. Review each plan's own assessment; there is no shared full read.");
const UNREAD_PLAN = withheld("The current plan has not been assessed. Read this plan before using its assessment.");
const INACTIVE_PLAN = withheld("The assessed plan is no longer displayed; its assessment is withheld.");
interface Binding { market: string; key: string | null }
type Loader = (signal: AbortSignal) => Promise<unknown>;
interface RubyReadStore {
  get: (symbol: string, timeframe: string) => ChartRead | null;
  set: (symbol: string, timeframe: string, read: ChartRead | null) => void;
  requestState: (symbol: string, timeframe: string) => ReadRequestState;
  request: (symbol: string, timeframe: string, load: Loader) => Promise<void>;
  getPlan: (symbol: string, timeframe: string, draft: RubyChartDraft | null) => ChartRead | null;
  planRequestState: (symbol: string, timeframe: string, draft: RubyChartDraft | null) => ReadRequestState;
  requestPlan: (symbol: string, timeframe: string, draft: RubyChartDraft | null, load: Loader) => Promise<void>;
  registerPlan: (owner: symbol, symbol: string, timeframe: string, draft: RubyChartDraft | null) => void;
  unregisterPlan: (owner: symbol) => void;
}
const RubyReadStoreContext = createContext<RubyReadStore>({
  get: () => null, set: () => {}, requestState: () => IDLE, request: async () => {},
  getPlan: (_s, _t, draft) => rubyChartReadPlanKey(_s, _t, draft) === null ? INVALID_PLAN : null,
  planRequestState: () => IDLE, requestPlan: async () => {}, registerPlan: () => {}, unregisterPlan: () => {},
});

export function RubyReadStoreProvider({ children }: { children: ReactNode }) {
  // All writes occur in event handlers, request completions or layout effects.
  // Synchronous refs make ticket/binding checks atomic within a React batch.
  const reads = useRef(new Map<string, ChartRead | null>());
  const requests = useRef(new Map<string, ReadRequestState>());
  const owners = useRef(new Map<symbol, Binding>());
  const marketRestrictions = useRef(new Map<string, ChartRead>());
  const tickets = useRef(new Map<string, AbortController>());
  const [revision, setRevision] = useState(0);
  const notify = useCallback(() => setRevision(n => n + 1), []);
  const cancel = useCallback((key: string) => {
    const previous = tickets.current.get(key);
    tickets.current.delete(key);
    previous?.abort();
    requests.current.set(key, IDLE);
  }, []);
  useEffect(() => () => {
    const pending = [...tickets.current.values()];
    tickets.current.clear();
    pending.forEach(controller => controller.abort());
  }, []);

  const registerPlan = useCallback((owner: symbol, symbol: string, timeframe: string, draft: RubyChartDraft | null) => {
    const market = keyOf(symbol, timeframe), key = rubyChartReadPlanKey(symbol, timeframe, draft);
    const previous = owners.current.get(owner);
    if (previous?.market === market && previous.key === key) return;
    owners.current.set(owner, { market, key });
    const shared = [...owners.current.entries()].some(([other, binding]) => other !== owner && binding.market === market && binding.key === key);
    if (previous?.market === market && previous.key !== key) {
      // Keep another consumer's same-plan work intact. Only the orphaned old
      // plan is cancelled; ignored transport aborts cannot regain its ticket.
      if (previous.key !== null && ![...owners.current.values()].some(binding => binding.key === previous.key)) {
        cancel(previous.key);
        reads.current.set(previous.key, CHANGED_PLAN);
      }
      if (key !== null && !shared) {
        cancel(key);
        reads.current.set(key, CHANGED_PLAN);
      }
      marketRestrictions.current.set(market, CHANGED_PLAN);
    }
    if (previous && previous.market !== market) {
      marketRestrictions.current.set(previous.market, INACTIVE_PLAN);
      // No-draft reads retain the legacy independent-market navigation
      // lifecycle. A draft-specific orphan must not complete behind another
      // market and reappear as if assessed for the newly displayed plan.
      if (previous.key !== null && previous.key !== previous.market
        && ![...owners.current.values()].some(binding => binding.key === previous.key)) {
        cancel(previous.key);
        reads.current.set(previous.key, INACTIVE_PLAN);
      }
    }
    notify();
  }, [cancel, notify]);
  const unregisterPlan = useCallback((owner: symbol) => {
    const previous = owners.current.get(owner);
    if (!previous) return;
    owners.current.delete(owner);
    if (previous.key !== null && previous.key !== previous.market
      && ![...owners.current.values()].some(binding => binding.key === previous.key)) {
      cancel(previous.key);
      reads.current.set(previous.key, INACTIVE_PLAN);
    }
    if (![...owners.current.values()].some(binding => binding.market === previous.market)) {
      marketRestrictions.current.set(previous.market, INACTIVE_PLAN);
    }
    notify();
  }, [cancel, notify]);

  const getPlan = useCallback((symbol: string, timeframe: string, draft: RubyChartDraft | null) => {
    const key = rubyChartReadPlanKey(symbol, timeframe, draft);
    return key === null ? INVALID_PLAN : reads.current.get(key) ?? null;
  }, [revision]);
  const get = useCallback((symbol: string, timeframe: string): ChartRead | null => {
    const market = keyOf(symbol, timeframe);
    const active = [...owners.current.values()].filter(binding => binding.market === market);
    if (!active.length) return marketRestrictions.current.get(market) ?? reads.current.get(market) ?? null;
    const keys = new Set(active.map(binding => binding.key));
    if (keys.size > 1) return DIFFERENT_PLANS;
    const key = active[0]!.key;
    if (key === null) return INVALID_PLAN;
    return reads.current.get(key) ?? (key !== market ? UNREAD_PLAN : marketRestrictions.current.get(market) ?? null);
  }, [revision]);
  const set = useCallback((symbol: string, timeframe: string, read: ChartRead | null) => {
    const key = keyOf(symbol, timeframe);
    cancel(key);
    reads.current.set(key, read);
    // Legacy explicitly seeded chart-only state retains its prior API semantics.
    marketRestrictions.current.delete(key);
    notify();
  }, [cancel, notify]);
  const requestState = useCallback((symbol: string, timeframe: string) => requests.current.get(keyOf(symbol, timeframe)) ?? IDLE, [revision]);
  const planRequestState = useCallback((symbol: string, timeframe: string, draft: RubyChartDraft | null) => {
    const key = rubyChartReadPlanKey(symbol, timeframe, draft);
    return key === null ? IDLE : requests.current.get(key) ?? IDLE;
  }, [revision]);

  const runRequest = useCallback(async (key: string, symbol: string, timeframe: string, load: Loader) => {
    const previous = tickets.current.get(key);
    const ticket = new AbortController();
    tickets.current.set(key, ticket);
    previous?.abort();
    requests.current.set(key, { loading: true, error: null });
    reads.current.set(key, withheld("Chart read is being refreshed; the previous assessment is withheld."));
    notify();
    let abortListener!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("Chart read did not finish. Please try again."));
      ticket.signal.addEventListener("abort", abortListener, { once: true });
    });
    const timeout = setTimeout(() => ticket.abort(), CHART_READ_REQUEST_TIMEOUT_MS);
    try {
      const response = await Promise.race([load(ticket.signal), interrupted]);
      if (tickets.current.get(key) !== ticket) return;
      const read = validateRubyChartRead(response, { symbol, timeframe });
      reads.current.set(key, read);
      requests.current.set(key, IDLE);
      notify();
    } catch (error) {
      if (tickets.current.get(key) !== ticket) return;
      reads.current.set(key, withheld("The latest chart read failed; the previous assessment is withheld. Try reading this chart again."));
      requests.current.set(key, { loading: false, error: error instanceof Error ? error.message : "network error" });
      notify();
    } finally {
      clearTimeout(timeout);
      ticket.signal.removeEventListener("abort", abortListener);
      if (tickets.current.get(key) === ticket) tickets.current.delete(key);
    }
  }, [notify]);
  const request = useCallback((symbol: string, timeframe: string, load: Loader) => runRequest(keyOf(symbol, timeframe), symbol, timeframe, load), [runRequest]);
  const requestPlan = useCallback(async (symbol: string, timeframe: string, draft: RubyChartDraft | null, load: Loader) => {
    const key = rubyChartReadPlanKey(symbol, timeframe, draft);
    if (key === null) return;
    await runRequest(key, symbol, timeframe, load);
  }, [runRequest]);
  const value = useMemo<RubyReadStore>(() => ({ get, set, requestState, request, getPlan, planRequestState, requestPlan, registerPlan, unregisterPlan }),
    [get, set, requestState, request, getPlan, planRequestState, requestPlan, registerPlan, unregisterPlan]);
  return <RubyReadStoreContext.Provider value={value}>{children}</RubyReadStoreContext.Provider>;
}
export function useRubyReadStore(): RubyReadStore { return useContext(RubyReadStoreContext); }
