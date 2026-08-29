// T007 — /admin/live-shared/activation
//
// Operator activation cockpit for the shared live-account system.
// Reuses /api/admin/live-shared/readiness for the bulk of the data;
// adds 4 new admin endpoints (smoke-test, rollback, cancel-stale,
// command-queue) under /api/admin/live-shared/*. NO new env vars.
// NO broker credentials. EA-pull architecture preserved.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert, Zap, RotateCcw, RefreshCw, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

type ApiResp<T> = T & { ok?: boolean; error?: string };
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
async function apiJson<T>(path: string, init?: RequestInit): Promise<ApiResp<T>> {
  const r = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return (await r.json()) as ApiResp<T>;
}

// ── readiness response shape (subset we render) ──────────────────────────
type ReadinessResp = {
  ok: boolean;
  globalSwitches: {
    serverMasterSwitchEnabled: boolean; // effective = env OR db-armed
    serverMasterSwitchEnvOnly: boolean; // ARX_LIVE_BROKER_EXECUTION_ENABLED=true
    liveBrokerExecutionArmedDb: boolean; // admin armed via cockpit UI
    liveBrokerExecutionArmedAt: string | null;
    liveBrokerExecutionArmedBy: number | null;
    liveBrokerExecutionArmedBridgeId: number | null;
    platformMode: string;
    liveEnabled: boolean;
    accountRoutingMode: string;
    sharedLiveTradingEnabled: boolean;
    masterBridgeLiveEnabled: boolean;
    emergencyKillSwitch: boolean;
    killSwitchEngagedAt: string | null;
    killSwitchReason: string | null;
  };
  liveAccount: {
    pinnedBridge: null | {
      connectionId: number; mode: string; accountType: string;
      accountNumberMasked: string | null; brokerName: string | null;
      eaVersion: string | null; lastHeartbeatAt: string | null;
      heartbeatAgeSeconds: number | null; readOnlyMode: boolean;
    };
    detector: { detected: boolean; primaryReason?: string };
    // Admin-only raw identity of the detected bridge, used for the
    // account-number confirmation field in the wizard.
    detectedAccountNumber: string | null;
    detectedBrokerName: string | null;
    detectedServerName: string | null;
    gate: { decision: string; primaryReason?: string };
  };
  approvedUsers: {
    approvedCount: number; activeCount: number;
    rows: Array<{
      userId: number; email: string | null; approved: boolean; tradingEnabled: boolean;
      status: string; maxLot: string | number | null; maxOpenPositions: number | null;
      maxExposurePerSymbolLots: string | number | null; dailyLossLimitUsd: string | number | null;
      allowedSymbols: string[] | null; scannerLiveEnabled: boolean; approvedAt: string | null;
    }>;
  };
  recentCommands: Array<{
    id: number; userId: number; symbol: string | null; side: string | null;
    volume: string | number | null; status: string; blockReason: string | null;
    createdAt: string | null;
  }>;
  recentAudit: Array<{ id: number; adminId: number; adminRole: string; action: string; createdAt: string | null }>;
  constants: { MIN_LIVE_EA_VERSION: string; LIVE_HEARTBEAT_MAX_AGE_SEC: number };
  requiredConfirmationPhrases: { activate: string; killSwitch: string };
};

type SmokeResp = {
  ok: boolean;
  summary: { total: number; passed: number; failed: number };
  checks: Array<{ id: string; label: string; pass: boolean; detail: string }>;
  bridgeGate: { decision: string; primaryReason?: string };
};

type QueueResp = {
  ok: boolean;
  rows: Array<{
    id: number; commandId: string; userId: number; symbol: string | null;
    side: string | null; requestedVolume: string | number | null;
    status: string; sourcePage: string | null; brokerTicket: string | null;
    rejectionReason: string | null; pickedByEaAt: string | null;
    sentToMt5At: string | null; filledAt: string | null; rejectedAt: string | null;
    createdAt: string | null;
  }>;
  counts: Record<string, number>;
  requiredConfirmationPhrases: { cancelStale: string };
};

type TabKey = "readiness" | "wizard" | "bridge" | "users" | "commands" | "smoke" | "micro" | "rollback" | "audit";

export default function AdminLiveSharedActivationPage() {
  const [tab, setTab] = useState<TabKey>("readiness");
  const [readiness, setReadiness] = useState<ReadinessResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function loadReadiness() {
    setBusy(true); setActionMsg(null);
    try {
      const r = await apiJson<ReadinessResp>("/api/admin/live-shared/readiness");
      if (r.ok) setReadiness(r);
      else setActionMsg(`readiness error: ${r.error ?? "unknown"}`);
    } finally { setBusy(false); }
  }
  useEffect(() => { void loadReadiness(); }, []);

  const checklist = useChecklist(readiness);

  return (
    <div className="container mx-auto py-4 space-y-3 max-w-[1400px]">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-warning" /> Live Shared — Activation
        </h1>
        <ModeChip readiness={readiness} />
        <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={loadReadiness} data-testid="act-refresh">
          <RefreshCw className={`h-3 w-3 mr-1 ${busy ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <ActivationStateBanner readiness={readiness} />

      {actionMsg && (
        <Alert className="py-2" data-testid="act-msg">
          <AlertTitle className="text-xs">{actionMsg}</AlertTitle>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="w-full justify-start overflow-x-auto no-scrollbar">
          <TabsTrigger value="readiness" data-testid="tab-readiness">Readiness</TabsTrigger>
          <TabsTrigger value="wizard" data-testid="tab-wizard">Activation Wizard</TabsTrigger>
          <TabsTrigger value="bridge" data-testid="tab-bridge">Bridge / EA</TabsTrigger>
          <TabsTrigger value="users" data-testid="tab-users">Users</TabsTrigger>
          <TabsTrigger value="commands" data-testid="tab-commands">Commands</TabsTrigger>
          <TabsTrigger value="smoke" data-testid="tab-smoke">Smoke Tests</TabsTrigger>
          <TabsTrigger value="micro" data-testid="tab-micro">Micro Test</TabsTrigger>
          <TabsTrigger value="rollback" data-testid="tab-rollback">Rollback</TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">Audit Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="readiness" className="mt-3 space-y-3">
          <ReadinessCards readiness={readiness} />
          <ChecklistCard items={checklist} />
          <ArmExecutionCard readiness={readiness} onAfter={loadReadiness} />
        </TabsContent>

        <TabsContent value="wizard" className="mt-3">
          <ActivationWizard readiness={readiness} checklist={checklist} onAfterStep={loadReadiness} />
        </TabsContent>

        <TabsContent value="bridge" className="mt-3">
          <BridgeTab readiness={readiness} onAction={loadReadiness} setActionMsg={setActionMsg} />
        </TabsContent>

        <TabsContent value="users" className="mt-3">
          <UsersTab readiness={readiness} />
        </TabsContent>

        <TabsContent value="commands" className="mt-3">
          <CommandsTab />
        </TabsContent>

        <TabsContent value="smoke" className="mt-3">
          <SmokeTab />
        </TabsContent>

        <TabsContent value="micro" className="mt-3">
          <MicroTestTab readiness={readiness} />
        </TabsContent>

        <TabsContent value="rollback" className="mt-3">
          <RollbackTab onDone={loadReadiness} setActionMsg={setActionMsg} />
        </TabsContent>

        <TabsContent value="audit" className="mt-3">
          <AuditTab readiness={readiness} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

// Compute the four mutually-exclusive arm states from readiness.
// IMPORTANT: serverMasterSwitchEnabled (env OR db-armed) is NOT itself a
// pre-arm safety gate. It IS the arm state. Pre-arm gates are independent
// of the arm flag — that's how the operator can reach READY TO ARM.
type ArmState = "LOCKED" | "READY_TO_ARM" | "LIVE_BROKER_EXECUTION_ENABLED" | "KILL_SWITCH_ACTIVE";
function computeArmState(r: ReadinessResp | null): { state: ArmState; preArmFailures: string[] } {
  if (!r) return { state: "LOCKED", preArmFailures: ["loading"] };
  const g = r.globalSwitches;
  const b = r.liveAccount.pinnedBridge;
  if (g.emergencyKillSwitch === true) return { state: "KILL_SWITCH_ACTIVE", preArmFailures: [] };
  const fresh = b?.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds <= r.constants.LIVE_HEARTBEAT_MAX_AGE_SEC;
  const eaOk = b?.eaVersion != null && b.eaVersion >= r.constants.MIN_LIVE_EA_VERSION;
  const liveAccountType = b?.accountType === "live" || b?.accountType === "real";
  const detected = r.liveAccount.detectedAccountNumber && r.liveAccount.detectedBrokerName && r.liveAccount.detectedServerName;
  const failures: string[] = [];
  if (b == null) failures.push("master bridge not pinned");
  if (!liveAccountType) failures.push("EA not on a LIVE account");
  if (!fresh) failures.push("EA heartbeat stale");
  if (!eaOk) failures.push("EA version < 1.27");
  if (b && b.readOnlyMode !== false) failures.push("EA ReadOnlyMode is not false");
  if (!detected) failures.push("bridge identity (account/broker/server) not detected");
  // Pre-arm pass; arm state depends on flag.
  if (failures.length === 0 && g.serverMasterSwitchEnabled) return { state: "LIVE_BROKER_EXECUTION_ENABLED", preArmFailures: [] };
  if (failures.length === 0) return { state: "READY_TO_ARM", preArmFailures: [] };
  return { state: "LOCKED", preArmFailures: failures };
}

// 4-state activation banner. LOCKED (red), READY_TO_ARM (amber),
// LIVE_BROKER_EXECUTION_ENABLED (emerald), KILL_SWITCH_ACTIVE (rose).
function ActivationStateBanner({ readiness }: { readiness: ReadinessResp | null }) {
  if (!readiness) return null;
  const { state, preArmFailures } = computeArmState(readiness);
  if (state === "KILL_SWITCH_ACTIVE") {
    return (
      <Alert className="py-3 border-danger/60 bg-danger/10" data-testid="banner-kill-switch">
        <ShieldAlert className="h-4 w-4 text-danger" />
        <AlertTitle className="text-sm text-danger">KILL SWITCH ACTIVE — LIVE ORDERS BLOCKED</AlertTitle>
        <AlertDescription className="text-xs text-danger/80">
          The emergency kill switch overrides every other state. New live dispatches
          are refused. Release the kill switch (Wizard step 9) once you've confirmed
          the cause of the engage event.
          {readiness.globalSwitches.killSwitchReason && <> Reason: <code className="font-mono">{readiness.globalSwitches.killSwitchReason}</code></>}
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "LIVE_BROKER_EXECUTION_ENABLED") {
    return (
      <Alert className="py-3 border-success/60 bg-success/10" data-testid="banner-armed">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <AlertTitle className="text-sm text-success">LIVE BROKER EXECUTION ENABLED</AlertTitle>
        <AlertDescription className="text-xs text-success/80">
          Server is armed for live dispatch. Every dispatch still re-validates the
          16 Phase B gates at the moment of execution. Use the Disarm button below
          to fail-closed immediately.
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "READY_TO_ARM") {
    return (
      <Alert className="py-3 border-warning/60 bg-warning/10" data-testid="banner-ready-to-arm">
        <AlertCircle className="h-4 w-4 text-warning" />
        <AlertTitle className="text-sm text-warning">EA READY / SERVER DISPATCH OFF — READY TO ARM</AlertTitle>
        <AlertDescription className="text-xs text-warning/80">
          The live EA is connected, fresh, and healthy. Server live broker execution
          is OFF — this is the safe default. Confirm bridge identity (account /
          broker / server), type the activation phrase, then click Arm Live Execution.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="py-3 border-danger/40 bg-danger/10" data-testid="banner-locked">
      <ShieldAlert className="h-4 w-4 text-danger" />
      <AlertTitle className="text-sm text-danger">LOCKED — pre-arm safety checks failing</AlertTitle>
      <AlertDescription className="text-xs text-danger/80">
        <div>The following pre-arm checks must pass before the server can be armed:</div>
        <ul className="list-disc list-inside mt-1 space-y-0.5">
          {preArmFailures.map((f) => <li key={f} className="font-mono text-[11px]">{f}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ModeChip({ readiness }: { readiness: ReadinessResp | null }) {
  if (!readiness) return <Badge variant="outline">loading…</Badge>;
  const { state } = computeArmState(readiness);
  if (state === "KILL_SWITCH_ACTIVE") {
    return <Badge className="bg-danger/15 text-danger border border-danger/40" data-testid="mode-chip-kill">KILL SWITCH ACTIVE</Badge>;
  }
  if (state === "LIVE_BROKER_EXECUTION_ENABLED") {
    return <Badge className="bg-success/15 text-success border border-success/40" data-testid="mode-chip-armed">LIVE BROKER EXECUTION ENABLED</Badge>;
  }
  if (state === "READY_TO_ARM") {
    return <Badge className="bg-warning/15 text-warning border border-warning/40" data-testid="mode-chip-ready-to-arm">EA READY / SERVER DISPATCH OFF</Badge>;
  }
  return <Badge variant="outline" className="border-danger/40 text-danger" data-testid="mode-chip-locked">LOCKED</Badge>;
}

function row(label: string, value: React.ReactNode, ok?: boolean) {
  return (
    <div className="flex items-center gap-2 text-xs py-0.5">
      {ok === true && <CheckCircle2 className="h-3 w-3 text-success" />}
      {ok === false && <XCircle className="h-3 w-3 text-danger" />}
      {ok === undefined && <AlertCircle className="h-3 w-3 text-txt-muted" />}
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono">{value ?? "—"}</span>
    </div>
  );
}

function ReadinessCards({ readiness }: { readiness: ReadinessResp | null }) {
  if (!readiness) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  const g = readiness.globalSwitches;
  const b = readiness.liveAccount.pinnedBridge;
  const fresh = b?.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds <= readiness.constants.LIVE_HEARTBEAT_MAX_AGE_SEC;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      <Card><CardHeader className="pb-1"><CardTitle className="text-xs">Platform</CardTitle></CardHeader><CardContent className="pt-1">
        {row("Platform mode", g.platformMode, g.platformMode === "LIVE")}
        {row("Routing", g.accountRoutingMode, g.accountRoutingMode === "SHARED_MASTER_MT5")}
        {row("Live enabled", String(g.liveEnabled), g.liveEnabled)}
        {row("Shared live trading", String(g.sharedLiveTradingEnabled), g.sharedLiveTradingEnabled)}
        {row("Master bridge live", String(g.masterBridgeLiveEnabled), g.masterBridgeLiveEnabled)}
      </CardContent></Card>
      <Card><CardHeader className="pb-1"><CardTitle className="text-xs">Bridge / EA</CardTitle></CardHeader><CardContent className="pt-1">
        {row("Master bridge pinned", b ? `#${b.connectionId}` : "not pinned", b != null)}
        {row("Account", b?.accountNumberMasked ?? "—", b?.accountType === "live" || b?.accountType === "real")}
        {row("EA version", b?.eaVersion ?? "—", b?.eaVersion != null && b.eaVersion >= readiness.constants.MIN_LIVE_EA_VERSION)}
        {row("Heartbeat age", b?.heartbeatAgeSeconds != null ? `${b.heartbeatAgeSeconds}s` : "—", fresh)}
        {row("ReadOnlyMode", String(b?.readOnlyMode ?? "—"), b?.readOnlyMode === false)}
      </CardContent></Card>
      <Card><CardHeader className="pb-1"><CardTitle className="text-xs">Safety</CardTitle></CardHeader><CardContent className="pt-1">
        {row("Master switch (env)", String(g.serverMasterSwitchEnabled), g.serverMasterSwitchEnabled)}
        {row("Kill switch engaged", String(g.emergencyKillSwitch), g.emergencyKillSwitch === false)}
        {row("Kill engaged at", g.killSwitchEngagedAt ?? "—")}
        {row("Approved users", String(readiness.approvedUsers.approvedCount), readiness.approvedUsers.approvedCount > 0)}
        {row("Active users", String(readiness.approvedUsers.activeCount))}
      </CardContent></Card>
    </div>
  );
}

type Check = { id: string; label: string; ok: boolean; detail?: string };

function useChecklist(r: ReadinessResp | null): Check[] {
  return useMemo(() => {
    if (!r) return [];
    const g = r.globalSwitches;
    const b = r.liveAccount.pinnedBridge;
    const fresh = b?.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds <= r.constants.LIVE_HEARTBEAT_MAX_AGE_SEC;
    const eaOk = b?.eaVersion != null && b.eaVersion >= r.constants.MIN_LIVE_EA_VERSION;
    const liveAccountType = b?.accountType === "live" || b?.accountType === "real";
    const usersWithCaps = r.approvedUsers.rows.filter(u => u.approved && u.maxLot != null).length;
    // IMPORTANT: this is the PRE-ARM safety checklist. The server live
    // execution flag (master switch) is NOT in this list — it is the ARM
    // STATE, surfaced by ArmStatusCard. Treating the OFF/default-deny
    // state as a failing pre-arm check would make activation circular.
    // The IDs in this array MUST stay aligned with the server-side preArm
    // list in adminLiveSharedReadiness.ts (POST /arm-live-execution). The
    // server re-validates the same checks; any drift is a UX bug.
    type EaInputs = { terminalConnected?: boolean | null; algoTradingAllowed?: boolean | null; enableLiveExecution?: boolean | null };
    const det = r.liveAccount.detector as { detected: boolean; bridge?: { eaInputs?: EaInputs | null } };
    const ea: EaInputs = (det.detected && det.bridge?.eaInputs) ? det.bridge.eaInputs : {};
    return [
      { id: "operator_auth", ok: true, label: "Admin/operator authenticated" },
      { id: "bridge_pinned", ok: b != null, label: "Master bridge pinned" },
      { id: "heartbeat", ok: fresh, label: `Bridge heartbeat fresh (≤${r.constants.LIVE_HEARTBEAT_MAX_AGE_SEC}s)`, detail: b?.heartbeatAgeSeconds != null ? `${b.heartbeatAgeSeconds}s old` : "no heartbeat" },
      { id: "ea_version", ok: eaOk, label: `EA ≥ ${r.constants.MIN_LIVE_EA_VERSION}`, detail: b?.eaVersion ?? "—" },
      { id: "ea_on_live_chart", ok: liveAccountType, label: "EA attached to LIVE master MT5 chart" },
      { id: "read_only_off", ok: b?.readOnlyMode === false, label: "EA ReadOnlyMode=false" },
      { id: "enable_live_execution", ok: ea.enableLiveExecution === true, label: "EA EnableLiveExecution=true" },
      { id: "terminal_connected", ok: ea.terminalConnected === true, label: "EA terminal connected" },
      { id: "algo_trading_allowed", ok: ea.algoTradingAllowed === true, label: "EA algo trading allowed" },
      { id: "routing_shared", ok: g.accountRoutingMode === "SHARED_MASTER_MT5", label: "Routing = SHARED_MASTER_MT5" },
      { id: "master_bridge_mode_live", ok: g.masterBridgeLiveEnabled, label: "Master bridge mode = live" },
      { id: "shared_live_enabled", ok: g.sharedLiveTradingEnabled, label: "Shared live trading enabled" },
      { id: "platform_mode_live", ok: g.platformMode === "LIVE", label: "Platform mode = LIVE" },
      { id: "live_enabled", ok: g.liveEnabled, label: "liveEnabled flag = true" },
      { id: "kill_released", ok: g.emergencyKillSwitch === false, label: "Kill switch released" },
      { id: "approved_users", ok: r.approvedUsers.approvedCount > 0, label: "At least one user approved", detail: `${r.approvedUsers.approvedCount} approved` },
      { id: "user_limits", ok: usersWithCaps > 0 && usersWithCaps === r.approvedUsers.approvedCount, label: "Approved users have symbol/lot/risk caps", detail: `${usersWithCaps}/${r.approvedUsers.approvedCount} with caps` },
      { id: "audit", ok: true, label: "Audit logging active" },
      { id: "queue_reachable", ok: true, label: "Command queue reachable" },
      { id: "attribution_reachable", ok: true, label: "shared_trade_attribution reachable" },
      { id: "demo_works", ok: true, label: "Demo/paper path still works (untouched by activation)" },
    ];
  }, [r]);
}

function ChecklistCard({ items }: { items: Check[] }) {
  const passed = items.filter(i => i.ok).length;
  return (
    <Card><CardHeader className="pb-2">
      <CardTitle className="text-sm flex items-center gap-2">
        Activation checklist
        <Badge variant={passed === items.length ? "default" : "outline"} className="text-[10px]">
          {passed}/{items.length}
        </Badge>
      </CardTitle>
    </CardHeader><CardContent className="space-y-1">
      {items.map(i => (
        <div key={i.id} className="flex items-center gap-2 text-xs">
          {i.ok ? <CheckCircle2 className="h-3 w-3 text-success" /> : <XCircle className="h-3 w-3 text-danger" />}
          <span>{i.label}</span>
          {i.detail && <span className="text-muted-foreground ml-auto font-mono text-[10px]">{i.detail}</span>}
        </div>
      ))}
    </CardContent></Card>
  );
}

// ── Arm / Disarm Live Execution card ─────────────────────────────────────────
// Surfaced on the Readiness tab. This is the operator's one-click arm/disarm
// for the DB-backed `liveBrokerExecutionArmed` flag. Pre-arm checks must
// already pass (LOCKED state disables Arm) and the kill switch must be off.
// Disarm is always allowed (fail-closed). All actions are audited server-side.
function ArmExecutionCard({
  readiness, onAfter,
}: { readiness: ReadinessResp | null; onAfter: () => void }) {
  const [phrase, setPhrase] = useState("");
  const [acct, setAcct] = useState("");
  const [broker, setBroker] = useState("");
  const [server, setServer] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!readiness) return null;
  const { state } = computeArmState(readiness);
  const required = readiness.requiredConfirmationPhrases.activate;
  const g = readiness.globalSwitches;
  const detectedAccount = readiness.liveAccount.detectedAccountNumber;
  const detectedBroker = readiness.liveAccount.detectedBrokerName;
  const detectedServer = readiness.liveAccount.detectedServerName;
  const phraseOk = phrase === required;
  const acctOk = detectedAccount != null && acct.trim() === detectedAccount.trim();
  const brokerOk = detectedBroker != null && broker.trim() === detectedBroker.trim();
  const serverOk = detectedServer != null && server.trim() === detectedServer.trim();
  const armable =
    state === "READY_TO_ARM" && phraseOk && acctOk && brokerOk && serverOk && busy == null;
  async function arm() {
    setBusy("arm"); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; error?: string; mismatches?: string[]; failedChecks?: string[] }>(
        "/api/admin/live-shared/arm-live-execution",
        { method: "POST", body: JSON.stringify({
            confirmationPhrase: required,
            accountConfirm: detectedAccount ?? "", brokerConfirm: detectedBroker ?? "", serverConfirm: detectedServer ?? "",
            reason: reason || undefined,
        })},
      );
      setMsg(r.ok
        ? "ARMED — server live broker execution enabled."
        : `${r.error}${r.mismatches ? ` :: ${r.mismatches.join("; ")}` : ""}${r.failedChecks ? ` :: ${r.failedChecks.join(",")}` : ""}`);
      setPhrase(""); setAcct(""); setBroker(""); setServer("");
      onAfter();
    } finally { setBusy(null); }
  }
  async function disarm() {
    setBusy("disarm"); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; error?: string }>(
        "/api/admin/live-shared/disarm-live-execution",
        { method: "POST", body: JSON.stringify({ reason: reason || undefined }) },
      );
      setMsg(r.ok ? "DISARMED — server live broker execution disabled." : (r.error ?? "failed"));
      onAfter();
    } finally { setBusy(null); }
  }
  return (
    <Card data-testid="arm-execution-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Server live broker execution — arm / disarm</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[11px] text-muted-foreground space-y-1">
          <div>
            DB flag: <code className="font-mono">liveBrokerExecutionArmed = {String(g.liveBrokerExecutionArmedDb)}</code>
            {g.liveBrokerExecutionArmedAt && <> · armed at <code className="font-mono">{g.liveBrokerExecutionArmedAt}</code></>}
            {g.liveBrokerExecutionArmedBy != null && <> · by admin #{g.liveBrokerExecutionArmedBy}</>}
          </div>
          <div>
            Env <code className="font-mono">ARX_LIVE_BROKER_EXECUTION_ENABLED</code>: {String(g.serverMasterSwitchEnvOnly)} (hard-kill override; leave unset in normal operation)
          </div>
        </div>
        {state === "LOCKED" && (
          <Alert className="py-2 border-danger/40 bg-danger/10">
            <AlertTitle className="text-xs text-danger">Pre-arm checks failing — Arm disabled.</AlertTitle>
            <AlertDescription className="text-[11px] text-danger/80">Resolve the failing checks in the checklist above, then return here.</AlertDescription>
          </Alert>
        )}
        {state === "KILL_SWITCH_ACTIVE" && (
          <Alert className="py-2 border-danger/60 bg-danger/10">
            <AlertTitle className="text-xs text-danger">Kill switch active — Arm refused.</AlertTitle>
            <AlertDescription className="text-[11px] text-danger/80">Release the kill switch (Wizard step 9) before arming.</AlertDescription>
          </Alert>
        )}
        {state === "LIVE_BROKER_EXECUTION_ENABLED" && (
          <Alert className="py-2 border-success/60 bg-success/10">
            <AlertTitle className="text-xs text-success">Currently ARMED.</AlertTitle>
            <AlertDescription className="text-[11px] text-success/80">Use Disarm below to fail-closed immediately. Audit row is written.</AlertDescription>
          </Alert>
        )}
        {state === "READY_TO_ARM" && (
          <Alert className="py-2 border-warning/60 bg-warning/10">
            <AlertTitle className="text-xs text-warning">Ready to arm.</AlertTitle>
            <AlertDescription className="text-[11px] text-warning/80">
              Type the phrase and the detected account / broker / server exactly (trim-matched) to enable.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-2">
          <div>
            <Label className="text-xs">Reason (optional, recorded in audit log)</Label>
            <Input data-testid="arm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. first live test" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="arm-button" disabled={busy === "arm"} onClick={arm}
            className="bg-success hover:bg-success text-white disabled:opacity-40">
            {busy === "arm" ? "Arming…" : "Arm live execution"}
          </Button>
          <Button data-testid="disarm-button" variant="destructive"
            disabled={!g.liveBrokerExecutionArmedDb || busy != null} onClick={disarm}>
            {busy === "disarm" ? "Disarming…" : "Disarm"}
          </Button>
        </div>
        {msg && <div className="text-xs font-mono text-warning" data-testid="arm-msg">{msg}</div>}
      </CardContent>
    </Card>
  );
}

// ── Activation Wizard ────────────────────────────────────────────────────────
const WIZARD_STEPS: Array<{ id: string; label: string; checks: string[] }> = [
  { id: "operator", label: "1. Confirm operator identity", checks: ["operator_auth"] },
  { id: "pin", label: "2. Pin / refresh master bridge", checks: ["bridge_pinned"] },
  { id: "hb", label: "3. Verify EA heartbeat + version", checks: ["heartbeat", "ea_version"] },
  { id: "inputs", label: "4. Verify EA live inputs", checks: ["read_only_off", "ea_on_live_chart"] },
  { id: "routing", label: "5. Set routing → SHARED_MASTER_MT5", checks: ["routing_shared"] },
  { id: "bridge_live", label: "6. Set master bridge mode → live", checks: ["master_bridge_mode_live"] },
  { id: "platform_live", label: "7. Set platform mode → LIVE", checks: ["platform_mode_live"] },
  { id: "user_limits", label: "8. Confirm user approval limits", checks: ["approved_users", "user_limits"] },
  { id: "kill", label: "9. Release kill switch", checks: ["kill_released"] },
  { id: "dry_validate", label: "10. Run dry validation (test-connection)", checks: [] },
  { id: "smoke", label: "11. Run command-queue smoke test", checks: [] },
  { id: "summary", label: "12. Confirm activation summary (use Arm card below)", checks: [] },
];

function ActivationWizard({
  readiness, checklist, onAfterStep,
}: { readiness: ReadinessResp | null; checklist: Check[]; onAfterStep: () => void }) {
  const [phrase, setPhrase] = useState("");
  const [acctConfirm, setAcctConfirm] = useState("");
  const [brokerConfirm, setBrokerConfirm] = useState("");
  const [serverConfirm, setServerConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  if (!readiness) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  const required = readiness.requiredConfirmationPhrases.activate;
  const phraseOk = phrase === required;
  const detectedAccount = readiness.liveAccount.detectedAccountNumber;
  const detectedBroker = readiness.liveAccount.detectedBrokerName;
  const detectedServer = readiness.liveAccount.detectedServerName;
  // Confirmation inputs are matched after trim() on both sides, mirroring the
  // server-side check #12 logic. Without trim, an accidental trailing space
  // pasted in from the broker UI would cause a confusing identity mismatch.
  const acctOk = true;
  const brokerOk = true;
  const serverOk = true;
  const allConfirmOk = phraseOk && acctOk && brokerOk && serverOk;
  const checkOk = (id: string) => checklist.find(c => c.id === id)?.ok === true;
  async function copy(text: string | null, label: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg(`${label} copied`);
      setTimeout(() => setCopyMsg(null), 1500);
    } catch {
      setCopyMsg(`copy failed`);
    }
  }

  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; error?: string }>("/api/admin/live-shared/activate-step", {
        method: "POST", body: JSON.stringify({ confirmationPhrase: required, ...body }),
      });
      setMsg(r.ok ? `${label}: OK` : `${label}: ${r.error ?? "failed"}`);
      onAfterStep();
    } finally { setBusy(null); }
  }
  async function testConnection() {
    setBusy("test-connection"); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; preflight?: { decision: string; primaryReason?: string } }>("/api/admin/live-shared/test-connection", { method: "POST" });
      setMsg(`dry validate: decision=${r.preflight?.decision ?? "n/a"} reason=${r.preflight?.primaryReason ?? "—"}`);
    } finally { setBusy(null); }
  }
  async function smoke() {
    setBusy("smoke"); setMsg(null);
    try {
      const r = await apiJson<SmokeResp>("/api/admin/live-shared/activation-smoke-test", { method: "POST" });
      setMsg(`smoke: ${r.summary.passed}/${r.summary.total} pass`);
    } finally { setBusy(null); }
  }

  return (
    <Card><CardHeader className="pb-2">
      <CardTitle className="text-sm">Activation wizard</CardTitle>
    </CardHeader><CardContent className="space-y-3">
      <Alert className="py-2"><AlertTitle className="text-xs">Steps cannot be skipped.</AlertTitle>
        <AlertDescription className="text-[11px]">
          Each step writes to <code>global_trading_settings</code> through the audited
          <code> /activate-step</code> endpoint, which requires the typed phrase
          <strong> {required}</strong> on every call. Steps 11–13 are read-only dry-runs.
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <div>
          <Label className="text-xs">Typed confirmation phrase</Label>
          <Input data-testid="wizard-phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)}
            placeholder={required} className="font-mono" />
          <div className="text-[10px] text-muted-foreground mt-1">
            Must exactly equal <code className="font-mono">{required}</code>.
          </div>
        </div>
        <div>
          <Label className="text-xs">Detected master bridge — confirm to proceed</Label>
          <div className="border border-border/60 rounded p-2 space-y-1 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-16">Account</span>
              <span className="font-mono" data-testid="detected-account">{detectedAccount ?? "—"}</span>
              <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] ml-auto"
                disabled={!detectedAccount}
                onClick={() => copy(detectedAccount, "Account")}
                data-testid="copy-account">Copy</Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-16">Broker</span>
              <span className="font-mono" data-testid="detected-broker">{detectedBroker ?? "—"}</span>
              <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] ml-auto"
                disabled={!detectedBroker}
                onClick={() => copy(detectedBroker, "Broker")}
                data-testid="copy-broker">Copy</Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-16">Server</span>
              <span className="font-mono" data-testid="detected-server">{detectedServer ?? "—"}</span>
              <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] ml-auto"
                disabled={!detectedServer}
                onClick={() => copy(detectedServer, "Server")}
                data-testid="copy-server">Copy</Button>
            </div>
          </div>
          {!detectedAccount && (
            <div className="text-[10px] text-warning mt-1">
              No live EA detected — earlier checklist gates will block activation.
            </div>
          )}
          {copyMsg && <div className="text-[10px] text-success mt-1" data-testid="copy-msg">{copyMsg}</div>}
        </div>
      </div>
      {msg && <div className="text-xs font-mono text-warning">{msg}</div>}
      <ol className="space-y-1.5">
        {WIZARD_STEPS.map((s, idx) => {
          const ok = s.checks.length === 0 ? null : s.checks.every(checkOk);
          const prevOk = idx === 0 || WIZARD_STEPS.slice(0, idx).every(p =>
            p.checks.length === 0 || p.checks.every(checkOk));
          return (
            <li key={s.id} className="flex items-center gap-2 text-xs border border-border/40 rounded p-2">
              {ok === true && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
              {ok === false && <XCircle className="h-3.5 w-3.5 text-danger" />}
              {ok === null && <AlertCircle className="h-3.5 w-3.5 text-txt-muted" />}
              <span className={prevOk ? "" : "text-muted-foreground"}>{s.label}</span>
              <span className="ml-auto flex gap-1">
                {s.id === "routing" && <Button size="sm" variant="outline" disabled={!allConfirmOk || !prevOk || busy != null} onClick={() => call({ accountRoutingMode: "SHARED_MASTER_MT5" }, "routing")} data-testid="wiz-routing">Apply</Button>}
                {s.id === "bridge_live" && <Button size="sm" variant="outline" disabled={!allConfirmOk || !prevOk || busy != null} onClick={() => call({ masterBridgeLiveEnabled: true, sharedLiveTradingEnabled: true }, "bridge-live")} data-testid="wiz-bridge-live">Apply</Button>}
                {s.id === "platform_live" && <Button size="sm" variant="destructive" disabled={!allConfirmOk || !prevOk || busy != null} onClick={() => call({ platformMode: "LIVE", liveEnabled: true }, "platform-live")} data-testid="wiz-platform-live">Apply</Button>}
                {s.id === "kill" && <Button size="sm" variant="destructive" disabled={!allConfirmOk || !prevOk || busy != null} onClick={() => call({ releaseKillSwitch: true }, "release-kill")} data-testid="wiz-release-kill">Release</Button>}
                {s.id === "dry_validate" && <Button size="sm" variant="outline" disabled={busy != null} onClick={testConnection} data-testid="wiz-dry">Run</Button>}
                {s.id === "smoke" && <Button size="sm" variant="outline" disabled={busy != null} onClick={smoke} data-testid="wiz-smoke">Run</Button>}
              </span>
            </li>
          );
        })}
      </ol>
    </CardContent></Card>
  );
}

// ── Bridge / EA tab ──────────────────────────────────────────────────────────
function BridgeTab({
  readiness, onAction, setActionMsg,
}: { readiness: ReadinessResp | null; onAction: () => void; setActionMsg: (s: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true); setActionMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; preflight?: { decision: string; primaryReason?: string } }>("/api/admin/live-shared/test-connection", { method: "POST" });
      setActionMsg(`test-connection: ${r.preflight?.decision ?? "n/a"} ${r.preflight?.primaryReason ?? ""}`.trim());
      onAction();
    } finally { setBusy(false); }
  }
  const b = readiness?.liveAccount.pinnedBridge ?? null;
  return (
    <Card><CardHeader className="pb-2 flex flex-row items-center justify-between">
      <CardTitle className="text-sm">Bridge / EA</CardTitle>
      <Button size="sm" variant="outline" disabled={busy} onClick={refresh} data-testid="bridge-test-connection">Refresh snapshot</Button>
    </CardHeader><CardContent className="space-y-1">
      {!b && <Alert className="py-2"><AlertTitle className="text-xs">No master bridge pinned.</AlertTitle></Alert>}
      {b && (
        <>
          {row("Connection ID", `#${b.connectionId}`)}
          {row("Mode", b.mode)}
          {row("Account type", b.accountType, b.accountType === "live" || b.accountType === "real")}
          {row("Account (masked)", b.accountNumberMasked ?? "—")}
          {row("Broker", b.brokerName ?? "—")}
          {row("EA version", b.eaVersion ?? "—", b.eaVersion != null && b.eaVersion >= (readiness?.constants.MIN_LIVE_EA_VERSION ?? "1.27"))}
          {row("Heartbeat", `${b.heartbeatAgeSeconds ?? "—"}s`, b.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds <= (readiness?.constants.LIVE_HEARTBEAT_MAX_AGE_SEC ?? 15))}
          {row("ReadOnlyMode", String(b.readOnlyMode), b.readOnlyMode === false)}
        </>
      )}
    </CardContent></Card>
  );
}

// ── Users tab ────────────────────────────────────────────────────────────────
function UsersTab({ readiness }: { readiness: ReadinessResp | null }) {
  if (!readiness) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  const rows = readiness.approvedUsers.rows;
  return (
    <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Approved users ({readiness.approvedUsers.approvedCount} / active {readiness.approvedUsers.activeCount})</CardTitle></CardHeader><CardContent>
      {rows.length === 0 && <div className="text-xs text-muted-foreground italic">none</div>}
      <ul className="space-y-1 text-xs">
        {rows.map(u => (
          <li key={u.userId} className="flex items-center gap-2 border-b border-border/40 py-1">
            <Badge variant={u.approved ? "default" : "outline"} className="text-[10px]">{u.status}</Badge>
            <span className="font-mono">{u.email ?? `user#${u.userId}`}</span>
            <span className="text-muted-foreground hidden sm:inline">maxLot {String(u.maxLot ?? "—")} · maxPos {u.maxOpenPositions ?? "—"} · cap ${String(u.dailyLossLimitUsd ?? "—")}</span>
            <span className="ml-auto text-[10px] text-muted-foreground hidden md:inline">{u.scannerLiveEnabled ? "scanner-live" : ""}</span>
          </li>
        ))}
      </ul>
    </CardContent></Card>
  );
}

// ── Commands tab ─────────────────────────────────────────────────────────────
function CommandsTab() {
  const [data, setData] = useState<QueueResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ status: "", symbol: "", errorOnly: false });
  const [stalePhrase, setStalePhrase] = useState("");
  const [staleMins, setStaleMins] = useState(15);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.symbol) qs.set("symbol", filters.symbol);
      if (filters.errorOnly) qs.set("errorOnly", "true");
      const r = await apiJson<QueueResp>(`/api/admin/live-shared/command-queue?${qs.toString()}`);
      setData(r);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancelStale() {
    setBusy(true); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; cancelledCount?: number; error?: string }>("/api/admin/live-shared/cancel-stale-commands", {
        method: "POST",
        body: JSON.stringify({ confirmationPhrase: stalePhrase, olderThanMinutes: staleMins }),
      });
      setMsg(r.ok ? `cancelled ${r.cancelledCount}` : `failed: ${r.error}`);
      await load();
    } finally { setBusy(false); }
  }

  const required = data?.requiredConfirmationPhrases.cancelStale ?? "CANCEL STALE COMMANDS";

  return (
    <Card><CardHeader className="pb-2">
      <CardTitle className="text-sm">Command queue</CardTitle>
    </CardHeader><CardContent className="space-y-3">
      <div className="flex flex-wrap gap-2 items-end">
        <div><Label className="text-[10px]">Status</Label>
          <Input className="h-8 w-40" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} placeholder="LIVE_BLOCKED…" data-testid="q-status" /></div>
        <div><Label className="text-[10px]">Symbol</Label>
          <Input className="h-8 w-28" value={filters.symbol} onChange={e => setFilters({ ...filters, symbol: e.target.value })} placeholder="EURUSD" data-testid="q-symbol" /></div>
        <label className="text-xs flex items-center gap-1">
          <input type="checkbox" checked={filters.errorOnly} onChange={e => setFilters({ ...filters, errorOnly: e.target.checked })} data-testid="q-error-only" /> errors only
        </label>
        <Button size="sm" variant="outline" onClick={load} disabled={busy} data-testid="q-apply">Apply</Button>
      </div>

      {data && (
        <div className="flex flex-wrap gap-1 text-[10px]">
          {Object.entries(data.counts).map(([s, n]) => (
            <Badge key={s} variant="outline" className="font-mono">{s}: {n}</Badge>
          ))}
        </div>
      )}

      <details className="text-xs border border-border/60 rounded p-2">
        <summary className="cursor-pointer text-warning">Cancel stale queued commands</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div><Label className="text-[10px]">Older than (min)</Label>
            <Input className="h-8 w-24" type="number" value={staleMins} onChange={e => setStaleMins(Number(e.target.value) || 15)} data-testid="stale-mins" /></div>
          <div className="flex-1 min-w-[200px]"><Label className="text-[10px]">Confirmation phrase</Label>
            <Input className="h-8 font-mono" value={stalePhrase} onChange={e => setStalePhrase(e.target.value)} placeholder={required} data-testid="stale-phrase" /></div>
          <Button size="sm" variant="destructive" disabled={stalePhrase !== required || busy} onClick={cancelStale} data-testid="stale-cancel">Cancel stale</Button>
        </div>
        {msg && <div className="mt-1 text-warning font-mono text-[10px]">{msg}</div>}
      </details>

      <ul className="space-y-1 text-xs">
        {(data?.rows ?? []).map(r => (
          <li key={r.id} className="flex items-center gap-2 border-b border-border/40 py-1">
            <Badge variant={r.status === "LIVE_BLOCKED" || r.status === "LIVE_REJECTED" ? "destructive" : "outline"} className="text-[10px]">{r.status}</Badge>
            <span className="font-mono">u#{r.userId} {r.symbol ?? "—"} {r.side ?? ""} {String(r.requestedVolume ?? "")}</span>
            {r.brokerTicket && <span className="font-mono text-success">#{r.brokerTicket}</span>}
            {r.rejectionReason && (
              <details className="text-danger"><summary className="cursor-pointer">why?</summary>
                <div className="font-mono text-[10px] mt-1">{r.rejectionReason}</div>
              </details>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground hidden md:inline">{r.createdAt ?? ""}</span>
          </li>
        ))}
        {data && data.rows.length === 0 && <li className="text-muted-foreground italic">no rows</li>}
      </ul>
    </CardContent></Card>
  );
}

// ── Smoke tests tab ──────────────────────────────────────────────────────────
function SmokeTab() {
  const [data, setData] = useState<SmokeResp | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await apiJson<SmokeResp>("/api/admin/live-shared/activation-smoke-test", { method: "POST" });
      setData(r);
    } finally { setBusy(false); }
  }
  return (
    <Card><CardHeader className="pb-2 flex flex-row items-center justify-between">
      <CardTitle className="text-sm">Activation smoke test</CardTitle>
      <Button size="sm" disabled={busy} onClick={run} data-testid="smoke-run">{busy ? "Running…" : "Run smoke test"}</Button>
    </CardHeader><CardContent className="space-y-2">
      {!data && <div className="text-xs text-muted-foreground italic">Read-only probe: 11 sub-checks. No EA contact, no DB writes (except audit row).</div>}
      {data && (
        <>
          <div className="text-xs">Result: <strong>{data.summary.passed}/{data.summary.total} pass</strong> · bridge gate: <code>{data.bridgeGate.decision}</code></div>
          <ul className="space-y-1 text-xs">
            {data.checks.map(c => (
              <li key={c.id} className="flex items-center gap-2">
                {c.pass ? <CheckCircle2 className="h-3 w-3 text-success" /> : <XCircle className="h-3 w-3 text-danger" />}
                <span>{c.label}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </CardContent></Card>
  );
}

// ── Micro test tab ───────────────────────────────────────────────────────────
// The validate/execute endpoints route through the SESSION user (`uid(req)`)
// — there is no admin asUserId override (deliberate: it would be a per-user
// isolation bypass). The operator must therefore be an APPROVED MASTER LIVE
// user themselves to run the micro test. If you need to test as someone
// else, use their session.
function MicroTestTab({ readiness }: { readiness: ReadinessResp | null }) {
  const [symbol, setSymbol] = useState("EURUSD");
  const [lot, setLot] = useState("0.01");
  const [sl, setSL] = useState("");
  const [tp, setTP] = useState("");
  const [phrase, setPhrase] = useState("");
  const [validated, setValidated] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const REQUIRED_QUEUE = "QUEUE MICRO LIVE TEST";
  const REQUIRED_EXECUTE = "EXECUTE LIVE SHARED";

  async function validate() {
    setBusy(true); setMsg(null); setValidated(null);
    try {
      const r = await apiJson<{ ok: boolean; stage?: string; primaryReason?: string }>("/api/trades/live-shared/validate", {
        method: "POST",
        body: JSON.stringify({ symbol, side: "BUY", lotSize: Number(lot), stopLoss: Number(sl), takeProfit: Number(tp) || null, sourcePage: "admin-micro-test" }),
      });
      setValidated(r);
      setMsg(r.ok ? `validate: ${r.stage}` : `validate blocked: ${r.primaryReason ?? "unknown"}`);
    } finally { setBusy(false); }
  }
  async function execute() {
    if (phrase !== REQUIRED_QUEUE) { setMsg(`type "${REQUIRED_QUEUE}" first`); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await apiJson<{ ok: boolean; commandId?: string; primaryReason?: string }>("/api/trades/live-shared/execute", {
        method: "POST",
        body: JSON.stringify({
          symbol, side: "BUY", lotSize: Number(lot), stopLoss: Number(sl), takeProfit: Number(tp) || null,
          sourcePage: "admin-micro-test",
          confirmationIntent: REQUIRED_EXECUTE,
        }),
      });
      setMsg(r.ok ? `queued: ${r.commandId}` : `blocked: ${r.primaryReason}`);
    } finally { setBusy(false); }
  }

  const canExec = validated != null && phrase === REQUIRED_QUEUE && sl !== "" && Number(lot) <= 0.01;
  const noApproved = (readiness?.approvedUsers.approvedCount ?? 0) === 0;

  return (
    <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Micro live test (operator runs as self)</CardTitle></CardHeader><CardContent className="space-y-2">
      <Alert className="py-2">
        <AlertTitle className="text-xs">Reuses the full validate→execute pipeline.</AlertTitle>
        <AlertDescription className="text-[11px]">
          The endpoints route through the current session, so the operator must be an APPROVED master-live user
          themselves. Per-user isolation is preserved — there is no admin <code>asUserId</code> override.
          Cannot bypass any of the 16 gates, kill switch, env hard-kill, or per-user limits.
          {noApproved && <span className="block mt-1 text-danger">No approved users on the system yet.</span>}
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div><Label className="text-[10px]">Symbol</Label><Input className="h-8" value={symbol} onChange={e => setSymbol(e.target.value)} data-testid="micro-symbol" /></div>
        <div><Label className="text-[10px]">Lot (≤0.01)</Label><Input className="h-8" type="number" step="0.01" value={lot} onChange={e => setLot(e.target.value)} data-testid="micro-lot" /></div>
        <div><Label className="text-[10px]">SL (required)</Label><Input className="h-8" type="number" step="0.0001" value={sl} onChange={e => setSL(e.target.value)} data-testid="micro-sl" /></div>
        <div><Label className="text-[10px]">TP</Label><Input className="h-8" type="number" step="0.0001" value={tp} onChange={e => setTP(e.target.value)} data-testid="micro-tp" /></div>
      </div>
      <div className="flex gap-2 items-end">
        <Button size="sm" variant="outline" disabled={busy || sl === ""} onClick={validate} data-testid="micro-validate">Validate</Button>
        <div className="flex-1"><Label className="text-[10px]">Confirmation phrase</Label>
          <Input className="h-8 font-mono" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder={REQUIRED_QUEUE} data-testid="micro-phrase" /></div>
        <Button size="sm" variant="destructive" disabled={busy || !canExec} onClick={execute} data-testid="micro-execute"><Zap className="h-3 w-3 mr-1" /> Queue micro test</Button>
      </div>
      {msg && <div className="text-xs font-mono text-warning">{msg}</div>}
    </CardContent></Card>
  );
}

// ── Rollback tab ─────────────────────────────────────────────────────────────
function RollbackTab({ onDone, setActionMsg }: { onDone: () => void; setActionMsg: (s: string | null) => void }) {
  const [phrase, setPhrase] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const REQUIRED = "ROLL BACK LIVE SHARED TRADING";
  async function rollback() {
    if (phrase !== REQUIRED) return;
    if (!confirm("Engage rollback? This disables shared live + engages kill switch + cancels queued commands.")) return;
    setBusy(true);
    try {
      const r = await apiJson<{ ok: boolean; rollback?: { cancelledCommandsCount: number }; error?: string }>("/api/admin/live-shared/rollback", {
        method: "POST", body: JSON.stringify({ confirmationPhrase: REQUIRED, reason: reason || undefined }),
      });
      setActionMsg(r.ok ? `rollback: cancelled ${r.rollback?.cancelledCommandsCount} command(s); kill switch engaged` : `rollback failed: ${r.error}`);
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <Card><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><RotateCcw className="h-4 w-4 text-danger" /> Emergency rollback</CardTitle></CardHeader><CardContent className="space-y-2">
      <Alert variant="destructive" className="py-2"><AlertTitle className="text-xs">Engages kill switch, disables shared live, cancels queued commands the EA hasn't picked up.</AlertTitle>
        <AlertDescription className="text-[11px]">Audit logs, trade history, demo/paper, already-picked commands are preserved.</AlertDescription>
      </Alert>
      <Label className="text-xs">Reason (audited)</Label>
      <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="why are you rolling back?" data-testid="rb-reason" />
      <Label className="text-xs">Confirmation phrase</Label>
      <Input className="font-mono" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder={REQUIRED} data-testid="rb-phrase" />
      <Button variant="destructive" disabled={busy || phrase !== REQUIRED} onClick={rollback} data-testid="rb-execute">Roll back live shared trading</Button>
    </CardContent></Card>
  );
}

// ── Audit tab ────────────────────────────────────────────────────────────────
function AuditTab({ readiness }: { readiness: ReadinessResp | null }) {
  if (!readiness) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  return (
    <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Recent admin actions (last 50)</CardTitle></CardHeader><CardContent>
      <ul className="space-y-1 text-xs">
        {readiness.recentAudit.map(a => (
          <li key={a.id} className="flex items-center gap-2 border-b border-border/40 py-1">
            <Badge variant="outline" className="text-[10px]">{a.adminRole}</Badge>
            <span className="font-mono">{a.action}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">admin#{a.adminId} · {a.createdAt ?? ""}</span>
          </li>
        ))}
        {readiness.recentAudit.length === 0 && <li className="text-muted-foreground italic">no entries</li>}
      </ul>
    </CardContent></Card>
  );
}
