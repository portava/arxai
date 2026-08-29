// Phase 24 — Protective Auto-Close Settings UI.
//
// SAFETY:
//   * Default is OFF. Saving prefs NEVER unlocks execution by itself.
//   * Enabling requires explicit `acknowledgedRiskOfAutoClose:true` in the
//     PUT body (backend enforces 400 if missing).
//   * Effective status is ALERT_ONLY, FIXED, in this build. The page separates
//     SYSTEM LOCKS (properties of the build — no auto-close order path exists,
//     live execution not unlocked) from YOUR GATES (conditions you control).
//     The locks are not status reads and are never rendered as checks that
//     might flip on their own; the earlier version showed them as failing gate
//     rows, so a user with a healthy MT5 bridge was told the bridge was down.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Shield, ShieldOff, Zap, ZapOff } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

type Mode = "ALERT_ONLY" | "CONFIRM_IF_ACTIVE" | "AUTO_IF_INACTIVE";

interface Settings {
  enabled: boolean;
  inactivityThresholdMin: number;
  mode: Mode;
  closeType: "FULL" | "PARTIAL" | "TIGHTEN";
  partialClosePercent: number;
  maxAutoClosesPerTrade: number;
  cooldownMin: number;
  minConfidence: "HIGH" | "MEDIUM";
  requireMultiSignal: boolean;
  protectProfitEnabled: boolean;
  protectProfitGivebackPct: number;
  maxLossProtectionEnabled: boolean;
  maxLossProtectionPct: number;
  killSwitchEngaged: boolean;
}

interface Activity {
  status: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  reason: string;
  inactiveDurationMs: number | null;
}

interface SettingsResponse {
  ok: boolean;
  settings: Settings;
  activity: Activity;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

function GateRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${ok ? "bg-success/20 text-success" : "bg-warning/20 text-warning"}`}>
        {ok ? "✓" : "!"}
      </span>
      <div className="flex-1">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <Badge variant="outline" className={`text-[10px] ${ok ? "border-success/40 text-success" : "border-warning/40 text-warning"}`}>
        {ok ? "PASS" : "BLOCKED"}
      </Badge>
    </div>
  );
}

// A SYSTEM LOCK is not a status read. It is a fixed property of this build, so
// it must not be dressed as a check that might one day flip on its own — the
// audit found two locks rendered as gate rows, telling users with a healthy,
// connected MT5 bridge that "MT5 bridge is not connected".
function LockRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold bg-muted text-muted-foreground">
        ⛔
      </span>
      <div className="flex-1">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
        SYSTEM LOCK
      </Badge>
    </div>
  );
}

export default function ProtectiveAutoClosePage() {
  const qc = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [pendingThreshold, setPendingThreshold] = useState<number | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["/me/protective-auto-close/settings"],
    queryFn: () => jsonFetch<SettingsResponse>(`${BASE}/api/me/protective-auto-close/settings`),
    refetchInterval: 15_000,
  });

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      jsonFetch<{ ok: boolean; settings?: Settings; error?: string; message?: string }>(
        `${BASE}/api/me/protective-auto-close/settings`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ),
    onSuccess: (resp) => {
      if (resp.ok) {
        setSaveMsg("Preferences saved. (Saving preferences does NOT unlock execution.)");
        setPendingEnabled(null); setPendingMode(null); setPendingThreshold(null);
      } else {
        setSaveMsg(resp.message ?? resp.error ?? "Save failed.");
      }
      qc.invalidateQueries({ queryKey: ["/me/protective-auto-close/settings"] });
    },
    onError: (e: Error) => setSaveMsg(`Save failed: ${e.message}`),
  });

  const killMutation = useMutation({
    mutationFn: () => jsonFetch<unknown>(`${BASE}/api/me/protective-auto-close/kill-switch`, { method: "POST" }),
    onSuccess: () => { setSaveMsg("Kill switch ENGAGED. Auto-close is disabled until you clear it."); qc.invalidateQueries({ queryKey: ["/me/protective-auto-close/settings"] }); },
  });
  const clearKillMutation = useMutation({
    mutationFn: () => jsonFetch<unknown>(`${BASE}/api/me/protective-auto-close/clear-kill-switch`, { method: "POST" }),
    onSuccess: () => { setSaveMsg("Kill switch cleared."); qc.invalidateQueries({ queryKey: ["/me/protective-auto-close/settings"] }); },
  });

  if (isLoading || !data) {
    return <div className="space-y-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  const s = data.settings;
  const act = data.activity;
  const effectiveEnabled = pendingEnabled ?? s.enabled;
  const effectiveMode = pendingMode ?? s.mode;
  const effectiveThreshold = pendingThreshold ?? s.inactivityThresholdMin;

  // SYSTEM LOCKS — fixed properties of this build, NOT status reads.
  //
  // The audit found these two rendered as gate rows with ok:false, so a user
  // with a healthy, connected MT5 bridge was told "MT5 bridge is not connected"
  // as if it were a live check that might pass tomorrow. It is not: this build
  // has no auto-close placement path at all (CLAUDE.md: "Auto-close is
  // ALERT_ONLY. The system never closes a position on a user's behalf."), so
  // ARMED is unreachable by construction and every row below it can never
  // combine into a firing policy. They are labelled as locks and excluded from
  // the pass/fail arithmetic, which now says plainly why the answer is fixed.
  const systemLocks = [
    { label: "Auto-close placement path", detail: "This build has no auto-close order path. The system never closes a position on your behalf — every decision is ALERT_ONLY, regardless of the settings below." },
    { label: "Live execution unlocked", detail: "Live execution is not unlocked for auto-close in this build. This is a fixed lock, not a check that can pass." },
  ];

  // Gates — your own conditions. Even with every one PASS, the system locks
  // above hold the effective status at ALERT_ONLY.
  const gates = [
    { label: "User opt-in saved", ok: s.enabled === true, detail: s.enabled ? "You have opted in to Protective Auto-Close." : "You have not opted in. Toggle ENABLE below and acknowledge the risk." },
    { label: "Risk acknowledgement", ok: s.enabled === true, detail: "Enabling required the acknowledgement that the AI may close or partially close your trades under your pre-authorized policy when you are inactive." },
    { label: "Activity status known", ok: act.status !== "UNKNOWN", detail: `Current activity: ${act.status}. ${act.reason}` },
    { label: "Inactivity confirmed", ok: act.status === "INACTIVE", detail: act.status === "INACTIVE" ? `Inactive for ${Math.round((act.inactiveDurationMs ?? 0) / 60_000)} min ≥ threshold ${s.inactivityThresholdMin} min.` : "Auto-close fires only when you are confirmed INACTIVE for longer than your threshold." },
    { label: "Multi-signal confirmation required", ok: s.requireMultiSignal === true, detail: s.requireMultiSignal ? "Auto-close requires ≥2 independent reversal signals." : "Multi-signal confirmation is OFF — recommend turning it ON." },
    { label: "Kill switch not engaged", ok: s.killSwitchEngaged === false, detail: s.killSwitchEngaged ? "Auto-close kill switch is ENGAGED. This switch stops Protective Auto-Close only — it is not the platform kill switch." : "Auto-close kill switch is clear. (This switch stops Protective Auto-Close only.)" },
    { label: "Duplicate-action protection active", ok: s.cooldownMin >= 1 && s.maxAutoClosesPerTrade >= 1, detail: `Cooldown ${s.cooldownMin} min between actions, max ${s.maxAutoClosesPerTrade} auto-close action(s) per trade. The engine refuses to re-fire inside the cooldown or after the cap.` },
  ];
  const yourGatesPass = gates.every((g) => g.ok);
  // ARMED is unreachable while any system lock stands, and both stand in this
  // build. Stated as such rather than implied by an all-gates count that a user
  // could reasonably expect to satisfy.
  const effectiveStatus: "ALERT_ONLY" | "ARMED" = "ALERT_ONLY";

  return (
    <div className="space-y-4 max-w-4xl">
      {/* HEADER */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            {effectiveStatus === "ALERT_ONLY"
              ? <ShieldOff className="h-4 w-4 text-warning" />
              : <Shield className="h-4 w-4 text-success" />}
            Protective Auto-Close
            <Badge variant="outline" className={effectiveStatus === "ALERT_ONLY" ? "border-warning/40 text-warning" : "border-success/40 text-success"}>
              {effectiveStatus}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p className="text-foreground/80">
            Protective Auto-Close lets the AI close or tighten your trades when you go inactive
            <strong> and</strong> a reversal pattern is confirmed. Default is <strong>OFF</strong>.
            Saving preferences does <strong>not</strong> unlock execution by itself.
          </p>
          <div className="rounded border border-warning/30 bg-warning/10 p-3 flex gap-2" data-testid="pac-alert-only-notice">
            <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <div className="text-warning text-xs">
              <strong>Alert Only — and fixed that way in this build.</strong> The AI can warn you; it
              cannot close a trade. Two system locks below hold this status, so the Mode, close-type and
              protection settings on this page are saved as your preferences but <strong>cannot fire</strong> yet.
              {yourGatesPass && " Your own gates all pass; the locks are what remain."}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SYSTEM LOCKS — fixed in this build, not status reads */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-white text-sm">System locks (fixed in this build)</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border" data-testid="pac-system-locks">
          {systemLocks.map((l) => <LockRow key={l.label} {...l} />)}
        </CardContent>
      </Card>

      {/* GATES — the user's own conditions */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-white text-sm">Your gates</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border" data-testid="pac-user-gates">
          {gates.map((g) => <GateRow key={g.label} {...g} />)}
        </CardContent>
      </Card>

      {/* SETTINGS */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-white text-sm">Your preferences</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground">Enable Protective Auto-Close</div>
              <div className="text-xs text-muted-foreground">Saving with Enable=ON requires the acknowledgement below.</div>
            </div>
            <Switch checked={effectiveEnabled} onCheckedChange={(v) => setPendingEnabled(v)} data-testid="toggle-pac-enabled" />
          </div>

          {effectiveEnabled && (
            <label className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 p-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                data-testid="checkbox-pac-acknowledge"
              />
              <span className="text-xs text-warning">
                I understand the AI may close or partially close my trades under my pre-authorized policy when I am inactive
                <strong> and</strong> every gate above passes. I accept that no auto-close fires until ARX unlocks live execution.
              </span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Inactivity threshold (min)</label>
              <Input type="number" min={1} max={360} value={effectiveThreshold}
                onChange={(e) => setPendingThreshold(Math.max(1, Math.min(360, parseInt(e.target.value, 10) || 1)))}
                className="bg-secondary border-border text-white" data-testid="input-pac-threshold" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Mode</label>
              <select
                value={effectiveMode}
                onChange={(e) => setPendingMode(e.target.value as Mode)}
                className="w-full bg-secondary border border-border text-white rounded px-2 py-2 text-sm"
                data-testid="select-pac-mode"
              >
                <option value="ALERT_ONLY">ALERT_ONLY (warn me — never close)</option>
                <option value="CONFIRM_IF_ACTIVE">CONFIRM_IF_ACTIVE — inert in this build</option>
                <option value="AUTO_IF_INACTIVE">AUTO_IF_INACTIVE — inert in this build</option>
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Only ALERT_ONLY has an effect today. The other two are stored as your preference and
                behave as ALERT_ONLY until the system locks above are lifted.
              </p>
            </div>
          </div>

          {saveMsg && (
            <div className="text-xs rounded border border-border bg-background/60 p-2 text-foreground/80" data-testid="text-pac-save-msg">{saveMsg}</div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                const body: Record<string, unknown> = {};
                if (pendingEnabled !== null) body["enabled"] = pendingEnabled;
                if (pendingMode !== null) body["mode"] = pendingMode;
                if (pendingThreshold !== null) body["inactivityThresholdMin"] = pendingThreshold;
                const enabling = (pendingEnabled ?? s.enabled) === true;
                if (enabling) body["acknowledgedRiskOfAutoClose"] = acknowledged;
                saveMutation.mutate(body);
              }}
              disabled={saveMutation.isPending || (effectiveEnabled && !acknowledged && pendingEnabled === true)}
              data-testid="button-pac-save"
            >
              Save preferences
            </Button>
            {!s.killSwitchEngaged ? (
              <Button variant="destructive" onClick={() => killMutation.mutate()} disabled={killMutation.isPending} data-testid="button-pac-kill">
                <ZapOff className="h-4 w-4 mr-1" /> Engage auto-close kill switch
              </Button>
            ) : (
              <Button variant="outline" onClick={() => clearKillMutation.mutate()} disabled={clearKillMutation.isPending} data-testid="button-pac-clear-kill">
                <Zap className="h-4 w-4 mr-1" /> Clear auto-close kill switch
              </Button>
            )}
          </div>

          {/* WHICH STOP IS THIS? — see the same statement on /emergency and
              /live-trading-control. Four kill-switch surfaces exist; each names
              its own reach so an operator cannot pick the wrong one by accident. */}
          <div className="text-xs rounded border border-border bg-muted/30 p-2 space-y-1" data-testid="pac-stop-scope">
            <p><strong>This switch stops:</strong> Protective Auto-Close decisions for your account only.</p>
            <p><strong>It does not stop:</strong> any order dispatch. To halt live orders use the{" "}
              <a href="/emergency" className="underline">Emergency kill switch</a>.</p>
          </div>

          <div className="text-xs text-muted-foreground italic">
            Activity: <strong className={act.status === "UNKNOWN" ? "text-warning" : act.status === "INACTIVE" ? "text-success" : "text-foreground"}>{act.status}</strong> — {act.reason}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
