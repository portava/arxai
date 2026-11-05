import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitMerge } from "lucide-react";
import { Link } from "wouter";

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

// The broker side counts only mean something when the server actually read the
// MT5 bridge. A DEFERRED status, or mt5Connected=false, means it did not, so
// "0 broker orders / 0 mismatches" would be an unmeasured value shown as a pass.
function brokerSideRead(r: Recon): boolean {
  return r.mt5Connected && r.syncStatus.toUpperCase() !== "DEFERRED" && r.syncStatus !== "unknown";
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; recon: Recon };

export default function BrokerReconciliationPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    fetch("/api/broker-reconciliation/status")
      .then(async (x) => {
        let raw: unknown = null;
        try { raw = await x.json(); } catch { raw = null; }
        if (!x.ok) {
          const code = raw && typeof raw === "object" ? (raw as { error?: unknown }).error : undefined;
          const message = x.status === 401 || x.status === 403 || code === "ADMIN_OR_OWNER_REQUIRED"
            ? `Admin or owner access is required (HTTP ${x.status}). No reconciliation data was read.`
            : `Could not load reconciliation status (HTTP ${x.status}${typeof code === "string" ? `: ${code}` : ""}). No reconciliation data was read.`;
          setState({ kind: "error", message });
          return;
        }
        setState({ kind: "ready", recon: normaliseRecon(raw) });
      })
      .catch((e: unknown) => setState({
        kind: "error",
        message: `Could not load reconciliation status (${e instanceof Error ? e.message : "request failed"}). No reconciliation data was read.`,
      }));
  }, []);

  const r = state.kind === "ready" ? state.recon : null;
  const brokerRead = r ? brokerSideRead(r) : false;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GitMerge className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Broker Reconciliation</h1>
          <p className="text-sm text-muted-foreground">Compare local OMS state vs MT5 bridge state.</p>
        </div>
        {r && (
          <Badge className={brokerRead ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}>
            {brokerRead ? `Broker side read · ${r.syncStatus}` : "Broker side not reconciled here"}
          </Badge>
        )}
      </div>

      {state.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.kind === "error" && (
        <p data-testid="recon-error" role="alert" className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {state.message}
        </p>
      )}
      {r && (
        <>
          <Card><CardHeader><CardTitle className="text-base">Status</CardTitle>
              <CardDescription>
                {brokerRead
                  ? r.notice
                  : "This page compares only the in-app order book. It did not read MT5 orders or positions, so broker counts and mismatches below were not checked."}
              </CardDescription></CardHeader>
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
            <Card><CardHeader><CardTitle className="text-base">Broker (MT5)</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <Row label="Broker orders" value={brokerRead ? String(r.brokerOrders.length) : "Not read"} />
                <Row label="Broker positions" value={brokerRead ? String(r.brokerPositions.length) : "Not read"} />
                <Row label="Mismatches" value={brokerRead ? String(r.mismatches.length) : "Not checked"} />
                {!brokerRead && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Broker reconciliation results are recorded in the{" "}
                    <Link href="/admin/reconciliation-center" className="underline">Reconciliation Center</Link>.
                  </p>
                )}
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
