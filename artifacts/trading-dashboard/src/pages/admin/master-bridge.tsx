// Admin — Master Bridge Dashboard
// (Centralized Master MT5 Bridge, Slice 1+2 read-only operator view).
//
// SECURITY:
//  - Reads only ADMIN-scoped endpoints under /api/admin/shared-master/*.
//  - Renders ONLY masked display fields (brokerName, accountNumberMasked,
//    eaVersion, heartbeat age). NEVER renders apiKeyHash, raw bridge
//    tokens, IP, server name, or raw account numbers.
//  - Per-user attribution rows are paged and quoted from the server
//    verbatim. The page itself never joins user PII beyond userId.
import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert, RefreshCw, Activity, Users, Layers, AlertTriangle, Plug, ShieldCheck } from "lucide-react";
import { MasterLiveUserAccessTable } from "@/components/admin/MasterLiveUserAccessTable";
import { LiveGatesDiagnosticPanel } from "@/components/admin/LiveGatesDiagnosticPanel";
import { OneClickControlsContent } from "@/pages/admin/one-click-controls";

// Main Bridge: Current Connected Bridge — operator card.
// Renders detector verdict from /api/admin/master-bridge/current + gate
// verdict from /api/admin/master-bridge/gate. Snapshot button persists
// detected bridgeId as platform_master_bridge_connection_id.
// SECURITY: shows masked operator evidence only — no key hash, no raw
// per-user token, no raw account number, no server name.
type MainBridge = {
  ok: boolean;
  detected: boolean;
  primaryReason?: string;
  liveBrokerExecutionEnabled?: boolean;
  bridge?: {
    bridgeId: number;
    brokerName: string | null;
    accountNumberMasked: string | null;
    eaVersion: string | null;
    heartbeatAgeSec: number | null;
    accountType: string;
    mode: string;
    readOnlyMode: boolean | null;
    enableLiveExecution: boolean | null;
    enableDemoExecution: boolean | null;
    terminalConnected: boolean | null;
    algoTradingAllowed: boolean | null;
    maxLiveLot: number | null;
  };
  latestHint?: MainBridge["bridge"];
};
type GateVerdict = {
  ok: boolean;
  verdict:
    | { decision: "PASS"; boundBridgeId: number }
    | { decision: "BLOCKED"; primaryReason: string; blockReasons: string[] };
};
function MainBridgeCurrentConnectedCard() {
  const [main, setMain] = useState<MainBridge | null>(null);
  const [gate, setGate] = useState<GateVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const [m, g] = await Promise.all([
        fetch("/api/admin/master-bridge/current", { credentials: "include" }).then((r) => r.json()),
        fetch("/api/admin/master-bridge/gate", { credentials: "include" }).then((r) => r.json()),
      ]);
      setMain(m); setGate(g);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function snapshot() {
    setBusy(true);
    try {
      await fetch("/api/admin/master-bridge/snapshot", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      await load();
    } finally { setBusy(false); }
  }
  const b = main?.bridge ?? main?.latestHint ?? null;
  const ready = main?.detected && gate?.verdict.decision === "PASS";
  return (
    <Card className="border border-primary/40 bg-primary/10" data-testid="card-main-bridge-current-connected">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-primary">
          <Plug className="w-5 h-5" /> Main Bridge: Current Connected Bridge
          {ready
            ? <Badge className="ml-2 bg-success/20 text-success"><ShieldCheck className="w-3 h-3 mr-1" />ready</Badge>
            : <Badge variant="destructive" className="ml-2"><AlertTriangle className="w-3 h-3 mr-1" />not ready</Badge>}
        </CardTitle>
        <CardDescription>
          The freshest REAL-mode EA bridge meeting every readiness criterion
          becomes the platform master live bridge. Snapshot persists it as
          <code className="font-mono ml-1">platform_master_bridge_connection_id</code>.
          The dispatch pipeline binds every master live command to this exact
          bridge id; the EA reporting back must match or the result is
          rejected with <code className="font-mono">BRIDGE_BINDING_MISMATCH</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div
          className={`rounded-md border px-3 py-2 text-[12px] ${main?.liveBrokerExecutionEnabled
            ? "border-success/40 bg-success/10 text-success"
            : "border-warning/40 bg-warning/10 text-warning"}`}
          data-testid="kv-arx-live-broker-execution-enabled"
        >
          <span className="font-medium">Backend live flag</span>{" "}
          <span className="font-mono">ARX_LIVE_BROKER_EXECUTION_ENABLED</span>{" "}
          ={" "}
          <span className="font-mono">
            {main?.liveBrokerExecutionEnabled ? "true" : "false"}
          </span>
          {!main?.liveBrokerExecutionEnabled && (
            <span className="ml-2">— live dispatch will refuse with <span className="font-mono">LIVE_BROKER_EXECUTION_DISABLED</span> regardless of bridge state.</span>
          )}
        </div>
        {b ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kv label="Bridge id" v={String(b.bridgeId)} mono />
            <Kv label="MT5 account" v={b.accountNumberMasked ?? "—"} mono />
            <Kv label="Broker/Server" v={b.brokerName ?? "—"} />
            <Kv label="Account type" v={b.accountType} mono />
            <Kv label="EA version" v={b.eaVersion ?? "—"} mono />
            <Kv label="Heartbeat age" v={b.heartbeatAgeSec == null ? "—" : `${b.heartbeatAgeSec}s`} mono />
            <Kv label="ReadOnlyMode" v={String(b.readOnlyMode ?? "—")} mono />
            <Kv label="EnableLiveExecution" v={String(b.enableLiveExecution ?? "—")} mono />
            <Kv label="EnableDemoExecution" v={String(b.enableDemoExecution ?? "—")} mono />
            <Kv label="MaxLiveLot" v={b.maxLiveLot == null ? "—" : String(b.maxLiveLot)} mono />
            <Kv label="terminalConnected" v={String(b.terminalConnected ?? "—")} mono />
            <Kv label="algoTradingAllowed" v={String(b.algoTradingAllowed ?? "—")} mono />
            <Kv label="mode" v={b.mode} mono />
          </div>
        ) : (
          <div className="text-warning/80">No bridge currently registered with the system.</div>
        )}
        {main && !main.detected && (
          <div className="text-[12px] text-warning">
            Detector blocked: <span className="font-mono">{main.primaryReason}</span>
          </div>
        )}
        {gate?.verdict.decision === "BLOCKED" && (
          <div className="text-[12px] text-warning">
            Gate blocked: <span className="font-mono">{gate.verdict.primaryReason}</span>
            {gate.verdict.blockReasons.length > 1 ? ` (+${gate.verdict.blockReasons.length - 1} more)` : ""}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <Button onClick={load} disabled={busy} variant="outline" size="sm">
            <RefreshCw className="w-3 h-3 mr-1" />Refresh
          </Button>
          <Button onClick={snapshot} disabled={busy || !main?.detected} size="sm">
            Snapshot as platform master bridge
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground pt-2 border-t border-primary/20">
          Per-user secrets, raw account numbers, server names, IPs, and
          key hashes are never returned to this dashboard. Only masked
          operator fields above.
        </div>
      </CardContent>
    </Card>
  );
}
function Kv({ label, v, mono }: { label: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono" : "font-medium"}>{v}</div>
    </div>
  );
}

type MasterOverview = {
  id: number;
  connectionId: number;
  accountType: "demo" | "live";
  brokerName: string | null;
  accountNumberMasked: string | null;
  status: string;
  isActive: boolean;
  userCount: number;
  openAttributions: number;
  realizedPnl24h: number;
  pendingUnattributed: number;
};
type VirtualAcc = {
  id: number; userId: number; sharedMasterAccountId: number | null;
  accountType: "demo" | "live"; virtualBalance: number; virtualEquity: number;
  virtualPnl: number; status: string;
};
type Attribution = {
  id: number; userId: number; sharedMasterAccountId: number;
  symbol: string; side: string; lotSize: number; status: string;
  pnl: number | null; openedAt: string | null; closedAt: string | null;
};
type Unattributed = {
  id: number; sharedMasterAccountId: number | null; symbol: string;
  side: string | null; lotSize: number | null; status: string;
  brokerMessage: string | null; createdAt: string;
};

const api = (path: string) =>
  fetch(path, { credentials: "include" }).then((r) => r.json());

export default function AdminMasterBridgePage() {
  const [overview, setOverview] = useState<MasterOverview[]>([]);
  const [virts, setVirts] = useState<VirtualAcc[]>([]);
  const [attrs, setAttrs] = useState<Attribution[]>([]);
  const [unattr, setUnattr] = useState<Unattributed[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setBusy(true); setErr(null);
    try {
      const [o, v, a, u] = await Promise.all([
        api("/api/admin/shared-master/overview"),
        api("/api/admin/shared-master/virtual-accounts"),
        api("/api/admin/shared-master/attributions"),
        api("/api/admin/shared-master/unattributed"),
      ]);
      if (o.ok) setOverview(o.masters ?? []);
      if (v.ok) setVirts(v.virtualAccounts ?? v.rows ?? []);
      if (a.ok) setAttrs(a.attributions ?? a.rows ?? []);
      if (u.ok) setUnattr(u.unattributed ?? u.rows ?? []);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="mx-auto w-full max-w-[1280px] pb-32 md:pb-6 space-y-4" data-testid="page-admin-master-bridge">
      <MainBridgeCurrentConnectedCard />
      <LiveGatesDiagnosticPanel />
      <MasterLiveUserAccessTable />
      <OneClickControlsContent embedded />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="w-6 h-6 text-warning" /> Master Bridge Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Centralized MT5 demo routing. Per-user isolation enforced in every
            attribution row. Live broker dispatch is permanently disabled on
            this page.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
        </Button>
      </div>

      <Alert className="border-danger/40 bg-danger/10">
        <ShieldAlert className="h-4 w-4 text-danger" />
        <AlertTitle>Live trading via master bridge is disabled.</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          This dashboard shows DEMO routing only. The shared LIVE flag remains
          OFF (default-deny) and Phase B live dispatch is unaffected by master
          mode. No broker credentials, tokens, or hashes are rendered on this
          page — only masked operator metadata.
        </AlertDescription>
      </Alert>

      {err && <div className="text-sm text-danger">{err}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4" /> Master accounts overview
          </CardTitle>
          <CardDescription>
            Active master accounts and their currently-attributed user counts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overview.length === 0 && (
            <div className="text-sm text-muted-foreground">No master accounts configured.</div>
          )}
          {overview.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3">ID</th>
                    <th className="py-1 pr-3">Type</th>
                    <th className="py-1 pr-3">Broker</th>
                    <th className="py-1 pr-3">Account (masked)</th>
                    <th className="py-1 pr-3">Status</th>
                    <th className="py-1 pr-3">Users</th>
                    <th className="py-1 pr-3">Open attribs</th>
                    <th className="py-1 pr-3">PnL 24h</th>
                    <th className="py-1 pr-3">Unattributed</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.map((m) => (
                    <tr key={m.id} className="border-t border-border/40" data-testid={`row-master-${m.id}`}>
                      <td className="py-1 pr-3 font-mono">#{m.id}</td>
                      <td className="py-1 pr-3"><Badge variant={m.accountType === "live" ? "destructive" : "outline"}>{m.accountType}</Badge></td>
                      <td className="py-1 pr-3">{m.brokerName ?? "—"}</td>
                      <td className="py-1 pr-3 font-mono">{m.accountNumberMasked ?? "—"}</td>
                      <td className="py-1 pr-3">
                        {m.isActive && m.status === "active"
                          ? <Badge className="bg-success/20 text-success">active</Badge>
                          : <Badge variant="outline">{m.status}</Badge>}
                      </td>
                      <td className="py-1 pr-3">{m.userCount}</td>
                      <td className="py-1 pr-3">{m.openAttributions}</td>
                      <td className={`py-1 pr-3 ${m.realizedPnl24h >= 0 ? "text-success" : "text-danger"}`}>
                        {m.realizedPnl24h.toFixed(2)}
                      </td>
                      <td className="py-1 pr-3">
                        {m.pendingUnattributed > 0
                          ? <Badge variant="destructive">{m.pendingUnattributed}</Badge>
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4" /> Virtual accounts ({virts.length})
          </CardTitle>
          <CardDescription>
            Per-user virtual ledger rows attributed to each master account.
            No credentials shown — only userId and balances.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {virts.length === 0 && <div className="text-sm text-muted-foreground">No virtual accounts yet.</div>}
          {virts.length > 0 && (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground sticky top-0 bg-background">
                  <tr>
                    <th className="py-1 pr-3">ID</th><th>User</th><th>Master</th>
                    <th>Type</th><th>Balance</th><th>Equity</th><th>PnL</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {virts.map((v) => (
                    <tr key={v.id} className="border-t border-border/40">
                      <td className="py-1 pr-3 font-mono">#{v.id}</td>
                      <td>u{v.userId}</td>
                      <td>{v.sharedMasterAccountId ?? "—"}</td>
                      <td>{v.accountType}</td>
                      <td>{Number(v.virtualBalance ?? 0).toFixed(2)}</td>
                      <td>{Number(v.virtualEquity ?? 0).toFixed(2)}</td>
                      <td className={Number(v.virtualPnl ?? 0) >= 0 ? "text-success" : "text-danger"}>
                        {Number(v.virtualPnl ?? 0).toFixed(2)}
                      </td>
                      <td>{v.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent attributions ({attrs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {attrs.length === 0 && <div className="text-sm text-muted-foreground">No attribution rows yet.</div>}
          {attrs.length > 0 && (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground sticky top-0 bg-background">
                  <tr>
                    <th className="py-1 pr-3">ID</th><th>User</th><th>Master</th>
                    <th>Symbol</th><th>Side</th><th>Lot</th><th>Status</th><th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {attrs.map((a) => (
                    <tr key={a.id} className="border-t border-border/40">
                      <td className="py-1 pr-3 font-mono">#{a.id}</td>
                      <td>u{a.userId}</td>
                      <td>{a.sharedMasterAccountId}</td>
                      <td className="font-mono">{a.symbol}</td>
                      <td>{a.side}</td>
                      <td>{a.lotSize}</td>
                      <td>{a.status}</td>
                      <td className={a.pnl != null && a.pnl >= 0 ? "text-success" : "text-danger"}>
                        {a.pnl != null ? a.pnl.toFixed(2) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" /> Unattributed master trades ({unattr.length})
          </CardTitle>
          <CardDescription>
            Fills on the master account that ARX could not match to a
            shared_trade_attribution row. Admin must link or dismiss.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unattr.length === 0 && <div className="text-sm text-muted-foreground">All master fills are attributed.</div>}
          {unattr.length > 0 && (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground sticky top-0 bg-background">
                  <tr>
                    <th>ID</th><th>Master</th><th>Symbol</th><th>Side</th>
                    <th>Lot</th><th>Status</th><th>Broker msg</th><th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {unattr.map((u) => (
                    <tr key={u.id} className="border-t border-border/40">
                      <td className="py-1 pr-3 font-mono">#{u.id}</td>
                      <td>{u.sharedMasterAccountId ?? "—"}</td>
                      <td className="font-mono">{u.symbol}</td>
                      <td>{u.side ?? "—"}</td>
                      <td>{u.lotSize ?? "—"}</td>
                      <td>{u.status}</td>
                      <td className="text-muted-foreground truncate max-w-xs">{u.brokerMessage ?? ""}</td>
                      <td>{new Date(u.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
