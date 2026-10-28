import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brain, ThumbsUp, ThumbsDown, ShieldAlert, Loader2, WifiOff } from "lucide-react";
import TradingViewLiveChart from "@/components/charts/TradingViewLiveChart";
import { useViewMode } from "@/hooks/useViewMode";
import { useChartSymbol, bareSymbol, setChartSymbol } from "@/lib/use-chart-symbol";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { useAssistantName } from "@/lib/assistant-name";

// Every level / score is null when the feed did not supply it — never 0
// shown or submitted as if it were a measured value. There is no risk score:
// the selected-market read does not compute one, so none is shown or sent.
type TradeCard = {
  symbol: string; direction: "BUY" | "SELL"; setup: string;
  entry: number | null; stopLoss: number | null; takeProfit: number | null;
  confidenceScore: number | null; riskRewardRatio: number | null;
  reasonForTrade: string; invalidationReason: string;
  marketCondition: string;
  /** Plain-English source of the read (e.g. "MT5 broker feed"), or null when not stated. */
  sourceLabel: string | null;
  /** Close time of the newest closed bar the read used, or null when unknown. */
  dataAsOf: string | null;
  /** When the live read stops holding without a new analysis, or null when unknown. */
  liveClaimExpiresAt: string | null;
  /** Why the levels were withheld, or null when they were shown. */
  levelsWithheldReason: string | null;
  riskWarnings: string[];
  /** Timeframe the read was computed on (the page requests M15). */
  timeframe: string | null;
};

function positiveOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmtLevel(v: number | null): string {
  return v == null ? "Not provided" : String(v);
}

function fmtUtc(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Display label → real symbol the Market Data Router understands.
const SYMBOLS: { label: string; value: string; tv: string }[] = [
  { label: "EURUSD", value: "EURUSD", tv: "FX:EURUSD" },
  { label: "GBPUSD", value: "GBPUSD", tv: "FX:GBPUSD" },
  { label: "USDJPY", value: "USDJPY", tv: "FX:USDJPY" },
  { label: "XAUUSD", value: "XAUUSD", tv: "FX:XAUUSD" },
  { label: "BTCUSD", value: "BTCUSD", tv: "BINANCE:BTCUSDT" },
];

type FeedState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "card"; card: TradeCard }
  | { kind: "neutral"; reason: string }       // real feed, but no directional edge
  | { kind: "nodata"; reason: string };        // feed unavailable / not enough data

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", headers: { ...(init?.headers ?? {}) }, ...init });
  const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// Admin diagnostics: a flag the permission route did not return is "unknown",
// never a default that reads as a checked answer. null means the server tried
// and could not check it (e.g. the broker status read failed).
function permFlag(perm: any, key: string): string {
  const t = perm?.testerAccess;
  const v = t?.[key];
  if (typeof v === "boolean") return String(v);
  if (!t || typeof t !== "object") return "unknown (permission status not loaded)";
  if (v === null) {
    const why = typeof t.reason === "string" && t.reason ? `: ${t.reason}` : "";
    return `unknown (could not be checked${why})`;
  }
  return "unknown (not reported by the server)";
}

// Map the real selected-market snapshot → trade card. Returns a FeedState so
// NEUTRAL/WAIT and unavailable feeds produce honest states, never a fake setup.
// Downgrade-only: a directional bias is shown only when the server says the
// read is LIVE_CONFIRMED; anything it did not supply stays null.
export function snapshotToState(snap: any): FeedState {
  if (!snap || snap.ok !== true) {
    const reason = snap?.reason === "SYMBOL_NOT_SUPPORTED"
      ? "This symbol isn't available on the live feed yet."
      : snap?.reason === "NO_MARKET_DATA"
      ? "Not enough market data to analyze this symbol right now."
      : snap?.message || "Awaiting live feed for this market.";
    return { kind: "nodata", reason };
  }
  const h = snap.highlights ?? {};
  const bias = h.bias as "BUY" | "SELL" | "NEUTRAL" | "WAIT";
  if (snap.dataState !== "LIVE_CONFIRMED") {
    return {
      kind: "nodata",
      reason: snap.readWithheldReason
        || "The feed did not confirm this market's data is live, so no setup is shown.",
    };
  }
  if (bias !== "BUY" && bias !== "SELL") {
    return {
      kind: "neutral",
      reason: snap.explanation?.why || "No clear directional edge right now — wait for confirmation.",
    };
  }
  const low = positiveOrNull(h.entryZone?.low);
  const high = positiveOrNull(h.entryZone?.high);
  const entry = low != null && high != null ? Number(((low + high) / 2).toFixed(5)) : null;
  const conf = typeof h.confidenceScore === "number" && Number.isFinite(h.confidenceScore)
    ? Math.round(h.confidenceScore) : null;
  return {
    kind: "card",
    card: {
      symbol: snap.symbol,
      direction: bias,
      setup: h.trendState ? `Trend: ${h.trendState}` : "Setup type not stated by the feed",
      entry,
      stopLoss: positiveOrNull(h.suggestedStop),
      takeProfit: positiveOrNull(h.suggestedTakeProfit),
      confidenceScore: conf,
      riskRewardRatio: positiveOrNull(h.riskRewardRatio),
      reasonForTrade: snap.explanation?.why || "",
      invalidationReason: snap.explanation?.invalidation || "",
      marketCondition: h.volatilityLabel || h.trendState || "Not stated",
      sourceLabel: typeof snap.dataSourceLabel === "string" && snap.dataSourceLabel ? snap.dataSourceLabel : null,
      dataAsOf: typeof snap.dataAsOf === "string" ? snap.dataAsOf : null,
      liveClaimExpiresAt: typeof snap.liveClaimExpiresAt === "string" ? snap.liveClaimExpiresAt : null,
      levelsWithheldReason: snap.levelsWithheld === true || entry == null
        ? (snap.levelsWithheldReason || "The feed did not supply entry, stop and target levels.")
        : null,
      riskWarnings: Array.isArray(h.riskWarnings) ? h.riskWarnings.filter((w: unknown) => typeof w === "string") : [],
      timeframe: typeof snap.timeframe === "string" && snap.timeframe ? snap.timeframe : null,
    },
  };
}

export default function LiveAiAssistPage() {
  const { effectiveIsAdmin } = useViewMode();
  // Single source of truth — the shared chart-symbol bus. Picking a
  // symbol here updates the chart, the trade ticket, scanner focus
  // panel, ruby explanation and every other consumer in the same paint.
  const [chartSymbol] = useChartSymbol();
  const symbol = (() => {
    const bare = bareSymbol(chartSymbol);
    return SYMBOLS.some((s) => s.value === bare) ? bare : SYMBOLS[0].value;
  })();
  const [feed, setFeed] = useState<FeedState>({ kind: "idle" });
  const [perm, setPerm] = useState<any>(null);
  const [resp, setResp] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [liveTicketOpen, setLiveTicketOpen] = useState(false);
  const liveAccess = useMasterLiveAccess();
  const { name } = useAssistantName();

  // Monotonic request id used to invalidate in-flight loadCard() results
  // when the shared symbol flips. Without this, a slow XAUUSD response
  // could land AFTER the user picked EURUSD and repopulate the card
  // with the previous symbol's setup.
  const loadReqIdRef = useRef(0);

  // Whenever the shared symbol changes, drop any stale AI card / response
  // and invalidate any in-flight loadCard() so a late response from the
  // previous symbol cannot overwrite the cleared state.
  useEffect(() => {
    loadReqIdRef.current += 1;
    setFeed({ kind: "idle" });
    setResp(null);
  }, [symbol]);

  useEffect(() => { void jget("/api/permission/status").then(r => setPerm(r.body)); }, []);

  // Fetch the REAL selected-market snapshot — same endpoint scanner/chart use.
  // Bumps the monotonic request id and only commits the result if the id
  // still matches when the response arrives. Any symbol change mid-flight
  // bumps the id and the stale response is discarded.
  async function loadCard() {
    const reqId = ++loadReqIdRef.current;
    const symbolAtRequest = symbol;
    setFeed({ kind: "loading" }); setResp(null);
    const r = await jget(`/api/market-scanner/selected-market?symbol=${encodeURIComponent(symbolAtRequest)}&timeframe=M15`);
    if (loadReqIdRef.current !== reqId) return; // stale — symbol changed
    setFeed(snapshotToState(r.body));
  }

  const card = feed.kind === "card" ? feed.card : null;
  const tvSymbol = SYMBOLS.find(s => s.value === symbol)?.tv ?? "FX:EURUSD";

  async function approve() {
    if (!card) return;
    // LIVE_SHARED users: open the real shared-account ticket pre-filled
    // from the AI card. The ticket runs /validate → /execute through the
    // 16-gate evaluator and dispatches a real broker order.
    // Paper / tester users keep the legacy live-intent capture path,
    // which only writes to the tester audit table and never trades.
    if (liveAccess.loaded && liveAccess.canTrade) {
      setLiveTicketOpen(true);
      return;
    }
    setBusy(true); setResp(null);
    const r = await jget("/api/live-intent/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "AI_ASSIST", symbol: card.symbol, direction: card.direction, orderType: "MARKET",
        lotSize: 0.01, entryPrice: card.entry, stopLoss: card.stopLoss, takeProfit: card.takeProfit,
        // null = not supplied by the feed; no risk score is computed, so none is sent.
        confidenceScore: card.confidenceScore, riskScore: null,
        riskRewardRatio: card.riskRewardRatio,
        reasonForTrade: card.reasonForTrade, invalidationReason: card.invalidationReason,
        marketCondition: card.marketCondition,
      }),
    });
    setResp(r.body); setBusy(false);
  }

  return (
    <div className="container mx-auto py-4 px-3 md:px-6 space-y-4 max-w-[1600px]">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="w-6 h-6" /> Live AI Assist</h1>
        <p className="text-sm text-muted-foreground">{name} analyzes the selected market on the live feed. Review the setup, then approve to submit a live-intent. Your risk caps apply.</p>
      </div>

      <div className="grid lg:grid-cols-[440px_1fr] gap-4">
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-sm">
                <span>AI Trade Card</span>
                <select
                  className="text-xs bg-background border border-border rounded px-2 py-1"
                  value={symbol}
                  data-testid="ai-symbol-select"
                  onChange={(e) => {
                    // Push through the shared bus so the chart, trade
                    // ticket and every other symbol consumer flip in the
                    // same paint. Card/resp cleanup happens via the
                    // useEffect that watches `symbol`.
                    const next = SYMBOLS.find((s) => s.value === e.target.value);
                    setChartSymbol(next?.tv ?? e.target.value);
                  }}
                >
                  {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </CardTitle>
              <CardDescription>Reads the live market feed. No setup is shown unless the data supports one.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={loadCard} className="w-full" data-testid="generate-card" disabled={feed.kind === "loading"}>
                {feed.kind === "loading" ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Reading feed…</> : "Analyze live market"}
              </Button>
            </CardContent>
          </Card>

          {/* Honest empty states — never a fabricated setup */}
          {feed.kind === "nodata" && (
            <Card className="border-amber-500/30" data-testid="ai-nodata">
              <CardContent className="pt-4 text-xs flex items-start gap-2 text-amber-200">
                <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">Awaiting feed</p>
                  <p className="text-amber-200/80">{feed.reason}</p>
                </div>
              </CardContent>
            </Card>
          )}
          {feed.kind === "neutral" && (
            <Card className="border-border" data-testid="ai-neutral">
              <CardContent className="pt-4 text-xs space-y-1">
                <p className="font-semibold">No setup right now</p>
                <p className="text-muted-foreground">{feed.reason}</p>
              </CardContent>
            </Card>
          )}

          {card && (
            <Card className="border-blue-500/30">
              <CardHeader><CardTitle className="text-sm flex justify-between">{card.symbol} <Badge>{card.direction}</Badge></CardTitle><CardDescription>{card.setup}</CardDescription></CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="text-[11px] text-muted-foreground" data-testid="ai-card-provenance">
                  {card.timeframe ? `${card.timeframe} read · ` : ""}Source: {card.sourceLabel ?? "not stated by the feed"} · data as of {fmtUtc(card.dataAsOf) ?? "an unknown time"}
                  {fmtUtc(card.liveClaimExpiresAt) ? ` · live read holds until ${fmtUtc(card.liveClaimExpiresAt)}; analyze again after that` : ""}
                </p>
                <div className="grid grid-cols-3 gap-1 font-mono">
                  <div className="rounded border border-border p-1.5" data-testid="ai-card-entry"><div className="text-muted-foreground">Entry</div>{fmtLevel(card.entry)}</div>
                  <div className="rounded border border-red-500/30 p-1.5" data-testid="ai-card-sl"><div className="text-muted-foreground">SL</div>{fmtLevel(card.stopLoss)}</div>
                  <div className="rounded border border-emerald-500/30 p-1.5" data-testid="ai-card-tp"><div className="text-muted-foreground">TP</div>{fmtLevel(card.takeProfit)}</div>
                </div>
                {card.levelsWithheldReason && (
                  <p className="text-[11px] text-amber-300" data-testid="ai-card-levels-withheld">Levels withheld: {card.levelsWithheldReason}</p>
                )}
                <div className="grid grid-cols-2 gap-1">
                  <div className="rounded border border-border p-1.5" data-testid="ai-card-confidence"><div className="text-muted-foreground">Confidence</div>{card.confidenceScore == null ? "Not provided" : `${card.confidenceScore}/100`}</div>
                  <div className="rounded border border-border p-1.5" data-testid="ai-card-rr"><div className="text-muted-foreground">R:R</div>{card.riskRewardRatio == null ? "Not provided" : card.riskRewardRatio}</div>
                </div>
                {card.riskWarnings.length > 0 && (
                  <ul className="text-[11px] text-red-300" data-testid="ai-card-risk-warnings">
                    {card.riskWarnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                )}
                {card.reasonForTrade && <p><span className="text-muted-foreground">Reason:</span> {card.reasonForTrade}</p>}
                {card.invalidationReason && <p><span className="text-muted-foreground">Invalidation:</span> {card.invalidationReason}</p>}
                <p><span className="text-muted-foreground">Market:</span> {card.marketCondition}</p>
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={() => setFeed({ kind: "idle" })} data-testid="reject-card"><ThumbsDown className="w-3.5 h-3.5 mr-1" /> Reject</Button>
                  <Button size="sm" onClick={approve} disabled={busy || !liveAccess.loaded} data-testid="approve-card">
                    <ThumbsUp className="w-3.5 h-3.5 mr-1" />
                    {!liveAccess.loaded
                      ? "Checking access…"
                      : liveAccess.canTrade
                        ? "Approve → Live ticket"
                        : "Approve → live-intent"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {resp && (typeof resp.status === "string" && resp.status ? (
            <Card className={resp.riskCheckPassed === true ? "border-amber-500/40 bg-amber-500/5" : "border-red-500/40 bg-red-500/5"}>
              <CardContent className="pt-4 text-xs space-y-1" data-testid="ai-assist-response">
                <p className="font-semibold flex items-center gap-2"><ShieldAlert className="w-4 h-4" />Intent recorded: {resp.status}</p>
                <p className="text-muted-foreground">{resp.reason}</p>
                {/* The live-intent route never places a broker order; say so unless it states otherwise. */}
                <p data-testid="ai-assist-no-broker-order">{resp.brokerExecution === true ? "The server reports broker execution." : "No broker order was placed."}</p>
                {resp.intentId && <p className="font-mono text-[10px]">intentId: {resp.intentId}</p>}
                {effectiveIsAdmin && <p className="text-[11px]">MT5 connected at submit: {typeof resp.mt5Connected === "boolean" ? String(resp.mt5Connected) : "not reported"} · broker execution: {typeof resp.brokerExecution === "boolean" ? String(resp.brokerExecution) : "not reported"}</p>}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-red-500/40 bg-red-500/5">
              <CardContent className="pt-4 text-xs space-y-1" data-testid="ai-assist-response">
                <p className="font-semibold flex items-center gap-2"><ShieldAlert className="w-4 h-4" />Not recorded</p>
                <p className="text-muted-foreground">
                  The server did not record this intent{typeof resp.error === "string" && resp.error ? `: ${resp.error}` : "."} No broker order was placed.
                </p>
              </CardContent>
            </Card>
          ))}

          {effectiveIsAdmin && (
            <Card className="border border-border">
              <CardContent className="pt-3 text-xs">
                <p className="font-semibold mb-1">Permission state (admin diagnostics)</p>
                {/* Unknown is printed as unknown — never defaulted to true/false. */}
                <div className="font-mono text-[11px]" data-testid="perm-can-execute">canExecuteRealBrokerOrder: <span className="text-red-400">{permFlag(perm, "canExecuteRealBrokerOrder")}</span></div>
                <div className="font-mono text-[11px]" data-testid="perm-can-submit">canSubmitLiveIntent: <span className={perm?.testerAccess?.canSubmitLiveIntent === true ? "text-emerald-400" : "text-muted-foreground"}>{permFlag(perm, "canSubmitLiveIntent")}</span></div>
                <div className="font-mono text-[11px]" data-testid="perm-mt5">mt5Connected: {permFlag(perm, "mt5Connected")}</div>
              </CardContent>
            </Card>
          )}
        </div>
        <div className="space-y-1">
          {/* The chart is a third-party widget; the card reads ARX's own feed. */}
          <p className="text-[11px] text-muted-foreground" data-testid="ai-chart-source-note">
            Chart: TradingView widget ({tvSymbol}), a third-party price source. The AI card reads ARX&apos;s market feed, so prices and candles can differ from this chart and from your broker.
          </p>
          <TradingViewLiveChart defaultSymbol={tvSymbol} height={620} compact />
        </div>
      </div>
      {card && (
        <LiveSharedTradeTicket
          open={liveTicketOpen}
          onOpenChange={setLiveTicketOpen}
          defaultSymbol={card.symbol}
          defaultSide={card.direction}
          rubyExplanationSummary={card.reasonForTrade ?? null}
        />
      )}
    </div>
  );
}
