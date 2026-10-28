import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { safeDate } from "@/lib/safeFormat";
import { Database } from "lucide-react";
import { Link } from "wouter";

type DQ = {
  quoteSource: string; candleSource: string;
  lastQuoteTime: string; lastCandleTime: string | null;
  quoteIsStale: boolean; candleIsStale: boolean;
  simulatorActive: boolean; chartActive: boolean;
  mt5Connected: boolean; brokerExecutableData: boolean;
  scannerProvider: string; riskGovernorProvider: string;
  notice: string;
};

export default function DataQualityPage() {
  const [d, setD] = useState<DQ | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/data-quality?symbol=EURUSD&timeframe=M15")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as DQ;
      })
      .then((next) => { setD(next); setErr(null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "request failed"));
    void load(); const id = setInterval(load, 5000); return () => clearInterval(id);
  }, []);

  // /api/data-quality is served by the legacy in-process simulator layer
  // (api-server lib/marketDataLayer.ts). Its MT5/scanner/risk-governor fields
  // are constants of that layer, not measurements of the live platform, and a
  // SIMULATOR quote is stamped with the request time.
  const simulatorQuote = d?.quoteSource === "SIMULATOR";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Database className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Data Quality</h1>
          <p className="text-sm text-muted-foreground">Quote and candle sources of the legacy simulator data layer.</p>
        </div>
        <Badge variant="outline">LEGACY SIMULATOR LAYER</Badge>
      </div>

      <p data-testid="dq-scope" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
        This page reports the legacy simulator data layer only. It does not read the live MT5 bridge, the
        scanner&apos;s candle feed or the risk governor, so it cannot tell you whether those are connected or
        healthy. For live feed and bridge state see{" "}
        <Link href="/market-health" className="underline">Market Health</Link> and{" "}
        <Link href="/mt5-bridge" className="underline">MT5 Bridge</Link>.
      </p>

      {err && (
        <p data-testid="dq-error" role="alert" className="text-sm text-rose-400">
          Could not load the data quality report ({err}).{d ? " The values below are from the last successful read." : ""}
        </p>
      )}

      {!d ? (!err && <p className="text-sm text-muted-foreground">Loading…</p>) : (
        <>
          <Card><CardHeader><CardTitle className="text-base">Notice (legacy layer)</CardTitle><CardDescription>{d.notice}</CardDescription></CardHeader></Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Row label="Quote source" value={d.quoteSource} />
            <Row label="Candle source" value={d.candleSource} />
            <Row label="Scanner provider" value={`Not measured by this layer (layer setting: ${d.scannerProvider})`} />
            <Row label="Risk governor provider" value={`Not measured by this layer (layer setting: ${d.riskGovernorProvider})`} />
            <Row label="Last quote time" value={simulatorQuote
              ? "Not recorded — simulator quotes are stamped with the request time"
              : safeDate(d.lastQuoteTime, "time", "Not reported")} />
            <Row label="Last candle time" value={safeDate(d.lastCandleTime, "datetime", "Not reported")} />
            <Boolean label="Quote stale" value={d.quoteIsStale} bad />
            <Boolean label="Candle stale" value={d.candleIsStale} bad />
            <Boolean label="Simulator active" value={d.simulatorActive} neutral />
            <Boolean label="Chart active" value={d.chartActive} neutral />
            <NotMeasured label="MT5 connected" value={d.mt5Connected} />
            <NotMeasured label="Broker-executable data" value={d.brokerExecutableData} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <Card data-testid="dq-card"><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase">{label}</p><p className="text-base font-mono mt-1">{value}</p></CardContent></Card>;
}
function Boolean({ label, value, bad, neutral }: { label: string; value: boolean; bad?: boolean; neutral?: boolean }) {
  const isOk = bad ? !value : value;
  const cls = neutral
    ? "bg-slate-500/20 text-slate-300 mt-1"
    : isOk ? "bg-emerald-500/20 text-emerald-400 mt-1" : "bg-rose-500/20 text-rose-400 mt-1";
  return <Card data-testid="dq-card"><CardContent className="p-4">
    <p className="text-xs text-muted-foreground uppercase">{label}</p>
    <Badge className={cls}>
      {value ? "yes" : "no"}
    </Badge>
  </CardContent></Card>;
}
// A field the legacy layer hard-codes. It is shown neutrally with its constant
// value, never coloured as a pass or a fault.
function NotMeasured({ label, value }: { label: string; value: boolean }) {
  return <Card data-testid="dq-card"><CardContent className="p-4">
    <p className="text-xs text-muted-foreground uppercase">{label}</p>
    <Badge className="bg-slate-500/20 text-slate-300 mt-1">
      Not measured by this layer (constant: {value ? "yes" : "no"})
    </Badge>
  </CardContent></Card>;
}
