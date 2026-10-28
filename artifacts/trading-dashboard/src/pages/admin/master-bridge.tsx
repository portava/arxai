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
  masterLiveSettings?: MasterLiveSettings;
  liveExecution?: LiveExecutionState;
};
// The execution switches a master live order also has to clear, as
// GET /admin/master-bridge/current read them: the effective switch is the
// server env AND the operator arm; either install-wide stop refuses new live
// orders. readable:false = could not be read (treated as blocked).
type LiveExecutionState = {
  readable: boolean;
  envEnabled: boolean;
  operatorArmed: boolean | null;
  effectiveEnabled: boolean;
  platformStopEngaged: boolean;
  platformStopSources: string[];
  platformStopReason: string | null;
};
const STOP_SOURCE_LABEL: Record<string, string> = {
  platform_emergency_stop: "platform emergency stop",
  safety_core_kill_switch: "safety-core kill switch",
};
/** Why live dispatch is refused regardless of the bridge, in plain words ([] = none of these). */
export function liveDispatchBlockers(main: Pick<MainBridge, "liveBrokerExecutionEnabled" | "liveExecution"> | null): string[] {
  if (!main) return ["the live execution switches could not be read"];
  const x = main.liveExecution;
  if (!x) {
    return main.liveBrokerExecutionEnabled === false
      ? ["the server switch ARX_LIVE_BROKER_EXECUTION_ENABLED is off"]
      : ["the operator arm and platform stops were not reported"];
  }
  const out: string[] = [];
  if (!x.readable) out.push("the live execution switches could not be read");
  if (!x.envEnabled) out.push("the server switch ARX_LIVE_BROKER_EXECUTION_ENABLED is off");
  if (x.operatorArmed === false) out.push("live execution is not armed by an operator");
  if (x.platformStopEngaged) {
    const names = x.platformStopSources.map((s) => STOP_SOURCE_LABEL[s] ?? s);
    out.push(`${names.length ? names.join(" and ") : "a platform stop"} engaged`);
  }
  if (!out.length && !x.effectiveEnabled) out.push("the effective live execution switch is off");
  return out;
}
// The stored master-live settings as GET /admin/master-bridge/current read
// them. readable:false (or a failed load) means they could not be read — the
// page then says so instead of asserting live is off.
export type MasterLiveSettings = {
  readable: boolean;
  platformMode: string | null;
  accountRoutingMode: string | null;
  sharedLiveTradingEnabled: boolean | null;
  masterBridgeLiveEnabled: boolean | null;
  platformMasterBridgeConnectionId: number | null;
  readAt: string;
};
type GateVerdict = {
  ok: boolean;
  verdict:
    | { decision: "PASS"; boundBridgeId: number }
    | { decision: "BLOCKED"; primaryReason: string; blockReasons: string[] };
};
// GET a JSON admin endpoint. A network failure, a non-2xx status, a non-JSON
// body or an `ok:false` answer all throw — the caller shows "could not be
// loaded", never an empty or "off" state.
async function loadJson(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(path, { credentials: "include" });
  let body: Record<string, unknown> | null = null;
  try { body = (await r.json()) as Record<string, unknown> | null; } catch { body = null; }
  if (!r.ok || !body || body.ok !== true) {
    const why = typeof body?.error === "string" ? body.error : null;
    throw new Error(`HTTP ${r.status}${why ? `: ${why}` : ""}`);
  }
  return body;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function MainBridgeCurrentConnectedCard({
  onSettings,
}: {
  /** Reports the stored master-live settings (null: could not be read). */
  onSettings?: (s: MasterLiveSettings | null) => void;
}) {
  const [main, setMain] = useState<MainBridge | null>(null);
  const [gate, setGate] = useState<GateVerdict | null>(null);
  const [mainErr, setMainErr] = useState<string | null>(null);
  const [gateErr, setGateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const [m, g] = await Promise.allSettled([
        loadJson("/api/admin/master-bridge/current"),
        loadJson("/api/admin/master-bridge/gate"),
      ]);
      if (m.status === "fulfilled") {
        const mb = m.value as unknown as MainBridge;
        setMain(mb); setMainErr(null);
        onSettings?.(mb.masterLiveSettings?.readable === true ? mb.masterLiveSettings : null);
      } else {
        setMain(null); setMainErr(errText(m.reason));
        onSettings?.(null);
      }
      if (g.status === "fulfilled" && g.value.verdict) {
        setGate(g.value as unknown as GateVerdict); setGateErr(null);
      } else {
        setGate(null);
        setGateErr(g.status === "rejected" ? errText(g.reason) : "no verdict in the response");
      }
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
  // A blocked detector returns the freshest bridge it saw as a hint. That
  // bridge did NOT qualify and is not the master bridge.
  const bIsHint = !!main && !main.detected && !main.bridge && !!main.latestHint;
  // The detector + master gate verdict is a bridge-binding verdict only. It
  // says nothing about the server switch, the operator arm or the stops, so
  // "binding ready" is green only when none of those refuses live dispatch.
  const bindingReady = main?.detected === true && gate?.verdict.decision === "PASS";
  const blockers = liveDispatchBlockers(main);
  return (
    <Card className="border border-primary/40 bg-primary/10" data-testid="card-main-bridge-current-connected">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-primary">
          <Plug className="w-5 h-5" /> Main Bridge: Current Connected Bridge
          {bindingReady && blockers.length === 0 ? (
            <Badge className="ml-2 bg-success/20 text-success" data-testid="badge-main-bridge-binding">
              <ShieldCheck className="w-3 h-3 mr-1" />bridge binding ready
            </Badge>
          ) : bindingReady ? (
            <Badge className="ml-2 bg-warning/20 text-warning" data-testid="badge-main-bridge-binding">
              <AlertTriangle className="w-3 h-3 mr-1" />bridge bound · live dispatch blocked
            </Badge>
          ) : (
            <Badge variant="destructive" className="ml-2" data-testid="badge-main-bridge-binding">
              <AlertTriangle className="w-3 h-3 mr-1" />bridge binding not ready
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The freshest REAL-mode EA bridge meeting every readiness criterion
          becomes the platform master live bridge. Snapshot persists it as
          <code className="font-mono ml-1">platform_master_bridge_connection_id</code>.
          The dispatch pipeline binds every master live command to this exact
          bridge id; the EA reporting back must match or the result is
          rejected with <code className="font-mono">BRIDGE_BINDING_MISMATCH</code>.
          The badge covers bridge selection and binding only; every live order
          still has to pass the server switch, the operator arm, the platform
          stops and the full live gate set.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {typeof main?.liveBrokerExecutionEnabled !== "boolean" ? (
          <div
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning"
            data-testid="kv-arx-live-broker-execution-enabled"
          >
            <span className="font-medium">Backend live flag</span>{" "}
            <span className="font-mono">ARX_LIVE_BROKER_EXECUTION_ENABLED</span>{" "}
            {mainErr ? "could not be read." : main ? "was not reported." : "checking…"}
          </div>
        ) : (
        <div
          className={`rounded-md border px-3 py-2 text-[12px] ${main.liveBrokerExecutionEnabled && main.liveExecution?.readable === true && main.liveExecution.effectiveEnabled
            ? "border-success/40 bg-success/10 text-success"
            : "border-warning/40 bg-warning/10 text-warning"}`}
          data-testid="kv-arx-live-broker-execution-enabled"
        >
          <span className="font-medium">Backend live flag</span>{" "}
          <span className="font-mono">ARX_LIVE_BROKER_EXECUTION_ENABLED</span>{" "}
          ={" "}
          <span className="font-mono">
            {main.liveBrokerExecutionEnabled ? "true" : "false"}
          </span>
          {!main.liveBrokerExecutionEnabled ? (
            <span className="ml-2">— live dispatch will refuse with <span className="font-mono">LIVE_BROKER_EXECUTION_DISABLED</span> regardless of bridge state.</span>
          ) : !main.liveExecution || !main.liveExecution.readable || main.liveExecution.operatorArmed == null ? (
            <span className="ml-2">(server env permits live). The operator arm could not be read, so the effective switch (env AND arm) is unknown — treat live dispatch as refused.</span>
          ) : !main.liveExecution.effectiveEnabled ? (
            <span className="ml-2">(server env permits live), but live execution is not armed by an operator. The effective switch (env AND arm) is OFF — live dispatch will refuse with <span className="font-mono">LIVE_BROKER_EXECUTION_DISABLED</span>.</span>
          ) : (
            <span className="ml-2">and armed by an operator: the effective switch (env AND arm) is ON. Every other live gate still applies.</span>
          )}
        </div>
        )}
        {main && blockers.length > 0 && (
          <div className="text-[12px] text-warning" data-testid="text-live-dispatch-blockers">
            Live dispatch is refused whatever the bridge state: {blockers.join("; ")}.
          </div>
        )}
        {b ? (
          <>
          {bIsHint && (
            <div
              className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning"
              data-testid="text-bridge-hint-label"
            >
              Not the master bridge: this is the freshest bridge the detector
              saw, and it does not qualify
              {main?.primaryReason ? <> (<span className="font-mono">{main.primaryReason}</span>)</> : null}.
              No bridge is currently selected as the master live bridge.
            </div>
          )}
          <div
            className={`grid grid-cols-2 sm:grid-cols-4 gap-3${bIsHint ? " rounded-md border border-dashed border-warning/40 p-2 opacity-80" : ""}`}
            data-testid={bIsHint ? "grid-bridge-hint" : "grid-bridge-selected"}
          >
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
          </>
        ) : mainErr ? (
          <div className="text-danger" data-testid="text-main-bridge-load-error">
            The bridge detector could not be loaded ({mainErr}). This page cannot
            say which bridge is connected.
          </div>
        ) : main ? (
          <div className="text-warning/80">No bridge currently registered with the system.</div>
        ) : (
          <div className="text-muted-foreground">Loading the bridge detector…</div>
        )}
        {main && !main.detected && (
          <div className="text-[12px] text-warning">
            Detector blocked: <span className="font-mono">{main.primaryReason}</span>
          </div>
        )}
        {gateErr && (
          <div className="text-[12px] text-danger" data-testid="text-main-bridge-gate-error">
            The master bridge gate verdict could not be loaded ({gateErr}).
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
const NO_SECRETS_NOTE =
  "No broker credentials, tokens, or hashes are rendered on this page — only masked operator metadata.";

function flagText(v: boolean | null): string {
  return v == null ? "unknown" : v ? "true" : "false";
}

// The live-posture banner. Driven by the stored flags — it never claims live is
// off (or on) without having read them.
export function MasterLiveSettingsAlert({ settings }: { settings: MasterLiveSettings | null | undefined }) {
  if (settings === undefined) {
    return (
      <Alert data-testid="alert-master-live-settings">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Checking the master-bridge live settings…</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">{NO_SECRETS_NOTE}</AlertDescription>
      </Alert>
    );
  }
  if (settings === null || !settings.readable) {
    return (
      <Alert className="border-warning/40 bg-warning/10" data-testid="alert-master-live-settings">
        <ShieldAlert className="h-4 w-4 text-warning" />
        <AlertTitle>Master-bridge live settings could not be read.</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          This page could not load shared_live_trading_enabled and
          master_bridge_live_enabled, so it does not say whether live trading
          through the master bridge is on or off. Check Live Shared Activation
          or Trading Control. {NO_SECRETS_NOTE}
        </AlertDescription>
      </Alert>
    );
  }
  const asOf = new Date(settings.readAt);
  const flags = (
    <>
      shared_live_trading_enabled = <span className="font-mono">{flagText(settings.sharedLiveTradingEnabled)}</span>,
      master_bridge_live_enabled = <span className="font-mono">{flagText(settings.masterBridgeLiveEnabled)}</span>,
      platform mode <span className="font-mono">{settings.platformMode ?? "unknown"}</span>,
      routing <span className="font-mono">{settings.accountRoutingMode ?? "unknown"}</span>
      {Number.isFinite(asOf.getTime()) ? ` (read ${asOf.toLocaleTimeString()})` : ""}.
    </>
  );
  if (settings.sharedLiveTradingEnabled === true && settings.masterBridgeLiveEnabled === true) {
    return (
      <Alert className="border-danger/40 bg-danger/10" data-testid="alert-master-live-settings">
        <ShieldAlert className="h-4 w-4 text-danger" />
        <AlertTitle>Shared live and master-bridge live are ON.</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          {flags} A live order goes through the master bridge only when every
          other gate also passes: platform mode LIVE, routing SHARED_MASTER_MT5,
          the server switch and operator arm, no emergency or safety-core stop,
          the master bridge binding, and the user&apos;s own approval. This page
          itself places no orders. {NO_SECRETS_NOTE}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="border-warning/40 bg-warning/10" data-testid="alert-master-live-settings">
      <ShieldAlert className="h-4 w-4 text-warning" />
      <AlertTitle>Live trading via master bridge is off.</AlertTitle>
      <AlertDescription className="text-xs text-muted-foreground">
        {flags} Both flags must be on before the master bridge can take a live
        order. {NO_SECRETS_NOTE}
      </AlertDescription>
    </Alert>
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

type ListKey = "overview" | "virts" | "attrs" | "unattr";
const NO_LIST_ERRORS: Record<ListKey, string | null> = { overview: null, virts: null, attrs: null, unattr: null };

function ListLoadError({ what, err }: { what: string; err: string }) {
  return (
    <div className="text-sm text-danger" data-testid="text-list-load-error">
      {what} could not be loaded ({err}). This is not an empty list.
    </div>
  );
}
function countLabel(rows: unknown[] | null): string {
  return rows == null ? "" : ` (${rows.length})`;
}

export default function AdminMasterBridgePage() {
  // null = not loaded (loading, or the last load failed — see listErr).
  const [overview, setOverview] = useState<MasterOverview[] | null>(null);
  const [virts, setVirts] = useState<VirtualAcc[] | null>(null);
  const [attrs, setAttrs] = useState<Attribution[] | null>(null);
  const [unattr, setUnattr] = useState<Unattributed[] | null>(null);
  const [listErr, setListErr] = useState<Record<ListKey, string | null>>(NO_LIST_ERRORS);
  const [busy, setBusy] = useState(false);
  const [liveSettings, setLiveSettings] = useState<MasterLiveSettings | null | undefined>(undefined);

  async function refresh() {
    setBusy(true);
    try {
      const [o, v, a, u] = await Promise.allSettled([
        loadJson("/api/admin/shared-master/overview"),
        loadJson("/api/admin/shared-master/virtual-accounts"),
        loadJson("/api/admin/shared-master/attributions"),
        loadJson("/api/admin/shared-master/unattributed"),
      ]);
      const errs: Record<ListKey, string | null> = { ...NO_LIST_ERRORS };
      // A list whose rows are missing from an ok answer was not loaded either.
      function rowsOf<T>(r: PromiseSettledResult<Record<string, unknown>>, key: ListKey, ...fields: string[]): T[] | null {
        if (r.status === "rejected") { errs[key] = errText(r.reason); return null; }
        for (const f of fields) if (Array.isArray(r.value[f])) return r.value[f] as T[];
        errs[key] = "no rows in the response";
        return null;
      }
      setOverview(rowsOf<MasterOverview>(o, "overview", "masters"));
      setVirts(rowsOf<VirtualAcc>(v, "virts", "virtualAccounts", "rows"));
      setAttrs(rowsOf<Attribution>(a, "attrs", "attributions", "rows"));
      setUnattr(rowsOf<Unattributed>(u, "unattr", "unattributed", "rows"));
      setListErr(errs);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="mx-auto w-full max-w-[1280px] p-4 md:p-6 pb-32 md:pb-6 space-y-4" data-testid="page-admin-master-bridge">
      <MainBridgeCurrentConnectedCard onSettings={setLiveSettings} />
      <LiveGatesDiagnosticPanel />
      <MasterLiveUserAccessTable />
      <OneClickControlsContent embedded />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="w-6 h-6 text-warning" /> Master Bridge Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Centralized master MT5 routing: shared master accounts with a
            virtual ledger per user. Per-user isolation enforced in every
            attribution row. This page places no broker orders.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
        </Button>
      </div>

      <MasterLiveSettingsAlert settings={liveSettings} />


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
          {listErr.overview && <ListLoadError what="Master accounts" err={listErr.overview} />}
          {overview == null && !listErr.overview && <div className="text-sm text-muted-foreground">Loading…</div>}
          {overview?.length === 0 && (
            <div className="text-sm text-muted-foreground">No master accounts configured.</div>
          )}
          {overview != null && overview.length > 0 && (
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
            <Users className="w-4 h-4" /> Virtual accounts{countLabel(virts)}
          </CardTitle>
          <CardDescription>
            Per-user virtual ledger rows attributed to each master account.
            No credentials shown — only userId and balances.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listErr.virts && <ListLoadError what="Virtual accounts" err={listErr.virts} />}
          {virts == null && !listErr.virts && <div className="text-sm text-muted-foreground">Loading…</div>}
          {virts?.length === 0 && <div className="text-sm text-muted-foreground">No virtual accounts yet.</div>}
          {virts != null && virts.length > 0 && (
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
          <CardTitle className="text-base">Recent attributions{countLabel(attrs)}</CardTitle>
        </CardHeader>
        <CardContent>
          {listErr.attrs && <ListLoadError what="Attributions" err={listErr.attrs} />}
          {attrs == null && !listErr.attrs && <div className="text-sm text-muted-foreground">Loading…</div>}
          {attrs?.length === 0 && <div className="text-sm text-muted-foreground">No attribution rows yet.</div>}
          {attrs != null && attrs.length > 0 && (
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
            <AlertTriangle className="w-4 h-4 text-warning" /> Unattributed master trades{countLabel(unattr)}
          </CardTitle>
          <CardDescription>
            Fills on the master account that ARX could not match to a
            shared_trade_attribution row. Admin must link or dismiss.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listErr.unattr && <ListLoadError what="Unattributed master trades" err={listErr.unattr} />}
          {unattr == null && !listErr.unattr && <div className="text-sm text-muted-foreground">Loading…</div>}
          {unattr?.length === 0 && <div className="text-sm text-muted-foreground">All master fills are attributed.</div>}
          {unattr != null && unattr.length > 0 && (
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
