// Phase 22V — Switch-based Live Shared cockpit (no typed phrases anywhere).
//   - Friendly labels in the main view (raw backend names are hidden behind
//     a collapsible "Technical details (advanced)" disclosure).
//   - Pin Current Master Bridge button is gated on a real EA heartbeat ≤15s.
//   - OWNER-only "First Live Test Mode" card sets safest per-user limits
//     (maxOpenLive=1, lot=0.01, SL required, EURUSD only, scanner OFF,
//     daily-loss cap $10) and is the only path that touches OWNER limits.
//   - Every switch goes through an AlertDialog confirm before POSTing
//     `{ confirm: true }` to the server. No typed phrases.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Shield, ShieldAlert, ShieldCheck, Activity, Users, Gauge, ListChecks,
  AlertTriangle, FileText, PlugZap, ChevronDown, ChevronRight, PinIcon,
} from "lucide-react";
import { ControlledLiveTestButton } from "@/components/live/ControlledLiveTestButton";

type Readiness = {
  ok: boolean;
  architecture: { model: string; summary: string; brokerCredentialsOnServer: boolean };
  globalSwitches: {
    serverMasterSwitchEnabled: boolean;
    serverMasterSwitchEnvOnly?: boolean;
    platformMode: string;
    liveEnabled: boolean;
    accountRoutingMode: string;
    sharedLiveTradingEnabled: boolean;
    masterBridgeLiveEnabled: boolean;
    complianceReviewFlag: boolean;
    emergencyKillSwitch: boolean;
    killSwitchEngagedAt: string | null;
    killSwitchReason: string | null;
    liveBrokerExecutionArmedDb?: boolean;
  };
  liveAccount: {
    pinnedBridge: null | {
      connectionId: number;
      mode: string;
      accountType: string | null;
      accountNumberMasked: string | null;
      brokerName: string | null;
      eaVersion: string | null;
      lastHeartbeatAt: string | null;
      heartbeatAgeSeconds: number | null;
      readOnlyMode: boolean | null;
      tokenRevokedAt: string | null;
    };
    detector: unknown;
    gate: { decision: string; primaryReason?: string | null } & Record<string, unknown>;
  };
  approvedUsers: {
    approvedCount: number;
    activeCount: number;
    rows: Array<{
      userId: number; email: string | null; approved: boolean;
      tradingEnabled: boolean; status: string | null;
      maxLot: string | number | null; maxOpenPositions: number | null;
      maxExposurePerSymbolLots: string | number | null;
      dailyLossLimitUsd: string | number | null;
      allowedSymbols: string[] | null; scannerLiveEnabled: boolean | null;
      approvedAt: string | null;
    }>;
  };
  openExposure: { totalOpenLots: number; totalFloatingPlUsd: number; openPositionsCount: number };
  recentCommands: Array<{
    id: number; userId: number; symbol: string; side: string;
    volume: number | string; status: string;
    blockReason: string | null; createdAt: string | null;
  }>;
  recentAudit: Array<{
    id: number; adminId: number | null; adminRole: string | null;
    action: string; createdAt: string | null;
  }>;
  arxLiveCommandsCount: number;
  requiredConfirmationPhrases?: { activate: string; killSwitch: string };
};

type DetectorResp = {
  ok?: boolean; detected?: boolean;
  bridge?: { heartbeatAgeSec?: number | null; eaVersion?: string | null };
  primaryReason?: string;
};

type FirstTestStatus = {
  ok: boolean; enabled: boolean; ownerRowExists?: boolean;
  current?: {
    maxOpenPositions: number | null;
    maxLot: number | string | null;
    allowedSymbols: string[] | null;
    requireStopLoss: boolean;
    scannerLiveEnabled: boolean;
    dailyLossLimitUsd: number | string | null;
    maxExposurePerSymbolLots: number | string | null;
  };
};

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} className="font-medium">
      {ok ? "✓ " : "✗ "}{label}
    </Badge>
  );
}

// ─── Confirm-action dialog primitive ─────────────────────────────────────────
function ConfirmActionDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, onConfirm, busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            disabled={busy}
            className={destructive ? "bg-destructive hover:bg-destructive/90" : undefined}
            data-testid="confirm-action-button"
          >
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── A single live switch (label + Switch + ConfirmDialog) ───────────────────
function LiveSwitch({
  testId, label, helper, checked, disabled, destructive,
  confirmTitle, confirmDesc, confirmLabel, onConfirm, busy,
}: {
  testId: string;
  label: string;
  helper?: string;
  checked: boolean;
  disabled?: boolean;
  destructive?: boolean;
  confirmTitle: string;
  confirmDesc: string;
  confirmLabel: string;
  onConfirm: (next: boolean) => void;
  busy?: boolean;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  return (
    <>
      <div className="flex items-start justify-between gap-3 py-2 border-b last:border-0">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {helper ? <div className="text-xs text-muted-foreground mt-0.5">{helper}</div> : null}
        </div>
        <Switch
          checked={checked}
          disabled={disabled || busy}
          onCheckedChange={(next) => setPending(next)}
          data-testid={testId}
        />
      </div>
      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={(o) => { if (!o) setPending(null); }}
        title={confirmTitle}
        description={confirmDesc}
        confirmLabel={confirmLabel}
        destructive={destructive}
        busy={busy}
        onConfirm={() => { if (pending !== null) { onConfirm(pending); setPending(null); } }}
      />
    </>
  );
}

export function LiveSharedAccountPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<Readiness>({
    queryKey: ["admin", "live-shared", "readiness"],
    queryFn: () => jget<Readiness>("/api/admin/live-shared/readiness"),
    refetchInterval: 15000,
  });

  const detectorQ = useQuery<DetectorResp>({
    queryKey: ["admin", "master-bridge", "current"],
    queryFn: () => jget<DetectorResp>("/api/admin/master-bridge/current"),
    refetchInterval: 5000,
  });

  const firstTestQ = useQuery<FirstTestStatus>({
    queryKey: ["admin", "live", "first-test-status"],
    queryFn: () => jget<FirstTestStatus>("/api/admin/live/first-live-test-mode/status"),
    refetchInterval: 15000,
    retry: false,
  });
  const ownerCanSeeFirstTest = firstTestQ.data?.ok === true; // 403 → undefined

  const [techOpen, setTechOpen] = useState(false);
  const [killReason, setKillReason] = useState("");
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmPin, setConfirmPin] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "live-shared", "readiness"] });
    void qc.invalidateQueries({ queryKey: ["admin", "master-bridge", "current"] });
    void qc.invalidateQueries({ queryKey: ["admin", "live", "first-test-status"] });
  };

  const activateMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      jpost<{ ok: boolean; error?: string; detail?: string }>(
        "/api/admin/live-shared/activate-step", { confirm: true, ...body }),
    onSuccess: (r) => { setActionMsg(r.ok ? "Applied." : `Failed: ${r.error ?? "unknown"}${r.detail ? " — " + r.detail : ""}`); invalidateAll(); },
  });
  const killMut = useMutation({
    mutationFn: (reason: string) =>
      jpost<{ ok: boolean; error?: string }>(
        "/api/admin/live-shared/kill-switch", { confirm: true, reason }),
    onSuccess: (r) => { setActionMsg(r.ok ? "Kill switch engaged." : `Failed: ${r.error}`); invalidateAll(); },
  });
  const pinMut = useMutation({
    mutationFn: () =>
      jpost<{ ok: boolean; error?: string; detail?: string; heartbeatAgeSec?: number }>(
        "/api/admin/live/pin-master-bridge", { confirm: true }),
    onSuccess: (r) => { setActionMsg(r.ok ? `Pinned. Heartbeat ${r.heartbeatAgeSec ?? "?"}s.` : `Failed: ${r.error}${r.detail ? " — " + r.detail : ""}`); invalidateAll(); },
  });
  const firstTestMut = useMutation({
    mutationFn: (enabled: boolean) =>
      jpost<{ ok: boolean; error?: string; applied?: unknown }>(
        "/api/admin/live/first-live-test-mode", { confirm: true, enabled }),
    onSuccess: (r) => { setActionMsg(r.ok ? "First Live Test Mode updated." : `Failed: ${r.error}`); invalidateAll(); },
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading live shared readiness…</div>;
  if (error || !data?.ok)
    return (
      <Alert variant="destructive" className="m-6">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Failed to load</AlertTitle>
        <AlertDescription>{String((error as Error)?.message ?? "unknown")}</AlertDescription>
      </Alert>
    );

  const g = data.globalSwitches;
  const isLive =
    g.serverMasterSwitchEnabled && g.platformMode === "LIVE" &&
    g.accountRoutingMode === "SHARED_MASTER_MT5" &&
    g.sharedLiveTradingEnabled && g.masterBridgeLiveEnabled && !g.emergencyKillSwitch;

  const hbAge = detectorQ.data?.bridge?.heartbeatAgeSec ?? null;
  const detectorFresh = hbAge != null && hbAge <= 15 && detectorQ.data?.ok === true;
  const detectorReason = detectorQ.data?.primaryReason ?? null;

  const busyAny = activateMut.isPending || killMut.isPending || pinMut.isPending || firstTestMut.isPending;

  return (
    <div className="p-3 md:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold flex items-center gap-2">
            {isLive ? <ShieldCheck className="h-6 w-6 text-success" /> : <Shield className="h-6 w-6 text-muted-foreground" />}
            Live Shared Account
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Operator-funded shared master MT5 — kill-switch operator: <span className="font-medium">Draie</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge variant={isLive ? "default" : "secondary"} className="text-sm">
            {isLive ? "Live trading: Active" : "Live trading: Not active"}
          </Badge>
          <Badge variant="outline" className="text-xs">
            Pending commands: {data.arxLiveCommandsCount}
          </Badge>
        </div>
      </div>

      <Alert>
        <PlugZap className="h-4 w-4" />
        <AlertTitle>Architecture: EA-pull (broker credentials never on the server)</AlertTitle>
        <AlertDescription className="text-xs">{data.architecture.summary}</AlertDescription>
      </Alert>

      {actionMsg && (
        <Alert>
          <AlertTitle className="text-xs">{actionMsg}</AlertTitle>
        </Alert>
      )}

      <Tabs defaultValue="account" className="w-full">
        {/* Mobile: Select dropdown. Desktop (md+): tabs row. */}
        <div className="md:hidden mb-2">
          <Select defaultValue="account" onValueChange={(v) => {
            const el = document.querySelector(`[data-tab-value="${v}"]`) as HTMLElement | null;
            el?.click();
          }}>
            <SelectTrigger data-testid="mobile-tabs-select">
              <SelectValue placeholder="Choose a tab" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="account">Live Account</SelectItem>
              <SelectItem value="users">Approved Users</SelectItem>
              <SelectItem value="bridge">Bridge Health</SelectItem>
              <SelectItem value="risk">Risk Limits</SelectItem>
              <SelectItem value="trades">Open Trades</SelectItem>
              <SelectItem value="kill">Kill Switch</SelectItem>
              <SelectItem value="audit">Audit Log</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <TabsList className="hidden md:grid md:grid-cols-7 w-full">
          <TabsTrigger value="account" data-tab-value="account"><Activity className="h-4 w-4 mr-1" />Live Account</TabsTrigger>
          <TabsTrigger value="users" data-tab-value="users"><Users className="h-4 w-4 mr-1" />Approved Users</TabsTrigger>
          <TabsTrigger value="bridge" data-tab-value="bridge"><PlugZap className="h-4 w-4 mr-1" />Bridge Health</TabsTrigger>
          <TabsTrigger value="risk" data-tab-value="risk"><Gauge className="h-4 w-4 mr-1" />Risk Limits</TabsTrigger>
          <TabsTrigger value="trades" data-tab-value="trades"><ListChecks className="h-4 w-4 mr-1" />Open Trades</TabsTrigger>
          <TabsTrigger value="kill" data-tab-value="kill"><ShieldAlert className="h-4 w-4 mr-1" />Kill Switch</TabsTrigger>
          <TabsTrigger value="audit" data-tab-value="audit"><FileText className="h-4 w-4 mr-1" />Audit</TabsTrigger>
        </TabsList>

        {/* ── Live Account ────────────────────────────────────────────── */}
        <TabsContent value="account" className="space-y-4">
          {/* Pin Master Bridge card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><PinIcon className="h-4 w-4" /> Pin current master bridge</CardTitle>
              <CardDescription>
                Persist the currently-detected live EA bridge as the platform master.
                Requires a real EA heartbeat within the last 15 seconds.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.liveAccount.pinnedBridge ? (
                <div className="text-xs">
                  Currently pinned: <span className="font-medium">connection #{data.liveAccount.pinnedBridge.connectionId}</span>
                  {" "}· broker {data.liveAccount.pinnedBridge.brokerName ?? "—"}
                  {" "}· EA v{data.liveAccount.pinnedBridge.eaVersion ?? "—"}
                  {" "}· last heartbeat {data.liveAccount.pinnedBridge.heartbeatAgeSeconds ?? "—"}s ago
                </div>
              ) : (
                <Alert variant="destructive">
                  <AlertTitle>No master bridge pinned yet</AlertTitle>
                  <AlertDescription className="text-xs">
                    Attach the MT5 EA v1.27 to your LIVE master chart and confirm a heartbeat appears below before pinning.
                  </AlertDescription>
                </Alert>
              )}
              <div className="text-xs flex items-center gap-2">
                <span className="text-muted-foreground">Detector heartbeat:</span>
                <Badge variant={detectorFresh ? "default" : "destructive"} data-testid="detector-heartbeat-badge">
                  {hbAge == null ? "no heartbeat" : `${hbAge}s old`}
                </Badge>
                {!detectorFresh && detectorReason && <span className="text-xs text-muted-foreground">({detectorReason})</span>}
              </div>
              <Button
                variant="default"
                disabled={!detectorFresh || pinMut.isPending}
                onClick={() => setConfirmPin(true)}
                data-testid="pin-master-bridge-button"
              >
                {pinMut.isPending ? "Pinning…" : "Pin current master bridge"}
              </Button>
              {!detectorFresh && (
                <div className="text-xs text-muted-foreground">
                  Button enables automatically once a live EA heartbeat (≤15s) is detected.
                </div>
              )}
              <ConfirmActionDialog
                open={confirmPin}
                onOpenChange={setConfirmPin}
                title="Pin current master bridge?"
                description={`This writes the detected live bridge as the platform master in global_trading_settings. Heartbeat: ${hbAge ?? "?"}s. An audit row is recorded.`}
                confirmLabel="Pin bridge"
                busy={pinMut.isPending}
                onConfirm={() => { setConfirmPin(false); pinMut.mutate(); }}
              />
            </CardContent>
          </Card>

          {/* Activation switches card — friendly labels */}
          <Card>
            <CardHeader>
              <CardTitle>Activation switches</CardTitle>
              <CardDescription>
                Each switch is an atomic, audited change. Default-deny is preserved at every layer.
                Broker execution must additionally be armed by the operator before any live order can be sent.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {/* Friendly pills — env permission vs operator arm vs effective surfaced separately */}
              {(() => {
                // Env permission = env var value ONLY (true source).
                // Operator arm = DB switch toggled by an operator.
                // Effective = env AND operator (matches backend resolver since
                // the Phase 22V QA tightening flipped resolveLiveBrokerExecutionEnabled
                // from OR to AND; UI now mirrors backend truth 1:1).
                const envOk = g.serverMasterSwitchEnvOnly === true;
                const opArm = g.liveBrokerExecutionArmedDb === true;
                const effective = g.serverMasterSwitchEnabled === true; // backend-resolved (env AND op)
                return (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                      <StatusPill ok={envOk} label={envOk ? "Broker execution permission: Allowed" : "Broker execution permission: Blocked"} />
                      <StatusPill ok={opArm} label={opArm ? "Operator broker execution: On" : "Operator broker execution: Off"} />
                      <StatusPill ok={effective} label={effective ? "Effective broker execution: Enabled" : "Effective broker execution: Disabled"} />
                      <StatusPill ok={!g.emergencyKillSwitch} label={g.emergencyKillSwitch ? "Kill switch: engaged" : "Kill switch: released"} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                      <StatusPill ok={g.platformMode === "LIVE"} label={g.platformMode === "LIVE" ? "Trading mode: Live" : "Trading mode: Demo"} />
                      <StatusPill ok={g.accountRoutingMode === "SHARED_MASTER_MT5"} label={g.accountRoutingMode === "SHARED_MASTER_MT5" ? "Routing: Shared master" : "Routing: User-owned"} />
                      <StatusPill ok={g.sharedLiveTradingEnabled} label={g.sharedLiveTradingEnabled ? "Shared live trading: On" : "Shared live trading: Off"} />
                      <StatusPill ok={g.masterBridgeLiveEnabled} label={g.masterBridgeLiveEnabled ? "Master bridge: Live" : "Master bridge: Off"} />
                      <StatusPill ok={detectorFresh} label={detectorFresh ? `Heartbeat: Fresh (${hbAge ?? "?"}s)` : "Heartbeat: Stale / missing"} />
                      <StatusPill ok={firstTestQ.data?.enabled === true} label={firstTestQ.data?.enabled === true ? "First Live Test Mode: On" : "First Live Test Mode: Off"} />
                    </div>
                  </>
                );
              })()}
              <Separator />

              <LiveSwitch
                testId="switch-routing-shared"
                label="Route trades through the shared master bridge"
                helper="Sends user orders through the operator-funded master MT5 instead of per-user bridges."
                checked={g.accountRoutingMode === "SHARED_MASTER_MT5"}
                busy={activateMut.isPending}
                confirmTitle="Switch routing?"
                confirmDesc="This changes accountRoutingMode in global_trading_settings and writes an audit row."
                confirmLabel="Switch routing"
                onConfirm={(next) => activateMut.mutate({ accountRoutingMode: next ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5" })}
              />
              <LiveSwitch
                testId="switch-master-bridge-live"
                label="Enable master bridge in LIVE mode"
                helper="Allows the platform to forward live commands to the pinned master bridge."
                checked={g.masterBridgeLiveEnabled}
                busy={activateMut.isPending}
                confirmTitle="Toggle master bridge LIVE?"
                confirmDesc="This sets masterBridgeLiveEnabled and writes an audit row."
                confirmLabel="Confirm"
                onConfirm={(next) => activateMut.mutate({ masterBridgeLiveEnabled: next })}
              />
              <LiveSwitch
                testId="switch-shared-live-trading"
                label="Enable shared live trading platform-wide"
                helper="Master switch for the shared live trading workflow across all approved users."
                checked={g.sharedLiveTradingEnabled}
                busy={activateMut.isPending}
                confirmTitle="Toggle shared live trading?"
                confirmDesc="This sets sharedLiveTradingEnabled and writes an audit row."
                confirmLabel="Confirm"
                onConfirm={(next) => activateMut.mutate({ sharedLiveTradingEnabled: next })}
              />
              <LiveSwitch
                testId="switch-platform-mode-live"
                label="Set platform trading mode to LIVE"
                helper="Switches the global trading mode from Demo to Live. Only takes effect alongside the switches above."
                checked={g.platformMode === "LIVE"}
                destructive
                busy={activateMut.isPending}
                confirmTitle="Switch platform to LIVE?"
                confirmDesc="The Phase B 16-gate evaluator will still block any dispatch where a single gate fails. Audit row is written."
                confirmLabel="Switch to LIVE"
                onConfirm={(next) => activateMut.mutate({ platformMode: next ? "LIVE" : "DEMO", liveEnabled: next })}
              />
              <LiveSwitch
                testId="switch-release-kill"
                label="Release emergency kill switch"
                helper="Re-allows live dispatch once the conditions that triggered the kill have been resolved."
                checked={!g.emergencyKillSwitch}
                disabled={!g.emergencyKillSwitch}
                busy={activateMut.isPending}
                confirmTitle="Release kill switch?"
                confirmDesc="This clears emergencyKillSwitch in global_trading_settings and writes an audit row. The 16-gate evaluator still applies on every dispatch."
                confirmLabel="Release"
                onConfirm={() => activateMut.mutate({ releaseKillSwitch: true })}
              />

              <Separator className="my-3" />

              {/* Collapsible technical details — admin-only, hides raw labels by default */}
              <button
                type="button"
                onClick={() => setTechOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="technical-details-toggle"
              >
                {techOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Technical details (advanced)
              </button>
              {techOpen && (
                <div className="mt-2 rounded bg-muted/40 p-3 text-xs space-y-1 font-mono">
                  <div>platformMode = <span className="font-semibold">{g.platformMode}</span></div>
                  <div>liveEnabled = <span className="font-semibold">{String(g.liveEnabled)}</span></div>
                  <div>accountRoutingMode = <span className="font-semibold">{g.accountRoutingMode}</span></div>
                  <div>sharedLiveTradingEnabled = <span className="font-semibold">{String(g.sharedLiveTradingEnabled)}</span></div>
                  <div>masterBridgeLiveEnabled = <span className="font-semibold">{String(g.masterBridgeLiveEnabled)}</span></div>
                  <div>emergencyKillSwitch = <span className="font-semibold">{String(g.emergencyKillSwitch)}</span></div>
                  <div className="pt-1 text-muted-foreground">
                    ARX_LIVE_BROKER_EXECUTION_ENABLED (env permission, true source) = <span className="font-semibold">{String(g.serverMasterSwitchEnvOnly ?? false)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    serverMasterSwitchEnabled (effective, env AND operator) = <span className="font-semibold">{String(g.serverMasterSwitchEnabled)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    liveBrokerExecutionArmed (DB operator switch) = <span className="font-semibold">{String(g.liveBrokerExecutionArmedDb ?? false)}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground pt-1">
                    Raw flag names shown for diagnostic purposes only. Use the switches above to mutate.
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* OWNER unrestricted live profile banner — visible when the
              signed-in OWNER currently has the unrestricted profile
              assigned. Reassures the OWNER that caps are intentionally
              waived for their own account while all real safety gates
              (16-gate, kill switch, master switch, bridge heartbeat,
              manual confirmation, audit) remain active. */}
          <OwnerUnrestrictedLiveBanner />

          {/* OWNER-only First Live Test Mode card */}
          {ownerCanSeeFirstTest && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-success" />
                  First Live Test Mode (OWNER only)
                </CardTitle>
                <CardDescription>
                  Locks the OWNER account to the safest possible limits before the first ever live test:
                  max 1 open position, 0.01 lot, EURUSD only, SL required, scanner OFF, $10 daily-loss cap.
                  This does <strong>not</strong> place any trade.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <LiveSwitch
                  testId="switch-first-live-test-mode"
                  label="Enable First Live Test Mode (OWNER account)"
                  helper="Forces auto-trade OFF, one-click OFF, auto-close ALERT_ONLY. Tightens OWNER limits only — never widens them automatically."
                  checked={firstTestQ.data?.enabled === true}
                  busy={firstTestMut.isPending}
                  confirmTitle="Enable First Live Test Mode?"
                  confirmDesc="Sets maxOpenPositions=1, maxLot=0.01, allowedSymbols=['EURUSD'], requireStopLoss=true, scannerLiveEnabled=false, dailyLossLimitUsd=10. No trade is placed."
                  confirmLabel="Apply safest limits"
                  onConfirm={(next) => firstTestMut.mutate(next)}
                />
                {firstTestQ.data?.current && (
                  <div className="text-xs grid grid-cols-2 gap-1 font-mono bg-muted/30 rounded p-2">
                    <div>Max open positions</div><div>{String(firstTestQ.data.current.maxOpenPositions ?? "—")}</div>
                    <div>Max lot</div><div>{String(firstTestQ.data.current.maxLot ?? "—")}</div>
                    <div>Allowed symbols</div><div>{(firstTestQ.data.current.allowedSymbols ?? []).join(", ") || "—"}</div>
                    <div>SL required</div><div>{String(firstTestQ.data.current.requireStopLoss)}</div>
                    <div>Scanner live</div><div>{String(firstTestQ.data.current.scannerLiveEnabled)}</div>
                    <div>Daily loss cap (USD)</div><div>{String(firstTestQ.data.current.dailyLossLimitUsd ?? "—")}</div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* OWNER-only Live Test Cycle — single-shot 0.01 EURUSD live
              verification. Gated on the same OWNER-only signal as First
              Live Test Mode (the backend status endpoint returns 403 for
              non-OWNER and downgrades under admin-previewing-as-user), so
              regular users and preview sessions never see it. The panel's
              own /api/me/live/test-cycle/* endpoints are independently
              OWNER-only server-side. Symbol & lot are server-pinned. */}
          {ownerCanSeeFirstTest && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-danger" />
                  Live Test Cycle (OWNER only)
                </CardTitle>
                <CardDescription>
                  Runs a single real 0.01 EURUSD live order through the
                  shared master bridge, then automatically closes it. Requires
                  an explicit Preview → Confirm. No trade is placed until you
                  confirm.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ControlledLiveTestButton />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Approved Users ───────────────────────────────────────────── */}
        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Approved Users ({data.approvedUsers.approvedCount} approved · {data.approvedUsers.activeCount} active)</CardTitle>
              <CardDescription>
                Per-user master-live access (approval, allocation, risk caps).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.approvedUsers.rows.length === 0 ? (
                <div className="text-sm text-muted-foreground">No approved users yet.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead><TableHead>Status</TableHead>
                      <TableHead>Max Lot</TableHead><TableHead>Max Open</TableHead>
                      <TableHead>Max Exposure/Sym</TableHead><TableHead>Daily Loss</TableHead>
                      <TableHead>Scanner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.approvedUsers.rows.map((u) => (
                      <TableRow key={u.userId}>
                        <TableCell className="font-mono text-xs">#{u.userId} · {u.email ?? "–"}</TableCell>
                        <TableCell>
                          <Badge variant={u.tradingEnabled ? "default" : "secondary"}>
                            {u.tradingEnabled ? "TRADING" : u.approved ? "APPROVED" : "PENDING"}
                          </Badge>
                        </TableCell>
                        <TableCell>{String(u.maxLot ?? "–")}</TableCell>
                        <TableCell>{u.maxOpenPositions ?? "–"}</TableCell>
                        <TableCell>{String(u.maxExposurePerSymbolLots ?? "–")}</TableCell>
                        <TableCell>{String(u.dailyLossLimitUsd ?? "–")}</TableCell>
                        <TableCell>
                          <Badge variant={u.scannerLiveEnabled ? "default" : "outline"} className="text-xs">
                            {u.scannerLiveEnabled ? "ON" : "OFF"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Bridge Health ────────────────────────────────────────────── */}
        <TabsContent value="bridge" className="space-y-4">
          <SharedBridgePoolCard />
          <Card>
            <CardHeader><CardTitle>Master Bridge Gate</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={data.liveAccount.gate.decision === "PASS" ? "default" : "destructive"}>
                  {data.liveAccount.gate.decision}
                </Badge>
                {data.liveAccount.gate.primaryReason
                  ? <span className="text-xs text-muted-foreground">{data.liveAccount.gate.primaryReason}</span>
                  : null}
              </div>
              {data.liveAccount.pinnedBridge ? (
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div className="text-muted-foreground">Account #</div><div>{data.liveAccount.pinnedBridge.accountNumberMasked ?? "–"}</div>
                  <div className="text-muted-foreground">Broker</div><div>{data.liveAccount.pinnedBridge.brokerName ?? "–"}</div>
                  <div className="text-muted-foreground">EA Version</div><div>{data.liveAccount.pinnedBridge.eaVersion ?? "–"}</div>
                  <div className="text-muted-foreground">Heartbeat age</div><div>{data.liveAccount.pinnedBridge.heartbeatAgeSeconds ?? "–"}s</div>
                  <div className="text-muted-foreground">Read-only mode</div><div>{String(data.liveAccount.pinnedBridge.readOnlyMode)}</div>
                </div>
              ) : <div className="text-xs text-muted-foreground">No bridge pinned.</div>}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Risk Limits ──────────────────────────────────────────────── */}
        <TabsContent value="risk" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Aggregate Risk Snapshot</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-3 gap-4">
              <div><div className="text-xs text-muted-foreground">Open lots</div><div className="text-2xl font-mono">{data.openExposure.totalOpenLots.toFixed(2)}</div></div>
              <div><div className="text-xs text-muted-foreground">Open positions</div><div className="text-2xl font-mono">{data.openExposure.openPositionsCount}</div></div>
              <div><div className="text-xs text-muted-foreground">Floating P/L (USD)</div>
                <div className={`text-2xl font-mono ${data.openExposure.totalFloatingPlUsd < 0 ? "text-danger" : "text-success"}`}>
                  {data.openExposure.totalFloatingPlUsd.toFixed(2)}
                </div></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Open Trades / Recent Commands ───────────────────────────── */}
        <TabsContent value="trades" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Recent Live Commands</CardTitle></CardHeader>
            <CardContent>
              {data.recentCommands.length === 0 ? (
                <div className="text-sm text-muted-foreground">No live commands. Pipeline is dormant.</div>
              ) : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>ID</TableHead><TableHead>User</TableHead><TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead><TableHead>Vol</TableHead><TableHead>Status</TableHead>
                    <TableHead>Block reason</TableHead><TableHead>Created</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.recentCommands.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono text-xs">{c.id}</TableCell>
                        <TableCell className="font-mono text-xs">#{c.userId}</TableCell>
                        <TableCell>{c.symbol}</TableCell><TableCell>{c.side}</TableCell>
                        <TableCell>{String(c.volume)}</TableCell>
                        <TableCell>
                          <Badge variant={c.status === "LIVE_FILLED" ? "default" : c.status.startsWith("LIVE_BLOCKED") ? "destructive" : "secondary"}>{c.status}</Badge>
                        </TableCell>
                        <TableCell className="text-xs">{c.blockReason ?? "–"}</TableCell>
                        <TableCell className="text-xs">{c.createdAt ?? "–"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Kill Switch ──────────────────────────────────────────────── */}
        <TabsContent value="kill" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-danger flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" /> Emergency kill switch
              </CardTitle>
              <CardDescription>
                Immediately halts all live dispatch and disables the shared posture. Audit row is written.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm">
                Current state: <Badge variant={g.emergencyKillSwitch ? "destructive" : "default"}>
                  {g.emergencyKillSwitch ? "ENGAGED" : "Released"}
                </Badge>
                {g.killSwitchReason && <span className="ml-2 text-xs text-muted-foreground">— {g.killSwitchReason}</span>}
              </div>
              <Label htmlFor="kill-reason" className="text-xs">Reason (recorded in audit log)</Label>
              <input
                id="kill-reason" className="w-full px-3 py-2 border rounded text-sm"
                value={killReason} onChange={(e) => setKillReason(e.target.value)}
                placeholder="Reason for engaging the kill switch"
                data-testid="kill-reason-input"
              />
              <Button
                variant="destructive" disabled={busyAny || g.emergencyKillSwitch}
                onClick={() => setConfirmKill(true)} data-testid="engage-kill-button"
              >
                Engage kill switch
              </Button>
              <ConfirmActionDialog
                open={confirmKill} onOpenChange={setConfirmKill}
                title="Engage emergency kill switch?"
                description="Halts all live dispatch immediately, disables shared posture, and writes an audit row. Demo/paper paths untouched."
                confirmLabel="Engage kill switch"
                destructive
                busy={killMut.isPending}
                onConfirm={() => { setConfirmKill(false); killMut.mutate(killReason || "operator engaged via switch"); }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Audit ────────────────────────────────────────────────────── */}
        <TabsContent value="audit" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Recent admin actions</CardTitle></CardHeader>
            <CardContent>
              {data.recentAudit.length === 0 ? (
                <div className="text-sm text-muted-foreground">No audit rows yet.</div>
              ) : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>ID</TableHead><TableHead>Admin</TableHead>
                    <TableHead>Action</TableHead><TableHead>When</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.recentAudit.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono text-xs">{a.id}</TableCell>
                        <TableCell className="font-mono text-xs">#{a.adminId ?? "—"} ({a.adminRole ?? "—"})</TableCell>
                        <TableCell className="font-mono text-xs">{a.action}</TableCell>
                        <TableCell className="text-xs">{a.createdAt ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// OWNER unrestricted live profile banner. Renders only when the signed-in
// user currently has the "Owner Unrestricted Live" risk template assigned.
// Communicates the exact safety contract: caps are intentionally waived,
// but EVERY other safety gate remains active.
function OwnerUnrestrictedLiveBanner() {
  const q = useQuery<{ ok: boolean; isOwnerUnrestricted: boolean; templateName: string | null }>({
    queryKey: ["me", "live", "profile"],
    queryFn: async () => (await fetch("/api/me/live/profile", { credentials: "include" })).json(),
    staleTime: 30_000,
  });
  if (!q.data?.ok || !q.data.isOwnerUnrestricted) return null;
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <ShieldAlert className="h-4 w-4 text-warning" />
      <AlertTitle className="text-warning">Owner unrestricted live profile active</AlertTitle>
      <AlertDescription className="text-xs">
        Active risk template: <strong>{q.data.templateName}</strong>.
        App-level caps (symbol allowlist, per-symbol lot, daily-loss USD,
        SL/TP requirement) are not enforced on your account.
        <span className="block mt-1">
          Still enforced on every live order: the 16-gate Phase B evaluator,
          kill switch, server master switch, bridge heartbeat ≤15s,
          EA-side flags, account-type=real check, manual confirmation,
          idempotency, audit log, per-user isolation.
        </span>
      </AlertDescription>
    </Alert>
  );
}

// ── Shared Bridge Pool card (Task #1 admin reconciliation surface) ────────
// Shows the live MT5 master snapshot that backs every shared-live
// allocation: balance, equity, total allocated, available headroom,
// over-allocated flag, last EA heartbeat. Provides a "Recompute &
// Reconcile" button that calls POST /api/admin/allocations/recompute
// (audit-logged on the server). Read-only otherwise — no per-user
// allocation mutations live here.
type PoolSnapshot = {
  mt5Balance: number; mt5Equity: number;
  mt5FreeMargin?: number; mt5UsedMargin?: number;
  totalAllocated: number; totalReservedRisk?: number;
  totalUserUnrealizedPnl: number; allocationDeficit?: number;
  bridgeAvailability: string;
  bridgeMessage?: string; isOverAllocated: boolean;
  snapshotStatus?: string; snapshotAgeMs?: number | null;
  sharedLivePaused?: boolean; pausedReason?: string | null;
  masterCap?: number; available?: number;
  lastMt5SnapshotAt: string | null; recomputedAt: string | null;
};
function SharedBridgePoolCard() {
  const qc = useQueryClient();
  const q = useQuery<{ ok: boolean; pool: PoolSnapshot | null; reason?: string }>({
    queryKey: ["adminMasterPool"],
    queryFn: async () => {
      const r = await fetch("/api/admin/allocations/master-pool", { credentials: "include" });
      return r.json();
    },
    refetchInterval: 5000,
  });
  const recomputeMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/allocations/recompute", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      return r.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["adminMasterPool"] }),
  });
  const [confirmRecompute, setConfirmRecompute] = useState(false);
  const pool = q.data?.pool ?? null;
  const cap = pool ? Math.min(pool.mt5Balance, pool.mt5Equity) : 0;
  const available = pool ? Math.max(0, cap - pool.totalAllocated) : 0;
  return (
    <Card data-testid="shared-bridge-pool-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4" /> Shared Bridge Pool
          {pool && (
            <Badge variant={pool.bridgeAvailability === "HEALTHY" ? "default"
              : pool.bridgeAvailability === "RECONCILING" ? "secondary" : "destructive"}>
              {pool.bridgeAvailability}
            </Badge>
          )}
          {pool?.isOverAllocated && <Badge variant="destructive">OVER-ALLOCATED</Badge>}
        </CardTitle>
        <CardDescription>
          MT5 master balance is the source of truth. Cap = min(balance, equity).
          Strict Real-Balance Mode; prop-firm over-allocation is disabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!pool ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>No master pool snapshot</AlertTitle>
            <AlertDescription className="text-xs">
              {q.data?.reason ?? "Waiting for an EA heartbeat from the pinned master."}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><div className="text-xs text-muted-foreground">Balance</div>
              <div className="text-xl font-mono">${pool.mt5Balance.toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Equity</div>
              <div className="text-xl font-mono">${pool.mt5Equity.toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Total allocated</div>
              <div className="text-xl font-mono">${pool.totalAllocated.toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Available</div>
              <div className={`text-xl font-mono ${pool.isOverAllocated ? "text-danger" : "text-success"}`}>
                ${available.toFixed(2)}
              </div></div>
            <div><div className="text-xs text-muted-foreground">Free margin</div>
              <div className="font-mono">${(pool.mt5FreeMargin ?? 0).toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Used margin</div>
              <div className="font-mono">${(pool.mt5UsedMargin ?? 0).toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Total reserved risk</div>
              <div className="font-mono">${(pool.totalReservedRisk ?? 0).toFixed(2)}</div></div>
            <div><div className="text-xs text-muted-foreground">Allocation deficit</div>
              <div className={`font-mono ${(pool.allocationDeficit ?? 0) > 0 ? "text-danger" : ""}`}>
                ${(pool.allocationDeficit ?? 0).toFixed(2)}
              </div></div>
            <div><div className="text-xs text-muted-foreground">Floating P/L (users)</div>
              <div className={`font-mono ${pool.totalUserUnrealizedPnl < 0 ? "text-danger" : "text-success"}`}>
                ${pool.totalUserUnrealizedPnl.toFixed(2)}
              </div></div>
            <div><div className="text-xs text-muted-foreground">Snapshot</div>
              <Badge variant={pool.snapshotStatus === "FRESH" ? "default"
                : pool.snapshotStatus === "STALE" ? "secondary" : "destructive"} className="text-xs">
                {pool.snapshotStatus ?? "–"}
                {pool.snapshotAgeMs != null && ` · ${Math.round(pool.snapshotAgeMs/1000)}s`}
              </Badge></div>
            <div className="col-span-2"><div className="text-xs text-muted-foreground">Last MT5 snapshot</div>
              <div className="font-mono text-xs">{pool.lastMt5SnapshotAt ?? "–"}</div></div>
          </div>
        )}
        {pool?.isOverAllocated && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Master is over-allocated</AlertTitle>
            <AlertDescription className="text-xs">
              Allocated ${pool.totalAllocated.toFixed(2)} exceeds master cap
              ${(pool.masterCap ?? Math.min(pool.mt5Balance, pool.mt5Equity)).toFixed(2)}.
              New shared-live entries are refused until allocations are
              proportionally reduced or shared-live is paused.
            </AlertDescription>
          </Alert>
        )}
        {pool?.sharedLivePaused && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Shared-live is paused</AlertTitle>
            <AlertDescription className="text-xs">
              Reason: {pool.pausedReason ?? "—"}. Existing open positions
              remain. Resume when reconciled.
            </AlertDescription>
          </Alert>
        )}
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            Recompute reconciles per-user reservedRisk from open positions and
            refreshes the pool snapshot. Audit-logged.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm" variant="outline"
              disabled={recomputeMut.isPending}
              onClick={() => setConfirmRecompute(true)}
              data-testid="btn-recompute-pool">
              {recomputeMut.isPending ? "Recomputing…" : "Recompute & Reconcile"}
            </Button>
            <ConfirmActionDialog
              open={confirmRecompute}
              onOpenChange={setConfirmRecompute}
              title="Recompute & reconcile the master pool?"
              description="Re-reads the MT5 master snapshot, reconciles per-user reservedRisk against open positions, and refreshes the pool row. Audit-logged. Does not change allocations or close positions."
              confirmLabel="Recompute"
              busy={recomputeMut.isPending}
              onConfirm={() => { setConfirmRecompute(false); recomputeMut.mutate(); }}
            />
            <SharedLivePauseResumeButton
              paused={pool?.sharedLivePaused === true}
              onDone={() => qc.invalidateQueries({ queryKey: ["adminMasterPool"] })}
            />
            <ProportionalReduceButton
              currentTotal={pool?.totalAllocated ?? 0}
              masterCap={pool?.masterCap ?? (pool ? Math.min(pool.mt5Balance, pool.mt5Equity) : 0)}
              onDone={() => qc.invalidateQueries({ queryKey: ["adminMasterPool"] })}
            />
            <SingleUserReduceButton
              onDone={() => qc.invalidateQueries({ queryKey: ["adminMasterPool"] })}
            />
            <ViewPoolJsonButton pool={pool} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Reduce a single user's allocation ─────────────────────────────────────
// Confirm-gated dialog that posts to /api/admin/allocations/:userId/reduce.
// Loads the current allocations list to populate the user picker so admins
// never have to type a userId by hand. Backend enforces lower-only and
// open-exposure rules; UI shows the typed failure reason verbatim.
type AllocListResp = {
  ok: boolean;
  users: Array<{
    userId: number; email: string | null;
    totalAllocation: number;
    realizedPnl?: number;
    unrealizedPnl?: number;
    openPositionsCount?: number;
  }>;
};
function SingleUserReduceButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState<string>("");
  const [newTotal, setNewTotal] = useState<string>("");
  const [reason, setReason] = useState("");
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const listQ = useQuery<AllocListResp>({
    queryKey: ["adminAllocationsList"],
    queryFn: () => jget<AllocListResp>("/api/admin/allocations"),
    enabled: open,
  });
  const selected = listQ.data?.users.find((u) => String(u.userId) === userId) ?? null;
  const mut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/allocations/${userId}/reduce`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newTotal: Number(newTotal), reason: reason || "operator-single-user-reduce" }),
      });
      return r.json() as Promise<{ ok: boolean; error?: string; message?: string }>;
    },
    onSuccess: (r) => {
      if (r.ok) {
        setResultMsg("Reduced.");
        setOpen(false);
        setUserId(""); setNewTotal(""); setReason("");
        onDone();
      } else {
        setResultMsg(`${r.error ?? "FAILED"}${r.message ? " — " + r.message : ""}`);
      }
    },
  });
  const newTotalNum = Number(newTotal);
  const validNumber = newTotal !== "" && Number.isFinite(newTotalNum) && newTotalNum >= 0;
  const isLower = selected ? validNumber && newTotalNum < selected.totalAllocation : false;
  // Mirror the backend USER_HAS_OPEN_EXPOSURE rule so admins see the warning
  // BEFORE clicking Confirm. Backend remains the source of truth.
  const openCount = selected?.openPositionsCount ?? 0;
  const floatingPl = selected?.unrealizedPnl ?? 0;
  const realizedPl = selected?.realizedPnl ?? 0;
  const coveredFloor = selected ? selected.totalAllocation - realizedPl : 0;
  const wouldStrandExposure = !!selected && validNumber && openCount > 0 && newTotalNum < coveredFloor;
  const plColor = floatingPl > 0 ? "text-success" : floatingPl < 0 ? "text-danger" : "";
  return (
    <AlertDialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) { setResultMsg(null); }
    }}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="btn-reduce-single-user">
        Reduce single user
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reduce one user's allocation?</AlertDialogTitle>
          <AlertDialogDescription>
            Lowers a single user's allocation to an absolute new total.
            Refused if the user has open exposure the new total would not
            cover. Audit-logged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-xs">
          <Label className="text-xs">User</Label>
          <Select value={userId} onValueChange={(v) => setUserId(v)}>
            <SelectTrigger data-testid="select-reduce-user">
              <SelectValue placeholder={listQ.isLoading ? "Loading users…" : "Pick a user"} />
            </SelectTrigger>
            <SelectContent>
              {(listQ.data?.users ?? [])
                .filter((u) => u.totalAllocation > 0)
                .map((u) => (
                  <SelectItem key={u.userId} value={String(u.userId)}>
                    #{u.userId} · {u.email ?? "—"} · ${u.totalAllocation.toFixed(2)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {selected && (
            <div className="font-mono space-y-0.5" data-testid="reduce-single-user-snapshot">
              <div>Current total: ${selected.totalAllocation.toFixed(2)}</div>
              <div>
                Open positions:{" "}
                <span data-testid="reduce-single-open-count">{openCount}</span>
                {"  ·  "}
                Floating P/L:{" "}
                <span className={plColor} data-testid="reduce-single-floating-pl">
                  {floatingPl >= 0 ? "+" : ""}${floatingPl.toFixed(2)}
                </span>
              </div>
              {openCount > 0 && (
                <div className="text-muted-foreground">
                  Cannot drop below ${coveredFloor.toFixed(2)} while positions are open.
                </div>
              )}
            </div>
          )}
          <Label className="text-xs">New total (USD)</Label>
          <input
            type="number" step="0.01" min="0"
            className="w-full border rounded px-2 py-1 bg-background"
            value={newTotal} onChange={(e) => setNewTotal(e.target.value)}
            data-testid="input-reduce-single-new-total"
          />
          <Label className="text-xs">Reason (audit-logged)</Label>
          <input
            className="w-full border rounded px-2 py-1 bg-background"
            value={reason} onChange={(e) => setReason(e.target.value)}
            data-testid="input-reduce-single-reason"
          />
          {wouldStrandExposure && (
            <div
              className="text-xs text-warning dark:text-warning border border-warning/40 rounded px-2 py-1"
              data-testid="reduce-single-exposure-warning"
            >
              Warning: ${newTotalNum.toFixed(2)} is below ${coveredFloor.toFixed(2)} while
              {" "}{openCount} position{openCount === 1 ? "" : "s"} ({floatingPl >= 0 ? "+" : ""}${floatingPl.toFixed(2)} floating)
              {" "}remain open. The server will refuse with USER_HAS_OPEN_EXPOSURE — close positions or pause shared-live first.
            </div>
          )}
          {resultMsg && (
            <div className="text-xs text-danger" data-testid="reduce-single-result">{resultMsg}</div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mut.isPending || !userId || !isLower || !reason}
            onClick={(e) => { e.preventDefault(); mut.mutate(); }}
            data-testid="btn-confirm-reduce-single">
            {mut.isPending ? "Reducing…" : "Confirm reduce"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── View raw pool JSON ────────────────────────────────────────────────────
// Read-only dialog that fetches /api/admin/allocations/master-pool fresh
// and pretty-prints the response so admins can audit every field that
// drives the pool decision (snapshot status, deficit, paused flags).
function ViewPoolJsonButton({ pool }: { pool: PoolSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<{ ok: boolean; pool: PoolSnapshot | null; reason?: string }>({
    queryKey: ["adminMasterPoolViewer"],
    queryFn: () => jget("/api/admin/allocations/master-pool"),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const payload = q.data ?? { ok: !!pool, pool };
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="btn-view-pool">
        View pool
      </Button>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Shared bridge pool — raw snapshot</AlertDialogTitle>
          <AlertDialogDescription>
            Live recomputed snapshot from <code>/api/admin/allocations/master-pool</code>.
            Refreshes every 5s while open. Read-only.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre
          className="text-[10px] font-mono bg-muted rounded p-3 max-h-[60vh] overflow-auto"
          data-testid="pool-json-viewer"
        >
{JSON.stringify(payload, null, 2)}
        </pre>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SharedLivePauseResumeButton({ paused, onDone }: { paused: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const url = paused ? "/api/admin/shared-live/resume" : "/api/admin/shared-live/pause";
      const r = await fetch(url, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || (paused ? "operator-resume" : "operator-pause") }),
      });
      return r.json();
    },
    onSettled: () => { setOpen(false); setReason(""); onDone(); },
  });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={paused ? "default" : "destructive"}
        onClick={() => setOpen(true)} data-testid="btn-pause-resume-shared-live">
        {paused ? "Resume shared-live" : "Pause shared-live"}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{paused ? "Resume shared-live trading?" : "Pause shared-live trading?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {paused
              ? "All 16 Phase B gates still apply. New shared-live entries can resume."
              : "New shared-live entries will be refused. Open positions are NOT closed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="text-xs">
          <Label className="text-xs">Reason (audit-logged)</Label>
          <input
            className="w-full mt-1 border rounded px-2 py-1 bg-background"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={paused ? "Reconciliation complete" : "Master balance drop / reconciliation"}
            data-testid="input-pause-resume-reason"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Working…" : "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProportionalReduceButton({ currentTotal, masterCap, onDone }: { currentTotal: number; masterCap: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const suggestion = Math.max(0, Math.min(currentTotal, masterCap));
  const [target, setTarget] = useState<string>(suggestion.toFixed(2));
  const [reason, setReason] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/allocations/reduce-proportional", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetTotal: Number(target), reason: reason || "reconciliation-proportional-reduce" }),
      });
      return r.json();
    },
    onSettled: () => { setOpen(false); setReason(""); onDone(); },
  });
  return (
    <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setTarget(suggestion.toFixed(2)); }}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="btn-reduce-proportional">
        Proportional reduce
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reduce all allocations proportionally?</AlertDialogTitle>
          <AlertDialogDescription>
            Scales every active user allocation by the same ratio so the new
            sum matches your target total. Audit-logged. Does not close
            positions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-xs">
          <div className="font-mono">
            Current total: ${currentTotal.toFixed(2)} · Master cap: ${masterCap.toFixed(2)}
          </div>
          <Label className="text-xs">Target total (USD)</Label>
          <input
            type="number" step="0.01" min="0"
            className="w-full border rounded px-2 py-1 bg-background"
            value={target} onChange={(e) => setTarget(e.target.value)}
            data-testid="input-reduce-target"
          />
          <Label className="text-xs">Reason (audit-logged)</Label>
          <input
            className="w-full border rounded px-2 py-1 bg-background"
            value={reason} onChange={(e) => setReason(e.target.value)}
            data-testid="input-reduce-reason"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mut.isPending || !target || Number(target) < 0 || Number(target) >= currentTotal}
            onClick={() => mut.mutate()}>
            {mut.isPending ? "Reducing…" : "Confirm reduce"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
