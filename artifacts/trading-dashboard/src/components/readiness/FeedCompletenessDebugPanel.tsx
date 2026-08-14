// Feed-completeness / live-readiness debug panel (Task #785, deliverable #6).
//
// Explains WHY a visually-correct chart can still be blocked for live entry:
// it separates SOURCE proof (is this the exact broker-confirmed MT5 symbol on a
// connected account?) from FRESHNESS proof (recent tick + recent bar for the
// selected timeframe within the freshness window?), and lists every blocker the
// unified resolver returned.
//
// Consumes GET /api/me/live-readiness/unified (self-scoped, no secrets). This is
// a DESCRIBE-only readout — it can never place an order; every live order still
// re-runs the instant-trade router → live pipeline → 18-gate dispatch.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, XCircle, RefreshCw, Activity } from "lucide-react";

type Blocker = { code: string; message: string; category: "ACCOUNT" | "BRIDGE" | "FEED" | string };

type Readiness = {
  userId: number;
  email: string | null;
  role: string;
  accountMode: string;
  liveApproved: boolean;
  sharedBridgeApproved: boolean;
  fullLiveActivation: boolean;
  liveExecutionActive: boolean;
  bridgeMode: string | null;
  bridgeHeartbeatFresh: boolean;
  allocationSource: string | null;
  allocatedAmount: number | null;
  availableLiveAllocation: number;
  brokerAccountId: number | null;
  symbol: string | null;
  brokerSymbol: string | null;
  normalizedSymbol: string | null;
  selectedTimeframe: string | null;
  lastTickAt: string | null;
  lastCandleAt: string | null;
  feedSource: string | null;
  feedConfirmed: boolean;
  missingIntervals: number | null;
  symbolLiveEligible: boolean;
  riskEligible: boolean;
  killSwitchClear: boolean;
  blockers: Blocker[];
  liveEntryEligible: boolean;
};

function ageSeconds(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;
}

function Row({ label, value, ok }: { label: string; value: React.ReactNode; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 font-mono text-right">
        {ok === true && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
        {ok === false && <XCircle className="h-3.5 w-3.5 text-red-500" />}
        {value}
      </span>
    </div>
  );
}

export function FeedCompletenessDebugPanel({ defaultSymbol = "EURUSD", defaultTimeframe = "M1" }: { defaultSymbol?: string; defaultTimeframe?: string }) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [timeframe, setTimeframe] = useState(defaultTimeframe);
  const [data, setData] = useState<Readiness | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams();
      if (symbol.trim()) qs.set("symbol", symbol.trim());
      if (timeframe.trim()) qs.set("timeframe", timeframe.trim());
      const r = await fetch(`/api/me/live-readiness/unified?${qs.toString()}`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setData(j.readiness as Readiness);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load readiness");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirrors the server LIVE_TRAILING_INTERVALS threshold (freshness.ts): the
  // newest bar naturally trails the forming bar by 1 interval, so trailing <= 1
  // is still "clean"/live. Requiring === 0 would mislabel a healthy live feed.
  const LIVE_TRAILING_INTERVALS = 1;
  const sourceProofOk = !!data && !!data.symbol && data.symbolLiveEligible && !!data.brokerAccountId;
  const freshnessProofOk =
    !!data && !!data.symbol && data.feedConfirmed && (data.missingIntervals ?? 99) <= LIVE_TRAILING_INTERVALS;

  return (
    <Card data-testid="feed-completeness-debug-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" /> Feed Completeness &amp; Live Readiness (debug)
        </CardTitle>
        <CardDescription>
          Separates <strong>source proof</strong> (exact broker-confirmed MT5 symbol on a connected account)
          from <strong>freshness proof</strong> (recent tick + recent bar within the freshness window). A
          chart can look correct yet still be blocked if either proof fails. Read-only — never places an order.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Symbol</label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="h-8 w-32 font-mono" data-testid="input-debug-symbol" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Timeframe</label>
            <Input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="h-8 w-24 font-mono" data-testid="input-debug-timeframe" />
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading} data-testid="button-debug-reload">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Reload
          </Button>
        </div>

        {err && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-600">{err}</div>}

        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.liveEntryEligible ? "default" : "secondary"} data-testid="badge-live-entry-eligible">
                {data.liveEntryEligible ? "Live entry eligible" : "Live entry blocked"}
              </Badge>
              <Badge variant={sourceProofOk ? "default" : "destructive"}>Source proof: {sourceProofOk ? "OK" : "FAIL"}</Badge>
              <Badge variant={freshnessProofOk ? "default" : "destructive"}>Freshness proof: {freshnessProofOk ? "OK" : "FAIL"}</Badge>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Account / Execution</h4>
                <Row label="Account mode" value={data.accountMode} />
                <Row label="Role" value={data.role} />
                <Row label="Live approved" value={String(data.liveApproved)} ok={data.liveApproved} />
                <Row label="Bridge approved" value={String(data.sharedBridgeApproved)} ok={data.sharedBridgeApproved} />
                <Row label="Full live activation" value={String(data.fullLiveActivation)} ok={data.fullLiveActivation} />
                <Row label="Live execution active" value={String(data.liveExecutionActive)} ok={data.liveExecutionActive} />
                <Row label="Kill switch clear" value={String(data.killSwitchClear)} ok={data.killSwitchClear} />
                <Row label="Risk eligible" value={String(data.riskEligible)} ok={data.riskEligible} />
              </div>
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Bridge / Allocation</h4>
                <Row label="Bridge mode" value={data.bridgeMode ?? "—"} />
                <Row label="Heartbeat fresh" value={String(data.bridgeHeartbeatFresh)} ok={data.bridgeHeartbeatFresh} />
                <Row label="Broker account id" value={data.brokerAccountId ?? "—"} />
                <Row label="Allocation source" value={data.allocationSource ?? "—"} />
                <Row label="Allocated" value={data.allocatedAmount ?? "—"} />
                <Row label="Available allocation" value={data.availableLiveAllocation} ok={data.availableLiveAllocation > 0} />
              </div>
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Feed / Symbol</h4>
                <Row label="Symbol" value={data.symbol ?? "—"} />
                <Row label="Broker symbol" value={data.brokerSymbol ?? "—"} />
                <Row label="Normalized symbol" value={data.normalizedSymbol ?? "—"} />
                <Row label="Timeframe" value={data.selectedTimeframe ?? "—"} />
                <Row label="Symbol live eligible" value={String(data.symbolLiveEligible)} ok={data.symbolLiveEligible} />
                <Row label="Feed source" value={data.feedSource ?? "—"} />
                <Row label="Feed confirmed" value={String(data.feedConfirmed)} ok={data.feedConfirmed} />
              </div>
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Freshness</h4>
                <Row label="Last tick" value={`${data.lastTickAt ?? "—"} (${ageSeconds(data.lastTickAt)})`} />
                <Row label="Last candle" value={`${data.lastCandleAt ?? "—"} (${ageSeconds(data.lastCandleAt)})`} />
                <Row label="Missing intervals" value={data.missingIntervals ?? "—"} ok={(data.missingIntervals ?? 99) <= LIVE_TRAILING_INTERVALS} />
                <Row label="Server time" value={new Date().toISOString()} />
              </div>
            </div>

            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Blockers ({data.blockers.length})
              </h4>
              {data.blockers.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" /> No blockers — account, bridge, and feed proofs all pass.
                </div>
              ) : (
                <ul className="space-y-1" data-testid="list-debug-blockers">
                  {data.blockers.map((b) => (
                    <li key={b.code} className="flex items-start gap-2 text-sm">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                      <span>
                        <Badge variant="outline" className="mr-1 font-mono text-[10px]">{b.category}</Badge>
                        {b.message} <span className="font-mono text-xs text-muted-foreground">({b.code})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
