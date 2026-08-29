import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown } from "lucide-react";
import TradingViewLiveChart from "@/components/charts/TradingViewLiveChart";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";

type SubmitResp = {
  accepted: boolean; testerAccess: boolean; brokerExecution: boolean;
  status: string; intentId: string; mt5Connected: boolean; reason: string;
  intent?: any;
};

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, { headers: { "x-security-role": "ADMIN", ...(init?.headers ?? {}) }, ...init });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

export default function LiveManualPage() {
  const [chartSymbol] = useChartSymbol();
  const [symbol, setSymbol] = useState(chartSymbol);
  useEffect(() => setSymbol(chartSymbol), [chartSymbol]);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [lotSize, setLotSize] = useState<number>(0.01);
  const [stopLoss, setStopLoss] = useState<number | "">("");
  const [takeProfit, setTakeProfit] = useState<number | "">("");
  const [maxLoss, setMaxLoss] = useState<number>(5);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resp, setResp] = useState<SubmitResp | null>(null);
  const [perm, setPerm] = useState<any>(null);
  const [defStatus, setDefStatus] = useState<any>(null);
  const [masterBridge, setMasterBridge] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);

  useEffect(() => {
    void jget("/api/permission/status").then(r => setPerm(r.body));
    void jget("/api/system/mt5-deferred-status").then(r => setDefStatus(r.body));
    // Real master shared-bridge health — the bridge that actually carries
    // live-shared dispatch. The per-user permission flag is NOT the bridge.
    void jget("/api/me/master-bridge/status").then(r => setMasterBridge(r.body));
  }, []);

  // Live simulated quote for the selected symbol — refreshed every 2s.
  useEffect(() => {
    let cancelled = false;
    const fetchQ = async () => {
      const bare = bareSymbol(symbol);
      const r = await jget(`/api/market/quote/${encodeURIComponent(bare)}`);
      if (!cancelled) setQuote(r.ok ? r.body : null);
    };
    void fetchQ();
    const t = window.setInterval(fetchQ, 2000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [symbol]);

  // Feature Truth Audit: the previous "estimated risk %" (lotSize * 0.5) was a
  // fabricated placeholder. Risk % requires account equity, which this tester
  // page does not load — so we show an honest "—" instead of a fake number.
  // Honest bridge health: the real master shared-bridge `detected` flag,
  // not the per-user permission/tester flag. Until the status resolves we
  // show "checking…" rather than asserting a state.
  const bridgeLoaded = masterBridge != null;
  const bridgeConnected = masterBridge?.detected === true;
  const killSwitch = perm?.killSwitchEngaged === true || defStatus?.simulator?.enforcesKillSwitch;
  const estLoss = stopLoss !== "" && quote ? Math.abs(quote.mid - Number(stopLoss)) * lotSize * 10000 : 0;
  const estGain = takeProfit !== "" && quote ? Math.abs(Number(takeProfit) - quote.mid) * lotSize * 10000 : 0;
  const rr = estLoss > 0 ? (estGain / estLoss) : 0;

  async function submit() {
    setConfirmOpen(false);
    setSubmitting(true); setResp(null);
    const r = await jget("/api/live-intent/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "MANUAL", symbol, direction: side, orderType, lotSize,
        stopLoss: stopLoss === "" ? null : stopLoss,
        takeProfit: takeProfit === "" ? null : takeProfit,
        maxLossUsd: maxLoss,
        note,
        reasonForTrade: "Manual tester intent",
      }),
    });
    setResp(r.body);
    setSubmitting(false);
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 pb-32 md:pb-6">
      <div>
        <h1 className="text-2xl font-bold leading-tight">Manual Trade Ticket</h1>
        <p className="text-sm text-txt-secondary">Manual order ticket. Captures your intent for review. Orders only dispatch after you review and confirm.</p>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 text-danger" />
        <div>
          <p className="font-semibold text-danger">Review required before any order</p>
          <p className="text-xs text-txt-muted">No order is placed until you confirm. The kill switch and risk governor always apply.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-[420px_1fr] gap-4">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3">
            <h2 className="text-base font-semibold">Order Ticket</h2>
            <p className="text-xs text-txt-muted">Manual order — review &amp; confirm</p>
          </div>
          <div className="space-y-3">
            <div>
              <Label>Symbol <span className="text-[10px] text-txt-muted">(synced from chart)</span></Label>
              <Input value={symbol} onChange={e => setSymbol(e.target.value)} data-testid="ticket-symbol" />
            </div>
            {quote && (
              <div className="rounded border border-border bg-background/40 p-2 text-xs grid grid-cols-4 gap-1 font-mono" data-testid="ticket-quote">
                <div><div className="text-txt-muted text-[10px]">BID</div>{quote.bid}</div>
                <div><div className="text-txt-muted text-[10px]">ASK</div>{quote.ask}</div>
                <div><div className="text-txt-muted text-[10px]">SPREAD</div>{quote.spread}</div>
                <div><div className="text-txt-muted text-[10px]">VOL</div>{quote.volatility}</div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant={side === "BUY" ? "default" : "outline"} onClick={() => setSide("BUY")} data-testid="ticket-buy"><TrendingUp className="w-3.5 h-3.5 mr-1" /> BUY</Button>
              <Button variant={side === "SELL" ? "default" : "outline"} onClick={() => setSide("SELL")} data-testid="ticket-sell"><TrendingDown className="w-3.5 h-3.5 mr-1" /> SELL</Button>
            </div>
            <div>
              <Label>Order Type</Label>
              <select className="w-full bg-background border border-border rounded px-2 py-2 text-sm" value={orderType} onChange={e => setOrderType(e.target.value as any)} data-testid="ticket-type">
                <option value="MARKET">MARKET</option><option value="LIMIT">LIMIT</option><option value="STOP">STOP</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label>Lot</Label><Input type="number" step="0.01" value={lotSize} onChange={e => setLotSize(Number(e.target.value))} data-testid="ticket-lot" /></div>
              <div><Label>Stop Loss</Label><Input type="number" step="0.0001" value={stopLoss} onChange={e => setStopLoss(e.target.value === "" ? "" : Number(e.target.value))} data-testid="ticket-sl" /></div>
              <div><Label>Take Profit</Label><Input type="number" step="0.0001" value={takeProfit} onChange={e => setTakeProfit(e.target.value === "" ? "" : Number(e.target.value))} data-testid="ticket-tp" /></div>
            </div>
            <div>
              <Label>Max Loss (USD)</Label>
              <Input type="number" step="0.5" value={maxLoss} onChange={e => setMaxLoss(Number(e.target.value))} data-testid="ticket-maxloss" />
            </div>
            <div>
              <Label>Trade Note</Label>
              <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Why this trade?" data-testid="ticket-note" />
            </div>

            <div className="rounded border border-border p-2 text-xs space-y-1 bg-background/40">
              <div className="flex justify-between"><span>Estimated max loss</span><span className="font-mono text-danger">${estLoss.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Estimated gain</span><span className="font-mono text-success">${estGain.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Risk / Reward</span><span className="font-mono">{rr.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Risk % <span className="text-[10px] text-txt-muted">(needs account equity)</span></span><span className="font-mono text-txt-muted">—</span></div>
              <div className="flex justify-between"><span>Account mode</span><Badge variant="outline" className="text-[10px]">TESTER</Badge></div>
              <div className="flex justify-between"><span>Execution environment</span><Badge className="bg-warning/20 text-warning text-[10px]">SIMULATOR</Badge></div>
              <div className="flex justify-between"><span>Risk governor</span><Badge className="bg-success/20 text-success text-[10px]">active</Badge></div>
              <div className="flex justify-between"><span>Kill switch</span><Badge variant={killSwitch ? "destructive" : "outline"} className="text-[10px]">{killSwitch ? "ENGAGED" : "off"}</Badge></div>
              <div className="flex justify-between"><span>Master bridge</span><Badge className={!bridgeLoaded ? "bg-muted text-txt-muted text-[10px]" : bridgeConnected ? "bg-success/20 text-success text-[10px]" : "bg-warning/20 text-warning text-[10px]"}>{!bridgeLoaded ? "checking…" : bridgeConnected ? "connected" : "not connected"}</Badge></div>
            </div>

            <div className="rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Submit Live Intent — captures the order for tester review. Live intent captured. MT5 bridge required for broker execution.</span>
            </div>

            <Button onClick={() => setConfirmOpen(true)} disabled={submitting} className="w-full" data-testid="ticket-submit">
              {submitting ? "Capturing…" : "Submit Live Intent"}
            </Button>

            {confirmOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ticket-confirm-title"
                data-testid="ticket-confirm-dialog"
                onClick={() => setConfirmOpen(false)}
              >
                <div
                  className="w-full max-w-md rounded-lg border border-warning/40 bg-card p-4 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-5 h-5 text-warning mt-0.5" />
                    <div className="text-sm">
                      <h2 id="ticket-confirm-title" className="font-semibold text-warning">Confirm live-intent submission</h2>
                      <p className="text-txt-muted text-xs mt-1">
                        Review the order before submitting. This goes through the risk governor and
                        kill switch. Once captured, the intent is permanently logged.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded border border-border bg-background/40 p-2 text-xs font-mono">
                    <div><div className="text-txt-muted text-[10px]">Symbol</div>{symbol}</div>
                    <div><div className="text-txt-muted text-[10px]">Side</div>{side}</div>
                    <div><div className="text-txt-muted text-[10px]">Type</div>{orderType}</div>
                    <div><div className="text-txt-muted text-[10px]">Lot</div>{lotSize}</div>
                    <div><div className="text-txt-muted text-[10px]">SL</div>{stopLoss === "" ? "—" : stopLoss}</div>
                    <div><div className="text-txt-muted text-[10px]">TP</div>{takeProfit === "" ? "—" : takeProfit}</div>
                    <div className="col-span-2"><div className="text-txt-muted text-[10px]">Max loss</div>${maxLoss} · R:R {rr.toFixed(2)}</div>
                  </div>
                  {(stopLoss === "" || takeProfit === "") && (
                    <p className="mt-2 text-[11px] text-warning">Warning: missing {stopLoss === "" ? "SL" : ""}{stopLoss === "" && takeProfit === "" ? " + " : ""}{takeProfit === "" ? "TP" : ""}. Risk governor may reject this intent.</p>
                  )}
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} data-testid="ticket-confirm-cancel">Cancel</Button>
                    <Button size="sm" onClick={submit} data-testid="ticket-confirm-submit">Confirm &amp; submit intent</Button>
                  </div>
                </div>
              </div>
            )}

            {resp && (
              <div className={`rounded border p-2 text-xs ${resp.accepted ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10"}`} data-testid="ticket-response">
                <div className="flex items-center gap-2 font-semibold">
                  {resp.accepted ? <CheckCircle2 className="w-4 h-4 text-success" /> : <ShieldAlert className="w-4 h-4 text-danger" />}
                  status: {resp.status}
                </div>
                <p className="text-txt-muted mt-1">{resp.reason}</p>
                <p className="font-mono text-[10px] mt-1">intentId: {resp.intentId}</p>
              </div>
            )}
          </div>
        </div>
        <TradingViewLiveChart defaultSymbol={symbol} height={620} compact />
      </div>
    </div>
  );
}
