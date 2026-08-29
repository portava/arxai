import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { safeDate } from "@/lib/safeFormat";
import { Database } from "lucide-react";

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
  useEffect(() => {
    const load = () => fetch("/api/data-quality?symbol=EURUSD&timeframe=M15").then((r) => r.json()).then(setD);
    void load(); const id = setInterval(load, 5000); return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Database className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Data Quality</h1>
          <p className="text-sm text-muted-foreground">Where every page gets its quotes and candles from.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
      </div>

      {!d ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <Card><CardHeader><CardTitle className="text-base">Notice</CardTitle><CardDescription>{d.notice}</CardDescription></CardHeader></Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Row label="Quote source" value={d.quoteSource} />
            <Row label="Candle source" value={d.candleSource} />
            <Row label="Scanner provider" value={d.scannerProvider} />
            <Row label="Risk governor provider" value={d.riskGovernorProvider} />
            <Row label="Last quote time" value={safeDate(d.lastQuoteTime, "time")} />
            <Row label="Last candle time" value={safeDate(d.lastCandleTime)} />
            <Boolean label="Quote stale" value={d.quoteIsStale} bad />
            <Boolean label="Candle stale" value={d.candleIsStale} bad />
            <Boolean label="Simulator active" value={d.simulatorActive} />
            <Boolean label="Chart active" value={d.chartActive} />
            <Boolean label="MT5 connected" value={d.mt5Connected} expected={false} />
            <Boolean label="Broker-executable data" value={d.brokerExecutableData} expected={false} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase">{label}</p><p className="text-base font-mono mt-1">{value}</p></CardContent></Card>;
}
function Boolean({ label, value, bad, expected }: { label: string; value: boolean; bad?: boolean; expected?: boolean }) {
  const isOk = expected !== undefined ? value === expected : (bad ? !value : value);
  return <Card><CardContent className="p-4">
    <p className="text-xs text-muted-foreground uppercase">{label}</p>
    <Badge className={isOk ? "bg-success/20 text-success mt-1" : "bg-danger/20 text-danger mt-1"}>
      {value ? "yes" : "no"}
    </Badge>
  </CardContent></Card>;
}
