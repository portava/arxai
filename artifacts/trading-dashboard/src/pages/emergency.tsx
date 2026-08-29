import { useState } from "react";
import {
  useGetSystemStatus,
  useSetSystemMode,
  useEngageKillSwitch,
  useResetKillSwitch,
  useGetSystemVault,
  useGetSystemStateTransitions,
  getGetSystemStatusQueryKey,
  getGetSystemVaultQueryKey,
  getGetSystemStateTransitionsQueryKey,
  type SystemStatus,
  type SetSystemModeBodyMode,
  type VaultEvent,
  type StateTransitionEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertOctagon,
  ShieldAlert,
  ShieldCheck,
  Activity,
  Eye,
  Lightbulb,
  FileText,
  Zap,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MODE_DEFS: { mode: SetSystemModeBodyMode; label: string; sub: string; icon: typeof Eye }[] = [
  { mode: "OBSERVE_ONLY", label: "OBSERVE", sub: "Watch market, no signals", icon: Eye },
  { mode: "SUGGEST_ONLY", label: "SUGGEST", sub: "Generate signals, no execution", icon: Lightbulb },
  { mode: "PAPER_TRADING", label: "DEMO", sub: "Execute on demo account", icon: FileText },
  { mode: "LIVE_TRADING", label: "LIVE", sub: "Real capital at risk", icon: Zap },
];

function severityClass(sev: string): string {
  switch (sev) {
    case "CRITICAL": return "bg-destructive text-destructive-foreground";
    case "DANGER": return "bg-destructive/80 text-destructive-foreground";
    case "WARN": return "bg-warning/20 text-warning dark:text-warning border border-warning/40";
    default: return "bg-muted text-muted-foreground";
  }
}

function linkHealthClass(h: string): string {
  if (h === "OK") return "bg-success/20 text-success dark:text-success border border-success/40";
  if (h === "DEGRADED") return "bg-warning/20 text-warning dark:text-warning border border-warning/40";
  return "bg-destructive/20 text-destructive border border-destructive/40";
}

function StatusBanner({ status }: { status: SystemStatus }) {
  const ks = status.killSwitchEngaged;
  const profile = status.effectiveProfile as { description?: string; executionPermission?: string };
  const reasons = status.reasons ?? [];
  const blockers = status.blockers ?? [];
  return (
    <Card className={ks ? "border-destructive bg-destructive/5" : "border-border"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {ks ? (
              <AlertOctagon className="text-destructive" size={28} />
            ) : (
              <ShieldCheck className="text-primary" size={28} />
            )}
            <div>
              <CardTitle className="text-xl tracking-wide">
                {ks ? "KILL SWITCH ENGAGED" : "Safety Core Online"}
              </CardTitle>
              <CardDescription className="mt-1">
                Operational Mode <Badge variant="outline" className="ml-1 font-mono">{status.operationalMode}</Badge>
                <span className="mx-2">·</span>
                Global State <Badge variant="outline" className="font-mono">{status.globalState}</Badge>
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={linkHealthClass(status.mt5LinkHealth)}>
              MT5 LINK: {status.mt5LinkHealth}
              {status.secondsSinceMt5Heartbeat !== null && status.secondsSinceMt5Heartbeat !== undefined ? ` · ${status.secondsSinceMt5Heartbeat}s` : ""}
            </Badge>
            <Badge variant="outline" className="font-mono text-xs">
              EXEC: {profile.executionPermission ?? "—"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      {(reasons.length > 0 || blockers.length > 0 || profile.description) && (
        <CardContent className="pt-0 space-y-2">
          {profile.description && (
            <p className="text-sm text-muted-foreground italic">{profile.description}</p>
          )}
          {blockers.length > 0 && (
            <div className="flex items-start gap-2 text-sm">
              <XCircle size={16} className="text-destructive shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-destructive">Blockers:</span>{" "}
                {blockers.join("; ")}
              </div>
            </div>
          )}
          {reasons.length > 0 && (
            <div className="flex items-start gap-2 text-sm">
              <Activity size={16} className="text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-muted-foreground">{reasons.join("; ")}</div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function ModeSwitcher({ status }: { status: SystemStatus }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setMode = useSetSystemMode();
  const [pendingMode, setPendingMode] = useState<SetSystemModeBodyMode | null>(null);
  const [confirmLive, setConfirmLive] = useState<{ step: number } | null>(null);

  const apply = (mode: SetSystemModeBodyMode) => {
    setMode.mutate(
      { data: { mode, changedBy: "operator" } },
      {
        onSuccess: (res) => {
          if (res.ok) {
            toast({ title: `Mode → ${res.mode}`, description: (res.reasons ?? []).join("; ") || "Mode changed." });
          } else {
            toast({ title: "Mode change blocked", description: (res.blockers ?? []).join("; "), variant: "destructive" });
          }
          void queryClient.invalidateQueries({ queryKey: getGetSystemStatusQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetSystemVaultQueryKey() });
        },
        // Unlike ENGAGE, changing the platform-wide operational mode IS
        // role-gated (live_trading:kill_switch as a floor, live_trading:reset
        // to select an execution-capable mode). An ordinary account maps to
        // VIEWER, so this will 403 for most users — name that instead of
        // leaving them to retry a button that can never work for them.
        onError: () =>
          toast({
            title: "Mode unchanged",
            description:
              "Changing the platform-wide operational mode requires an operator role (ADMIN or OWNER). The mode is unchanged. To stop trading, use ENGAGE KILL SWITCH below — that is available to every signed-in user.",
            variant: "destructive",
          }),
        onSettled: () => {
          setPendingMode(null);
          setConfirmLive(null);
        },
      },
    );
  };

  const handleClick = (mode: SetSystemModeBodyMode) => {
    if (status.killSwitchEngaged) {
      toast({ title: "Kill switch engaged", description: "Reset the kill switch first.", variant: "destructive" });
      return;
    }
    setPendingMode(mode);
    if (mode === "LIVE_TRADING") {
      setConfirmLive({ step: 1 });
    } else {
      apply(mode);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck size={20} /> Operational Mode
        </CardTitle>
        <CardDescription>Control Tower governs which mode is allowed. LIVE requires multi-step acknowledgement.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {MODE_DEFS.map(({ mode, label, sub, icon: Icon }) => {
            const isCurrent = status.operationalMode === mode;
            const isAllowed = status.allowedModes.includes(mode);
            const isPending = setMode.isPending && pendingMode === mode;
            return (
              <button
                key={mode}
                onClick={() => handleClick(mode)}
                disabled={!isAllowed || isCurrent || setMode.isPending || status.killSwitchEngaged}
                className={[
                  "p-4 rounded-lg border-2 text-left transition-all",
                  isCurrent
                    ? "border-primary bg-primary/10 shadow-md"
                    : isAllowed
                      ? "border-border hover:border-primary/60 hover:bg-accent/40"
                      : "border-dashed border-muted opacity-40 cursor-not-allowed",
                ].join(" ")}
                data-testid={`button-mode-${mode}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={18} className={isCurrent ? "text-primary" : "text-muted-foreground"} />
                  <span className="font-bold tracking-wide">{label}</span>
                  {isCurrent && <CheckCircle2 size={14} className="text-primary ml-auto" />}
                </div>
                <p className="text-xs text-muted-foreground">{sub}</p>
                {isPending && <p className="text-xs text-primary mt-1">Switching…</p>}
                {!isAllowed && !isCurrent && <p className="text-xs text-destructive mt-1">Blocked by gate</p>}
              </button>
            );
          })}
        </div>
      </CardContent>

      <AlertDialog open={confirmLive !== null} onOpenChange={(o) => !o && setConfirmLive(null)}>
        <AlertDialogContent className="border-destructive border-2">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <Zap /> Enable LIVE Trading — Step {confirmLive?.step ?? 1} of 2
            </AlertDialogTitle>
            <AlertDialogDescription className="py-3 text-base">
              {confirmLive?.step === 1
                ? "LIVE mode places real capital at risk. The Risk Governor and Control Tower will still gate every order, but live executions cannot be undone. Continue?"
                : "Final confirmation: switching to LIVE_TRADING now. Type-equivalent click required."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmLive(null)}>Cancel</AlertDialogCancel>
            {confirmLive?.step === 1 ? (
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); setConfirmLive({ step: 2 }); }}
                className="bg-destructive hover:bg-destructive/90"
              >
                I understand — continue
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                onClick={() => apply("LIVE_TRADING")}
                className="bg-destructive hover:bg-destructive/90"
              >
                Confirm — switch to LIVE
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function KillSwitchPanel({ status }: { status: SystemStatus }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const engage = useEngageKillSwitch();
  const reset = useResetKillSwitch();
  const [engageOpen, setEngageOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [ack, setAck] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getGetSystemStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetSystemVaultQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetSystemStateTransitionsQueryKey() });
  };

  const doEngage = () => {
    const r = reason.trim() || "Operator-triggered emergency stop";
    engage.mutate(
      { data: { reason: r, triggeredBy: "operator" } },
      {
        onSuccess: () => {
          toast({ title: "KILL SWITCH ENGAGED", description: r, variant: "destructive" });
          setEngageOpen(false);
          setReason("");
          invalidate();
        },
        // NOT ENGAGED — say so, and say what still works. A bare "Engage
        // failed" left the user unable to tell a transient server error from a
        // control that would never work for them. Engaging needs only a
        // signed-in session (see routes/system.ts), so the realistic causes are
        // a lost session or the server being unreachable — in both of which
        // cases nothing was halted and the user needs the other route now.
        onError: () =>
          toast({
            title: "NOT ENGAGED — trading was not halted",
            description:
              "The platform stop did not engage, so live dispatch is still running. Check you are still signed in and retry. If it keeps failing, use EMERGENCY STOP ALL TRADING on /risk-settings, which reaches the same switch.",
            variant: "destructive",
          }),
      },
    );
  };

  const doReset = () => {
    reset.mutate(
      { data: { acknowledgement: ack, resetBy: "operator" } },
      {
        onSuccess: (res) => {
          if (res.ok) {
            toast({ title: "Kill switch reset", description: "Entered RECOVERY_MODE." });
            setResetOpen(false);
            setAck("");
            invalidate();
          } else {
            toast({ title: "Reset rejected", description: (res.blockers ?? []).join("; "), variant: "destructive" });
          }
        },
        onError: () => toast({
          title: "Reset failed",
          description: "Releasing the platform kill switch requires an ADMIN or OWNER role.",
          variant: "destructive",
        }),
      },
    );
  };

  const ks = status.killSwitchEngaged;

  return (
    <Card className={ks ? "border-destructive/60" : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertOctagon size={20} /> Emergency Kill Switch
        </CardTitle>
        <CardDescription>
          {ks
            ? `Engaged ${status.killSwitchEngagedAt ? new Date(status.killSwitchEngagedAt).toLocaleString() : ""}. Reset requires an ADMIN/OWNER role and an explicit acknowledgement.`
            : "Drops the platform to OBSERVE_ONLY and blocks new order dispatch on every venue."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {ks && status.killSwitchReason && (
          <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/40 text-sm">
            <span className="font-semibold">Reason:</span> {status.killSwitchReason}
          </div>
        )}
        {/* WHAT THIS STOPS — named precisely, because this platform has four
            kill-switch surfaces and an operator in a hurry must not have to
            guess which one they are looking at. Every claim below corresponds
            to a gate that reads safety_core.kill_switch_engaged. */}
        <div className="p-3 rounded-md border bg-muted/40 text-xs space-y-2" data-testid="kill-switch-scope">
          <p className="font-semibold text-foreground">What this switch stops</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>MT5 live command dispatch — refused at draft and at dispatch</li>
            <li>The Deriv guided dispatch path</li>
            <li>Simulated execution through the Safety Core trade gate — the <code>/execute-trade</code> path only</li>
          </ul>
          <p className="font-semibold text-foreground pt-1">What it does not do</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>It does not close anything. Open positions stay open and no close command reaches your broker.</li>
            {/* The trade gate has exactly one caller (routes/trades.ts →
                POST /execute-trade). The per-user paper screen is a different
                route family (routes/mePaperTrades.ts) that never reads the
                safety core, so claiming "paper execution is halted" without
                this line would be a promise this page cannot keep. */}
            <li>
              It does not stop the Paper Trades screen. Opening and closing paper trades there does not
              consult this switch, so those keep working while the stop is engaged.
            </li>
            <li>It does not clear the Autopilot Control Center&apos;s own lock, or the Risk Command Center pause — those are separate controls.</li>
          </ul>
        </div>
      </CardContent>
      <CardFooter className="gap-3 flex-wrap">
        <Button
          variant="destructive"
          size="lg"
          className="font-bold tracking-wider"
          onClick={() => setEngageOpen(true)}
          disabled={ks || engage.isPending}
          data-testid="button-engage-kill-switch"
        >
          <AlertOctagon size={18} className="mr-2" />
          {engage.isPending ? "ENGAGING…" : "ENGAGE KILL SWITCH"}
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={() => setResetOpen(true)}
          disabled={!ks || reset.isPending}
          data-testid="button-reset-kill-switch"
        >
          <RefreshCw size={18} className="mr-2" />
          Reset (Recovery)
        </Button>
      </CardFooter>

      <AlertDialog open={engageOpen} onOpenChange={setEngageOpen}>
        <AlertDialogContent className="border-destructive border-2">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <ShieldAlert /> Confirm Kill Switch
            </AlertDialogTitle>
            <AlertDialogDescription>
              New order dispatch halts immediately on every venue (MT5 live, Deriv guided, paper).
              Open positions are NOT closed — no close command is sent to your broker.
              Provide a reason for the audit log; the acting account is recorded from your session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-3">
            <Label htmlFor="ks-reason">Reason</Label>
            <Textarea
              id="ks-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Unexpected slippage, news event, system anomaly…"
              className="mt-1"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doEngage} className="bg-destructive hover:bg-destructive/90">
              ENGAGE NOW
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RefreshCw /> Reset Kill Switch
            </AlertDialogTitle>
            <AlertDialogDescription>
              System will enter RECOVERY_MODE. Type <span className="font-mono font-bold">I_UNDERSTAND_RISK</span> to confirm.
              Releasing the platform stop for every user requires an ADMIN or OWNER role — the phrase alone is not
              authority, and the account that resets it is recorded from your session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-3">
            <Label htmlFor="ks-ack">Acknowledgement</Label>
            <Input
              id="ks-ack"
              value={ack}
              onChange={(e) => setAck(e.target.value)}
              placeholder="I_UNDERSTAND_RISK"
              className="mt-1 font-mono"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={doReset}
              disabled={ack !== "I_UNDERSTAND_RISK"}
            >
              Confirm Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function VaultList({ events }: { events: VaultEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground p-4 text-center">No vault events yet.</p>;
  }
  return (
    <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2">
      {events.map((ev) => (
        <div key={ev.id} className="p-3 rounded-md border bg-card text-sm" data-testid={`vault-event-${ev.id}`}>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <div className="flex items-center gap-2">
              <Badge className={severityClass(ev.severity)}>{ev.severity}</Badge>
              <Badge variant="outline" className="font-mono text-xs">{ev.kind}</Badge>
              <span className="text-xs text-muted-foreground">{ev.source}</span>
            </div>
            <span className="text-xs text-muted-foreground font-mono">
              {new Date(ev.generatedAtIso).toLocaleString()}
            </span>
          </div>
          <p className="font-medium">{ev.summary}</p>
          {ev.reasons && ev.reasons.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">{ev.reasons.join("; ")}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function TransitionsList({ transitions }: { transitions: StateTransitionEntry[] }) {
  if (transitions.length === 0) {
    return <p className="text-sm text-muted-foreground p-4 text-center">No state transitions yet.</p>;
  }
  return (
    <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2">
      {transitions.map((t) => (
        <div key={t.id} className="p-3 rounded-md border bg-card text-sm" data-testid={`state-transition-${t.id}`}>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">{t.fromState}</Badge>
              <span className="text-muted-foreground">→</span>
              <Badge className={t.changed ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}>
                {t.toState}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground font-mono">
              {new Date(t.generatedAtIso).toLocaleString()}
            </span>
          </div>
          {t.reasons && t.reasons.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">{t.reasons.join("; ")}</p>
          )}
          {t.acceptedSources && t.acceptedSources.length > 0 && (
            <p className="text-xs mt-1">
              <span className="text-muted-foreground">Sources:</span> {t.acceptedSources.join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Emergency() {
  const statusQ = useGetSystemStatus({ query: { queryKey: getGetSystemStatusQueryKey(), refetchInterval: 5000 } });
  const vaultQ = useGetSystemVault({ limit: 50 }, { query: { queryKey: getGetSystemVaultQueryKey({ limit: 50 }), refetchInterval: 5000 } });
  const transitionsQ = useGetSystemStateTransitions({ limit: 50 }, { query: { queryKey: getGetSystemStateTransitionsQueryKey({ limit: 50 }), refetchInterval: 10000 } });

  if (statusQ.isLoading || !statusQ.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const status = statusQ.data;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShieldAlert className="text-primary" /> Safety Core — Control Tower
          </h1>
          <p className="text-muted-foreground mt-1">
            Phase 1 Foundation · Risk Governor · Global State Machine · Black Box Vault
          </p>
        </div>
        {status.lastModeChangeAt && (
          <div className="text-xs text-muted-foreground text-right">
            <div>Last mode change</div>
            <div className="font-mono">{new Date(status.lastModeChangeAt).toLocaleString()}</div>
            {status.lastModeChangedBy && <div>by {status.lastModeChangedBy}</div>}
          </div>
        )}
      </div>

      <StatusBanner status={status} />

      <div className="grid lg:grid-cols-2 gap-6">
        <ModeSwitcher status={status} />
        <KillSwitchPanel status={status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText size={20} /> Black Box Vault
          </CardTitle>
          <CardDescription>
            Immutable audit trail of every safety-critical decision. Polled every 5s.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="vault">
            <TabsList>
              <TabsTrigger value="vault" data-testid="tab-vault">
                Vault Events
                {vaultQ.data && (
                  <Badge variant="secondary" className="ml-2">{vaultQ.data.events.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="transitions" data-testid="tab-transitions">
                State Transitions
                {transitionsQ.data && (
                  <Badge variant="secondary" className="ml-2">{transitionsQ.data.transitions.length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="vault" className="mt-4">
              {vaultQ.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
                </div>
              ) : (
                <VaultList events={vaultQ.data?.events ?? []} />
              )}
            </TabsContent>
            <TabsContent value="transitions" className="mt-4">
              {transitionsQ.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
                </div>
              ) : (
                <TransitionsList transitions={transitionsQ.data?.transitions ?? []} />
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground p-3 rounded-md border border-dashed flex items-start gap-2">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <span>
          Phase 1 Foundation/Safety. Trade execution is gated by the Risk Governor + Control Tower at the API layer
          (<span className="font-mono">/api/execute-trade</span>). HARD_BLOCK verdicts return HTTP 409. OBSERVE/SUGGEST modes
          downgrade trades to signal-only logs. DEMO/LIVE modes apply size multipliers from the active risk profile.
        </span>
      </div>
    </div>
  );
}
