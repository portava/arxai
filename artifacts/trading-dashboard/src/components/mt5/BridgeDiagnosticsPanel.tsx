import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, XCircle, AlertTriangle, Wifi, WifiOff } from "lucide-react";

type Diag = {
  tokenConfigured: boolean;
  expectedServerBaseUrl: string;
  expectedHeartbeatEndpoint: string;
  expectedHeader: string;
  endpoints: Record<string, boolean>;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  lastRejectedHeartbeatAt: string | null;
  lastRejectReason: string | null;
  acceptedHeartbeatCount: number;
  rejectedHeartbeatCount: number;
  appState: { mt5Connected: boolean; mt5Deferred: boolean; brokerExecutionAvailable: boolean; executionMode: string; placementLayer: string };
  troubleshooting: {
    webRequestChecklist: string[];
    algoTradingChecklist: string[];
    commonRejectReasons: Record<string, string>;
  };
  serverTime: string;
};

function YesNo({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> yes</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-txt-secondary"><XCircle className="w-3.5 h-3.5" /> no</span>
  );
}

export function BridgeDiagnosticsPanel() {
  const { data, isLoading, error } = useQuery<Diag>({
    queryKey: ["mt5-bridge-diagnostics"],
    queryFn: async () => {
      const r = await fetch("/api/mt5/bridge-diagnostics");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5000,
  });

  if (isLoading) return <Card><CardContent className="p-6 text-sm text-txt-secondary">Loading bridge diagnostics…</CardContent></Card>;
  if (error || !data) return <Card><CardContent className="p-6 text-sm text-danger">Failed to load bridge diagnostics.</CardContent></Card>;

  const fresh = data.heartbeatFresh;

  return (
    <Card data-testid="bridge-diagnostics-panel">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              {fresh ? <Wifi className="w-4 h-4 text-success" /> : <WifiOff className="w-4 h-4 text-txt-secondary" />}
              MT5 Bridge Troubleshooting
            </CardTitle>
            <CardDescription>Live diagnostic view. Read-only — does not change execution state.</CardDescription>
          </div>
          <Badge variant="outline" className={fresh ? "border-success/40 text-success" : "border-border/40 text-txt-secondary"}>
            {fresh ? "EA HEARTBEAT FRESH" : "NO FRESH HEARTBEAT"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-txt-secondary">Connection</div>
            <div className="flex justify-between"><span className="text-txt-secondary">Token configured</span><YesNo ok={data.tokenConfigured} /></div>
            <div className="flex justify-between"><span className="text-txt-secondary">EA connected (fresh heartbeat)</span><YesNo ok={fresh} /></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Last heartbeat</span><span>{data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).toLocaleString() : "never"}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Heartbeat age</span><span>{data.heartbeatAgeSeconds === null ? "—" : `${data.heartbeatAgeSeconds}s`}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Accepted count</span><span>{data.acceptedHeartbeatCount}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Rejected count</span><span className={data.rejectedHeartbeatCount > 0 ? "text-warning" : ""}>{data.rejectedHeartbeatCount}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Last reject</span><span>{data.lastRejectedHeartbeatAt ? new Date(data.lastRejectedHeartbeatAt).toLocaleString() : "never"}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">Last reject reason</span><span className="text-warning">{data.lastRejectReason ?? "—"}</span></div>
          </div>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-txt-secondary">App state (honest)</div>
            <div className="flex justify-between"><span className="text-txt-secondary">mt5Connected</span><YesNo ok={data.appState.mt5Connected} /></div>
            <div className="flex justify-between"><span className="text-txt-secondary">mt5Deferred</span><YesNo ok={data.appState.mt5Deferred} /></div>
            <div className="flex justify-between"><span className="text-txt-secondary">brokerExecutionAvailable</span><YesNo ok={data.appState.brokerExecutionAvailable} /></div>
            <div className="flex justify-between"><span className="text-txt-secondary">executionMode</span><span>{data.appState.executionMode}</span></div>
            <div className="flex justify-between"><span className="text-txt-secondary">placementLayer</span><span className="text-xs">{data.appState.placementLayer}</span></div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-txt-secondary">Endpoint mounting</div>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(data.endpoints).map(([k, v]) => (
              <div key={k} className="flex justify-between"><span className="text-txt-secondary">{k}</span><YesNo ok={v} /></div>
            ))}
          </div>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Configure your EA to point here</AlertTitle>
          <AlertDescription className="space-y-1 mt-1">
            <div><span className="text-txt-secondary">Expected server URL:</span> <code className="text-xs">{data.expectedServerBaseUrl}</code></div>
            <div><span className="text-txt-secondary">Heartbeat endpoint:</span> <code className="text-xs">{data.expectedHeartbeatEndpoint}</code></div>
            <div><span className="text-txt-secondary">Required header:</span> <code className="text-xs">{data.expectedHeader}: &lt;your per-user bridge token&gt;</code></div>
            <div className="text-xs text-txt-secondary">The EA must send the per-user token created on the MT5 Setup page. The legacy <code>MT5_BRIDGE_TOKEN</code> env value is rejected on every EA endpoint.</div>
          </AlertDescription>
        </Alert>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">WebRequest checklist</div>
            <ul className="list-disc pl-5 space-y-1 text-txt-secondary">
              {data.troubleshooting.webRequestChecklist.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">AlgoTrading / EA checklist</div>
            <ul className="list-disc pl-5 space-y-1 text-txt-secondary">
              {data.troubleshooting.algoTradingChecklist.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">Common reject reasons</div>
          <div className="space-y-1">
            {Object.entries(data.troubleshooting.commonRejectReasons).map(([k, v]) => (
              <div key={k} className="text-txt-secondary">
                <code className="text-xs text-warning">{k}</code> — {v}
              </div>
            ))}
          </div>
        </div>

        <div className="text-xs text-txt-muted">Server time: {new Date(data.serverTime).toLocaleString()} · Token values are never returned by this endpoint.</div>
      </CardContent>
    </Card>
  );
}
