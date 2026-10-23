import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, CheckCircle2, Copy, Lock, Power, ShieldAlert,
  Unlock, XCircle, Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type GateCheck = {
  id: number; key: string; label: string;
  passed: boolean; reason: string | null; userInput: boolean; preArm: boolean;
};
type GateResp = {
  gate: {
    checks: GateCheck[];
    allPassed: boolean;
    preArmPassed: boolean;
    armReady: boolean;
    serverDispatchEnabled: boolean;
    killSwitchEngaged: boolean;
    preArmPassedCount: number;
    preArmFailedCount: number;
    passedCount: number;
    failedCount: number;
    detected: {
      accountNumber: string | null;
      brokerName: string | null;
      serverName: string | null;
    };
    phraseDebug?: {
      receivedLength: number;
      isEmpty: boolean;
      expectedLength: number;
      matchedAfterTrim: boolean;
    };
  };
  confirmationPhrase: string;
};

const CONFIRM_PHRASE = "ENABLE LIVE TRADING";

type ArmState =
  | "KILL_SWITCH_ACTIVE"
  | "ARMED"
  | "READY_TO_ARM"
  | "LOCKED"
  | "EVALUATING";

function computeArmState(gate: GateResp["gate"] | undefined, isArmed: boolean): ArmState {
  if (!gate) return "EVALUATING";
  if (gate.killSwitchEngaged) return "KILL_SWITCH_ACTIVE";
  if (isArmed && gate.serverDispatchEnabled) return "ARMED";
  if (gate.preArmPassed) return "READY_TO_ARM";
  return "LOCKED";
}

function StatusBanner({ state, preArmFailed }: { state: ArmState; preArmFailed: number }) {
  const map: Record<ArmState, { cls: string; label: string; sub: string }> = {
    KILL_SWITCH_ACTIVE: {
      cls: "bg-red-700/40 border-red-500 text-red-100",
      label: "KILL SWITCH ACTIVE",
      sub: "Live broker dispatch is force-disabled. Release the kill switch before re-arming.",
    },
    ARMED: {
      cls: "bg-emerald-700/30 border-emerald-500 text-emerald-100",
      label: "LIVE BROKER EXECUTION ENABLED",
      sub: "Live orders will dispatch to the broker. Kill switch overrides this state.",
    },
    READY_TO_ARM: {
      cls: "bg-amber-700/30 border-amber-500 text-amber-100",
      label: "READY TO ARM — EA READY / SERVER DISPATCH OFF",
      sub: "All pre-arm checks pass. Server dispatch is OFF (safe default). Admin must arm to enable broker orders.",
    },
    LOCKED: {
      cls: "bg-rose-900/30 border-rose-500/60 text-rose-100",
      label: `LOCKED — ${preArmFailed} pre-arm check(s) failing`,
      sub: "Resolve the pre-arm checklist below before live trading can be armed.",
    },
    EVALUATING: {
      cls: "bg-zinc-800/60 border-zinc-700 text-zinc-300",
      label: "EVALUATING…",
      sub: "Fetching live readiness state from the server.",
    },
  };
  const v = map[state];
  return (
    <div className={`rounded-md border p-3 ${v.cls}`} data-testid={`arm-state-${state}`}>
      <div className="text-sm font-semibold tracking-wide">{v.label}</div>
      <div className="text-xs opacity-90 mt-0.5">{v.sub}</div>
    </div>
  );
}

function DetectedValueRow({
  label, value, onCopyExact, testId,
}: { label: string; value: string | null; onCopyExact: () => void; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-zinc-400 shrink-0">{label}</span>
      <div className="flex items-center gap-1 min-w-0">
        <code className="font-mono text-zinc-200 truncate" data-testid={`${testId}-value`}>
          {value ?? "—"}
        </code>
        <Button
          type="button" size="sm" variant="outline" className="h-6 px-2 text-[10px] shrink-0"
          onClick={onCopyExact} disabled={value == null}
          aria-label={`Use exact ${label}`} data-testid={`${testId}-copy`}
        >
          <Copy className="h-3 w-3 mr-1" /> Use exact
        </Button>
      </div>
    </div>
  );
}

/**
 * Render a string with hidden whitespace + non-ASCII chars made visible.
 * Used by the admin-only #12 debug to expose smart quotes / NBSP / trailing
 * spaces that copy-paste from the broker's website silently introduces.
 */
function asLiteral(s: string): string {
  if (s.length === 0) return "<empty>";
  let out = "";
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (c === " ") out += "·";
    else if (c === "\t") out += "→";
    else if (code === 0xa0) out += "[NBSP]";
    else if (code < 0x20 || code === 0x7f) out += `[U+${code.toString(16).padStart(4, "0")}]`;
    else if (code > 0x7e) out += `${c}[U+${code.toString(16).padStart(4, "0")}]`;
    else out += c;
  }
  return out;
}

export function LiveTradingUnlockCard() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [confirmationPhrase, setPhrase] = useState("");
  const [accountNumber, setAccount] = useState("");
  const [brokerConfirmed, setBroker] = useState("");
  const [serverConfirmed, setServer] = useState("");
  const [maxLot, setMaxLot] = useState("0.10");
  const [dailyLoss, setDailyLoss] = useState("100");
  const [risk, setRisk] = useState(false);
  const [killAck, setKillAck] = useState(false);

  const body = {
    confirmationPhrase,
    accountNumberConfirmed: accountNumber,
    brokerConfirmed,
    serverConfirmed,
    maxLotConfirmed: Number(maxLot),
    dailyLossLimitConfirmed: Number(dailyLoss),
    riskAcknowledged: risk,
    killSwitchAcknowledged: killAck,
  };

  const preview = useQuery<GateResp>({
    queryKey: ["live", "arming-preview", body],
    queryFn: () => fetch(`${BASE}/api/me/live/arming/preview`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });

  const arming = useQuery<{ arming: { isArmed: boolean; killSwitchEngaged: boolean; armedAt: string | null } | null }>({
    queryKey: ["live", "arming"],
    queryFn: () => fetch(`${BASE}/api/me/live/arming`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 10_000,
  });

  const arm = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/arming/arm`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.json();
    },
    onSuccess: (j) => {
      if (j?.ok) {
        toast({ title: "Live arming complete", description: "All pre-arm checks passed." });
        qc.invalidateQueries({ queryKey: ["live"] });
        // Arming flips the unified account-mode envelope (liveExecutionArmed,
        // userCanManualTrade, currentAccountMode). Force-refresh so badges,
        // banners, and trade tickets reflect the new state immediately
        // instead of waiting for the 60s background poll.
        qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
      } else {
        toast({ variant: "destructive", title: "Arming refused", description: j?.reason ?? "Gate failed" });
      }
    },
  });

  const disarm = useMutation({
    mutationFn: () => fetch(`${BASE}/api/me/live/arming/disarm`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "user_request" }),
    }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["live"] });
      qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
      toast({ title: "Disarmed" });
    },
  });

  const gate = preview.data?.gate;
  const isArmed = !!arming.data?.arming?.isArmed;
  const armState = computeArmState(gate, isArmed);
  const detected = gate?.detected ?? { accountNumber: null, brokerName: null, serverName: null };
  const phraseDebug = gate?.phraseDebug;

  // "Use exact" — fills the corresponding input AND copies to clipboard.
  // This is the key fix for hidden-Unicode / smart-quote / NBSP cases:
  // pasting the broker's website value never matches the stored bridge
  // value, so we bypass paste entirely and write the stored bytes in.
  const useExact = async (
    label: string, v: string | null, setter: (s: string) => void,
  ) => {
    if (v == null) return;
    setter(v);
    try { await navigator.clipboard.writeText(v); } catch { /* clipboard optional */ }
    toast({ title: `${label} set to exact bridge value`, description: v });
  };

  // Show #9 separately ("Server dispatch status") — not in the locked count.
  const preArmChecks = gate?.checks?.filter((c) => c.preArm) ?? [];
  const dispatchCheck = gate?.checks?.find((c) => c.key === "SERVER_LIVE_FLAG");

  return (
    <Card className="border-red-500/30 overflow-hidden" data-testid="live-unlock-card">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-red-400" /> Live Trading Unlock
            </CardTitle>
            <CardDescription>
              Pre-arm checks must pass. Server dispatch arms separately (admin-only).
              Kill switch overrides everything.
            </CardDescription>
          </div>
          {isArmed
            ? <Badge className="bg-red-500/20 text-red-300 border border-red-500/50" data-testid="live-armed-badge">LIVE ARMED</Badge>
            : <Badge variant="outline" data-testid="live-disarmed-badge">DISARMED</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusBanner state={armState} preArmFailed={gate?.preArmFailedCount ?? 0} />

        <Alert className="border-red-500/40 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <AlertTitle>This is real money territory</AlertTitle>
          <AlertDescription>
            Live trading sends orders to a real broker account. Losses are permanent.
            Confirm risk before arming.
          </AlertDescription>
        </Alert>

        {/* Detected bridge values — operator copies these into the inputs below. */}
        <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3 space-y-1.5"
             data-testid="detected-bridge">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 mb-1">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
            Detected from your freshest non-revoked LIVE bridge
          </div>
          <DetectedValueRow label="MT5 account #" value={detected.accountNumber}
            onCopyExact={() => useExact("Account #", detected.accountNumber, setAccount)}
            testId="detected-account" />
          <DetectedValueRow label="Broker" value={detected.brokerName}
            onCopyExact={() => useExact("Broker", detected.brokerName, setBroker)}
            testId="detected-broker" />
          <DetectedValueRow label="Server" value={detected.serverName}
            onCopyExact={() => useExact("Server", detected.serverName, setServer)}
            testId="detected-server" />
        </div>

        {/* Three separate confirm fields. Each must match the detected value exactly after trim. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="lt-account">MT5 account number (confirm)</Label>
            <Input id="lt-account" value={accountNumber} onChange={(e) => setAccount(e.target.value)}
              placeholder={detected.accountNumber ?? "e.g. 62470041"} className="font-mono"
              autoCorrect="off" autoCapitalize="none" spellCheck={false} inputMode="numeric"
              data-testid="input-account-number" />
          </div>
          <div>
            <Label htmlFor="lt-broker">Broker (confirm)</Label>
            <Input id="lt-broker" value={brokerConfirmed} onChange={(e) => setBroker(e.target.value)}
              placeholder={detected.brokerName ?? "e.g. Deriv (SVG) LLC"} className="font-mono"
              autoCorrect="off" autoCapitalize="none" spellCheck={false}
              data-testid="input-broker" />
          </div>
          <div>
            <Label htmlFor="lt-server">Server (confirm)</Label>
            <Input id="lt-server" value={serverConfirmed} onChange={(e) => setServer(e.target.value)}
              placeholder={detected.serverName ?? "e.g. DerivSVG-Server"} className="font-mono"
              autoCorrect="off" autoCapitalize="none" spellCheck={false}
              data-testid="input-server" />
          </div>
          <div>
            <Label htmlFor="lt-maxlot">Max lot per order (≤1.0)</Label>
            <Input id="lt-maxlot" type="number" step="0.01" value={maxLot}
              onChange={(e) => setMaxLot(e.target.value)} data-testid="input-max-lot" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="lt-loss">Daily loss limit (USD)</Label>
            <Input id="lt-loss" type="number" step="1" value={dailyLoss}
              onChange={(e) => setDailyLoss(e.target.value)} data-testid="input-daily-loss" />
          </div>
        </div>

        <div className="grid gap-2">
          <label className="flex items-start gap-2">
            <Checkbox checked={risk} onCheckedChange={(v) => setRisk(v === true)} data-testid="check-risk" />
            <span className="text-sm leading-tight">I understand live trading uses real money and losses are permanent.</span>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox checked={killAck} onCheckedChange={(v) => setKillAck(v === true)} data-testid="check-kill" />
            <span className="text-sm leading-tight">I acknowledge the emergency kill switch is available on this page.</span>
          </label>
        </div>

        <div>
          <Label htmlFor="lt-phrase">
            Type exactly: <span className="font-mono font-bold text-red-300">{CONFIRM_PHRASE}</span>
          </Label>
          <Input id="lt-phrase" value={confirmationPhrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={CONFIRM_PHRASE} className="font-mono"
            data-testid="input-confirm-phrase" />
          {/* Admin-only phrase debug — server omits phraseDebug for non-admins. */}
          {phraseDebug && (
            <div className="mt-1 text-[11px] text-zinc-500 font-mono" data-testid="phrase-debug">
              [admin debug] received {phraseDebug.receivedLength} chars
              {phraseDebug.isEmpty ? " (EMPTY)" : ""} · expected {phraseDebug.expectedLength}
              {" · "}match-after-trim={String(phraseDebug.matchedAfterTrim)}
            </div>
          )}
        </div>

        {/* Server dispatch status — shown separately, NOT in the locked count. */}
        {dispatchCheck && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3"
               data-testid="server-dispatch-status">
            <div className="flex items-center gap-2 text-sm">
              <Power className={`h-4 w-4 ${gate?.serverDispatchEnabled ? "text-emerald-400" : "text-amber-400"}`} />
              <span className="font-semibold">Server dispatch:</span>
              <span className={gate?.serverDispatchEnabled ? "text-emerald-300" : "text-amber-300"}>
                {gate?.serverDispatchEnabled ? "On — live orders will be sent to the broker" : "Off — waiting on admin to enable"}
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              Kill switch overrides both states. Server dispatch is admin-controlled.
            </div>
          </div>
        )}

        <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3" data-testid="live-checklist">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">Pre-arm checklist</div>
            <div className="text-xs text-muted-foreground">
              {gate ? `${gate.preArmPassedCount} / ${preArmChecks.length} passing` : "evaluating…"}
            </div>
          </div>
          <ul className="space-y-1.5">
            {preArmChecks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm" data-testid={`check-${c.key}`}>
                {c.passed
                  ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 shrink-0" />
                  : <XCircle className="h-4 w-4 mt-0.5 text-rose-400 shrink-0" />}
                <div className="min-w-0 break-words flex-1">
                  <div className={c.passed ? "text-zinc-200" : "text-zinc-100"}>
                    <span className="text-xs text-zinc-500 mr-1.5">#{c.id}</span>{c.label}
                  </div>
                  {!c.passed && c.reason && (
                    <div className="text-xs text-rose-300/80 mt-0.5 break-words"
                         data-testid={`reason-${c.key}`}>{c.reason}</div>
                  )}
                  {/* Admin-only per-character debug for #12. phraseDebug is
                      admin-only so we use its presence as the admin signal. */}
                  {c.key === "ACCOUNT_BROKER_CONFIRMED" && phraseDebug && (
                    <div className="mt-1 rounded border border-zinc-800 bg-zinc-950 p-2 text-[10px] font-mono text-zinc-400 space-y-0.5"
                         data-testid="account-broker-debug">
                      <div>[admin debug] hidden chars made visible:</div>
                      <div>account  received: <span className="text-zinc-200">{asLiteral(accountNumber)}</span></div>
                      <div>account  expected: <span className="text-zinc-200">{asLiteral(detected.accountNumber ?? "")}</span></div>
                      <div>broker   received: <span className="text-zinc-200">{asLiteral(brokerConfirmed)}</span></div>
                      <div>broker   expected: <span className="text-zinc-200">{asLiteral(detected.brokerName ?? "")}</span></div>
                      <div>server   received: <span className="text-zinc-200">{asLiteral(serverConfirmed)}</span></div>
                      <div>server   expected: <span className="text-zinc-200">{asLiteral(detected.serverName ?? "")}</span></div>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2 flex-wrap">
          {isArmed ? (
            <Button variant="destructive" onClick={() => disarm.mutate()}
              disabled={disarm.isPending} data-testid="btn-disarm-live">
              <Lock className="h-4 w-4 mr-1.5" /> Disarm live trading
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => arm.mutate()}
              disabled={arm.isPending || !gate?.armReady}
              data-testid="btn-arm-live"
            >
              <Unlock className="h-4 w-4 mr-1.5" />
              {armState === "READY_TO_ARM"
                ? "Waiting on admin to enable server dispatch"
                : armState === "LOCKED"
                  ? `Locked — ${gate?.preArmFailedCount ?? "?"} check(s) failing`
                  : armState === "KILL_SWITCH_ACTIVE"
                    ? "Kill switch engaged — release to arm"
                    : "Arm live trading"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
