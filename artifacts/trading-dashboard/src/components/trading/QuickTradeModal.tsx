import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Loader2, Info } from "lucide-react";
import { HistoricalCheckPanel } from "./HistoricalCheckPanel";
import { NewsRiskCheckPanel } from "./NewsRiskCheckPanel";
import { useTradingMode } from "@/hooks/useTradingMode";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

const ORDER_TYPES = [
  "BUY_MARKET",
  "SELL_MARKET",
  "BUY_LIMIT",
  "SELL_LIMIT",
  "BUY_STOP",
  "SELL_STOP",
  "BUY_STOP_LIMIT",
  "SELL_STOP_LIMIT",
] as const;
type OrderType = (typeof ORDER_TYPES)[number];

function isMarket(t: OrderType): boolean { return t === "BUY_MARKET" || t === "SELL_MARKET"; }
function isStopLimit(t: OrderType): boolean { return t === "BUY_STOP_LIMIT" || t === "SELL_STOP_LIMIT"; }
function directionOf(t: OrderType): "BUY" | "SELL" { return t.startsWith("BUY") ? "BUY" : "SELL"; }

type ValidationResp = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  riskReward: number | null;
  slDistancePips: number | null;
  tpDistancePips: number | null;
  riskPriceUnits: number | null;
  rewardPriceUnits: number | null;
  dataUnavailable: boolean;
};

function n(s: string): number | null {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Pure client-side mirror of validateOrderTicket. Backend re-validates as the
// source of truth; this is just inline UI feedback.
function validateLocal(args: {
  orderType: OrderType;
  lotSize: number;
  currentPrice: number | null;
  entryPrice: number | null;
  stopTriggerPrice: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}): ValidationResp {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { orderType, lotSize, currentPrice, entryPrice, stopTriggerPrice, stopLimitPrice, stopLoss, takeProfit } = args;
  const dir = directionOf(orderType);
  const isLong = dir === "BUY";

  if (!Number.isFinite(lotSize) || lotSize <= 0) errors.push("Lot size must be greater than 0.");
  if (lotSize > 100) errors.push("Lot size cannot exceed 100.");

  // Effective entry: market uses currentPrice; limit/stop uses entryPrice; stop-limit uses stopLimitPrice.
  let effectiveEntry: number | null = null;
  if (isMarket(orderType)) effectiveEntry = currentPrice;
  else if (isStopLimit(orderType)) effectiveEntry = stopLimitPrice;
  else effectiveEntry = entryPrice;

  // Required fields per type.
  if (!isMarket(orderType) && !isStopLimit(orderType) && entryPrice == null)
    errors.push("Entry price is required for limit/stop orders.");
  if (isStopLimit(orderType) && stopTriggerPrice == null)
    errors.push("Stop trigger price is required for stop-limit orders.");
  if (isStopLimit(orderType) && stopLimitPrice == null)
    errors.push("Stop limit price is required for stop-limit orders.");

  // Pending-order direction vs market.
  if (currentPrice != null) {
    if (orderType === "BUY_LIMIT" && entryPrice != null && entryPrice >= currentPrice)
      errors.push("BUY_LIMIT entry must be BELOW current market.");
    if (orderType === "SELL_LIMIT" && entryPrice != null && entryPrice <= currentPrice)
      errors.push("SELL_LIMIT entry must be ABOVE current market.");
    if (orderType === "BUY_STOP" && entryPrice != null && entryPrice <= currentPrice)
      errors.push("BUY_STOP entry must be ABOVE current market.");
    if (orderType === "SELL_STOP" && entryPrice != null && entryPrice >= currentPrice)
      errors.push("SELL_STOP entry must be BELOW current market.");
    if (orderType === "BUY_STOP_LIMIT" && stopTriggerPrice != null && stopTriggerPrice <= currentPrice)
      errors.push("BUY_STOP_LIMIT trigger must be ABOVE current market.");
    if (orderType === "SELL_STOP_LIMIT" && stopTriggerPrice != null && stopTriggerPrice >= currentPrice)
      errors.push("SELL_STOP_LIMIT trigger must be BELOW current market.");
  }

  // Stop-limit relationship.
  if (orderType === "BUY_STOP_LIMIT" && stopTriggerPrice != null && stopLimitPrice != null && stopLimitPrice >= stopTriggerPrice)
    errors.push("BUY_STOP_LIMIT limit price must be STRICTLY BELOW trigger price (per MT5).");
  if (orderType === "SELL_STOP_LIMIT" && stopTriggerPrice != null && stopLimitPrice != null && stopLimitPrice <= stopTriggerPrice)
    errors.push("SELL_STOP_LIMIT limit price must be STRICTLY ABOVE trigger price (per MT5).");

  // SL/TP direction vs effective entry.
  if (effectiveEntry != null) {
    if (stopLoss != null) {
      if (isLong && stopLoss >= effectiveEntry) errors.push("Stop loss must be BELOW entry for BUY orders.");
      if (!isLong && stopLoss <= effectiveEntry) errors.push("Stop loss must be ABOVE entry for SELL orders.");
    }
    if (takeProfit != null) {
      if (isLong && takeProfit <= effectiveEntry) errors.push("Take profit must be ABOVE entry for BUY orders.");
      if (!isLong && takeProfit >= effectiveEntry) errors.push("Take profit must be BELOW entry for SELL orders.");
    }
  }

  let riskReward: number | null = null;
  let riskPriceUnits: number | null = null;
  let rewardPriceUnits: number | null = null;
  if (effectiveEntry != null && stopLoss != null && takeProfit != null) {
    riskPriceUnits = Math.abs(effectiveEntry - stopLoss);
    rewardPriceUnits = Math.abs(takeProfit - effectiveEntry);
    if (riskPriceUnits > 0) riskReward = rewardPriceUnits / riskPriceUnits;
    if (riskReward != null && riskReward < 1) warnings.push(`Risk/Reward ${riskReward.toFixed(2)} is below 1:1.`);
  }

  const dataUnavailable = currentPrice == null && !isMarket(orderType);
  return {
    ok: errors.length === 0,
    errors, warnings,
    riskReward, slDistancePips: null, tpDistancePips: null,
    riskPriceUnits, rewardPriceUnits,
    dataUnavailable,
  };
}

export function QuickTradeModal({
  open, onClose, onOpened, defaultMode,
}: {
  open: boolean;
  onClose: () => void;
  onOpened: () => void;
  defaultMode?: "SIMULATED" | "DEMO" | "LIVE";
}) {
  const [orderType, setOrderType] = useState<OrderType>("BUY_MARKET");
  const [symbol, setSymbol] = useState("EURUSD");
  const [lotSize, setLotSize] = useState(0.01);
  const [mode, setMode] = useState<"SIMULATED" | "DEMO" | "LIVE">(defaultMode ?? "SIMULATED");
  const [currentPrice, setCurrentPrice] = useState<string>("");
  const [entryPrice, setEntryPrice] = useState<string>("");
  const [stopTriggerPrice, setStopTriggerPrice] = useState<string>("");
  const [stopLimitPrice, setStopLimitPrice] = useState<string>("");
  const [sl, setSl] = useState<string>("");
  const [tp, setTp] = useState<string>("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState(false);

  // Unified per-user account mode (read-only). Drives the honest default mode +
  // disabled states. Authorizes nothing — the backend re-runs every gate.
  const tradingMode = useTradingMode();
  // Live is selectable/default ONLY for an approved + armed trader who can
  // manually trade and is not frozen. While the mode is still loading we treat
  // the user as NOT live-capable (fail-closed, no live flash before resolve).
  const liveCapable =
    !tradingMode.isLoading
    && (tradingMode.isLiveShared || tradingMode.isLiveArmed)
    && tradingMode.canManualTrade
    && !tradingMode.isFrozen;
  const demoCapable = tradingMode.isDemo || tradingMode.envelope?.demoAvailable === true;
  // Honest default: live for an approved+armed trader, demo for a demo-ready
  // user, simulated otherwise. An explicit `defaultMode` prop always wins.
  const resolvedDefaultMode: "SIMULATED" | "DEMO" | "LIVE" =
    defaultMode ?? (liveCapable ? "LIVE" : demoCapable ? "DEMO" : "SIMULATED");

  // Apply the resolved default once the modal opens and the mode resolves,
  // unless the user has already picked a mode this session.
  const userPickedMode = useRef(false);
  useEffect(() => {
    if (!open) { userPickedMode.current = false; return; }
    if (userPickedMode.current || tradingMode.isLoading) return;
    setMode(resolvedDefaultMode);
  }, [open, tradingMode.isLoading, resolvedDefaultMode]);

  const market = isMarket(orderType);
  const stopLimit = isStopLimit(orderType);
  const isLive = mode === "LIVE";
  const direction = directionOf(orderType);

  const validation = useMemo<ValidationResp>(() => validateLocal({
    orderType,
    lotSize,
    currentPrice: n(currentPrice),
    entryPrice: n(entryPrice),
    stopTriggerPrice: n(stopTriggerPrice),
    stopLimitPrice: n(stopLimitPrice),
    stopLoss: n(sl),
    takeProfit: n(tp),
  }), [orderType, lotSize, currentPrice, entryPrice, stopTriggerPrice, stopLimitPrice, sl, tp]);

  async function submitMarket() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(u("/api/me/trades/open"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol, side: direction, lotSize, mode,
          stopLoss: n(sl), takeProfit: n(tp),
          confirmedByUser: true,
        }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        setErr(String(body.error ?? `HTTP ${r.status}`));
        return;
      }
      setResult(`Market order ${body.result?.status ?? "QUEUED"}`);
      onOpened();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function submitPendingDraft() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(u("/api/me/pending-order-draft"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderType, symbol, lotSize, requestedMode: mode,
          entryPrice: n(entryPrice),
          stopTriggerPrice: n(stopTriggerPrice),
          stopLimitPrice: n(stopLimitPrice),
          stopLoss: n(sl), takeProfit: n(tp),
          currentPrice: n(currentPrice),
        }),
      });
      const body = await r.json();
      if (!r.ok) {
        setErr(String(body.error ?? `HTTP ${r.status}`));
        return;
      }
      if (body.blocked) {
        setErr(`${body.reason ?? "Blocked"} (${body.checkId ?? "guard"})`);
        return;
      }
      if (body.ok) {
        setResult(`Draft #${body.draftId} saved. ${body.reason}`);
        onOpened();
      } else {
        setErr(String(body.error ?? "draft_failed"));
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  function onSubmitClick() {
    if (!validation.ok) return;
    if (!confirmStep) { setConfirmStep(true); return; }
    if (market) submitMarket(); else submitPendingDraft();
  }

  function reset() {
    setConfirmStep(false);
    setErr(null); setResult(null);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isLive && <AlertTriangle className="h-5 w-5 text-danger" />}
            Quick Trade
            <span className={`ml-2 rounded px-2 py-0.5 text-xs ${
              mode === "LIVE" ? "bg-danger/20 text-danger" :
              mode === "DEMO" ? "bg-warning/20 text-warning" :
              "bg-secondary/20 text-foreground"
            }`}>{mode}</span>
            {!market && (
              <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-200">DRAFT ONLY</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {!confirmStep ? (
          <div className="space-y-3 text-sm">
            <div>
              <Label>Order type</Label>
              <select
                className="w-full rounded border border-border bg-card px-2 py-1.5 text-sm"
                value={orderType}
                onChange={(e) => { setOrderType(e.target.value as OrderType); reset(); }}
              >
                {ORDER_TYPES.map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Symbol</Label>
                <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
              </div>
              <div>
                <Label>Lot size</Label>
                <Input type="number" step="0.01" min="0.01" value={lotSize}
                  onChange={(e) => setLotSize(Number(e.target.value))} />
              </div>

              <div className="col-span-2">
                <Label>Mode</Label>
                <div className="flex gap-1">
                  {(["SIMULATED", "DEMO", "LIVE"] as const).map((m) => {
                    const disabled = m === "LIVE" && !liveCapable;
                    return (
                      <Button key={m} type="button" size="sm"
                        variant={mode === m ? "default" : "outline"}
                        disabled={disabled}
                        title={disabled ? "Live requires an approved, armed account" : undefined}
                        onClick={() => { userPickedMode.current = true; setMode(m); }}>{m}</Button>
                    );
                  })}
                </div>
                {!liveCapable && (
                  <p className="mt-1 text-xs text-txt-secondary">
                    {tradingMode.cleanBlockedReason
                      ?? "Live trading is available only for an approved, armed account. Demo and simulated stay available."}
                  </p>
                )}
              </div>

              <div className="col-span-2">
                <Label>Current price (optional, enables market-relative checks)</Label>
                <Input value={currentPrice} onChange={(e) => setCurrentPrice(e.target.value)} placeholder="e.g. 1.0850" />
              </div>

              {!market && !stopLimit && (
                <div className="col-span-2">
                  <Label>Entry price</Label>
                  <Input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} placeholder="required" />
                </div>
              )}

              {stopLimit && (
                <>
                  <div>
                    <Label>Stop trigger</Label>
                    <Input value={stopTriggerPrice} onChange={(e) => setStopTriggerPrice(e.target.value)} placeholder="trigger price" />
                  </div>
                  <div>
                    <Label>Stop limit</Label>
                    <Input value={stopLimitPrice} onChange={(e) => setStopLimitPrice(e.target.value)} placeholder="limit price" />
                  </div>
                </>
              )}

              <div>
                <Label>Stop loss</Label>
                <Input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="—" />
              </div>
              <div>
                <Label>Take profit</Label>
                <Input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" />
              </div>
            </div>

            {/* Live RR + distance feedback */}
            <div className="rounded border border-border bg-card p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-txt-secondary">Risk/Reward</span>
                <span className="font-mono">{validation.riskReward != null ? validation.riskReward.toFixed(2) : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-txt-secondary">Risk (price units)</span>
                <span className="font-mono">{validation.riskPriceUnits != null ? validation.riskPriceUnits.toFixed(5) : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-txt-secondary">Reward (price units)</span>
                <span className="font-mono">{validation.rewardPriceUnits != null ? validation.rewardPriceUnits.toFixed(5) : "—"}</span>
              </div>
              {validation.dataUnavailable && (
                <div className="mt-1 flex items-start gap-1 text-warning">
                  <Info className="mt-0.5 h-3 w-3" />
                  <span>Enter current price to enable direction checks against the market.</span>
                </div>
              )}
            </div>

            {symbol.trim().length > 0 && (
              <>
                <HistoricalCheckPanel symbol={symbol} timeframe="1d" />
                <NewsRiskCheckPanel symbol={symbol} />
              </>
            )}

            {validation.errors.length > 0 && (
              <div className="rounded bg-danger/10 p-2 text-xs text-danger">
                <div className="mb-1 font-semibold">Validation errors</div>
                <ul className="list-inside list-disc">
                  {validation.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div className="rounded bg-warning/10 p-2 text-xs text-warning">
                {validation.warnings.join(" ")}
              </div>
            )}

            {!market && (
              <div className="rounded bg-indigo-500/10 p-2 text-xs text-indigo-200">
                Pending orders are saved as validated drafts. The MT5 EA does not yet support
                pending-order execution — this order will NOT be sent to your broker until that
                EA upgrade ships.
              </div>
            )}

            {isLive && market && (
              <div className="rounded bg-danger/10 p-3 text-danger">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <div>This is a <strong>LIVE</strong> market order. The full safety guard chain must approve before it reaches your broker.</div>
                </div>
                <label className="mt-2 flex items-start gap-2">
                  <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                  <span className="text-xs">I confirm this live order with real money.</span>
                </label>
              </div>
            )}

            {err && <div className="rounded bg-danger/10 p-2 text-xs text-danger">{err}</div>}
            {result && <div className="rounded bg-success/10 p-2 text-xs text-success">{result}</div>}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="rounded border border-border bg-card p-3">
              <div className="mb-2 text-xs font-semibold text-txt-secondary">Review before submitting</div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-txt-secondary">Order type</dt><dd className="font-mono">{orderType}</dd>
                <dt className="text-txt-secondary">Symbol</dt><dd className="font-mono">{symbol}</dd>
                <dt className="text-txt-secondary">Side</dt><dd className="font-mono">{direction}</dd>
                <dt className="text-txt-secondary">Lot size</dt><dd className="font-mono">{lotSize}</dd>
                <dt className="text-txt-secondary">Mode</dt><dd className="font-mono">{mode}</dd>
                {!market && !stopLimit && entryPrice && (<><dt className="text-txt-secondary">Entry</dt><dd className="font-mono">{entryPrice}</dd></>)}
                {stopLimit && stopTriggerPrice && (<><dt className="text-txt-secondary">Trigger</dt><dd className="font-mono">{stopTriggerPrice}</dd></>)}
                {stopLimit && stopLimitPrice && (<><dt className="text-txt-secondary">Limit</dt><dd className="font-mono">{stopLimitPrice}</dd></>)}
                {sl && (<><dt className="text-txt-secondary">Stop loss</dt><dd className="font-mono">{sl}</dd></>)}
                {tp && (<><dt className="text-txt-secondary">Take profit</dt><dd className="font-mono">{tp}</dd></>)}
                <dt className="text-txt-secondary">R/R</dt>
                <dd className="font-mono">{validation.riskReward != null ? validation.riskReward.toFixed(2) : "—"}</dd>
              </dl>
            </div>
            {market ? (
              <div className="text-xs text-txt-secondary">Market orders go through the existing guarded placement chain.</div>
            ) : (
              <div className="rounded bg-indigo-500/10 p-2 text-xs text-indigo-200">
                This will save a validated DRAFT. The MT5 EA does not yet execute pending orders —
                nothing will be sent to your broker.
              </div>
            )}
            {isLive && market && !ack && (
              <label className="flex items-start gap-2 rounded bg-danger/10 p-2 text-xs text-danger">
                <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                <span>I confirm this live order with real money.</span>
              </label>
            )}
            {err && <div className="rounded bg-danger/10 p-2 text-xs text-danger">{err}</div>}
            {result && <div className="rounded bg-success/10 p-2 text-xs text-success">{result}</div>}
          </div>
        )}

        <DialogFooter>
          {confirmStep && (
            <Button variant="outline" onClick={() => setConfirmStep(false)} disabled={busy}>Back</Button>
          )}
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={busy}>Close</Button>
          <Button
            onClick={onSubmitClick}
            disabled={busy || !validation.ok || (isLive && market && confirmStep && !ack)}
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {confirmStep
              ? (market ? "Submit Order" : "Save Draft")
              : "Review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
