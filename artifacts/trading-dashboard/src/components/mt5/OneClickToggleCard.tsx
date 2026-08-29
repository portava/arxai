import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { ShieldCheck, AlertTriangle, Zap, ShieldOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { humanize } from "@/lib/humanize";
import { useAssistantName } from "@/lib/assistant-name";
import { useGetMeOneClickStatus } from "@workspace/api-client-react";
import { OneClickArmModal } from "./OneClickArmModal";

// Standing-consent model (Task #745): flipping a one-click switch ON is
// itself the user's consent — no typed phrase is required. Enabling LIVE
// still requires admin approval (master-live user-access gate), enforced
// server-side in artifacts/api-server/src/routes/meOneClick.ts.

type Settings = {
  demoOneClickEnabled: boolean;
  liveOneClickEnabled: boolean;
  maxLotPerClick: number | null;
  updatedAt: string | null;
  canEnableLive: boolean;
  canEnableLiveBlockedReason: string | null;
  // Ruby execution-authority model (Task #319).
  rubyExecutionAuthority?: string | null;
  rubyRequireExtraConfirmation?: boolean | null;
  allowRubyBreakEven?: boolean | null;
  allowRubyPartialClose?: boolean | null;
  allowRubyMonitor?: boolean | null;
  allowRubyWatchEnter?: boolean | null;
  allowRubyWatchClose?: boolean | null;
  maxRubyLotPerTrade?: number | null;
  maxRubyOpenPositions?: number | null;
  maxRubyDailyTrades?: number | null;
};

function ArmStatusSection({ onRefresh }: { onRefresh: () => void }) {
  const { toast } = useToast();
  const { data: status, isLoading, isError, error, refetch } = useGetMeOneClickStatus();
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (isError) {
      toast({ title: "Could not load arm status", description: (error as Error)?.message, variant: "destructive" });
    }
  }, [isError, error, toast]);

  if (isLoading) return <div className="text-xs text-muted-foreground">Loading arm status…</div>;
  if (!status) return null;

  const bridgeLabel = status.bridgeType === "OWN" ? "Own Bridge" : status.bridgeType === "SHARED" ? "Shared Bridge" : "No Bridge";

  return (
    <>
      <div className="rounded-md border-2 border-warning/40 bg-warning/10 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Zap className={`w-4 h-4 ${status.armed ? "text-success" : "text-warning"}`} />
            <Label className="text-sm font-semibold">
              Armed One-Click Trading
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">{bridgeLabel}</Badge>
            {status.armed ? (
              <Badge variant="default" className="bg-success text-xs" data-testid="badge-one-click-armed">ARMED</Badge>
            ) : (
              <Badge variant="secondary" className="text-xs" data-testid="badge-one-click-armed">NOT ARMED</Badge>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {status.armed
            ? "Buy and Sell execute immediately — no confirmation dialog. Disarm to restore the confirmation step."
            : "Arm one-click to skip the confirmation dialog on every Buy/Sell surface. All 16 safety gates remain active."}
        </p>

        {status.armed && status.armedAt && (
          <p className="text-xs text-success/80">Armed since {new Date(status.armedAt).toLocaleString()}</p>
        )}

        {status.armed && status.executionReadinessState === "STALE" && (
          <p className="text-xs text-warning flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Bridge type changed since arming — disarm and re-arm to restore instant execution.
          </p>
        )}

        {status.armed && status.executionReadinessState === "BLOCKED" && status.executionBlockReason && (
          <p className="text-xs text-danger flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {status.executionBlockReason.replace(/_/g, " ")}
          </p>
        )}

        {!status.canArm && !status.armed && status.canArmBlockReason && (
          <p className="text-xs text-warning/80 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {status.canArmBlockReason.replace(/_/g, " ")}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant={status.armed ? "destructive" : "default"}
            className={status.armed ? "" : "bg-warning hover:bg-warning/15 text-white"}
            onClick={() => setModalOpen(true)}
            data-testid="button-one-click-arm"
          >
            {status.armed ? <><ShieldOff className="w-3.5 h-3.5 mr-1" />Disarm</> : <><Zap className="w-3.5 h-3.5 mr-1" />Arm One-Click Trading</>}
          </Button>
        </div>
      </div>

      <OneClickArmModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        status={status}
        onArmed={() => {
          void refetch();
          onRefresh();
        }}
      />
    </>
  );
}

async function fetchSettings(): Promise<Settings> {
  const r = await fetch("/api/me/one-click", { credentials: "include" });
  if (!r.ok) throw new Error(`GET /api/me/one-click → ${r.status}`);
  return r.json();
}

// Ruby-only settings save — no scope/enable, so the backend updates the Ruby
// authority/permission/cap fields without touching the one-click toggle.
async function putRubySettings(body: Record<string, unknown>): Promise<void> {
  const r = await fetch("/api/me/one-click", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string; blockReason?: string }).blockReason
    ?? (j as { error?: string }).error ?? `PUT ${r.status}`);
}

async function putSettings(body: {
  scope: "demo" | "live";
  enable: boolean;
  maxLotPerClick?: number;
}): Promise<Settings> {
  const r = await fetch("/api/me/one-click", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `PUT ${r.status}`);
  return j as Settings;
}

export function OneClickToggleCard() {
  const { toast } = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    fetchSettings()
      .then(setS)
      .catch((e: Error) => setErr(e.message));
  }

  useEffect(() => {
    let alive = true;
    fetchSettings()
      .then((v) => alive && setS(v))
      .catch((e: Error) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);

  async function flip(scope: "demo" | "live", enable: boolean) {
    setBusy(true);
    try {
      const next = await putSettings({ scope, enable });
      setS(next);
      toast({ title: `One-click ${scope}: ${enable ? "enabled" : "disabled"}` });
    } catch (e) {
      toast({
        title: "One-click change rejected",
        description: humanize(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  if (err) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="w-4 h-4" />
        <AlertTitle>Could not load one-click settings</AlertTitle>
        <AlertDescription>{err}</AlertDescription>
      </Alert>
    );
  }
  if (!s) return null;

  return (
    <Card className="border-2 border-warning/30 bg-warning/5" data-testid="card-one-click-toggle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-warning" />
          ARX Single Confirm (One-Click)
        </CardTitle>
        <CardDescription>
          Skip the per-trade confirmation dialog. Default is <b>OFF</b> for
          both scopes. Every safety gate (Phase B, master-live access,
          per-user arming, exposure, daily-loss) still runs on every
          dispatch — Single Confirm only removes the manual click.
          <span className="mt-2 block text-warning/90">
            This is an <b>ARX app setting</b>. It is <b>not</b> your MT5
            terminal's "One Click Trading" checkbox (Options → Trade) — ARX
            cannot read that terminal setting and does not require it.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ArmStatusSection onRefresh={load} />

        <div className="rounded-md border border-border bg-background/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">One-click for DEMO</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                MT5 demo execution only. Flip the switch on — that is your
                standing consent. No typed phrase required.
              </p>
            </div>
            <Badge variant={s.demoOneClickEnabled ? "default" : "secondary"} data-testid="badge-one-click-demo">
              {s.demoOneClickEnabled ? "ON" : "OFF"}
            </Badge>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Switch
              checked={s.demoOneClickEnabled}
              disabled={busy}
              onCheckedChange={(v) => flip("demo", v)}
              data-testid="switch-one-click-demo"
            />
            <span className="text-xs text-muted-foreground">
              {s.demoOneClickEnabled ? "Click switch to disable." : "Flip the switch to enable."}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">One-click for LIVE</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Master-bridge LIVE dispatch. Flipping the switch on is your
                standing consent. Still requires admin approval (master-live
                user-access gate) before it can be enabled.
              </p>
            </div>
            <Badge variant={s.liveOneClickEnabled ? "default" : "secondary"} data-testid="badge-one-click-live">
              {s.liveOneClickEnabled ? "ON" : "OFF"}
            </Badge>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Switch
              checked={s.liveOneClickEnabled}
              disabled={busy || (!s.liveOneClickEnabled && !s.canEnableLive)}
              onCheckedChange={(v) => flip("live", v)}
              data-testid="switch-one-click-live"
            />
            {!s.liveOneClickEnabled && !s.canEnableLive && (
              <span className="text-xs text-warning" data-testid="text-one-click-live-block-reason">
                {humanize(s.canEnableLiveBlockedReason ?? "MASTER_LIVE_USER_ACCESS_REQUIRED")}
              </span>
            )}
            {s.liveOneClickEnabled && (
              <span className="text-xs text-muted-foreground">Click switch to disable.</span>
            )}
          </div>
        </div>

        <Alert className="border-success/30 bg-success/5">
          <ShieldCheck className="w-4 h-4 text-success" />
          <AlertTitle>Server gates still apply</AlertTitle>
          <AlertDescription className="text-xs">
            Enabling one-click never bypasses the master switch, admin
            approval, per-user arming, kill switch, EA flags, or
            exposure / daily-loss caps. A blocked trade with one-click
            ON is still blocked.
          </AlertDescription>
        </Alert>

        <RubyAuthoritySection s={s} onSaved={(next) => setS(next)} />

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => { setBusy(true); fetchSettings().then(setS).finally(() => setBusy(false)); }}
          data-testid="button-one-click-refresh"
        >
          Refresh
        </Button>
      </CardContent>
    </Card>
  );
}

// Authority levels shown in the UI. AI_AUTO exists in the data model but is
// intentionally NOT offered here — it is defined and not enabled in this build.
const RUBY_AUTHORITY_OPTIONS = (name: string): Array<{ value: string; label: string; hint: string }> => [
  { value: "OFF", label: "Off", hint: `${name} never trades. Read-only answers only.` },
  { value: "ADVISE_ONLY", label: "Advise only", hint: `${name} explains and proposes, but never executes.` },
  { value: "AI_ASSISTED", label: "AI-Assisted", hint: `${name} executes your commands directly — every safety gate still runs.` },
];

function RubyAuthoritySection({ s, onSaved }: { s: Settings; onSaved: (next: Settings) => void }) {
  const { toast } = useToast();
  const { name } = useAssistantName();
  const [busy, setBusy] = useState(false);
  const authority = (s.rubyExecutionAuthority ?? "OFF").toUpperCase();
  const isAssisted = authority === "AI_ASSISTED";

  async function save(patch: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      await putRubySettings(patch);
      const next = await fetchSettings();
      onSaved(next);
      toast({ title: `${name}: ${label}` });
    } catch (e) {
      toast({ title: `${name} setting rejected`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const perms: Array<{ key: keyof Settings; field: string; label: string }> = [
    { key: "allowRubyBreakEven", field: "allowRubyBreakEven", label: "Move stop to break-even" },
    { key: "allowRubyPartialClose", field: "allowRubyPartialClose", label: "Partial close" },
    { key: "allowRubyMonitor", field: "allowRubyMonitor", label: "Monitor a position (alerts only)" },
    { key: "allowRubyWatchEnter", field: "allowRubyWatchEnter", label: "Watch & enter at a level" },
    { key: "allowRubyWatchClose", field: "allowRubyWatchClose", label: "Watch & close at a level" },
  ];

  const caps: Array<{ key: keyof Settings; field: string; label: string; step: string }> = [
    { key: "maxRubyLotPerTrade", field: "maxRubyLotPerTrade", label: `Max lot per ${name} trade`, step: "0.01" },
    { key: "maxRubyOpenPositions", field: "maxRubyOpenPositions", label: `Max open ${name} positions`, step: "1" },
    { key: "maxRubyDailyTrades", field: "maxRubyDailyTrades", label: `Max ${name} trades per day`, step: "1" },
  ];

  return (
    <div className="rounded-md border-2 border-premium/30 bg-premium/5 p-3 space-y-4" data-testid="section-ruby-authority">
      <div>
        <Label className="text-sm font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-premium" /> {name} execution authority
        </Label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Controls whether {name} can act on your trading commands. AI-Assisted
          requires live access and only removes the extra confirmation prompt —
          every backend safety gate still runs on every action.
        </p>
      </div>

      <div className="grid gap-2">
        {RUBY_AUTHORITY_OPTIONS(name).map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={busy}
            onClick={() => save({ rubyExecutionAuthority: opt.value }, `authority ${opt.label}`)}
            className={`text-left rounded-md border p-2.5 transition ${
              authority === opt.value
                ? "border-premium bg-premium/10"
                : "border-border bg-background/40 hover:border-premium/40"
            }`}
            data-testid={`button-ruby-authority-${opt.value.toLowerCase()}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{opt.label}</span>
              {authority === opt.value && <Badge variant="default">Active</Badge>}
            </div>
            <span className="text-xs text-muted-foreground">{opt.hint}</span>
          </button>
        ))}
      </div>

      {isAssisted && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-2.5">
            <div>
              <Label className="text-sm">Ask me one more time before acting</Label>
              <p className="text-xs text-muted-foreground">
                Keep an explicit confirmation step. Turn off for true single-command execution.
              </p>
            </div>
            <Switch
              checked={s.rubyRequireExtraConfirmation !== false}
              disabled={busy}
              onCheckedChange={(v) => save({ rubyRequireExtraConfirmation: v }, v ? "confirm-first ON" : "confirm-first OFF")}
              data-testid="switch-ruby-extra-confirm"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">What {name} may do</Label>
            {perms.map((p) => (
              <div key={p.field} className="flex items-center justify-between gap-3">
                <span className="text-sm">{p.label}</span>
                <Switch
                  checked={s[p.key] === true}
                  disabled={busy}
                  onCheckedChange={(v) => save({ [p.field]: v }, `${p.label} ${v ? "on" : "off"}`)}
                  data-testid={`switch-ruby-${p.field}`}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{name}-only caps (stricter than your account limits)</Label>
            {caps.map((c) => (
              <div key={c.field} className="flex items-center justify-between gap-3">
                <span className="text-sm">{c.label}</span>
                <Input
                  type="number"
                  step={c.step}
                  min="0"
                  defaultValue={s[c.key] == null ? "" : String(s[c.key])}
                  placeholder="none"
                  disabled={busy}
                  className="w-28 h-8"
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const val = raw === "" ? null : Number(raw);
                    if (raw !== "" && (!Number.isFinite(val) || (val as number) <= 0)) return;
                    if ((s[c.key] ?? null) === val) return;
                    save({ [c.field]: val }, `${c.label} saved`);
                  }}
                  data-testid={`input-ruby-${c.field}`}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Leave blank to inherit your account limits. A value sets a stricter {name}-only ceiling.</p>
          </div>
        </>
      )}
    </div>
  );
}
