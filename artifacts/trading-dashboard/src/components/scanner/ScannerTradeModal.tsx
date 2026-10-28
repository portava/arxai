import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Loader2, ShieldCheck, Info, Radio, RadioTower } from "lucide-react";
import { RubySetupReason, type SignalContext } from "./RubySetupReason";
import {
  assessStopLoss,
  computeValidatedRR,
  stopLossInputsFromBrokerSpec,
  type BrokerSymbolSpecForStops,
  type StopLossSpecInputs,
} from "@/lib/risk/stopLossAssessment";
import { resolveBrokerSymbol, type SymbolResolution } from "@/lib/useMt5Symbols";
import { useToast } from "@/hooks/use-toast";
import { LiveTradeTicket } from "@/components/live/LiveTradeTicket";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { formatInstrumentPrice, resolveDisplayPricePrecision, seedInstrumentPrice } from "@/lib/instrumentPriceFormat";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { resolveTradeAffordance } from "@/lib/trade-affordance";
import { HistoricalCheckPanel } from "@/components/trading/HistoricalCheckPanel";
import { NewsRiskCheckPanel } from "@/components/trading/NewsRiskCheckPanel";
import { useAssistantName } from "@/lib/assistant-name";
import { Zap } from "lucide-react";
import { bridgeBlockReason as bridgeBlockReasonFor } from "./bridgeBlockReason";

/**
 * Conservative fallback lot, used ONLY when the producing engine supplied no
 * size — i.e. it deliberately refused to compute one. It is never a substitute
 * for a real computed lot; seeding the ticket unconditionally with it is what
 * made the executed size diverge from the displayed one (Theme D1).
 */
const DEFAULT_LOT = 0.02;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1">
      {children}
    </div>
  );
}

type BridgeReadiness = {
  connectionId: number | null;
  accountLoginMasked: string | null;
  accountType: string | null;
  eaVersionReported: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  // Server-authoritative dispatch-gate fields (added by debug endpoint).
  // UI must use bridgeReady (not local heuristics) to gate submit so the
  // UI verdict matches what createDraftCommand will actually accept.
  /** false = the server could not evaluate the dispatch gate for this read. */
  gateEvaluated?: boolean;
  // null = not measured (gate not evaluated); only true counts as a pass.
  heartbeatFreshStrict?: boolean | null;
  eaVersionAtLeast?: boolean | null;
  bridgeReady?: boolean | null;
  bridgeBlockers?: string[];
  gateBlockers?: string[];
  /** Demo execution armed for this account (MT5 Setup → Demo Execution Control); null/absent = not reported. */
  armed?: boolean | null;
  eaInputs: {
    readOnlyMode: boolean | null;
    enableDemoExecution: boolean | null;
    reportedAt: string | null;
  };
};

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

const ORDER_TYPES = [
  "BUY_MARKET", "SELL_MARKET",
  "BUY_LIMIT", "SELL_LIMIT",
  "BUY_STOP", "SELL_STOP",
  "BUY_STOP_LIMIT", "SELL_STOP_LIMIT",
] as const;
type OrderType = (typeof ORDER_TYPES)[number];

const SAFE_LOT_DEFAULT = 0.10;

function isMarket(t: OrderType) { return t === "BUY_MARKET" || t === "SELL_MARKET"; }
function isStopLimit(t: OrderType) { return t === "BUY_STOP_LIMIT" || t === "SELL_STOP_LIMIT"; }
function dirOf(t: OrderType): "BUY" | "SELL" { return t.startsWith("BUY") ? "BUY" : "SELL"; }
function num(s: string): number | null { const v = Number(s); return Number.isFinite(v) ? v : null; }

// Format a raw price number into a clean, parseable string for the editable
// price inputs at the instrument's display precision (the SAME precision the
// header, chart badge and price axis use — lib/instrumentPriceFormat). Used to
// seed the "Current price" field from the ONE shared truth price so the modal
// can never show a different price, or fewer digits, than the rest of the page.
function seedPriceStr(n: number, precision: number | null | undefined): string {
  return seedInstrumentPrice(n, precision);
}

// Where the editable "Current price" value came from. The field is filled once
// per open and never follows the market, so the ticket says what it holds: the
// feed's last candle close (with its candle time, source and feed state), the
// signal's entry level when no feed price exists, or the user's own edit.
type CurrentPriceBasis =
  | { kind: "signal" }
  | { kind: "user" }
  | {
      kind: "feed";
      value: number;
      candleAt: string | null;
      sourceLabel: string | null;
      displayStatus: string;
      isLive: boolean;
    };

const FEED_STATE_WORD: Record<string, string> = {
  LIVE: "live",
  STALE: "stale",
  ANALYSIS_ONLY: "historical only",
  FALLBACK_COMPOSITE: "on a fallback composite source",
  UNAVAILABLE: "unavailable",
};

function utcClock(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 19)} UTC` : null;
}

function currentPriceBasisText(
  basis: CurrentPriceBasis,
  hasValue: boolean,
  latestClose: number | null,
  precision: number | null | undefined,
): string {
  if (basis.kind === "user") return "Entered by you.";
  if (basis.kind === "signal") {
    return hasValue
      ? "No feed price is available yet — this is the signal's entry level, not a current price."
      : "No feed price is available yet.";
  }
  const at = utcClock(basis.candleAt);
  const from = `from ${basis.sourceLabel ?? "the chart feed"}${at ? `, candle at ${at}` : ""}`;
  const head = basis.isLive
    ? `Last candle close ${from}.`
    : `Not a live price — last candle close ${from}, while the feed is ${FEED_STATE_WORD[basis.displayStatus] ?? "not live"}.`;
  const moved = latestClose != null && latestClose !== basis.value
    ? ` Latest close is now ${formatInstrumentPrice(latestClose, precision)}.`
    : "";
  return `${head} Filled once when this ticket opened; it does not update while the ticket stays open.${moved}`;
}

type DemoCommand = {
  commandId: string;
  status: string;
  reason: string | null;
  brokerTicket?: string | null;
  fillPrice?: number | null;
  fillVolume?: number | null;
  filledAt?: string | null;
  terminalAt?: string | null;
};

const TERMINAL = new Set(["FILLED_DEMO", "REJECTED", "FAILED", "BLOCKED"]);
// Statuses before the command is handed to the EA: nothing is "waiting for an
// EA fill" yet.
const PRE_DISPATCH = new Set(["DRAFT", "USER_CONFIRMATION_REQUIRED", "DEMO_APPROVED"]);
// Consecutive failed status reads after which the modal stops narrating
// progress and says the status is unavailable.
const POLL_FAILURES_BEFORE_UNKNOWN = 3;

// The server's per-user dispatch gate (GET /api/me/demo-bridge-debug →
// bridge.gateBlockers) is evaluated with userConfirmed=false, so
// USER_NOT_CONFIRMED is always listed and is cleared by this form's own
// confirm step. Every other blocker means the server will refuse the order.
const CONFIRM_STEP_BLOCKER = "USER_NOT_CONFIRMED";
const GATE_BLOCKER_WORDS: Record<string, string> = {
  WRONG_EXECUTION_MODE: "your account is not armed for demo execution (arm it in MT5 Setup → Demo Execution Control)",
  NOT_VERIFIED_DEMO: "the demo account has not passed demo verification",
  ACCOUNT_TYPE_NOT_EXPLICIT_DEMO: "the bridge account is not confirmed as a demo account",
  NO_BRIDGE_CONNECTION: "no demo bridge is connected",
  BRIDGE_NOT_CONNECTED: "the demo bridge is not connected",
  HEARTBEAT_STALE: "the demo bridge heartbeat is stale",
  LIVE_LOCK_BROKEN: "the live lock is not in place",
  RISK_GATE_FAILED: "the risk gate did not pass",
  DUPLICATE_SUSPECTED: "a duplicate EA is suspected",
};
function gateBlockerWords(code: string): string {
  if (GATE_BLOCKER_WORDS[code]) return GATE_BLOCKER_WORDS[code];
  if (code.startsWith("EA_VERSION_TOO_OLD")) return "the EA version is too old";
  return code;
}

type DemoExecutionState =
  | { kind: "checking" }
  | { kind: "unchecked" }
  | { kind: "unreported" }
  | { kind: "blocked"; reasons: string[] }
  | { kind: "enabled" };

// ScannerTradeModal — opens from a Market Scanner result card. Routes
// MARKET orders through the demo-command queue (POST /api/me/demo-commands
// → /confirm → /dispatch) so they appear in Recent Demo Commands, Open
// Demo Positions, and Latest Demo Trade Result on the MT5 Bridge page.
// Pending order types are saved as drafts only (never sent to the broker); the
// saved draft carries the server's reading of the bridge's pending support. Live mode is structurally blocked unless the user's live envelope
// allows it AND they go through a separate protected confirm step.
export function ScannerTradeModal({
  open, onClose, signal, defaultSide,
}: {
  open: boolean;
  onClose: () => void;
  signal: SignalContext;
  defaultSide: "BUY" | "SELL";
}) {
  const { name } = useAssistantName();
  const [orderType, setOrderType] = useState<OrderType>(defaultSide === "BUY" ? "BUY_MARKET" : "SELL_MARKET");
  // Seed from the engine's computed risk-based lot so the executed size equals
  // the displayed one. DEFAULT_LOT is only a fallback for when the engine
  // refused to size (null) — it must never override a real computed lot
  // (Theme D1).
  const [lotSize, setLotSize] = useState<number>(signal.suggestedLot ?? DEFAULT_LOT);
  const [currentPrice, setCurrentPrice] = useState<string>(signal.entry != null ? String(signal.entry) : "");
  const [entryPrice, setEntryPrice] = useState<string>(signal.entry != null ? String(signal.entry) : "");
  const [stopTriggerPrice, setStopTriggerPrice] = useState<string>("");
  const [stopLimitPrice, setStopLimitPrice] = useState<string>("");
  const [sl, setSl] = useState<string>(signal.stopLoss != null ? String(signal.stopLoss) : "");
  const [tp, setTp] = useState<string>(signal.takeProfit != null ? String(signal.takeProfit) : "");
  const [notes, setNotes] = useState<string>("");
  const [bigLotAck, setBigLotAck] = useState(false);
  const [feedAck, setFeedAck] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cmd, setCmd] = useState<DemoCommand | null>(null);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [pollFailures, setPollFailures] = useState(0);
  const [bridge, setBridge] = useState<BridgeReadiness | null>(null);
  // Outcome of the most recent bridge-status request. "checking" until the
  // first answer of this open; "failed" when the request errored — the bridge
  // state is then UNKNOWN (never reported as "no bridge connected").
  const [bridgeCheck, setBridgeCheck] = useState<"checking" | "failed" | "done">("checking");
  const [bridgeCheckDetail, setBridgeCheckDetail] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string>(`sc-${signal.symbol}-${signal.timeframe ?? ""}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const toastedTerminalRef = useRef<string | null>(null);
  // Tracks whether the editable "Current price" has been seeded from the shared
  // truth price for the current open. Lets us snap to the live price exactly
  // once when it resolves (cold open) without clobbering subsequent user edits.
  const currentPriceSeededRef = useRef(false);
  const [priceBasis, setPriceBasis] = useState<CurrentPriceBasis>({ kind: "signal" });
  const { toast } = useToast();
  const [liveTicketOpen, setLiveTicketOpen] = useState(false);
  // Client-side hide of the LIVE SHARED button for unapproved users. Server
  // still re-checks; this is purely a "don't tempt the user" guard.
  const liveSharedAccess = useMasterLiveAccess();
  // Authoritative account mode. A LIVE_SHARED account ALWAYS routes to the
  // live ticket — never the DEMO order body — regardless of a transient
  // bridge-availability block. The live ticket renders the honest live
  // block when canTrade is false.
  const tradingMode = useTradingMode();

  // Shared scanner feed-truth for THIS signal's symbol/timeframe. Drives the
  // honest feed-affordance: a demo trade on a stale/historical read requires an
  // explicit acknowledgement; a live one-click stays frictionless but the live
  // ticket carries a non-blocking feed warning. Called unconditionally (before
  // any early return) so hook order stays stable.
  const { truth: feedTruth, isError: feedReadFailed } = useScannerTruth(
    signal.symbol,
    normalizeChartTimeframe(signal.timeframe ?? "5m"),
  );
  // A failed feed read is an unknown feed, not a pending one → warn + demo ack.
  const demoAffordance = resolveTradeAffordance(feedTruth, "demo", { isError: feedReadFailed });
  const liveAffordance = resolveTradeAffordance(feedTruth, "live", { isError: feedReadFailed });
  const liveFeedWarning = liveAffordance.warningTitle
    ? { warningTitle: liveAffordance.warningTitle, warningDetail: liveAffordance.warningDetail }
    : null;

  // The ONE shared current price for this symbol — same source (chart candles →
  // resolveScannerTruth) the header strip and chart read. Seeds the editable
  // "Current price" field so the modal can never display a different live price
  // than the rest of the page (Task #512, risk #4). The planned "Entry price"
  // stays signal.entry — that is the intended limit/stop level, not the current
  // market price.
  const sharedLastClose = feedTruth?.candles.lastClose ?? null;

  // The broker's reported spec for this symbol (arx_symbol_specs via the
  // resolve endpoint, which maps aliases such as "V75" to the broker string).
  // It is the ONLY source of the pip size, stop level and spread the
  // stop-loss check uses; with no spec the check says the distance could not
  // be checked instead of guessing a pip size from the symbol name.
  const symbolSpecQ = useQuery<SymbolResolution>({
    queryKey: ["mt5-symbol-spec", signal.symbol],
    enabled: open && !!signal.symbol,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => resolveBrokerSymbol(signal.symbol),
  });
  const specResolution = symbolSpecQ.data;
  const brokerSpec: BrokerSymbolSpecForStops | null =
    specResolution && specResolution.ok === true && specResolution.matched && typeof specResolution.matched === "object"
      ? specResolution.matched
      : null;
  const specInputs: StopLossSpecInputs = stopLossInputsFromBrokerSpec(brokerSpec);

  // OWNER unrestricted profile bypasses the "safe-default lot" warning
  // — same source of truth as LiveTradeTicket so the two surfaces are
  // consistent. Server-side 16-gate evaluator + kill switch + master
  // switch still run; this is purely a client warning-copy bypass.
  const liveProfile = useQuery<{ ok: boolean; isOwnerUnrestricted: boolean; templateName: string | null }>({
    queryKey: ["me", "live", "profile"],
    queryFn: async () => (await fetch(u("/api/me/live/profile"), { credentials: "include" })).json(),
    staleTime: 30_000,
  });
  const isOwnerUnrestricted = !!liveProfile.data?.isOwnerUnrestricted;

  const direction = dirOf(orderType);
  const market = isMarket(orderType);
  const stopLimit = isStopLimit(orderType);
  const bigLot = lotSize > SAFE_LOT_DEFAULT && !isOwnerUnrestricted;
  const terminal = cmd && TERMINAL.has(cmd.status);

  // Fetch the active demo bridge readiness whenever the modal opens, and
  // poll every 5s while open so the operator sees fresh heartbeat / EA-Input
  // state. Drives both the "Active demo bridge" status line and the
  // submit-block when ReadOnlyMode=true or EnableDemoExecution=false.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // A snapshot from an earlier open is not this open's bridge state.
    setBridge(null);
    setBridgeCheck("checking");
    setBridgeCheckDetail(null);
    // A failed request leaves the bridge state unknown: it is never shown as
    // "no bridge connected", and the stale answer is dropped (submit stays
    // blocked because bridgeReady needs a successful answer).
    const failed = (detail: string) => {
      if (cancelled) return;
      setBridge(null);
      setBridgeCheck("failed");
      setBridgeCheckDetail(detail);
    };
    async function load() {
      try {
        const r = await fetch(u("/api/me/demo-bridge-debug"), { credentials: "include" });
        if (!r.ok) { failed(`HTTP ${r.status}`); return; }
        const j = await r.json();
        if (cancelled) return;
        // A payload with no bridge block is not an answer about the bridge.
        if (!j.bridge) { failed("no bridge block in the response"); return; }
        setBridge(j.bridge);
        setBridgeCheck("done");
        setBridgeCheckDetail(null);
      } catch (e) { failed(String((e as Error)?.message ?? e)); }
    }
    void load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [open]);

  // Server-authoritative verdict — matches the dispatch gate exactly.
  // Falls back to a strict local approximation only if the server hasn't
  // returned the new fields yet (e.g. older API in flight).
  const bridgeReady = Boolean(
    bridge && (
      bridge.bridgeReady === true ||
      // Defensive fallback when server hasn't returned the new field set.
      (
        bridge.bridgeReady === undefined &&
        bridge.connectionId != null &&
        bridge.heartbeatFreshStrict === true &&
        (bridge.accountType === "demo" || bridge.accountType === "contest") &&
        bridge.eaVersionAtLeast === true &&
        bridge.eaInputs.readOnlyMode !== true &&
        bridge.eaInputs.enableDemoExecution !== false
      )
    ),
  );
  const bridgeBlockReason: string | null = bridgeBlockReasonFor(bridge, bridgeReady);

  // Is demo execution enabled for THIS user right now? Read from the server's
  // own dispatch gate, never asserted: a ready bridge is not enough (the user
  // must also be armed for demo execution and verified), and createDraftCommand
  // refuses an unarmed user with NOT_ARMED_FOR_DEMO_EXECUTION.
  const demoExecution: DemoExecutionState = (() => {
    if (bridgeCheck === "checking") return { kind: "checking" };
    if (bridgeCheck === "failed" || !bridge) return { kind: "unchecked" };
    if (!Array.isArray(bridge.gateBlockers)) return { kind: "unreported" };
    const blocking = bridge.gateBlockers.filter((b) => b !== CONFIRM_STEP_BLOCKER);
    if (blocking.length > 0) return { kind: "blocked", reasons: blocking.map(gateBlockerWords) };
    return { kind: "enabled" };
  })();

  // Reset internal state every time the modal opens for a new signal,
  // including a fresh idempotency key so a different signal can't reuse
  // the previous one.
  useEffect(() => {
    if (!open) return;
    setOrderType(defaultSide === "BUY" ? "BUY_MARKET" : "SELL_MARKET");
    setLotSize(signal.suggestedLot ?? DEFAULT_LOT);
    setCurrentPrice(signal.entry != null ? String(signal.entry) : "");
    setEntryPrice(signal.entry != null ? String(signal.entry) : "");
    setStopTriggerPrice("");
    setStopLimitPrice("");
    setSl(signal.stopLoss != null ? String(signal.stopLoss) : "");
    setTp(signal.takeProfit != null ? String(signal.takeProfit) : "");
    setNotes("");
    setBigLotAck(false);
    setFeedAck(false);
    setConfirmStep(false);
    setBusy(false);
    setErr(null);
    setCmd(null);
    setStatusLog([]);
    setPollFailures(0);
    currentPriceSeededRef.current = false;
    setPriceBasis({ kind: "signal" });
    idempotencyKeyRef.current = `sc-${signal.symbol}-${signal.timeframe ?? ""}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }, [open, signal.symbol, signal.timeframe, signal.entry, signal.stopLoss, signal.takeProfit, defaultSide]);

  // Snap the editable "Current price" to the ONE shared truth price exactly once
  // per open, as soon as it resolves (the feed may still be loading on a cold
  // open, where the reset above seeded signal.entry as a placeholder). Seeding
  // once — not on every poll tick — avoids jitter and preserves any later user
  // edit. Risk #4: the modal's current price now matches the header/chart.
  useEffect(() => {
    if (!open || sharedLastClose == null || currentPriceSeededRef.current) return;
    setCurrentPrice(seedPriceStr(sharedLastClose, feedTruth?.candles.pricePrecision));
    setPriceBasis({
      kind: "feed",
      value: sharedLastClose,
      candleAt: feedTruth?.candles.lastTime ?? null,
      sourceLabel: feedTruth?.candles.sourceLabel ?? null,
      displayStatus: feedTruth?.displayStatus ?? "UNAVAILABLE",
      isLive: feedTruth?.isLivePrice === true,
    });
    currentPriceSeededRef.current = true;
  }, [open, sharedLastClose]);

  // Live validation — now uses the reasonable-stop-loss assessor so a SL
  // placed too close to entry (or omitted) is either adjusted to a safe
  // distance or surfaced as a blocking error. R:R only renders when risk
  // is at least 1 pip — eliminates the absurd R:R from a near-zero risk.
  // The pip size, stop level and spread come from the broker spec
  // (specInputs); without it the distance is reported as not checked.
  const validation = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const slAdvice: string[] = [];
    if (!Number.isFinite(lotSize) || lotSize <= 0) errors.push("Lot size must be greater than 0.");
    if (lotSize > 100) errors.push("Lot size cannot exceed 100.");
    const cp = num(currentPrice), ep = num(entryPrice), st = num(stopTriggerPrice), sli = num(stopLimitPrice);
    const slv = num(sl), tpv = num(tp);
    let effEntry: number | null = market ? cp : stopLimit ? sli : ep;
    // Derived prices and distances print at the instrument's display precision
    // (the same one the header and chart use); with none known, at the digits
    // of the prices on this ticket — never an invented fixed 5 dp.
    const pricePrecision: number | null =
      feedTruth?.candles.pricePrecision ?? resolveDisplayPricePrecision(null, [cp, ep, st, sli, slv, tpv]);
    const px = (v: number | null | undefined): string =>
      v == null || !Number.isFinite(v) ? "—" : pricePrecision != null ? v.toFixed(pricePrecision) : String(v);
    if (!market && !stopLimit && ep == null) errors.push("Entry price required for limit/stop orders.");
    if (stopLimit && (st == null || sli == null)) errors.push("Stop trigger + stop limit prices required.");

    let assessedSl: number | null = slv;
    let pipSize: number | null = null;
    if (effEntry != null) {
      const long = direction === "BUY";
      if (tpv != null && long && tpv <= effEntry) errors.push("Take profit must be ABOVE entry for BUY.");
      if (tpv != null && !long && tpv >= effEntry) errors.push("Take profit must be BELOW entry for SELL.");
      const assess = assessStopLoss({
        symbol: signal.symbol,
        side: long ? "BUY" : "SELL",
        entry: effEntry,
        proposedSl: slv,
        recentSwingLow: typeof (signal as unknown as { recentSwingLow?: number }).recentSwingLow === "number" ? (signal as unknown as { recentSwingLow?: number }).recentSwingLow : null,
        recentSwingHigh: typeof (signal as unknown as { recentSwingHigh?: number }).recentSwingHigh === "number" ? (signal as unknown as { recentSwingHigh?: number }).recentSwingHigh : null,
        atr: typeof (signal as unknown as { atr?: number }).atr === "number" ? (signal as unknown as { atr?: number }).atr : null,
        spread: typeof (signal as unknown as { spread?: number }).spread === "number" ? (signal as unknown as { spread?: number }).spread : specInputs.spread,
        minStopDistance: specInputs.minStopDistance,
        freezeLevel: specInputs.freezeLevel,
        pipSize: specInputs.pipSize,
        slippageBufferPips: 3,
      });
      pipSize = assess.pipSize;
      if (!assess.ok) {
        errors.push(assess.reason);
      } else {
        assessedSl = assess.sl;
        if (assess.adjusted) {
          warnings.push(assess.reason);
          slAdvice.push(`Suggested SL ${px(assess.sl)} (stop distance ${px(assess.stopDistance)}).`);
        } else if (!assess.distanceChecked) {
          // The broker spec is missing: say the distance was not checked.
          warnings.push(assess.reason);
        } else {
          slAdvice.push(assess.reason);
        }
      }
    }

    let riskPx: number | null = null, rewardPx: number | null = null, rr: number | null = null;
    if (effEntry != null && assessedSl != null && tpv != null) {
      rr = computeValidatedRR(effEntry, assessedSl, tpv, pipSize);
      if (rr == null) {
        warnings.push(pipSize == null
          ? `R:R not shown: without the broker's pip size for ${signal.symbol} a near-zero stop cannot be ruled out.`
          : "R:R unavailable until a valid stop loss is set.");
        // The price distances are plain arithmetic on the ticket's prices and
        // stay shown when only the pip size (needed for the ratio) is missing.
        const r = Math.abs(effEntry - assessedSl), w = Math.abs(tpv - effEntry);
        if (pipSize == null && r > 0 && w > 0) { riskPx = r; rewardPx = w; }
      } else {
        riskPx = Math.abs(effEntry - assessedSl);
        rewardPx = Math.abs(tpv - effEntry);
        if (rr < 1) warnings.push(`Risk/Reward ${rr.toFixed(2)} is below 1:1.`);
      }
    }
    return {
      ok: errors.length === 0, errors, warnings, rr, riskPx, rewardPx, assessedSl, slAdvice,
      riskPxText: px(riskPx), rewardPxText: px(rewardPx),
    };
  }, [orderType, direction, market, stopLimit, lotSize, currentPrice, entryPrice, stopTriggerPrice, stopLimitPrice, sl, tp, signal, feedTruth?.candles.pricePrecision,
    specInputs.pipSize, specInputs.minStopDistance, specInputs.freezeLevel, specInputs.spread]);

  // Submit MARKET via demo-command queue (only flow EA actually executes
  // today). Sets source=MARKET_SCANNER + signalContext in payload so the
  // MT5 Bridge page can filter and the audit trail is honest.
  async function submitMarket() {
    setBusy(true); setErr(null);
    try {
      const draftBody = {
        commandType: "PLACE_MARKET_ORDER",
        payload: {
          symbol: signal.symbol,
          volume: lotSize,
          side: direction,
          orderType,
          stopLoss: num(sl),
          takeProfit: num(tp),
          notes: notes.slice(0, 300) || null,
          idempotencyKey: idempotencyKeyRef.current,
          source: "MARKET_SCANNER",
          // Centralized Master MT5 Bridge (Slice 1+2) — let the queue
          // populate mt5_demo_commands.source_page / source_signal_id.
          sourcePage: "MARKET_SCANNER",
          sourceSignalId: `${signal.symbol}:${signal.timeframe ?? "?"}:${signal.bias ?? "?"}`,
          signalContext: {
            symbol: signal.symbol,
            timeframe: signal.timeframe ?? null,
            bias: signal.bias,
            recommendedAction: signal.recommendedAction,
            confidenceScore: signal.confidenceScore ?? null,
            setupType: signal.setupType ?? null,
            reasonForTrade: (signal.reasonForTrade ?? "").slice(0, 200),
          },
        },
      };
      // 1. Draft
      const r1 = await fetch(u("/api/me/demo-commands"), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftBody),
      });
      const j1 = await r1.json();
      if (!j1.ok || !j1.command) { setErr(j1.reason ?? `HTTP ${r1.status}`); return; }
      const commandId = j1.command.commandId as string;
      setCmd({ commandId, status: j1.command.status, reason: j1.command.reason ?? null });
      setStatusLog((s) => [...s, `${j1.command.status} ${commandId}`]);
      // Every step records the row status the SERVER returned — on success AND
      // on refusal (a refused confirm can already have moved the row to BLOCKED).
      const applyStep = (j: { command?: { status?: string; reason?: string | null } | null }) => {
        const status = j.command?.status;
        if (typeof status !== "string" || !status) return;
        setCmd((c) => c ? { ...c, status, reason: j.command?.reason ?? null } : c);
        setStatusLog((s) => (s[s.length - 1] === status ? s : [...s, status]));
      };
      // 2. Confirm
      const r2 = await fetch(u(`/api/me/demo-commands/${encodeURIComponent(commandId)}/confirm`), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: "{}",
      });
      const j2 = await r2.json();
      applyStep(j2);
      if (!j2.ok || !j2.command) { setErr(`CONFIRM_FAILED: ${j2.reason ?? r2.status}`); return; }
      // 3. Dispatch
      const r3 = await fetch(u(`/api/me/demo-commands/${encodeURIComponent(commandId)}/dispatch`), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: "{}",
      });
      const j3 = await r3.json();
      applyStep(j3);
      if (!j3.ok || !j3.command) { setErr(`DISPATCH_FAILED: ${j3.reason ?? r3.status}`); return; }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function submitPendingDraft() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(u("/api/me/pending-order-draft"), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderType, symbol: signal.symbol, lotSize, requestedMode: "DEMO",
          entryPrice: num(entryPrice), stopTriggerPrice: num(stopTriggerPrice),
          stopLimitPrice: num(stopLimitPrice),
          stopLoss: num(sl), takeProfit: num(tp), currentPrice: num(currentPrice),
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(String(j.error ?? `HTTP ${r.status}`)); return; }
      if (j.blocked) { setErr(`${j.reason ?? "Blocked"} (${j.checkId ?? "guard"})`); return; }
      if (j.ok) {
        setCmd({ commandId: `draft-${j.draftId}`, status: "DRAFT_SAVED", reason: j.reason ?? null });
        setStatusLog((s) => [...s, `DRAFT_SAVED ${j.draftId}${typeof j.pendingStatus === "string" ? ` (${j.pendingStatus})` : ""}`]);
      } else {
        setErr(String(j.error ?? "draft_failed"));
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function onSubmitClick() {
    if (!validation.ok || busy) return;
    if (bigLot && !bigLotAck) return;
    if (demoAffordance.requireAck && !feedAck) return;
    if (!confirmStep) { setConfirmStep(true); return; }
    if (market) void submitMarket(); else void submitPendingDraft();
  }

  // Poll active command to refresh status / fill ticket until terminal.
  useEffect(() => {
    if (!cmd || !cmd.commandId || cmd.commandId.startsWith("draft-")) return;
    if (TERMINAL.has(cmd.status)) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const r = await fetch(u(`/api/me/demo-commands/${encodeURIComponent(cmd.commandId)}`), { credentials: "include" });
        if (cancelled) return;
        if (!r.ok) { setPollFailures((n) => n + 1); return; }
        const j = await r.json();
        const c = j.command;
        if (cancelled) return;
        if (!c) { setPollFailures((n) => n + 1); return; }
        setPollFailures(0);
        const next: DemoCommand = {
          commandId: c.commandId,
          status: c.status,
          reason: c.reason ?? null,
          brokerTicket: c.brokerTicket ?? null,
          fillPrice: c.fillPrice ?? null,
          fillVolume: c.fillVolume ?? null,
          filledAt: c.filledAt ?? null,
          terminalAt: c.terminalAt ?? null,
        };
        setCmd((prev) => {
          if (prev && prev.status !== next.status) {
            setStatusLog((s) => [...s, next.status]);
          }
          return next;
        });
        if (TERMINAL.has(next.status)) {
          clearInterval(t);
          // Toast exactly once per command on terminal — no fake success.
          if (toastedTerminalRef.current !== next.commandId) {
            toastedTerminalRef.current = next.commandId;
            if (next.status === "FILLED_DEMO") {
              toast({
                title: "Demo trade filled",
                description: `${signal.symbol} ${direction} ${lotSize} — ticket ${next.brokerTicket ?? "?"} @ ${next.fillPrice ?? "?"}`,
              });
            } else {
              toast({
                title: "Demo trade not filled",
                description: `${next.status}: ${next.reason ?? "no reason returned"}`,
                variant: "destructive",
              });
            }
          }
        }
      } catch { if (!cancelled) setPollFailures((n) => n + 1); /* keep polling */ }
    }, 1200);
    return () => { cancelled = true; clearInterval(t); };
  }, [cmd?.commandId, cmd?.status]);

  const submitDisabled =
    busy ||
    !validation.ok ||
    (bigLot && !bigLotAck) ||
    (demoAffordance.requireAck && !feedAck) || // honest demo feed-not-live ack
    (cmd != null && !terminal) ||
    (market && !bridgeReady) || // block market dispatch when bridge isn't execution-ready
    (market && demoExecution.kind === "blocked"); // the server's dispatch gate would refuse it

  // While either the account mode or the access verdict is still loading,
  // render a neutral skeleton — never the DEMO body, so a live account
  // never sees a "DEMO" flash before being routed to the live ticket.
  if (open && (tradingMode.isLoading || !liveSharedAccess.loaded)) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-md w-[calc(100%-1rem)] sm:w-full p-6">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading trading access…
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // A LIVE_SHARED account ALWAYS gets the live shared ticket — opened
  // directly. No demo body, no second popup, no DEMO badge. We route by
  // account MODE (not only canTrade) so a transient bridge block can
  // never dump a live account into the DEMO order form; the live ticket
  // itself surfaces the honest live block when canTrade is false.
  if (tradingMode.isLiveShared || liveSharedAccess.canTrade) {
    return (
      <LiveSharedTradeTicket
        open={open}
        onOpenChange={(o) => { if (!o) onClose(); }}
        defaultSymbol={signal.symbol}
        defaultSide={direction}
        rubyExplanationSummary={signal.reasonForTrade ?? null}
        feedWarning={liveFeedWarning}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl w-[calc(100%-1rem)] sm:w-full max-h-[90dvh] overflow-x-hidden flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0 border-b border-border/40">
          {/* pr-9 keeps the title/LIVE row clear of the absolute Dialog close
              (X) at right-4 top-4 so the close control stays tappable on
              narrow mobile widths. */}
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base min-w-0 pr-9">
            <span className="truncate">Scanner Trade — {signal.symbol}</span>
            <span className="text-xs text-muted-foreground">{signal.timeframe}</span>
            <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${direction === "BUY" ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}>{direction}</span>
            <span className="rounded bg-warning/20 px-2 py-0.5 text-[10px] font-semibold text-warning">DEMO</span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 text-[11px] border-danger/50 text-danger hover:bg-danger/10"
              onClick={() => setLiveTicketOpen(true)}
              data-testid="scanner-btn-live"
            >
              <Zap className="h-3 w-3 mr-1" /> LIVE
            </Button>
          </DialogTitle>
        </DialogHeader>
        <LiveTradeTicket
          open={liveTicketOpen}
          onOpenChange={setLiveTicketOpen}
          defaultSymbol={signal.symbol}
          defaultSide={direction}
          sourcePage="MARKET_SCANNER_LIVE"
          rubyExplanationSummary={signal.reasonForTrade ?? null}
          feedWarning={liveFeedWarning}
        />

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm min-h-0">
          <div
            className={`flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px] ${
              demoExecution.kind === "enabled"
                ? "border-success/40 bg-success/5 text-success"
                : demoExecution.kind === "checking"
                  ? "border-border bg-card text-muted-foreground"
                  : "border-warning/50 bg-warning/10 text-warning"
            }`}
            data-testid="scanner-demo-execution-banner"
          >
            {demoExecution.kind === "enabled"
              ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              : demoExecution.kind === "checking"
                ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              {demoExecution.kind === "enabled" && "Demo execution enabled for this account (server dispatch gate)."}
              {demoExecution.kind === "checking" && "Checking demo execution for this account…"}
              {demoExecution.kind === "unchecked" && "Demo execution for this account could not be checked — the server's dispatch gate did not respond."}
              {demoExecution.kind === "unreported" && "The server did not report whether demo execution is allowed for this account."}
              {demoExecution.kind === "blocked" &&
                `Demo execution is not available for this account: ${demoExecution.reasons.join("; ")}. The server will refuse orders from this form until that is fixed.`}
              {" "}This form sends demo orders only; live orders go through the separate LIVE ticket.
            </span>
          </div>

          <SectionLabel>{name} Summary</SectionLabel>
          <RubySetupReason signal={signal} dense />

          <SectionLabel>Historical Check</SectionLabel>
          <HistoricalCheckPanel symbol={signal.symbol} timeframe={signal.timeframe ?? "1d"} defaultOpen />

          <SectionLabel>News Risk Check</SectionLabel>
          <NewsRiskCheckPanel symbol={signal.symbol} defaultOpen />

          {/* Active demo bridge readiness — drives submit gating */}
          <div
            className={`flex items-start gap-2 rounded border px-2 py-1.5 text-[11px] ${
              bridgeReady
                ? "border-success/40 bg-success/5 text-success"
                : "border-warning/50 bg-warning/10 text-warning"
            }`}
            data-testid="scanner-bridge-readiness"
          >
            {bridgeReady ? <RadioTower className="mt-0.5 h-3.5 w-3.5" /> : <Radio className="mt-0.5 h-3.5 w-3.5" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {bridgeCheck === "checking" ? "Checking active demo bridge…"
                  : bridgeCheck === "failed" ? "Active demo bridge status unknown"
                  : bridgeReady ? "Active demo bridge ready"
                  : "Active demo bridge NOT ready"}
              </div>
              {bridge && bridge.connectionId != null && (
                <div className="mt-0.5 truncate font-mono text-[10px] opacity-80">
                  bridge #{bridge.connectionId}
                  {bridge.accountLoginMasked ? ` · acct ${bridge.accountLoginMasked}` : ""}
                  {bridge.eaVersionReported ? ` · EA v${bridge.eaVersionReported}` : ""}
                  {bridge.heartbeatAgeSeconds != null ? ` · hb ${bridge.heartbeatAgeSeconds}s` : ""}
                  {bridge.eaInputs.readOnlyMode === true ? " · READ_ONLY" : ""}
                  {bridge.eaInputs.enableDemoExecution === false ? " · EXEC_OFF" : ""}
                </div>
              )}
              {bridgeCheck === "failed" && (
                <div className="mt-1 opacity-90" data-testid="scanner-bridge-check-failed">
                  The bridge status could not be checked{bridgeCheckDetail ? ` (${bridgeCheckDetail})` : ""}, so whether your EA is attached and ready is unknown. Demo orders stay blocked until the check succeeds; it retries every 5 seconds.
                </div>
              )}
              {bridgeCheck === "done" && !bridgeReady && bridgeBlockReason && (
                <div className="mt-1 opacity-90">{bridgeBlockReason}</div>
              )}
            </div>
          </div>

          {!cmd && (
            <>
              <SectionLabel>Trade Setup</SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <Label className="text-xs">Order type</Label>
                  <select
                    className="w-full rounded border border-border bg-card px-2 py-1.5 text-sm"
                    value={orderType}
                    onChange={(e) => setOrderType(e.target.value as OrderType)}
                  >
                    {ORDER_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Volume / lot</Label>
                  <Input type="number" step="0.01" min="0.01" value={lotSize}
                    onChange={(e) => setLotSize(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="text-xs">Current price</Label>
                  <Input
                    value={currentPrice}
                    onChange={(e) => { setCurrentPrice(e.target.value); setPriceBasis({ kind: "user" }); }}
                    placeholder="e.g. 1.0850"
                    data-testid="scanner-trade-current-price"
                  />
                </div>
                <div
                  className={`col-span-2 -mt-1 text-[10px] ${priceBasis.kind === "feed" && priceBasis.isLive ? "text-muted-foreground" : "text-warning"}`}
                  data-testid="scanner-trade-current-price-basis"
                  data-basis={priceBasis.kind}
                >
                  {currentPriceBasisText(priceBasis, currentPrice.trim() !== "", sharedLastClose, feedTruth?.candles.pricePrecision)}
                </div>
                {!market && !stopLimit && (
                  <div className="col-span-2">
                    <Label className="text-xs">Entry price</Label>
                    <Input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} placeholder="required" />
                  </div>
                )}
                {stopLimit && (
                  <>
                    <div><Label className="text-xs">Stop trigger</Label>
                      <Input value={stopTriggerPrice} onChange={(e) => setStopTriggerPrice(e.target.value)} /></div>
                    <div><Label className="text-xs">Stop limit</Label>
                      <Input value={stopLimitPrice} onChange={(e) => setStopLimitPrice(e.target.value)} /></div>
                  </>
                )}
                <div>
                  <Label className="text-xs">Stop loss</Label>
                  <Input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="—" />
                </div>
                <div>
                  <Label className="text-xs">Take profit</Label>
                  <Input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why are you taking this?" maxLength={300} />
                </div>
              </div>

              <SectionLabel>Risk / Reward</SectionLabel>
              <div className="rounded border border-border bg-card p-2 text-xs space-y-0.5">
                <div className="flex justify-between"><span className="text-txt-secondary">Estimated risk (price units)</span><span className="font-mono" data-testid="scanner-trade-risk-px">{validation.riskPxText}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Estimated reward (price units)</span><span className="font-mono" data-testid="scanner-trade-reward-px">{validation.rewardPxText}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Risk / Reward</span><span className="font-mono">{validation.rr != null ? validation.rr.toFixed(2) : "—"}</span></div>
                {/* Theme B — this is a hand-weighted heuristic sum, not a
                    calibrated probability. It is NOT rendered with a "%": an
                    "82%" reads as "82 out of 100 of these work out", which is a
                    claim nothing here has measured. Shown as a bounded score
                    with its scale stated instead. */}
                {signal.confidenceScore != null && (
                  <div className="flex justify-between pt-1 border-t border-border">
                    <span className="text-txt-secondary" title="Hand-weighted signal strength, not a calibrated win probability.">
                      Scanner signal strength
                    </span>
                    <span className="font-mono">{Math.round(signal.confidenceScore)} / 100</span>
                  </div>
                )}
              </div>

              {!market && (
                <div
                  className="rounded bg-indigo-500/10 p-2 text-[11px] text-indigo-200 flex items-start gap-1.5"
                  data-testid="scanner-trade-pending-disclosure"
                >
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  Pending orders save as validated drafts only — this ticket never sends a pending order to your broker. After saving, the draft shows what your MT5 bridge reports about pending-order support.
                </div>
              )}

              {validation.errors.length > 0 && (
                <div className="rounded bg-danger/10 p-2 text-xs text-danger">
                  <div className="font-semibold mb-1">Validation errors</div>
                  <ul className="list-disc list-inside">{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div className="rounded bg-warning/10 p-2 text-xs text-warning">{validation.warnings.join(" ")}</div>
              )}
              {bigLot && (
                <label className="flex items-start gap-2 rounded bg-warning/10 p-2 text-xs text-warning">
                  <Checkbox checked={bigLotAck} onCheckedChange={(v) => setBigLotAck(v === true)} />
                  <span>Lot size <strong>{lotSize}</strong> exceeds the safe default ({SAFE_LOT_DEFAULT}). Confirm you want to proceed.</span>
                </label>
              )}
              {demoAffordance.warningTitle && (
                <label className="flex items-start gap-2 rounded bg-warning/10 p-2 text-xs text-warning" data-testid="scanner-trade-feed-warning">
                  {demoAffordance.requireAck ? (
                    <Checkbox checked={feedAck} onCheckedChange={(v) => setFeedAck(v === true)} className="mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  )}
                  <span>
                    <strong>{demoAffordance.warningTitle}.</strong> {demoAffordance.warningDetail}
                    {demoAffordance.requireAck && " Confirm you understand before sending."}
                  </span>
                </label>
              )}
              {confirmStep && (
                <>
                  <SectionLabel>Final Confirmation</SectionLabel>
                  <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Review the trade details above. Tap <strong>Send</strong> to dispatch to your demo broker.
                  </div>
                </>
              )}
              {err && <div className="rounded bg-danger/10 p-2 text-xs text-danger">{err}</div>}
            </>
          )}

          {cmd && (
            <div className="rounded border border-border bg-card p-3 text-xs space-y-1.5" data-testid="scanner-trade-result">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-muted-foreground">{cmd.commandId}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                  cmd.status === "FILLED_DEMO" ? "bg-success/20 text-success" :
                  cmd.status === "REJECTED" || cmd.status === "FAILED" || cmd.status === "BLOCKED" ? "bg-danger/20 text-danger" :
                  cmd.status === "SENT_TO_MT5_DEMO" ? "bg-primary/20 text-primary" :
                  cmd.status === "DRAFT_SAVED" ? "bg-indigo-500/20 text-indigo-300" :
                  "bg-warning/20 text-warning"
                }`}>{cmd.status}</span>
              </div>
              <div className="text-muted-foreground" data-testid="scanner-trade-lifecycle">Lifecycle: {statusLog.join(" → ")}</div>
              {cmd.status === "FILLED_DEMO" && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 border-t border-border">
                  <div><span className="text-muted-foreground">Broker ticket:</span> <span className="font-mono">{cmd.brokerTicket ?? "—"}</span></div>
                  <div><span className="text-muted-foreground">Fill price:</span> <span className="font-mono">{cmd.fillPrice ?? "—"}</span></div>
                  <div><span className="text-muted-foreground">Executed volume:</span> <span className="font-mono">{cmd.fillVolume ?? "—"}</span></div>
                  <div><span className="text-muted-foreground">Filled at:</span> <span className="font-mono">{cmd.filledAt ? new Date(cmd.filledAt).toLocaleTimeString() : "—"}</span></div>
                </div>
              )}
              {(cmd.status === "REJECTED" || cmd.status === "FAILED" || cmd.status === "BLOCKED") && (
                <div className="rounded bg-danger/10 p-1.5 text-danger">
                  <span className="font-semibold">Reason:</span> <span className="font-mono">{cmd.reason ?? "unknown"}</span>
                </div>
              )}
              {cmd.status === "DRAFT_SAVED" && (
                <div className="rounded bg-indigo-500/10 p-1.5 text-indigo-200" data-testid="scanner-trade-draft-reason">
                  {cmd.reason ?? "Draft saved. It has not been sent to your broker."}
                </div>
              )}
              {err && <div className="rounded bg-danger/10 p-1.5 text-danger">{err}</div>}
              {!terminal && cmd.status !== "DRAFT_SAVED" && (
                pollFailures >= POLL_FAILURES_BEFORE_UNKNOWN ? (
                  <div className="flex items-start gap-1.5 text-warning" data-testid="scanner-trade-status-unavailable">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Status unavailable — the last {pollFailures} status checks for this command failed. Last status the server returned: {cmd.status}. Check Recent Demo Commands on the MT5 Bridge page.
                    </span>
                  </div>
                ) : PRE_DISPATCH.has(cmd.status) ? (
                  busy && !err
                    ? <div className="flex items-center gap-1.5 text-warning"><Loader2 className="h-3 w-3 animate-spin" /> Submitting to the server…</div>
                    : <div className="text-warning">Not sent to the EA — the command is at {cmd.status}.</div>
                ) : (
                  <div className="flex items-center gap-1.5 text-warning"><Loader2 className="h-3 w-3 animate-spin" /> Waiting for EA fill…</div>
                )
              )}
            </div>
          )}
        </div>

        <DialogFooter className="px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0 border-t border-border/40 bg-background/95 backdrop-blur flex-row flex-wrap gap-2 sm:gap-2">
          {!cmd && confirmStep && (
            <Button variant="outline" onClick={() => setConfirmStep(false)} disabled={busy} className="h-10 flex-1 sm:flex-none">Back</Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy && !terminal} className="h-10 flex-1 sm:flex-none" data-testid="scanner-trade-cancel">Cancel</Button>
          {!cmd && (
            <Button onClick={onSubmitClick} disabled={submitDisabled} data-testid="scanner-trade-submit" className="h-10 flex-1 sm:flex-none font-semibold">
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {confirmStep ? (market ? "Send to Demo Broker" : "Save Draft") : "Review"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
