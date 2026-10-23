// Phase 24 — Protective Auto-Close Settings UI.
//
// SAFETY:
//   * Default is OFF. Saving prefs NEVER unlocks execution by itself.
//   * Enabling requires explicit `acknowledgedRiskOfAutoClose:true` in the
//     PUT body (backend enforces 400 if missing).
//   * Effective status is ALERT_ONLY unless every gate passes — this UI
//     shows the gate list and never lies about the live state.

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
      <span className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${ok ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
        {ok ? "✓" : "!"}
      </span>
      <div className="flex-1">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <Badge variant="outline" className={`text-[10px] ${ok ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>
        {ok ? "PASS" : "BLOCKED"}
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

  // Gates — every one must PASS for real auto-close to fire. We deliberately
  // hard-code bridgeConnected:false until a real MT5 bridge is wired.
  const gates = [
    { label: "Broker bridge connected", ok: false, detail: "MT5 bridge is not connected (demo-only system lock). Without the bridge, the AI cannot send a close order." },
    { label: "User opt-in saved", ok: s.enabled === true, detail: s.enabled ? "You have opted in to Protective Auto-Close." : "You have not opted in. Toggle ENABLE below and acknowledge the risk." },
    { label: "Risk acknowledgement", ok: s.enabled === true, detail: "Enabling required the acknowledgement that the AI may close or partially close your trades under your pre-authorized policy when you are inactive." },
    { label: "Activity status known", ok: act.status !== "UNKNOWN", detail: `Current activity: ${act.status}. ${act.reason}` },
    { label: "Inactivity confirmed", ok: act.status === "INACTIVE", detail: act.status === "INACTIVE" ? `Inactive for ${Math.round((act.inactiveDurationMs ?? 0) / 60_000)} min ≥ threshold ${s.inactivityThresholdMin} min.` : "Auto-close fires only when you are confirmed INACTIVE for longer than your threshold." },
    { label: "Multi-signal confirmation required", ok: s.requireMultiSignal === true, detail: s.requireMultiSignal ? "Auto-close requires ≥2 independent reversal signals." : "Multi-signal confirmation is OFF — recommend turning it ON." },
    { label: "Live execution unlocked", ok: false, detail: "Live execution remains system-locked (demo-only). Until ARX explicitly unlocks live trading, every decision is ALERT_ONLY." },
    { label: "Kill switch not engaged", ok: s.killSwitchEngaged === false, detail: s.killSwitchEngaged ? "Kill switch is ENGAGED. Auto-close cannot fire." : "Kill switch is clear." },
    { label: "Duplicate-action protection active", ok: s.cooldownMin >= 1 && s.maxAutoClosesPerTrade >= 1, detail: `Cooldown ${s.cooldownMin} min between actions, max ${s.maxAutoClosesPerTrade} auto-close action(s) per trade. The engine refuses to re-fire inside the cooldown or after the cap.` },
  ];
  const allPass = gates.every((g) => g.ok);
  const effectiveStatus: "ALERT_ONLY" | "ARMED" = allPass ? "ARMED" : "ALERT_ONLY";

  return (
    <div className="space-y-4 max-w-4xl">
      {/* HEADER */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            {effectiveStatus === "ALERT_ONLY"
              ? <ShieldOff className="h-4 w-4 text-amber-400" />
              : <Shield className="h-4 w-4 text-emerald-400" />}
            Protective Auto-Close
            <Badge variant="outline" className={effectiveStatus === "ALERT_ONLY" ? "border-amber-500/40 text-amber-300" : "border-emerald-500/40 text-emerald-300"}>
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
          {effectiveStatus === "ALERT_ONLY" && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 flex gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-amber-100 text-xs">
                <strong>Alert Only</strong> — the AI can warn you, but cannot close this trade.
                At least one gate below is BLOCKED.
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* GATES */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-2"><CardTitle className="text-white text-sm">Required gates</CardTitle></CardHeader>
        <CardContent className="divide-y divide-zinc-800">
          {gates.map((g) => <GateRow key={g.label} {...g} />)}
        </CardContent>
      </Card>

      {/* SETTINGS */}
      <Card className="bg-zinc-900 border-zinc-800">
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
            <label className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                data-testid="checkbox-pac-acknowledge"
              />
              <span className="text-xs text-amber-100">
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
                className="bg-zinc-800 border-zinc-700 text-white" data-testid="input-pac-threshold" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Mode</label>
              <select
                value={effectiveMode}
                onChange={(e) => setPendingMode(e.target.value as Mode)}
                className="w-full bg-zinc-800 border border-zinc-700 text-white rounded px-2 py-2 text-sm"
                data-testid="select-pac-mode"
              >
                <option value="ALERT_ONLY">ALERT_ONLY (warn me — never close)</option>
                <option value="CONFIRM_IF_ACTIVE">CONFIRM_IF_ACTIVE (ask if I'm at the keyboard)</option>
                <option value="AUTO_IF_INACTIVE">AUTO_IF_INACTIVE (auto when inactive — all gates required)</option>
              </select>
            </div>
          </div>

          {saveMsg && (
            <div className="text-xs rounded border border-zinc-800 bg-zinc-950/60 p-2 text-foreground/80" data-testid="text-pac-save-msg">{saveMsg}</div>
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
                <ZapOff className="h-4 w-4 mr-1" /> Engage kill switch
              </Button>
            ) : (
              <Button variant="outline" onClick={() => clearKillMutation.mutate()} disabled={clearKillMutation.isPending} data-testid="button-pac-clear-kill">
                <Zap className="h-4 w-4 mr-1" /> Clear kill switch
              </Button>
            )}
          </div>

          <div className="text-xs text-muted-foreground italic">
            Activity: <strong className={act.status === "UNKNOWN" ? "text-amber-300" : act.status === "INACTIVE" ? "text-emerald-300" : "text-foreground"}>{act.status}</strong> — {act.reason}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
