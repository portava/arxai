// ── T019 — Admin Risk/Governance panel ──────────────────────────────────────
//
// Owner/admin control surface for the per-user app-added trading restrictions
// that T019 moved out of hardcoded code and behind governance. Every toggle
// here writes owner_governance_settings via PATCH /api/admin/governance and the
// resolver (getEffectiveTradingGovernance) is the single source of truth both
// this UI and the backend dispatch read.
//
// SAFETY: this panel only changes APP-ADDED policy. It can NEVER relax a
// permanent technical/security/broker-truth check (the 16-gate evaluator,
// master switch, kill switch, bridge heartbeat, EA flags, account type,
// manual confirmation, ledger, ownership, master-account privacy, broker
// symbol/lot/price truth). Those are shown read-only as context, never toggled.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

interface EffectiveGovernance {
  userId: number;
  role: string;
  isPrivileged: boolean;
  ownerLiveControlMode: boolean;
  requireStopLoss: boolean;
  requireTakeProfit: boolean;
  requireSecondConfirm: boolean;
  maxLotPerTrade: number | null;
  maxOpenPositions: number | null;
  maxDailyLossUsd: number | null;
  enforceSymbolAllowlist: boolean;
  enforceAllocationLimit: boolean;
  enforceMarketHoursAppCheck: boolean;
  requireSpreadLimit: boolean;
  spreadLimitPoints: number | null;
  requireScannerSignal: boolean;
  requireRubyExplanation: boolean;
  requireBacktest: boolean;
  requireNewsCheck: boolean;
  requireRiskReward: boolean;
  allowMarketOrders: boolean;
  allowPendingOrders: boolean;
  allowChartTrading: boolean;
  allowReverse: boolean;
  allowPartialClose: boolean;
  allowBreakEven: boolean;
  allowOneClick: boolean;
}

type GovResponse = { ok: boolean; targetUserId: number; effective: EffectiveGovernance };

async function fetchGovernance(): Promise<GovResponse> {
  const r = await fetch("/api/admin/governance", { credentials: "include" });
  return (await r.json()) as GovResponse;
}

async function patchGovernance(patch: Record<string, unknown>): Promise<GovResponse> {
  const r = await fetch("/api/admin/governance", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await r.json()) as GovResponse;
}

// Restriction toggles: ON = restriction active. Each maps directly to a
// boolean governance column.
const REQUIRE_TOGGLES: { key: keyof EffectiveGovernance; label: string; hint: string }[] = [
  { key: "requireStopLoss", label: "Require Stop Loss", hint: "Refuse live orders without an SL." },
  { key: "requireTakeProfit", label: "Require Take Profit", hint: "Refuse live orders without a TP." },
  { key: "requireSecondConfirm", label: "Require Second Confirmation", hint: "Add a second confirm step before dispatch." },
  { key: "enforceSymbolAllowlist", label: "Enforce Symbol Allowlist", hint: "Only allow symbols on the allowlist." },
  { key: "enforceAllocationLimit", label: "Enforce Allocation Limit", hint: "Apply the app margin/allocation proxy." },
  { key: "enforceMarketHoursAppCheck", label: "App Market-Hours Check", hint: "Block outside app-defined market hours." },
  { key: "requireSpreadLimit", label: "Enforce Spread Limit", hint: "Block when spread exceeds the limit." },
  { key: "requireScannerSignal", label: "Require Scanner Signal", hint: "Only trade with a fresh scanner signal." },
  { key: "requireRubyExplanation", label: "Require Ruby Explanation", hint: "Require a Ruby read before trading." },
  { key: "requireBacktest", label: "Require Backtest", hint: "Require a backtest before trading." },
  { key: "requireNewsCheck", label: "Require News Check", hint: "Require a news check before trading." },
  { key: "requireRiskReward", label: "Require Risk/Reward", hint: "Require an R:R on the ticket." },
];

// Allowed-action toggles: ON = action allowed. Maps to allow* columns.
const ALLOW_TOGGLES: { key: keyof EffectiveGovernance; label: string }[] = [
  { key: "allowMarketOrders", label: "Allow Market Orders" },
  { key: "allowPendingOrders", label: "Allow Pending Orders" },
  { key: "allowChartTrading", label: "Allow Chart Trading" },
  { key: "allowReverse", label: "Allow Reverse" },
  { key: "allowPartialClose", label: "Allow Partial Close" },
  { key: "allowBreakEven", label: "Allow Break-Even" },
  { key: "allowOneClick", label: "Allow One-Click / Single Confirm" },
];

const NUMERIC_FIELDS: { key: keyof EffectiveGovernance; label: string; step: string; hint: string }[] = [
  { key: "maxLotPerTrade", label: "Max Lot Per Trade", step: "0.01", hint: "Blank = no cap." },
  { key: "maxOpenPositions", label: "Max Open Positions", step: "1", hint: "Blank = no cap." },
  { key: "maxDailyLossUsd", label: "Max Daily Loss (USD)", step: "1", hint: "Blank = no cap." },
  { key: "spreadLimitPoints", label: "Spread Limit (points)", step: "1", hint: "Used when Spread Limit is on." },
];

const PERMANENT_CHECKS = [
  "16-gate Phase B evaluator",
  "Server master switch + DB arm flag",
  "Kill switch (TOCTOU re-check)",
  "Bridge heartbeat ≤ 15s + EA flags",
  "Account type / terminal / algo-trading truth",
  "Manual confirmation (no auto-place / auto-close)",
  "Ledger, ownership filtering, master-account privacy",
  "Broker symbol / lot / price truth (final authority)",
  "Stop-loss physics sanity (wrong-side / typo)",
];

export function GovernancePanel() {
  const { name } = useAssistantName();
  const [gov, setGov] = useState<EffectiveGovernance | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numericDraft, setNumericDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchGovernance();
      if (res.ok) {
        setGov(res.effective);
        setNumericDraft({});
        setError(null);
      } else {
        setError("Could not load governance settings.");
      }
    } catch {
      setError("Could not load governance settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async (patch: Record<string, unknown>, busyKey: string) => {
    setSaving(busyKey);
    try {
      const res = await patchGovernance(patch);
      if (res.ok) { setGov(res.effective); setNumericDraft({}); setError(null); }
      else setError("Update was rejected.");
    } catch {
      setError("Update failed.");
    } finally {
      setSaving(null);
    }
  }, []);

  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading governance…
        </CardContent>
      </Card>
    );
  }

  if (!gov) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Governance unavailable</AlertTitle>
        <AlertDescription>{error ?? "No governance data."}</AlertDescription>
      </Alert>
    );
  }

  if (!gov.isPrivileged) {
    return (
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Protective defaults apply</AlertTitle>
        <AlertDescription className="text-xs">
          This account uses the standard protective trading defaults. Governance
          overrides are available for owner/admin accounts only.
        </AlertDescription>
      </Alert>
    );
  }

  const controlOff = !gov.ownerLiveControlMode;

  return (
    <div className="space-y-4" data-testid="governance-panel">
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Master switch */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            Owner Live Control Mode
            <Badge className="bg-success/15 text-success border-success/30">
              {gov.ownerLiveControlMode ? "ON — governance-driven" : "OFF — protective defaults"}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            When ON, every app-added restriction below is OFF unless you turn it
            on. When OFF, this account falls back to the standard protective
            defaults. Permanent safety checks always apply either way.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label className="text-sm">Governance-driven (no training wheels)</Label>
            <Switch
              checked={gov.ownerLiveControlMode}
              disabled={saving != null}
              onCheckedChange={(v) => apply({ ownerLiveControlMode: v }, "ownerLiveControlMode")}
              data-testid="gov-owner-live-control-mode"
            />
          </div>
        </CardContent>
      </Card>

      {/* Requirement toggles */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base">Trade requirements</CardTitle>
          <CardDescription className="text-xs">
            Turn a requirement ON to re-enable that app-added block.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {REQUIRE_TOGGLES.map((t) => (
            <div key={t.key} className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">{t.label.replace(/Ruby/g, name)}</div>
                <div className="text-xs text-muted-foreground">{t.hint.replace(/Ruby/g, name)}</div>
              </div>
              <Switch
                checked={Boolean(gov[t.key])}
                disabled={controlOff || saving != null}
                onCheckedChange={(v) => apply({ [t.key]: v }, String(t.key))}
                data-testid={`gov-${t.key}`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Numeric caps */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base">Sizing &amp; loss caps</CardTitle>
          <CardDescription className="text-xs">Leave blank for no app cap. Press Save per field.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {NUMERIC_FIELDS.map((f) => {
            const current = gov[f.key] as number | null;
            const draft = numericDraft[f.key] ?? (current == null ? "" : String(current));
            return (
              <div key={f.key} className="flex items-end justify-between gap-3">
                <div className="flex-1">
                  <Label className="text-sm">{f.label}</Label>
                  <div className="text-xs text-muted-foreground">{f.hint}</div>
                </div>
                <Input
                  type="number"
                  step={f.step}
                  value={draft}
                  disabled={controlOff || saving != null}
                  className="w-28"
                  onChange={(e) => setNumericDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  data-testid={`gov-${f.key}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlOff || saving != null}
                  onClick={() => {
                    const raw = (numericDraft[f.key] ?? "").trim();
                    const val = raw === "" ? null : Number(raw);
                    if (val != null && !Number.isFinite(val)) { setError("Enter a valid number."); return; }
                    apply({ [f.key]: val }, String(f.key));
                  }}
                  data-testid={`gov-${f.key}-save`}
                >
                  {saving === f.key ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Allowed actions */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base">Allowed actions</CardTitle>
          <CardDescription className="text-xs">Turn OFF to disallow that action for this account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ALLOW_TOGGLES.map((t) => (
            <div key={t.key} className="flex items-center justify-between gap-3">
              <Label className="text-sm">{t.label}</Label>
              <Switch
                checked={Boolean(gov[t.key])}
                disabled={controlOff || saving != null}
                onCheckedChange={(v) => apply({ [t.key]: v }, String(t.key))}
                data-testid={`gov-${t.key}`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Permanent checks — read-only context */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" /> Always enforced (not changeable)
          </CardTitle>
          <CardDescription className="text-xs">
            These are permanent technical / security / broker-truth checks. They
            run for every account regardless of the toggles above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {PERMANENT_CHECKS.map((c) => (
              <li key={c} className="flex items-center gap-2">
                <Badge variant="outline" className="border-border text-txt-secondary">locked</Badge>
                {c}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
