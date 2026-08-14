// Master Live Bridge banner — rendered on the Live Trading page.
// Shows the exact label the spec requires verbatim:
//   "Master Live Bridge: Current Connected Bridge"
// SECURITY: consumes /api/me/master-bridge/status which already masks
// the account number. Never renders apiKeyHash, raw bridge token,
// tokenLast4, server name, or raw account number.
import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plug, ShieldCheck, AlertTriangle } from "lucide-react";

type MasterBridgeStatus = {
  ok: boolean;
  label: string;
  detected: boolean;
  blocked: boolean;
  primaryReason: string | null;
  blockReasons: string[];
  bridge: null | {
    bridgeId: number;
    brokerName: string | null;
    accountNumberMasked: string | null;
    eaVersion: string | null;
    heartbeatAgeSec: number | null;
    accountType: string;
    mode: string;
    readOnlyMode: boolean | null;
    enableLiveExecution: boolean | null;
    terminalConnected: boolean | null;
    algoTradingAllowed: boolean | null;
    maxLiveLot: number | null;
  };
};

export function MasterLiveBridgeBanner() {
  const [s, setS] = useState<MasterBridgeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/me/master-bridge/status", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as MasterBridgeStatus;
        if (!cancelled) setS(j);
      } catch { /* silent */ }
    }
    void load();
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  if (!s) return null;
  const b = s.bridge;
  return (
    <Card
      className="border-2 border-sky-500/40 bg-sky-500/5"
      data-testid="card-master-live-bridge-banner"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sky-200">
          <Plug className="w-5 h-5" />
          Master Live Bridge: Current Connected Bridge
          {s.detected && !s.blocked
            ? <Badge className="ml-2 bg-emerald-500/20 text-emerald-300"><ShieldCheck className="w-3 h-3 mr-1" />ready</Badge>
            : <Badge variant="destructive" className="ml-2"><AlertTriangle className="w-3 h-3 mr-1" />blocked</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {b ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Bridge id" value={String(b.bridgeId)} />
            <Field label="Broker" value={b.brokerName ?? "—"} />
            <Field label="MT5 account" value={b.accountNumberMasked ?? "—"} mono />
            <Field label="Account type" value={b.accountType} mono />
            <Field label="EA version" value={b.eaVersion ?? "—"} mono />
            <Field
              label="Heartbeat"
              value={b.heartbeatAgeSec == null ? "—" : `${b.heartbeatAgeSec}s ago`}
              mono
            />
            <Field label="ReadOnlyMode" value={String(b.readOnlyMode ?? "—")} mono />
            <Field label="EnableLiveExecution" value={String(b.enableLiveExecution ?? "—")} mono />
            <Field label="MaxLiveLot" value={b.maxLiveLot == null ? "—" : String(b.maxLiveLot)} mono />
            <Field label="terminalConnected" value={String(b.terminalConnected ?? "—")} mono />
            <Field label="algoTradingAllowed" value={String(b.algoTradingAllowed ?? "—")} mono />
            <Field label="mode" value={b.mode} mono />
          </div>
        ) : (
          <div className="text-amber-300/90">
            No real-mode EA bridge currently connected. Attach the EA v1.27
            to your master MT5 terminal so the detector can resolve it.
          </div>
        )}
        {s.blocked && (
          <div className="text-[12px] text-amber-200 pt-2 border-t border-sky-500/20">
            Blocked: {s.primaryReason} {s.blockReasons.length > 1 ? `(+${s.blockReasons.length - 1} more)` : ""}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground pt-2 border-t border-sky-500/20">
          Broker tokens, raw account numbers, and the server name are never
          returned to this card. Master live dispatch additionally requires
          ARX_LIVE_BROKER_EXECUTION_ENABLED + every Phase B gate PASS.
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono" : "font-medium"}>{value}</div>
    </div>
  );
}
