import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitMerge } from "lucide-react";

type Recon = {
  mt5Connected: boolean; brokerOrders: unknown[]; brokerPositions: unknown[];
  localOrders: number; localPositions: number; localLiveIntents: number;
  mismatches: unknown[]; syncStatus: string; notice: string;
};

// Defensive normaliser. The /api/broker-reconciliation/status endpoint
// is documented to return arrays for brokerOrders/brokerPositions/
// mismatches, but a partial/empty response (e.g. before MT5 bridge is
// up) historically returned undefined for these fields and crashed the
// page with "Cannot read properties of undefined (reading 'length')".
// Defaulting at the boundary keeps render code simple and unbreakable.
function normaliseRecon(raw: unknown): Recon {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Recon>;
  return {
    mt5Connected: r.mt5Connected === true,
    brokerOrders: Array.isArray(r.brokerOrders) ? r.brokerOrders : [],
    brokerPositions: Array.isArray(r.brokerPositions) ? r.brokerPositions : [],
    localOrders: typeof r.localOrders === "number" ? r.localOrders : 0,
    localPositions: typeof r.localPositions === "number" ? r.localPositions : 0,
    localLiveIntents: typeof r.localLiveIntents === "number" ? r.localLiveIntents : 0,
    mismatches: Array.isArray(r.mismatches) ? r.mismatches : [],
    syncStatus: typeof r.syncStatus === "string" ? r.syncStatus : "unknown",
    notice: typeof r.notice === "string" ? r.notice : "",
  };
}

export default function BrokerReconciliationPage() {
  const [r, setR] = useState<Recon | null>(null);
  useEffect(() => {
    fetch("/api/broker-reconciliation/status")
      .then((x) => x.json())
      .then((raw) => setR(normaliseRecon(raw)))
      .catch(() => setR(normaliseRecon(null)));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GitMerge className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Broker Reconciliation</h1>
          <p className="text-sm text-muted-foreground">Compare local OMS state vs MT5 bridge state.</p>
        </div>
        <Badge className="bg-purple-500/20 text-purple-400">MT5 DEFERRED</Badge>
      </div>

      {!r ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <Card><CardHeader><CardTitle className="text-base">Status</CardTitle><CardDescription>{r.notice}</CardDescription></CardHeader>
            <CardContent>
              <Badge variant="outline">syncStatus={r.syncStatus}</Badge>
              <Badge className="ml-2" variant="outline">mt5Connected={String(r.mt5Connected)}</Badge>
            </CardContent></Card>

          <div className="grid gap-3 md:grid-cols-2">
            <Card><CardHeader><CardTitle className="text-base">Local (this app)</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <Row label="Orders" value={String(r.localOrders)} />
                <Row label="Positions" value={String(r.localPositions)} />
                <Row label="Live tester intents" value={String(r.localLiveIntents)} />
              </CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Broker (MT5, deferred)</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <Row label="Broker orders" value={String(r.brokerOrders?.length ?? 0)} />
                <Row label="Broker positions" value={String(r.brokerPositions?.length ?? 0)} />
                <Row label="Mismatches" value={String(r.mismatches?.length ?? 0)} />
                <p className="text-xs text-muted-foreground mt-2">Activates once MT5 bridge is connected.</p>
              </CardContent></Card>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between border-b py-1"><span className="text-muted-foreground">{label}</span><span className="font-mono">{value}</span></div>;
}
