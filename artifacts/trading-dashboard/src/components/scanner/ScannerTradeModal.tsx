import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Loader2, ShieldCheck, Info, Radio, RadioTower } from "lucide-react";
import { RubySetupReason, type SignalContext } from "./RubySetupReason";
import { assessStopLoss, computeValidatedRR } from "@/lib/risk/stopLossAssessment";
import { useToast } from "@/hooks/use-toast";
import { LiveTradeTicket } from "@/components/live/LiveTradeTicket";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { resolveTradeAffordance } from "@/lib/trade-affordance";
import { HistoricalCheckPanel } from "@/components/trading/HistoricalCheckPanel";
import { NewsRiskCheckPanel } from "@/components/trading/NewsRiskCheckPanel";
import { useAssistantName } from "@/lib/assistant-name";
import { Zap } from "lucide-react";

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
  heartbeatFreshStrict?: boolean;
  eaVersionAtLeast?: boolean;
  bridgeReady?: boolean;
  bridgeBlockers?: string[];
  gateBlockers?: string[];
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
// price inputs (mirrors the header/chart precision: 2 dp ≥ 100, else 5 dp).
// Used to seed the "Current price" field from the ONE shared truth price so the
// modal can never show a different live price than the rest of the page.
function seedPriceStr(n: number): string {
  if (!Number.isFinite(n)) return "";
  const digits = Math.abs(n) >= 100 ? 2 : 5;
  return String(Number(n.toFixed(digits)));
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

// ScannerTradeModal — opens from a Market Scanner result card. Routes
// MARKET orders through the demo-command queue (POST /api/me/demo-commands
// → /confirm → /dispatch) so they appear in Recent Demo Commands, Open
// Demo Positions, and Latest Demo Trade Result on the MT5 Bridge page.
// Pending order types are saved as drafts (EA does not yet execute pending
// orders). Live mode is structurally blocked unless the user's live envelope
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
  const [bridge, setBridge] = useState<BridgeReadiness | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const idempotencyKeyRef = useRef<string>(`sc-${signal.symbol}-${signal.timeframe ?? ""}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const toastedTerminalRef = useRef<string | null>(null);
  // Tracks whether the editable "Current price" has been seeded from the shared
  // truth price for the current open. Lets us snap to the live price exactly
  // once when it resolves (cold open) without clobbering subsequent user edits.
  const currentPriceSeededRef = useRef(false);
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
  const { truth: feedTruth } = useScannerTruth(
    signal.symbol,
    normalizeChartTimeframe(signal.timeframe ?? "5m"),
  );
  const demoAffordance = resolveTradeAffordance(feedTruth, "demo");
  const liveAffordance = resolveTradeAffordance(feedTruth, "live");
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
    async function load() {
      try {
        setBridgeLoading(true);
        const r = await fetch(u("/api/me/demo-bridge-debug"), { credentials: "include" });
        if (!r.ok) { if (!cancelled) setBridge(null); return; }
        const j = await r.json();
        if (cancelled) return;
        setBridge(j.bridge ?? null);
      } catch { if (!cancelled) setBridge(null); }
      finally { if (!cancelled) setBridgeLoading(false); }
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
  const bridgeBlockReason: string | null = (() => {
    if (bridgeReady) return null;
    if (!bridge || bridge.connectionId == null) return "No demo bridge connected. Open MT5 Setup and attach the ARX EA to a demo account.";
    // Prefer server-provided blocker list when available.
    const serverBlockers = [
      ...(bridge.bridgeBlockers ?? []),
      ...(bridge.gateBlockers ?? []),
    ];
    if (serverBlockers.length > 0) {
      return `Bridge not dispatch-ready: ${serverBlockers.join(", ")}. Open MT5 Setup → Demo Execution Control or MT5 → EA → Inputs to fix.`;
    }
    if (bridge.heartbeatFreshStrict === false) return `Bridge heartbeat stale (${bridge.heartbeatAgeSeconds ?? "?"}s ≥ 15s strict window). Reattach the EA on the MT5 chart.`;
    if (bridge.accountType !== "demo" && bridge.accountType !== "contest") return `Bridge account type is "${bridge.accountType ?? "unknown"}" — must be DEMO.`;
    if (bridge.eaVersionAtLeast === false) return `EA version "${bridge.eaVersionReported ?? "unknown"}" is below the required 1.27. Open MT5 Setup and refresh/attach the active EA.`;
    if (bridge.eaInputs.readOnlyMode === true) return "Selected bridge is read-only. In MT5 → EA → Inputs, set ReadOnlyMode=false.";
    if (bridge.eaInputs.enableDemoExecution === false) return "Selected bridge has EnableDemoExecution=false. In MT5 → EA → Inputs, set EnableDemoExecution=true.";
    return "Selected bridge is not dispatch-ready. Open MT5 Setup for details.";
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
    currentPriceSeededRef.current = false;
    idempotencyKeyRef.current = `sc-${signal.symbol}-${signal.timeframe ?? ""}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }, [open, signal.symbol, signal.timeframe, signal.entry, signal.stopLoss, signal.takeProfit, defaultSide]);

  // Snap the editable "Current price" to the ONE shared truth price exactly once
  // per open, as soon as it resolves (the feed may still be loading on a cold
  // open, where the reset above seeded signal.entry as a placeholder). Seeding
  // once — not on every poll tick — avoids jitter and preserves any later user
  // edit. Risk #4: the modal's current price now matches the header/chart.
  useEffect(() => {
    if (!open || sharedLastClose == null || currentPriceSeededRef.current) return;
    setCurrentPrice(seedPriceStr(sharedLastClose));
    currentPriceSeededRef.current = true;
  }, [open, sharedLastClose]);

  // Live validation — now uses the reasonable-stop-loss assessor so a SL
  // placed too close to entry (or omitted) is either adjusted to a safe
  // distance or surfaced as a blocking error. R:R only renders when risk
  // is at least 1 pip — eliminates the absurd R:R from a near-zero risk.
  const validation = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const slAdvice: string[] = [];
    if (!Number.isFinite(lotSize) || lotSize <= 0) errors.push("Lot size must be greater than 0.");
    if (lotSize > 100) errors.push("Lot size cannot exceed 100.");
    const cp = num(currentPrice), ep = num(entryPrice), st = num(stopTriggerPrice), sli = num(stopLimitPrice);
    const slv = num(sl), tpv = num(tp);
    let effEntry: number | null = market ? cp : stopLimit ? sli : ep;
    if (!market && !stopLimit && ep == null) errors.push("Entry price required for limit/stop orders.");
    if (stopLimit && (st == null || sli == null)) errors.push("Stop trigger + stop limit prices required.");

    let assessedSl: number | null = slv;
    let pipSize = 0.0001;
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
        spread: typeof (signal as unknown as { spread?: number }).spread === "number" ? (signal as unknown as { spread?: number }).spread : null,
        slippageBufferPips: 3,
      });
      pipSize = assess.pipSize;
      if (!assess.ok) {
        errors.push(assess.reason);
      } else {
        assessedSl = assess.sl;
        if (assess.adjusted) {
          warnings.push(assess.reason);
          slAdvice.push(`Suggested SL ${assess.sl?.toFixed(5) ?? "—"} (stop distance ${assess.stopDistance?.toFixed(5) ?? "—"}).`);
        } else {
          slAdvice.push(assess.reason);
        }
      }
    }

    let riskPx: number | null = null, rewardPx: number | null = null, rr: number | null = null;
    if (effEntry != null && assessedSl != null && tpv != null) {
      rr = computeValidatedRR(effEntry, assessedSl, tpv, pipSize);
      if (rr == null) {
        warnings.push("R:R unavailable until a valid stop loss is set.");
      } else {
        riskPx = Math.abs(effEntry - assessedSl);
        rewardPx = Math.abs(tpv - effEntry);
        if (rr < 1) warnings.push(`Risk/Reward ${rr.toFixed(2)} is below 1:1.`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, rr, riskPx, rewardPx, assessedSl, slAdvice };
  }, [orderType, direction, market, stopLimit, lotSize, currentPrice, entryPrice, stopTriggerPrice, stopLimitPrice, sl, tp, signal]);

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
      setStatusLog((s) => [...s, `QUEUED ${commandId}`]);
      // 2. Confirm
      const r2 = await fetch(u(`/api/me/demo-commands/${encodeURIComponent(commandId)}/confirm`), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: "{}",
      });
      const j2 = await r2.json();
      if (!j2.ok || !j2.command) { setErr(`CONFIRM_FAILED: ${j2.reason ?? r2.status}`); return; }
      setCmd((c) => c ? { ...c, status: j2.command.status, reason: j2.command.reason ?? null } : c);
      setStatusLog((s) => [...s, `DEMO_APPROVED`]);
      // 3. Dispatch
      const r3 = await fetch(u(`/api/me/demo-commands/${encodeURIComponent(commandId)}/dispatch`), {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: "{}",
      });
      const j3 = await r3.json();
      if (!j3.ok || !j3.command) { setErr(`DISPATCH_FAILED: ${j3.reason ?? r3.status}`); return; }
      setCmd((c) => c ? { ...c, status: j3.command.status, reason: j3.command.reason ?? null } : c);
      setStatusLog((s) => [...s, `SENT_TO_MT5_DEMO`]);
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
        setStatusLog((s) => [...s, `DRAFT_SAVED ${j.draftId}`]);
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
        if (!r.ok) return;
        const j = await r.json();
        const c = j.command;
        if (!c || cancelled) return;
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
      } catch {/* keep polling */}
    }, 1200);
    return () => { cancelled = true; clearInterval(t); };
  }, [cmd?.commandId, cmd?.status]);

  const submitDisabled =
    busy ||
    !validation.ok ||
    (bigLot && !bigLotAck) ||
    (demoAffordance.requireAck && !feedAck) || // honest demo feed-not-live ack
    (cmd != null && !terminal) ||
    (market && !bridgeReady); // block market dispatch when bridge isn't execution-ready

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
          <div className="flex items-center gap-1.5 rounded border border-success/40 bg-success/5 px-2 py-1.5 text-[11px] text-success">
            <ShieldCheck className="h-3.5 w-3.5" />
            Demo trading enabled. Live broker execution disabled.
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
                {bridgeLoading && !bridge ? "Checking active demo bridge…"
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
              {!bridgeReady && bridgeBlockReason && (
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
                  <Input value={currentPrice} onChange={(e) => setCurrentPrice(e.target.value)} placeholder="e.g. 1.0850" />
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
                <div className="flex justify-between"><span className="text-txt-secondary">Estimated risk (price units)</span><span className="font-mono">{validation.riskPx != null ? validation.riskPx.toFixed(5) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Estimated reward (price units)</span><span className="font-mono">{validation.rewardPx != null ? validation.rewardPx.toFixed(5) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Risk / Reward</span><span className="font-mono">{validation.rr != null ? validation.rr.toFixed(2) : "—"}</span></div>
                {/* Theme B — this is a hand-weighted heuristic sum, not a
                    calibrated probability. It is NOT rendered with a "%": an
                    "82%" reads as "82 out of 100 of these work out", which is a
                    claim nothing here has measured. Shown as a bounded score
                    with its scale stated instead. */}
                {(signal.signalStrength ?? signal.confidenceScore) != null && (
                  <div className="flex justify-between pt-1 border-t border-border">
                    <span className="text-txt-secondary" title="Hand-weighted signal strength, not a calibrated win probability.">
                      Scanner signal strength
                    </span>
                    <span className="font-mono">{Math.round((signal.signalStrength ?? signal.confidenceScore)!)} / 100</span>
                  </div>
                )}
              </div>

              {!market && (
                <div className="rounded bg-primary/10 p-2 text-[11px] text-primary flex items-start gap-1.5">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  Pending orders save as validated drafts. The MT5 EA does not yet execute pending orders — nothing will be sent to your broker until that EA upgrade ships.
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
                  cmd.status === "DRAFT_SAVED" ? "bg-primary/20 text-primary" :
                  "bg-warning/20 text-warning"
                }`}>{cmd.status}</span>
              </div>
              <div className="text-muted-foreground">Lifecycle: {statusLog.join(" → ")}</div>
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
              {!terminal && cmd.status !== "DRAFT_SAVED" && (
                <div className="flex items-center gap-1.5 text-warning"><Loader2 className="h-3 w-3 animate-spin" /> Waiting for EA fill…</div>
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
