import React, { useState, useEffect } from "react";
import {
  useGetRiskSettings,
  useUpdateRiskSettings,
  useApplyRiskMode,
  useSetLiveLock,
  useGetRiskAudit,
  useGetPositionSize,
  useEmergencyStop,
  useUpdateBotStatus,
  useGetBotStatus,
  getGetRiskSettingsQueryKey,
  getGetRiskAuditQueryKey,
  getGetPositionSizeQueryKey,
  getGetBotStatusQueryKey,
  type RiskAudit,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  ShieldAlert, ShieldCheck, ShieldX, Zap, AlertTriangle, Lock, Unlock,
  PauseCircle, XCircle, CalculatorIcon, TrendingDown, Activity,
  ChevronRight, BarChart3, Target, Timer, Hash,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DisclaimerBanner } from "@/components/compliance/DisclaimerBanner";
import { useLiveAccountSnapshot } from "@/hooks/useLiveAccountSnapshot";
import { CanonicalBalancePanel } from "@/components/account/CanonicalBalancePanel";
import { RiskLimitLayersPanel, RISK_LIMIT_LAYERS_QUERY_KEY } from "@/components/risk/RiskLimitLayersPanel";

// ── Risk mode config ─────────────────────────────────────────────────────────

type PresetMode = "Conservative" | "Balanced" | "Aggressive";
interface PresetLimits {
  riskPerTradePct: number; maxDailyLossPct: number; maxWeeklyLossPct: number;
  maxTradesPerDay: number; stopAfterLosingStreak: number; minConfidenceScore: number;
  maxOpenTrades: number; cooldownAfterLossMinutes: number; maxLotSize: number;
}

// The values POST /risk/mode writes for each preset (RISK_PRESETS in the
// api-server's routes/risk.ts). The saved risk-mode label and the limits are
// stored separately, so a label is "Active" only while the stored limits
// still equal these values.
const PRESET_LIMITS: Record<PresetMode, PresetLimits> = {
  Conservative: { riskPerTradePct: 0.25, maxDailyLossPct: 1, maxWeeklyLossPct: 3, maxTradesPerDay: 3, stopAfterLosingStreak: 2,
    minConfidenceScore: 80, maxOpenTrades: 1, cooldownAfterLossMinutes: 60, maxLotSize: 0.05 },
  Balanced: { riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, stopAfterLosingStreak: 3,
    minConfidenceScore: 75, maxOpenTrades: 2, cooldownAfterLossMinutes: 30, maxLotSize: 0.1 },
  Aggressive: { riskPerTradePct: 1, maxDailyLossPct: 3, maxWeeklyLossPct: 7, maxTradesPerDay: 8, stopAfterLosingStreak: 3,
    minConfidenceScore: 70, maxOpenTrades: 3, cooldownAfterLossMinutes: 15, maxLotSize: 0.2 },
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const PRESET_FIELDS: { key: keyof PresetLimits; label: string; fmt: (v: number) => string }[] = [
  { key: "riskPerTradePct", label: "Risk/Trade", fmt: (v) => `${v}%` },
  { key: "maxDailyLossPct", label: "Daily Limit", fmt: (v) => `${v}%` },
  // The settings API reports a missing weekly cap as 0.
  { key: "maxWeeklyLossPct", label: "Weekly Limit", fmt: (v) => (v > 0 ? `${v}%` : "no weekly cap") },
  { key: "maxTradesPerDay", label: "Max Trades", fmt: (v) => `${v}/day` },
  { key: "stopAfterLosingStreak", label: "Loss Streak", fmt: (v) => plural(v, "trade") },
  { key: "minConfidenceScore", label: "Min Confidence", fmt: (v) => `${v}%` },
  { key: "maxOpenTrades", label: "Max Open", fmt: (v) => plural(v, "trade") },
  { key: "cooldownAfterLossMinutes", label: "Cooldown", fmt: (v) => `${v} min` },
  { key: "maxLotSize", label: "Max Lot", fmt: (v) => plural(v, "lot") },
];

function isPresetMode(mode: string | null | undefined): mode is PresetMode {
  return mode === "Conservative" || mode === "Balanced" || mode === "Aggressive";
}

// PLATFORM_RISK_CEILINGS.maxLotSize in the api-server's riskGovernor/preTrade.ts.
// GET /risk/settings reports a trader with no lot cap of their own as this
// value, so at or above it the number is not (only) a stored cap.
const PLATFORM_LOT_CEILING = 5;

/** What the settings read says about one limit, and where the number comes from. */
function storedText(key: keyof PresetLimits, v: unknown, fmt: (v: number) => string): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "not reported";
  if (key === "maxLotSize") {
    if (Math.abs(v - PLATFORM_LOT_CEILING) < 1e-6) return `no lot cap of your own below the platform ceiling (${fmt(v)})`;
    if (v > PLATFORM_LOT_CEILING) return `${fmt(v)} stored, above the platform ceiling of ${fmt(PLATFORM_LOT_CEILING)}`;
  }
  return `${fmt(v)} stored`;
}

/** Stored limits that are not the preset's value, worded "stored, preset". */
function presetDiffs(mode: PresetMode, stored: Partial<Record<keyof PresetLimits, unknown>>) {
  const preset = PRESET_LIMITS[mode];
  return PRESET_FIELDS.flatMap((f) => {
    const v = stored[f.key];
    if (typeof v === "number" && Math.abs(v - preset[f.key]) < 1e-6) return [];
    return [`${f.label}: ${storedText(f.key, v, f.fmt)}, preset ${f.fmt(preset[f.key])}`];
  });
}

const MODES = {
  Conservative: {
    icon: ShieldCheck,
    color: "text-success",
    border: "border-success/40",
    bg: "bg-success/10",
    activeBg: "bg-success/15",
    badge: "bg-success/20 text-success border-success/30",
    stats: PRESET_FIELDS.map((f) => ({ label: f.label, value: f.fmt(PRESET_LIMITS.Conservative[f.key]) })),
    description: "Capital preservation first. Tight limits, high confidence bar. Ideal for volatile market conditions.",
  },
  Balanced: {
    icon: ShieldAlert,
    color: "text-blue-400",
    border: "border-blue-500/40",
    bg: "bg-blue-500/5",
    activeBg: "bg-blue-500/15",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    stats: PRESET_FIELDS.map((f) => ({ label: f.label, value: f.fmt(PRESET_LIMITS.Balanced[f.key]) })),
    description: "Optimized for consistent growth. Balanced exposure across all market conditions.",
  },
  Aggressive: {
    icon: Zap,
    color: "text-orange-400",
    border: "border-orange-500/40",
    bg: "bg-orange-500/5",
    activeBg: "bg-orange-500/15",
    badge: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    stats: PRESET_FIELDS.map((f) => ({ label: f.label, value: f.fmt(PRESET_LIMITS.Aggressive[f.key]) })),
    description: "Maximum opportunity capture. Higher drawdown tolerance. Use only in favorable conditions.",
  },
  Custom: {
    icon: BarChart3,
    color: "text-violet-400",
    border: "border-violet-500/40",
    bg: "bg-violet-500/5",
    activeBg: "bg-violet-500/15",
    badge: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    stats: [] as { label: string; value: string }[],
    description: "Full manual control. Every parameter editable. Your rules, your risk.",
  },
};

const MISMATCH_BADGE = "bg-yellow-500/20 text-yellow-300 border-yellow-500/30";
// Nothing read means nothing to show: no mode, limit, rule or lock state is
// assumed while GET /risk/settings has failed.
const SETTINGS_UNREAD = "could not be loaded";

// React Query keeps the last good `data` when a later read fails. While the
// latest read has failed (or is being retried after a failure) that data is
// not current, so no verdict or state is shown from it.
const latestReadFailed = (q: { isError: boolean; failureCount: number }) => q.isError || q.failureCount > 0;
const lastReadText = (dataUpdatedAt: number | undefined) =>
  dataUpdatedAt && dataUpdatedAt > 0 ? `the last successful read was at ${new Date(dataUpdatedAt).toLocaleTimeString()}` : "";

// ── Custom limits form schema ────────────────────────────────────────────────

const limitsSchema = z.object({
  riskPerTradePct:          z.coerce.number().min(0.01).max(10),
  maxDailyLossPct:          z.coerce.number().min(0.1).max(20),
  // 0 is the store's "no weekly cap" (user_risk_settings keeps NULL, the
  // governor applies no weekly % limit). Saving it keeps the cap off.
  maxWeeklyLossPct:         z.coerce.number().refine((v) => v === 0 || (v >= 0.1 && v <= 50), {
    message: "Set a weekly cap between 0.1% and 50%.",
  }),
  maxTradesPerDay:          z.coerce.number().min(1).max(500),
  maxOpenTrades:            z.coerce.number().min(1).max(50),
  maxLotSize:               z.coerce.number().min(0.01).max(100),
  stopAfterLosingStreak:    z.coerce.number().min(1).max(20),
  cooldownAfterLossMinutes: z.coerce.number().min(0).max(1440),
  minConfidenceScore:       z.coerce.number().min(0).max(100),
  disableDuringAbnormalVolatility: z.boolean(),
});

// ── Position calculator schema ───────────────────────────────────────────────

const calcSchema = z.object({
  symbol:         z.string().min(1),
  accountBalance: z.coerce.number().min(1),
  riskPercent:    z.coerce.number().min(0.01).max(100),
  entry:          z.coerce.number().min(0.000001),
  stopLoss:       z.coerce.number().min(0.000001),
});

// ── Reusable Stat Row ────────────────────────────────────────────────────────

function StatRow({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-right">
        <span className="text-sm font-mono font-semibold text-foreground">{value}</span>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

// ── Live mode lock copy ──────────────────────────────────────────────────────
// risk_settings.liveLocked is a stored preference: the permission status and
// checklists list it as a blocker, but no order path reads it.

const LIVE_LOCK_ON_NOTE =
  "Saved as a preference. Your permission status and checklists now list it as a blocker, but orders are not checked against it. To stop new orders, use \"Pause my trading\" in Risk Command Center.";
const LIVE_LOCK_OFF_NOTE =
  "This does not enable live trading: live orders still need live arming and must pass the Risk Governor.";

// ── What the risk audit read ─────────────────────────────────────────────────
// GET /risk/audit is the legacy audit: it measures loss % against a $1,000
// placeholder balance (balanceSource) and counts trades in the retired legacy
// trades table (tradeSource / measuredFrom), the trader's own rows or every
// account's (scope / tradeScope). Daily / weekly loss, the losing streak and
// the cooldown are measurements only when the server says it counted closed
// rows (closedTradesMeasured) and does not list them in notMeasured. A server
// that does not say what it read is treated as the unscoped, unmeasured case:
// the page only ever downgrades. Daily / weekly loss is only part of the loss
// when closed rows with UNKNOWN P/L were left out of it (partlyMeasured, or
// the unknownPnlRows* counts alone): never a pass, never the whole loss.

const LEGACY_AUDIT_NOT_MEASURED = ["dailyLossUsed", "weeklyLossUsed", "losingStreak", "cooldownActive"];

function auditBasis(a: RiskAudit) {
  const placeholder = !a.balanceSource || a.balanceSource.startsWith("PLACEHOLDER");
  const source = a.tradeSource ?? a.measuredFrom;
  const legacyLog = !source || source === "LEGACY_TRADES_TABLE";
  // Own rows only when the server says so and nothing it says contradicts it.
  const ownRowsOnly =
    (a.scope === "USER" || a.tradeScope === "USER") && a.scope !== "ALL_USERS" && a.tradeScope !== "ALL_ACCOUNTS";
  const scopeReported = a.scope != null || a.tradeScope != null;
  const allAccounts = !ownRowsOnly;
  const notMeasured = new Set(a.notMeasured ?? []);
  if (a.closedTradesMeasured !== true) for (const f of LEGACY_AUDIT_NOT_MEASURED) notMeasured.add(f);
  const lossMeasured = !LEGACY_AUDIT_NOT_MEASURED.some((f) => notMeasured.has(f));
  const unknownToday = a.unknownPnlRowsToday ?? null;
  const unknownWeek = a.unknownPnlRowsThisWeek ?? null;
  const partlyMeasured = new Set((a.partlyMeasured ?? []).filter((f) => !notMeasured.has(f)));
  if ((unknownToday ?? 0) > 0 && !notMeasured.has("dailyLossUsed")) partlyMeasured.add("dailyLossUsed");
  if ((unknownWeek ?? 0) > 0 && !notMeasured.has("weeklyLossUsed")) partlyMeasured.add("weeklyLossUsed");
  const partlyLabel = partlyMeasured.has("dailyLossUsed") && partlyMeasured.has("weeklyLossUsed")
    ? "daily and weekly loss"
    : partlyMeasured.has("dailyLossUsed") ? "daily loss" : partlyMeasured.has("weeklyLossUsed") ? "weekly loss" : null;
  const lossFullyMeasured = lossMeasured && partlyLabel == null;
  const balance = a.accountBalanceUsed ?? 1000;
  const notes: string[] = [];
  if (placeholder) notes.push(`Loss % is measured against a $${balance.toLocaleString("en-US")} placeholder balance, not your live balance.`);
  if (legacyLog) {
    const whose = ownRowsOnly
      ? "your rows in the legacy simulated trades table"
      : scopeReported
        ? "every user's rows in the legacy simulated trades table (not only yours)"
        : "the legacy simulated trades table (the server did not say whose rows were counted, so they may not be only yours)";
    notes.push(`Trade counts come from ${whose}, which takes no new trades: trades you place now are not in it.`);
  }
  if (notMeasured.has("dailyLossUsed") || notMeasured.has("losingStreak")) {
    notes.push("Daily loss, weekly loss and losing streak are not measured: no closed trade in that log is counted.");
  }
  if (partlyLabel != null) {
    notes.push(`Closed trades with unknown P/L are left out of ${partlyLabel}, so it is only part of the loss.`);
  }
  if (placeholder || legacyLog) {
    notes.push("Shown for review only: the Risk Governor checks your orders against your own book when they are placed; see Risk Command Center.");
  }
  const evaluated = a.evaluatedAt ? new Date(a.evaluatedAt) : null;
  const asOf = evaluated && !Number.isNaN(evaluated.getTime()) ? evaluated.toLocaleTimeString() : null;
  return {
    legacy: placeholder || legacyLog, placeholder, legacyLog, ownRowsOnly, scopeReported, allAccounts,
    notMeasured, lossMeasured, partlyMeasured, partlyLabel, lossFullyMeasured, unknownToday, unknownWeek, balance, notes, asOf,
  };
}

type AuditBasis = ReturnType<typeof auditBasis>;

// ── Risk Audit Banner ────────────────────────────────────────────────────────

/** pass: a verified pass (green). legacy: no rule tripped on the legacy basis (neutral, never green). */
type AuditVerdict = { tone: "pass" | "legacy" | "unmeasured" | "tripped"; headline: string };

type HaltRead = { engaged: boolean; sources: string[]; reason: string | null; venues: string[] } | null | undefined;

/** Where an engaged stop switch is released, by which switch it is. */
export function haltReleaseHint(sources: string[]): string {
  const parts: string[] = [];
  if (sources.includes("trader_kill_switch")) {
    parts.push("Your own kill switch: release it with Resume on Risk Command Center (Audit tab).");
  }
  if (sources.includes("safety_core_kill_switch") || sources.includes("platform_emergency_stop")) {
    parts.push("Platform-wide stop: it halts every trader, and an operator (admin or owner) releases it on the Emergency page.");
  }
  return parts.join(" ");
}

/**
 * The banner may say a check passed only when the server measured it, and a
 * pass on a placeholder balance / legacy log is not a verified pass: it is
 * shown neutral, never green.
 */
function riskAuditVerdict(audit: { passed: boolean; tradingHalt?: HaltRead }, basis: AuditBasis): AuditVerdict {
  if (audit.tradingHalt?.engaged) return { tone: "tripped", headline: "New trades are halted: a stop switch is engaged" };
  const name = basis.legacy ? "Legacy risk audit" : "Risk audit";
  if (!audit.passed) return { tone: "tripped", headline: `${name}: a rule is tripped` };
  if (!basis.lossMeasured) {
    return { tone: "unmeasured", headline: `${name}: daily / weekly loss and losing streak were not measured` };
  }
  if (basis.partlyLabel != null) {
    return { tone: "unmeasured", headline: `${name}: ${basis.partlyLabel} is not fully measured (closed trades with unknown P/L)` };
  }
  if (basis.legacy) return { tone: "legacy", headline: "Legacy risk audit: no rule tripped — not a check of your live account" };
  return { tone: "pass", headline: "Risk audit: no rule tripped" };
}

export function AuditBanner({ symbol }: { symbol?: string }) {
  const auditParams = symbol ? { symbol } : {};
  const auditQ = useGetRiskAudit(
    auditParams,
    { query: { queryKey: getGetRiskAuditQueryKey(auditParams), refetchInterval: 30_000 } }
  );
  const { data: audit, isLoading } = auditQ;

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  // No audit read is no verdict: say so where the verdict normally sits. A
  // later read that failed (or is being retried) leaves the old verdict
  // unproven, so it is not shown as current.
  if (!audit || latestReadFailed(auditQ)) {
    const last = audit ? lastReadText(auditQ.dataUpdatedAt) : "";
    return (
      <div
        className="flex items-center gap-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-5 py-3"
        data-testid="risk-audit-banner"
      >
        <AlertTriangle className="h-6 w-6 shrink-0 text-yellow-400" />
        <div className="min-w-0" data-testid="risk-audit-banner-unavailable">
          <p className="font-semibold text-sm text-yellow-300" data-testid="risk-audit-banner-error">Risk audit could not be loaded</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {audit
              ? `The latest read failed, so no risk verdict is shown${last ? `; ${last}` : ""}. It is retried every 30 seconds.`
              : "No risk verdict is shown, because none was read. It is retried every 30 seconds."}
          </p>
        </div>
      </div>
    );
  }
  const basis = auditBasis(audit);
  const verdict = riskAuditVerdict(audit, basis);

  return (
    <div
      data-testid="risk-audit-banner"
      className={cn(
        "flex items-center gap-4 rounded-lg border px-5 py-3",
        verdict.tone === "pass"
          ? "border-success/30 bg-success/10"
          : verdict.tone === "legacy"
            ? "border-border/50 bg-muted/20"
            : verdict.tone === "unmeasured"
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-red-500/30 bg-red-500/5"
      )}
    >
      <div className="shrink-0">
        {verdict.tone === "pass"
          ? <ShieldCheck className="h-8 w-8 text-success" />
          : verdict.tone === "legacy"
            ? <ShieldAlert className="h-8 w-8 text-muted-foreground" />
            : verdict.tone === "unmeasured"
              ? <ShieldAlert className="h-8 w-8 text-amber-400" />
              : <ShieldX className="h-8 w-8 text-red-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={cn("font-semibold text-sm",
            verdict.tone === "pass" ? "text-success"
              : verdict.tone === "legacy" ? "text-foreground"
              : verdict.tone === "unmeasured" ? "text-amber-300"
              : "text-red-300")}
          data-testid="risk-audit-headline"
        >
          {verdict.headline}
        </p>
        {!audit.passed && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {audit.reasonsBlocked[0]}
            {audit.reasonsBlocked.length > 1 && ` (+${audit.reasonsBlocked.length - 1} more)`}
          </p>
        )}
        {audit.tradingHalt?.engaged && (
          <p className="text-xs text-red-300 mt-0.5" data-testid="risk-halt-release">
            {haltReleaseHint(audit.tradingHalt.sources)}
          </p>
        )}
        {audit.warnings.length > 0 && audit.passed && (
          <p className="text-xs text-yellow-400/80 truncate mt-0.5">
            ⚠ {audit.warnings[0]}
          </p>
        )}
        {basis.notes.length > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5" data-testid="risk-audit-basis">
            {basis.notes.join(" ")}
          </p>
        )}
      </div>
      <div className="hidden md:flex gap-6 shrink-0 text-center">
        <div>
          <div className="text-xs text-muted-foreground">{basis.placeholder ? `Daily loss (vs $${basis.balance.toLocaleString("en-US")})` : "Daily Loss"}</div>
          <div className="font-mono font-bold text-sm" data-testid="risk-audit-banner-daily-loss">
            {basis.notMeasured.has("dailyLossUsed") ? "Not measured"
              : `${audit.dailyLossUsed.toFixed(1)}%${basis.partlyMeasured.has("dailyLossUsed") ? " (partial)" : ""}`}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{basis.legacyLog ? "Trades left (legacy log)" : "Trades Left"}</div>
          <div className="font-mono font-bold text-sm">{audit.tradesRemaining}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{basis.legacyLog ? "Open (legacy log)" : "Open"}</div>
          <div className="font-mono font-bold text-sm">{audit.openTradesCount}</div>
        </div>
        {audit.cooldownActive && (
          <div>
            <div className="text-xs text-red-400">Cooldown</div>
            <div className="font-mono font-bold text-sm text-red-400">ACTIVE</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bot settings flags ───────────────────────────────────────────────────────

/**
 * What the bot settings flags do. Bot mode, "is running" and the paused flag
 * are stored in your bot settings and echoed back here; no order path (the
 * Risk Governor, the paper autopilot, the live pipeline) reads them, so they
 * do not halt new trades. The Kill switches row shows only the kill switches
 * /risk/audit reads; the governor's other halts on demo and live orders (the
 * broker's operator controls, a frozen shared-account allocation) are not
 * read there, and the note says so.
 */
export const BOT_PAUSE_FLAG_NOTE =
  "Stores a paused flag in your bot settings. No order path reads this flag, so it does not stop new trades. " +
  "To halt new trades on your account, use \"Pause my trading\" on Risk Command Center (Audit tab), which engages your kill switch.";

export const BOT_FLAGS_NOTE =
  "Bot Mode, Is Running and the paused flag are stored bot settings; no order path reads them. " +
  "The Kill switches row shows the platform emergency stop, the safety-core switch and your own kill switch. " +
  "The Risk Governor also refuses new demo and live orders when the broker's operator controls disable execution or a shared-account allocation is frozen; those are not read here.";

// ── Emergency stop scope ─────────────────────────────────────────────────────

type StopScope = "PLATFORM" | "YOUR_ACCOUNT" | undefined;

/** Who the emergency stop halts for this viewer, as the server reports it. */
export function emergencyStopScopeLine(scope: StopScope): string {
  if (scope === "PLATFORM") {
    return "As an operator, you engage the platform-wide safety-core kill switch: new trades stop for every trader on every venue, " +
      "and the platform mode drops to OBSERVE_ONLY, until an operator releases it on the Emergency page.";
  }
  if (scope === "YOUR_ACCOUNT") {
    return "It engages your own kill switch: new trades on your account stop on every venue and live is disarmed, " +
      "until you release it with Resume on Risk Command Center. Other traders are not affected.";
  }
  return "Who it halts could not be loaded: for an operator (admin or owner) it halts every trader on the platform; otherwise only your account.";
}

export const EMERGENCY_STOP_EFFECTS =
  "It cancels open rows in the legacy simulated trades table only: open paper-book and broker positions stay open. It also sets your bot settings to OFF.";

// ── Main Page ────────────────────────────────────────────────────────────────

const VALID_RISK_TABS = ["mode", "limits", "rules", "calculator", "emergency"] as const;
type RiskTab = (typeof VALID_RISK_TABS)[number];

function readTabFromUrl(): RiskTab {
  if (typeof window === "undefined") return "mode";
  const t = new URLSearchParams(window.location.search).get("tab");
  return (VALID_RISK_TABS as readonly string[]).includes(t ?? "")
    ? (t as RiskTab)
    : "mode";
}

export default function RiskSettings() {
  const liveAcct = useLiveAccountSnapshot();
  const [activeTab, setActiveTab] = useState<RiskTab>(() => readTabFromUrl());
  useEffect(() => {
    const onPop = () => setActiveTab(readTabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const handleTabChange = (v: string) => {
    if (!(VALID_RISK_TABS as readonly string[]).includes(v)) return;
    setActiveTab(v as RiskTab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", v);
    window.history.replaceState({}, "", url.toString());
  };

  const { data: settings, isLoading } = useGetRiskSettings();
  // Bot Control and the kill switch elsewhere change this row too, so it is re-read.
  const botQ = useGetBotStatus(
    { query: { queryKey: getGetBotStatusQueryKey(), refetchInterval: 30_000 } },
  );
  const { data: botStatus } = botQ;
  // A failed poll leaves the previous row in `data`; System Status does not
  // show it as current.
  const botStatusFailed = latestReadFailed(botQ);
  const botStatusCurrent = botStatusFailed ? undefined : botStatus;
  // Same query as the audit banner: it also carries the stop-switch read. A
  // read whose latest refetch failed is not a current stop-switch state.
  const auditHaltQ = useGetRiskAudit(
    {},
    { query: { queryKey: getGetRiskAuditQueryKey({}), refetchInterval: 30_000 } }
  );
  const auditHaltFailed = latestReadFailed(auditHaltQ);
  const auditHaltLoading = auditHaltQ.isLoading;
  const halt = auditHaltFailed ? undefined : auditHaltQ.data?.tradingHalt;
  const stopScope = botStatus?.emergencyStopScope;
  const updateSettings = useUpdateRiskSettings();
  const applyMode = useApplyRiskMode();
  const setLiveLock = useSetLiveLock();
  const emergencyStop = useEmergencyStop();
  const updateBotStatus = useUpdateBotStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [confirmKill, setConfirmKill] = useState(false);
  const [calcSymbol, setCalcSymbol] = useState("Volatility 75 Index");

  // ── Limits form ────────────────────────────────────────────────────────────
  const limitsForm = useForm<z.infer<typeof limitsSchema>>({
    resolver: zodResolver(limitsSchema),
    defaultValues: {
      riskPerTradePct: 0.5,
      maxDailyLossPct: 2,
      maxWeeklyLossPct: 5,
      maxTradesPerDay: 5,
      maxOpenTrades: 2,
      maxLotSize: 0.1,
      stopAfterLosingStreak: 3,
      cooldownAfterLossMinutes: 30,
      minConfidenceScore: 75,
      disableDuringAbnormalVolatility: true,
    },
  });

  useEffect(() => {
    if (settings) {
      limitsForm.reset({
        riskPerTradePct:          settings.riskPerTradePct,
        maxDailyLossPct:          settings.maxDailyLossPct,
        maxWeeklyLossPct:         settings.maxWeeklyLossPct,
        maxTradesPerDay:          settings.maxTradesPerDay,
        maxOpenTrades:            settings.maxOpenTrades,
        maxLotSize:               settings.maxLotSize,
        stopAfterLosingStreak:    settings.stopAfterLosingStreak,
        cooldownAfterLossMinutes: settings.cooldownAfterLossMinutes,
        minConfidenceScore:       settings.minConfidenceScore,
        disableDuringAbnormalVolatility: settings.disableDuringAbnormalVolatility,
      });
    }
  }, [settings]);

  // ── Position calculator form ───────────────────────────────────────────────
  const [calcResult, setCalcResult] = useState<null | {
    riskAmount: number; stopDistance: number; suggestedLot: number;
    maxLotAllowed: number; finalLot: number; warning?: string | null;
    // Which instrument-class value model sized the lot. Missing = not
    // reported, so the lot is treated as an estimate.
    valueModel?: string; estimate?: boolean; valuePerUnitPerLot?: number; basis?: string;
    // Set when the Risk Governor refuses every order on this symbol (or
    // side) whatever the lot: no allowed or final lot is shown, only this.
    refusedReason?: string | null;
  }>(null);
  const [calcParams, setCalcParams] = useState<null | {
    symbol: string; accountBalance: number; riskPercent: number;
    entry: number; stopLoss: number;
  }>(null);

  const calcForm = useForm<z.infer<typeof calcSchema>>({
    resolver: zodResolver(calcSchema),
    defaultValues: {
      symbol: "Volatility 75 Index",
      accountBalance: 1000,
      riskPercent: 0.5,
      entry: 100,
      stopLoss: 98,
    },
  });

  const positionSizeQueryKey = getGetPositionSizeQueryKey(
    calcParams ?? { symbol: "", accountBalance: 0, riskPercent: 0, entry: 0, stopLoss: 0 }
  );
  const { data: positionData } = useGetPositionSize(
    calcParams ?? { symbol: "", accountBalance: 0, riskPercent: 0, entry: 0, stopLoss: 0 },
    { query: { queryKey: positionSizeQueryKey, enabled: !!calcParams } }
  );

  useEffect(() => {
    if (positionData) setCalcResult(positionData);
  }, [positionData]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleApplyMode(mode: "Conservative" | "Balanced" | "Aggressive") {
    applyMode.mutate(
      { data: { mode } },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(getGetRiskSettingsQueryKey(), res);
          // The preset rewrote the governor's limits: re-read every view of them.
          queryClient.invalidateQueries({ queryKey: getGetRiskAuditQueryKey() });
          queryClient.invalidateQueries({ queryKey: RISK_LIMIT_LAYERS_QUERY_KEY });
          toast({ title: `${mode} mode applied`, description: "All risk limits updated." });
        },
        onError: () => toast({ title: "Failed to apply mode", variant: "destructive" }),
      }
    );
  }

  function handleSaveLimits(data: z.infer<typeof limitsSchema>) {
    updateSettings.mutate(
      { data },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(getGetRiskSettingsQueryKey(), res);
          queryClient.invalidateQueries({ queryKey: getGetRiskAuditQueryKey() });
          queryClient.invalidateQueries({ queryKey: RISK_LIMIT_LAYERS_QUERY_KEY });
          toast({ title: "Custom limits saved", description: "Risk parameters updated." });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      }
    );
  }

  function handleSaveSpecialRules(patch: Partial<{
    vol75ExtraConfidence: boolean; vol75SmallLot: boolean;
    us30BlockNews: boolean; stocksBlockEarnings: boolean; forexBlockEvents: boolean;
    disableDuringAbnormalVolatility: boolean;
  }>) {
    updateSettings.mutate(
      { data: patch },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(getGetRiskSettingsQueryKey(), res);
          queryClient.invalidateQueries({ queryKey: getGetRiskAuditQueryKey() });
          toast({ title: "Special rules saved" });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      }
    );
  }

  function handleToggleLiveLock() {
    const next = !settings?.liveLocked;
    setLiveLock.mutate(
      { data: { locked: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRiskSettingsQueryKey() });
          // The lock is a stored preference: no order path reads it (live
          // dispatch is gated by live arming and the Risk Governor), so the
          // toast never says live trading is now permitted or stopped.
          toast({
            title: next ? "Live mode lock saved" : "Live mode lock removed",
            description: next ? LIVE_LOCK_ON_NOTE : LIVE_LOCK_OFF_NOTE,
          });
        },
        onError: () => toast({ title: "Failed to toggle lock", variant: "destructive" }),
      }
    );
  }

  function handleEmergencyStop() {
    emergencyStop.mutate(undefined, {
      onSuccess: (res) => {
        setConfirmKill(false);
        queryClient.invalidateQueries({ queryKey: getGetRiskAuditQueryKey() });
        // The stop set the bot OFF and engaged a kill switch: re-read both.
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: RISK_LIMIT_LAYERS_QUERY_KEY });
        toast({
          title: res.scope === "PLATFORM" ? "⛔ Platform-wide emergency stop engaged" : "⛔ Emergency stop engaged",
          description: res.message,
          variant: "destructive",
        });
      },
      onError: () => toast({ title: "Emergency stop failed", variant: "destructive" }),
    });
  }

  function handlePauseTrading() {
    updateBotStatus.mutate(
      { data: { isPaused: true } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
          toast({ title: "Bot paused flag set", description: BOT_PAUSE_FLAG_NOTE });
        },
        onError: () => toast({ title: "Could not set the bot paused flag", variant: "destructive" }),
      }
    );
  }

  function handleResumeTrading() {
    updateBotStatus.mutate(
      { data: { isPaused: false } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
          toast({ title: "Bot paused flag cleared", description: BOT_PAUSE_FLAG_NOTE });
        },
        onError: () => toast({ title: "Could not clear the bot paused flag", variant: "destructive" }),
      }
    );
  }

  function handleCalcSubmit(data: z.infer<typeof calcSchema>) {
    setCalcParams(data);
    setCalcSymbol(data.symbol);
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6 pb-32 md:pb-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const currentMode: string | null = settings?.riskMode ?? null;
  const modeConfig = MODES[currentMode as keyof typeof MODES] ?? MODES.Custom;
  const ModeIcon = modeConfig.icon;
  // The label is stored apart from the limits (a fresh trader, or a Risk
  // Command Center preset, leaves it unchanged), so it only names the
  // limits in force while they still equal that preset.
  const labelDiffs = settings && isPresetMode(currentMode) ? presetDiffs(currentMode, settings) : [];
  const labelMismatch = labelDiffs.length > 0;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-6 pb-32 md:pb-6 animate-in fade-in duration-500">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldAlert className="text-primary" />
            Risk Control Center
          </h2>
          <p className="text-muted-foreground text-sm">
            Professional risk management across all markets and strategies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-w-full min-w-0">
          {settings ? (
            <Badge
              className={cn("px-3 py-1 font-semibold border", labelMismatch ? MISMATCH_BADGE : modeConfig.badge)}
              data-testid="risk-mode-badge"
            >
              <ModeIcon size={13} className="mr-1.5" />
              {labelMismatch ? `${currentMode} label · limits differ` : `${currentMode} Mode`}
            </Badge>
          ) : (
            <Badge className="bg-red-500/20 text-red-300 border-red-500/30 px-3 py-1 border" data-testid="risk-mode-badge">
              <AlertTriangle size={12} className="mr-1.5" /> Risk settings {SETTINGS_UNREAD}
            </Badge>
          )}
          {settings?.liveLocked && (
            <Badge className="bg-muted/40 text-muted-foreground border-border/50 px-3 py-1 border" data-testid="live-lock-badge">
              <Lock size={12} className="mr-1.5" /> Live lock on (preference)
            </Badge>
          )}
          {halt?.engaged && (
            <Badge className="bg-red-500/20 text-red-300 border-red-500/30 px-3 py-1 border" data-testid="risk-halt-badge">
              <XCircle size={12} className="mr-1.5" /> New trades halted
            </Badge>
          )}
          {botStatusCurrent?.isPaused && (
            <Badge className="bg-yellow-500/20 text-yellow-300 border-yellow-500/30 px-3 py-1 border" data-testid="bot-paused-flag-badge">
              <PauseCircle size={12} className="mr-1.5" /> Bot paused flag set
            </Badge>
          )}
        </div>
      </div>

      {/* Canonical balance (Task #430) — the same live equity as the
          Dashboard, account, Open Trades, wallet and admin. The legacy risk
          audit below is NOT measured against it (it uses a placeholder
          balance and says so). */}
      <CanonicalBalancePanel live={liveAcct.live} title="Live balance" />

      {/* ── Compliance + Risk Audit Banner ── */}
      <DisclaimerBanner kind="riskCenter" />
      <AuditBanner />

      {/* ── Main Tabs ── */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="mode" className="gap-1.5 text-xs sm:text-sm">
            <ShieldAlert size={14} /> Mode
          </TabsTrigger>
          <TabsTrigger value="limits" className="gap-1.5 text-xs sm:text-sm">
            <Target size={14} /> Limits
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-1.5 text-xs sm:text-sm">
            <Activity size={14} /> Rules
          </TabsTrigger>
          <TabsTrigger value="calculator" className="gap-1.5 text-xs sm:text-sm">
            <CalculatorIcon size={14} /> Sizer
          </TabsTrigger>
          <TabsTrigger value="emergency" className="gap-1.5 text-xs sm:text-sm text-red-400 data-[state=active]:text-red-400">
            <AlertTriangle size={14} /> Emergency
          </TabsTrigger>
        </TabsList>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 1 — RISK MODE
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="mode" className="space-y-4">
          {!settings && (
            <Alert className="border-red-500/30 bg-red-500/5" data-testid="risk-settings-load-error">
              <AlertTriangle className="h-4 w-4 text-red-400" />
              <AlertTitle className="text-red-300 text-sm">Your risk settings {SETTINGS_UNREAD}</AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                No mode is marked active and no limits, rules or lock state are shown, because none were read.
                Applying a preset still writes that preset's values.
              </AlertDescription>
            </Alert>
          )}
          {labelMismatch && (
            <Alert className="border-yellow-500/30 bg-yellow-500/5" data-testid="risk-mode-mismatch">
              <AlertTriangle className="h-4 w-4 text-yellow-400" />
              <AlertTitle className="text-yellow-300 text-sm">
                Saved label is {currentMode}, but your stored limits are not the {currentMode} preset
              </AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground space-y-1">
                <ul className="list-disc list-inside">
                  {labelDiffs.map((d) => <li key={d}>{d}</li>)}
                </ul>
                <p>
                  Orders are checked against your stored limits, or a stricter operator or platform limit,
                  as listed under Limits in force on the Limits tab. Re-apply the preset to write its values.
                </p>
              </AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(["Conservative", "Balanced", "Aggressive", "Custom"] as const).map((mode) => {
              const cfg = MODES[mode];
              const Icon = cfg.icon;
              const labelled = currentMode === mode;
              const isActive = labelled && !labelMismatch;
              const labelOnly = labelled && labelMismatch;
              return (
                <Card
                  key={mode}
                  data-testid={`risk-mode-card-${mode}`}
                  className={cn(
                    "cursor-pointer border-2 transition-all duration-200",
                    isActive ? `${cfg.border} ${cfg.activeBg}` : "border-border/40 hover:border-border"
                  )}
                  onClick={() => mode !== "Custom" && handleApplyMode(mode as "Conservative" | "Balanced" | "Aggressive")}
                >
                  <CardHeader className="pb-3">
                    <CardTitle className={cn("flex items-center gap-2 text-lg", isActive && cfg.color)}>
                      <Icon size={20} className={isActive ? cfg.color : "text-muted-foreground"} />
                      {mode}
                      {isActive && (
                        <Badge className={cn("ml-auto text-xs border", cfg.badge)}>Active</Badge>
                      )}
                      {labelOnly && (
                        <Badge className={cn("ml-auto text-xs border", MISMATCH_BADGE)}>Saved label · limits differ</Badge>
                      )}
                      {mode === "Custom" && !isActive && (
                        <Badge className="ml-auto text-xs bg-muted/50 text-muted-foreground border border-border">
                          Manual
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="text-xs">{cfg.description}</CardDescription>
                  </CardHeader>
                  {cfg.stats.length > 0 && (
                    <CardContent className="pt-0">
                      <p className="text-[11px] text-muted-foreground mb-1">Applying this preset sets:</p>
                      <div className="grid grid-cols-2 gap-x-4">
                        {cfg.stats.map((s) => (
                          <div key={s.label} className="flex justify-between py-1 border-b border-border/20 last:border-0">
                            <span className="text-xs text-muted-foreground">{s.label}</span>
                            <span className={cn("text-xs font-mono font-semibold", isActive && cfg.color)}>
                              {s.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  )}
                  {mode === "Custom" && (
                    <CardContent className="pt-0">
                      <p className="text-xs text-muted-foreground">
                        Switch to the{" "}
                        <span className="text-violet-400 font-semibold">Limits</span> tab to
                        configure every parameter individually.
                      </p>
                    </CardContent>
                  )}
                  {mode !== "Custom" && (
                    <CardFooter className="pt-0">
                      <Button
                        variant={isActive ? "outline" : "ghost"}
                        size="sm"
                        className={cn(
                          "w-full text-xs gap-1",
                          isActive ? `border-current ${cfg.color}` : ""
                        )}
                        disabled={isActive || applyMode.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleApplyMode(mode as "Conservative" | "Balanced" | "Aggressive");
                        }}
                      >
                        {isActive ? "Currently Active" : labelOnly ? `Re-apply ${mode} Preset` : `Apply ${mode} Preset`}
                        {!isActive && <ChevronRight size={12} />}
                      </Button>
                    </CardFooter>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Risk tolerance visual */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal">Risk Tolerance Spectrum</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative pt-2 pb-4">
                <div className="h-2 rounded-full bg-gradient-to-r from-emerald-500 via-blue-500 via-orange-400 to-red-500" />
                {settings && <div
                  className="absolute top-0 w-4 h-4 rounded-full border-2 border-background shadow-lg transition-all duration-500"
                  style={{
                    left: labelMismatch ? "90%" :
                          currentMode === "Conservative" ? "2%" :
                          currentMode === "Balanced" ? "33%" :
                          currentMode === "Aggressive" ? "65%" : "90%",
                    backgroundColor: labelMismatch ? "#8b5cf6" :
                                     currentMode === "Conservative" ? "#10b981" :
                                     currentMode === "Balanced" ? "#3b82f6" :
                                     currentMode === "Aggressive" ? "#f97316" : "#8b5cf6",
                  }}
                />}
                <div className="flex justify-between text-xs text-muted-foreground mt-3">
                  <span>Safe</span>
                  <span>Balanced</span>
                  <span>Aggressive</span>
                  <span>Custom</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 2 — LIMITS
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="limits">
          <RiskLimitLayersPanel />
          {settings && currentMode !== "Custom" && (
            <Alert className="mb-4 border-blue-500/30 bg-blue-500/5">
              <ShieldAlert className="h-4 w-4 text-blue-400" />
              <AlertTitle className="text-blue-300 text-sm">
                {labelMismatch
                  ? `Saved label ${currentMode} — your stored limits are not that preset`
                  : `Preset Active — ${currentMode}`}
              </AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                Editing any limit below will switch you to <strong className="text-violet-400">Custom</strong> mode automatically.
              </AlertDescription>
            </Alert>
          )}
          {!settings ? (
            <Alert className="border-red-500/30 bg-red-500/5" data-testid="risk-limits-load-error">
              <AlertTriangle className="h-4 w-4 text-red-400" />
              <AlertTitle className="text-red-300 text-sm">Your saved limits {SETTINGS_UNREAD}</AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                The limit editor is hidden so placeholder values cannot be saved over your real limits. Reload the page to try again.
              </AlertDescription>
            </Alert>
          ) : (
          <Form {...limitsForm}>
            <form onSubmit={limitsForm.handleSubmit(handleSaveLimits)}>
              <Card className="border-border/50">
                <CardHeader className="bg-muted/20 border-b border-border/50">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingDown size={16} /> Loss Limits
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-6 p-6 md:grid-cols-3">
                  <FormField control={limitsForm.control} name="riskPerTradePct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Risk Per Trade <span className="font-mono text-primary">{field.value}%</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0.01} max={5} step={0.01}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">% of account per trade</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="maxDailyLossPct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Daily Loss <span className="font-mono text-primary">{field.value}%</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0.1} max={20} step={0.1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Bot halts at this daily drawdown</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="maxWeeklyLossPct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Weekly Loss <span className="font-mono text-primary">{field.value > 0 ? `${field.value}%` : "Off"}</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0.1} max={50} step={0.1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">
                          {field.value > 0
                            ? "Weekly cumulative drawdown cap"
                            : "No weekly cap is set, so no weekly loss % limit blocks trades. Move the slider to set one."}
                        </FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                </CardContent>

                <Separator className="opacity-40" />
                <CardHeader className="bg-muted/20 border-b border-border/50 pt-4">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Hash size={16} /> Trade Quotas
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-6 p-6 md:grid-cols-3">
                  <FormField control={limitsForm.control} name="maxTradesPerDay"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Trades/Day <span className="font-mono text-primary">{field.value}</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={1} max={50} step={1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Total trades allowed per day</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="maxOpenTrades"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Open Trades <span className="font-mono text-primary">{field.value}</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={1} max={20} step={1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Max concurrent positions</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="maxLotSize"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Lot Size <span className="font-mono text-primary">{field.value}</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0.01} max={10} step={0.01}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Absolute lot cap per position</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                </CardContent>

                <Separator className="opacity-40" />
                <CardHeader className="bg-muted/20 border-b border-border/50 pt-4">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Timer size={16} /> Streak &amp; Cooldown
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-6 p-6 md:grid-cols-3">
                  <FormField control={limitsForm.control} name="stopAfterLosingStreak"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Stop After Streak <span className="font-mono text-primary">{field.value}</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={1} max={15} step={1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Consecutive losses before cooldown</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="cooldownAfterLossMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Cooldown (min) <span className="font-mono text-primary">{field.value}m</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0} max={480} step={5}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Pause duration after hitting streak</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="minConfidenceScore"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Min Confidence <span className="font-mono text-primary">{field.value}%</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={50} max={99} step={1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Signals below this are blocked</FormDescription>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )} />
                </CardContent>

                <Separator className="opacity-40" />
                <CardContent className="p-6">
                  <FormField control={limitsForm.control} name="disableDuringAbnormalVolatility"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border/50 p-4 bg-muted/10">
                        <div>
                          <FormLabel className="text-sm font-medium">Spike Protection</FormLabel>
                          <FormDescription className="text-xs" data-testid="spike-protection-desc">
                            Saved preference only. No risk check or trading loop reads it yet, so nothing pauses on abnormal tick volatility.
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )} />
                </CardContent>

                <CardFooter className="bg-muted/10 border-t border-border/50 p-4 flex justify-end">
                  <Button type="submit" disabled={updateSettings.isPending} className="gap-2">
                    Save Custom Limits
                  </Button>
                </CardFooter>
              </Card>
            </form>
          </Form>
          )}
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 3 — SPECIAL RULES
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="rules" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader className="bg-muted/20 border-b border-border/50">
              <CardTitle className="text-base">Synthetic Index Rules</CardTitle>
              <CardDescription className="text-xs">Special guards for Deriv volatility indices</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border/30 px-0">
              {[
                {
                  key: "vol75ExtraConfidence" as const,
                  label: "Volatility 75 (1s) — Extra Confidence",
                  desc: "Adds 10 points to the minimum confidence when a symbol named \"(1s)\" is risk-checked with a confidence score (MT5 order requests and the risk audit).",
                  accent: "text-orange-400",
                },
                {
                  key: "vol75SmallLot" as const,
                  label: "Volatility 75 — Reduced Lot Size",
                  desc: "Saved preference only. The position sizer and risk checks do not read it yet, so it changes no lot size. Separately, the sizer always halves the lot for symbols whose name contains \"1s\", whether this is on or off.",
                  accent: "text-orange-400",
                },
              ].map(({ key, label, desc, accent }) => (
                <div key={key} className="flex items-start justify-between px-6 py-4 gap-4">
                  <div>
                    <p className={cn("text-sm font-medium", accent)}>{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-sm">{desc}</p>
                  </div>
                  <Switch
                    checked={settings?.[key] ?? false}
                    onCheckedChange={(v) => handleSaveSpecialRules({ [key]: v })}
                    disabled={updateSettings.isPending || !settings}
                    className="shrink-0 mt-0.5"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="bg-muted/20 border-b border-border/50">
              <CardTitle className="text-base">News & Event Reminders</CardTitle>
              <CardDescription className="text-xs">
                Reminder warnings added to the risk check for matching symbols. They do not read an economic or earnings calendar and never block a trade.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border/30 px-0">
              {[
                {
                  key: "us30BlockNews" as const,
                  label: "US30 — Major U.S. News Reminder",
                  desc: "Adds a reminder to check NFP, FOMC, CPI and other major U.S. releases when a US30 or DJ30 symbol is risk-checked. It does not check whether news is near.",
                  accent: "text-blue-400",
                },
                {
                  key: "stocksBlockEarnings" as const,
                  label: "Stocks — Earnings Reminder",
                  desc: "Adds a reminder to check for an earnings release when a stock ticker is risk-checked. It does not read an earnings calendar.",
                  accent: "text-blue-400",
                },
                {
                  key: "forexBlockEvents" as const,
                  label: "Forex — Central Bank Reminder",
                  desc: "Adds a reminder to check central bank decisions and high-impact news when a major forex pair is risk-checked. It does not check whether an event is near.",
                  accent: "text-blue-400",
                },
              ].map(({ key, label, desc, accent }) => (
                <div key={key} className="flex items-start justify-between px-6 py-4 gap-4">
                  <div>
                    <p className={cn("text-sm font-medium", accent)}>{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-sm">{desc}</p>
                  </div>
                  <Switch
                    checked={settings?.[key] ?? false}
                    onCheckedChange={(v) => handleSaveSpecialRules({ [key]: v })}
                    disabled={updateSettings.isPending || !settings}
                    className="shrink-0 mt-0.5"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Rules preview */}
          <Card className="border-border/50 bg-muted/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
                <Activity size={14} /> Current Rule Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1" data-testid="rule-summary">
              {!settings && <p className="text-xs text-red-300">Special rules {SETTINGS_UNREAD}</p>}
              {settings && (() => {
                // "applied": a risk check reads it. "reminder": adds warning text
                // only. "saved": stored, but nothing reads it yet.
                const rules: { text: string; kind: "applied" | "reminder" | "saved" }[] = [
                  ...(settings.vol75ExtraConfidence ? [{ kind: "applied" as const,
                    text: "V75 (1s): +10 confidence required when a \"(1s)\" symbol is risk-checked with a confidence score" }] : []),
                  ...(settings.vol75SmallLot ? [{ kind: "saved" as const,
                    text: "V75 reduced lot: saved, not applied. No lot is reduced by this setting" }] : []),
                  ...(settings.disableDuringAbnormalVolatility ? [{ kind: "saved" as const,
                    text: "Spike protection: saved, not applied. Nothing pauses on abnormal volatility" }] : []),
                  ...(settings.us30BlockNews ? [{ kind: "reminder" as const,
                    text: "US30: news reminder added to its risk check. Does not block" }] : []),
                  ...(settings.stocksBlockEarnings ? [{ kind: "reminder" as const,
                    text: "Stocks: earnings reminder added to their risk check. Does not block" }] : []),
                  ...(settings.forexBlockEvents ? [{ kind: "reminder" as const,
                    text: "Forex: central bank reminder added to its risk check. Does not block" }] : []),
                ];
                if (rules.length === 0) {
                  return <p className="text-xs text-muted-foreground">No special rules switched on</p>;
                }
                return rules.map((rule) => (
                  <div key={rule.text} className="flex items-center gap-2 text-xs text-muted-foreground" data-rule-kind={rule.kind}>
                    <div className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                      rule.kind === "applied" ? "bg-success" : rule.kind === "reminder" ? "bg-yellow-400" : "bg-muted-foreground/50")} />
                    {rule.text}
                  </div>
                ));
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 4 — POSITION SIZER
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="calculator" className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="border-border/50">
              <CardHeader className="bg-muted/20 border-b border-border/50">
                <CardTitle className="text-base flex items-center gap-2">
                  <CalculatorIcon size={16} /> Position Sizing Calculator
                </CardTitle>
                <CardDescription className="text-xs">
                  Estimate a lot size from your balance, risk % and stop distance. It uses an instrument-class value model, not your broker&apos;s contract specification.
                </CardDescription>
              </CardHeader>
              <Form {...calcForm}>
                <form onSubmit={calcForm.handleSubmit(handleCalcSubmit)}>
                  <CardContent className="space-y-4 p-6">
                    <FormField control={calcForm.control} name="symbol"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Symbol</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="e.g. Volatility 75 Index" className="font-mono text-sm" />
                          </FormControl>
                        </FormItem>
                      )} />
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={calcForm.control} name="accountBalance"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Account Balance ($)</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.01" {...field} className="font-mono text-sm" />
                            </FormControl>
                          </FormItem>
                        )} />
                      <FormField control={calcForm.control} name="riskPercent"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Risk % Per Trade</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.01" {...field} className="font-mono text-sm" />
                            </FormControl>
                          </FormItem>
                        )} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={calcForm.control} name="entry"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Entry Price</FormLabel>
                            <FormControl>
                              <Input type="number" step="any" {...field} className="font-mono text-sm" />
                            </FormControl>
                          </FormItem>
                        )} />
                      <FormField control={calcForm.control} name="stopLoss"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Stop Loss</FormLabel>
                            <FormControl>
                              <Input type="number" step="any" {...field} className="font-mono text-sm" />
                            </FormControl>
                          </FormItem>
                        )} />
                    </div>
                  </CardContent>
                  <CardFooter className="border-t border-border/50 p-4">
                    <Button type="submit" className="w-full gap-2">
                      <CalculatorIcon size={14} /> Calculate Position Size
                    </Button>
                  </CardFooter>
                </form>
              </Form>
            </Card>

            <Card className="border-border/50">
              <CardHeader className="bg-muted/20 border-b border-border/50">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 size={16} /> Result
                </CardTitle>
                <CardDescription className="text-xs">
                  {calcSymbol && `Analysis for ${calcSymbol}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                {!calcResult ? (
                  <div className="flex flex-col items-center justify-center h-40 text-center gap-2">
                    <CalculatorIcon size={32} className="text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">Enter parameters and calculate</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <StatRow label="Risk Amount" value={`$${calcResult.riskAmount.toFixed(2)}`} />
                    <StatRow label="Stop Distance" value={calcResult.stopDistance.toFixed(4)} />
                    <StatRow label="Suggested Lot" value={calcResult.valueModel === "unknown_contract" ? "—" : calcResult.suggestedLot.toFixed(2)} />
                    <StatRow
                      label="Max Allowed Lot"
                      value={calcResult.refusedReason ? "None" : calcResult.maxLotAllowed.toFixed(2)}
                      sub="Lot cap in force: the strictest of your cap, your operator's limit, the platform cap and any cap you set for this symbol. Your broker may allow less."
                    />
                    <div className="mt-3 pt-3 border-t border-border/50">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold" data-testid="sizer-final-label">
                          {calcResult.refusedReason ? "Lot Size" : calcResult.estimate === false ? "Final Lot Size" : "Estimated Lot Size"}
                        </span>
                        <span className="text-xl font-mono font-bold text-primary" data-testid="sizer-final-lot">
                          {calcResult.refusedReason ? "Refused" : calcResult.valueModel === "unknown_contract" ? "Not sized" : calcResult.finalLot.toFixed(2)}
                        </span>
                      </div>
                      {calcResult.refusedReason && (
                        <p className="mt-2 text-xs text-red-300" data-testid="sizer-refused">{calcResult.refusedReason}</p>
                      )}
                      <p className="mt-2 text-xs text-muted-foreground" data-testid="sizer-basis">
                        {calcResult.basis ?? "The sizing basis was not reported, so treat this lot as an estimate."}
                      </p>
                    </div>
                    {calcResult.warning && (
                      <Alert className="mt-3 border-yellow-500/30 bg-yellow-500/5 py-2">
                        <AlertTriangle className="h-3 w-3 text-yellow-400" />
                        <AlertDescription className="text-xs text-yellow-300/90 ml-1">
                          {calcResult.warning}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
              </CardContent>

              {calcResult && (
                <CardFooter className="border-t border-border/50 p-4">
                  <div className="w-full space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Risk exposure</span>
                      <span>{calcForm.getValues("riskPercent")}% of account</span>
                    </div>
                    <Progress
                      value={Math.min(calcForm.getValues("riskPercent") * 10, 100)}
                      className="h-1.5"
                    />
                  </div>
                </CardFooter>
              )}
            </Card>
          </div>

          {/* Quick reference table */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal">
                Lot Size Reference — $1,000 Account
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40">
                      <th className="text-left py-2 text-muted-foreground font-medium">Symbol</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">0.25% Risk</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">0.5% Risk</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">1% Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {[
                      { sym: "V75 Index (30pt SL)", v: [0.08, 0.17, 0.33] },
                      { sym: "V75 1s (50pt SL)", v: [0.03, 0.05, 0.10] },
                      { sym: "V25 Index (20pt SL)", v: [0.13, 0.25, 0.50] },
                      { sym: "EURUSD (30pip SL)", v: [0.01, 0.02, 0.03] },
                      { sym: "US30 (50pt SL)", v: [0.05, 0.10, 0.20] },
                    ].map((row) => (
                      <tr key={row.sym} data-testid={`lot-ref-row-${row.sym}`}>
                        <td className="py-2 font-medium">{row.sym}</td>
                        {row.v.map((v, i) => (
                          <td key={i} className="py-2 text-right font-mono text-primary">{v.toFixed(2)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Lots from the sizer above, rounded to the nearest 0.01, so the money at risk can differ from the
                percentage (EURUSD at 0.25%: 0.01 lot risks $3.00, not $2.50).
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 5 — EMERGENCY
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="emergency" className="space-y-4">

          {/* Kill Switch */}
          <Card className="border-red-500/40 bg-red-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-400">
                <XCircle size={20} /> Emergency Kill Switch
              </CardTitle>
              <CardDescription className="text-muted-foreground text-sm space-y-1" data-testid="emergency-stop-description">
                <span className="block">{emergencyStopScopeLine(stopScope)}</span>
                <span className="block">{EMERGENCY_STOP_EFFECTS}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Dialog open={confirmKill} onOpenChange={setConfirmKill}>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="lg"
                    className="w-full h-16 text-lg font-black tracking-widest gap-3 shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-shadow"
                  >
                    <XCircle size={24} />
                    {stopScope === "PLATFORM"
                      ? "⛔ EMERGENCY STOP: EVERY TRADER"
                      : stopScope === "YOUR_ACCOUNT" ? "⛔ EMERGENCY STOP: MY TRADING" : "⛔ EMERGENCY STOP"}
                  </Button>
                </DialogTrigger>
                <DialogContent className="border-red-500/40">
                  <DialogHeader>
                    <DialogTitle className="text-red-400 flex items-center gap-2">
                      <AlertTriangle /> Confirm Emergency Stop
                    </DialogTitle>
                    <DialogDescription asChild>
                      <div className="text-sm text-muted-foreground space-y-2 pt-2" data-testid="emergency-stop-dialog">
                        <p>This will immediately:</p>
                        <ul className="list-disc list-inside space-y-1 text-foreground/80">
                          <li>
                            {stopScope === "PLATFORM"
                              ? <>Engage the <strong>platform-wide</strong> safety-core kill switch: new trades stop for <strong>every trader</strong></>
                              : stopScope === "YOUR_ACCOUNT"
                                ? <>Engage <strong>your own</strong> kill switch: new trades on your account stop on every venue</>
                                : <>Engage a kill switch (who it halts could not be loaded)</>}
                          </li>
                          <li>Cancel open rows in the legacy simulated trades table (paper-book and broker positions stay open)</li>
                          <li>Set your bot settings to <strong>OFF</strong></li>
                        </ul>
                        <p>{emergencyStopScopeLine(stopScope)}</p>
                        <p className="text-red-400 font-medium pt-2">Are you sure?</p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => setConfirmKill(false)}>Cancel</Button>
                    <Button
                      variant="destructive"
                      onClick={handleEmergencyStop}
                      disabled={emergencyStop.isPending}
                      className="gap-2"
                    >
                      <XCircle size={16} />
                      {emergencyStop.isPending ? "Stopping..." : "Confirm Emergency Stop"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>

          {/* Quick Actions Grid */}
          <div className="grid md:grid-cols-3 gap-4">
            {/* Pause / Resume */}
            <Card className="border-yellow-500/30" data-testid="pause-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-yellow-400">
                  <PauseCircle size={16} /> Bot Paused Flag
                </CardTitle>
                <CardDescription className="text-xs" data-testid="bot-paused-flag-note">
                  {BOT_PAUSE_FLAG_NOTE}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* No current bot status read: no paused / not-paused state is
                    shown, and only the stricter pause request is offered. */}
                {!botStatusCurrent ? (
                  <p className="text-xs text-muted-foreground" data-testid="pause-state-unread">
                    Pause state {botStatusFailed ? "could not be loaded" : "is not loaded yet"}: it is not shown as
                    paused or running, because the bot status was not read.
                  </p>
                ) : botStatusCurrent.isPaused ? (
                  <Alert className="border-yellow-500/30 bg-yellow-500/5 py-2">
                    <PauseCircle className="h-3 w-3 text-yellow-400" />
                    <AlertDescription className="text-xs text-yellow-300 ml-1">The bot paused flag is set. New trades are not stopped by it.</AlertDescription>
                  </Alert>
                ) : null}
                <Button
                  variant="outline"
                  className={cn(
                    "w-full gap-2 border",
                    botStatusCurrent?.isPaused
                      ? "border-success/40 text-success hover:bg-success/10"
                      : "border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                  )}
                  onClick={botStatusCurrent?.isPaused ? handleResumeTrading : handlePauseTrading}
                  disabled={updateBotStatus.isPending}
                >
                  {botStatusCurrent?.isPaused ? (
                    <><Activity size={14} /> Clear Paused Flag</>
                  ) : botStatusCurrent ? (
                    <><PauseCircle size={14} /> Set Paused Flag</>
                  ) : (
                    <><PauseCircle size={14} /> Set Paused Flag (current state not read)</>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Live mode lock — a stored preference (risk_settings.liveLocked).
                The permission status and checklists list it as a blocker; no
                order path reads it, so the card never claims it stops or
                permits live trading. */}
            <Card className="border border-border/50" data-testid="live-lock-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  {!settings
                    ? <><AlertTriangle size={16} className="text-muted-foreground" /> <span>Live Mode Lock</span></>
                    : settings.liveLocked
                    ? <><Lock size={16} className="text-muted-foreground" /> <span>Live Mode Lock: on</span></>
                    : <><Unlock size={16} className="text-muted-foreground" /> <span>Live Mode Lock: off</span></>}
                </CardTitle>
                <CardDescription className="text-xs" data-testid="live-lock-description">
                  A preference saved on your account. While it is on, your permission status and the trade-plan and
                  confirmation checklists list it as a blocker. Orders are not checked against it: live orders are
                  controlled by live arming and the Risk Governor, so turning it off does not enable live trading.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* Settings unread: the lock is neither on nor off on this
                    page, and only the stricter "on" request is offered. */}
                {!settings && (
                  <p className="text-xs text-muted-foreground" data-testid="live-lock-unread">
                    Live lock state {SETTINGS_UNREAD}: it is not shown as on or off, because your risk
                    settings were not read.
                  </p>
                )}
                <Button
                  variant="outline"
                  className="w-full gap-2 border"
                  onClick={handleToggleLiveLock}
                  disabled={setLiveLock.isPending}
                >
                  {settings?.liveLocked ? (
                    <><Unlock size={14} /> Turn live mode lock off</>
                  ) : settings ? (
                    <><Lock size={14} /> Turn live mode lock on</>
                  ) : (
                    <><Lock size={14} /> Turn live mode lock on (current state not read)</>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Status Overview */}
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                  <ShieldAlert size={16} /> System Status
                </CardTitle>
                <CardDescription className="text-xs" data-testid="bot-flags-note">{BOT_FLAGS_NOTE}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {(() => {
                  // A row nobody read is grey "could not be loaded", never a green "NO".
                  const botUnread = botStatusFailed ? "could not be loaded" : "not loaded yet";
                  const bot = botStatusCurrent;
                  // id keeps each row's stable test id; label is what the row says.
                  // The bot rows are the saved Bot Control preference, which no
                  // engine reads: "start requested", never "is running".
                  const rows: { id: string; label: string; value: React.ReactNode; tone: "ok" | "warn" | "neutral" | "unread"; testId?: string }[] = [
                    // Only the kill switches are read here (BOT_FLAGS_NOTE says
                    // what is not), so released switches are neutral, not a
                    // green "nothing halts new trades".
                    halt
                      ? {
                          id: "Stop switch", label: "Kill switches", testId: "risk-status-row-Stop switch",
                          value: halt.engaged ? `ENGAGED (${halt.venues.join(", ")})` : "none engaged",
                          tone: halt.engaged ? "warn" : "neutral",
                        }
                      : {
                          id: "Stop switch", label: "Kill switches", testId: "risk-status-row-Stop switch",
                          value: auditHaltFailed ? "could not be loaded" : auditHaltLoading ? "loading" : "not read",
                          tone: "unread",
                        },
                    bot
                      ? { id: "Bot Mode", label: "Bot Mode", value: bot.mode, tone: bot.mode === "OFF" || !bot.isRunning ? "ok" : "warn" }
                      : { id: "Bot Mode", label: "Bot Mode", value: botUnread, tone: "unread" },
                    bot
                      ? { id: "Is Running", label: "Start requested (saved)", value: bot.isRunning ? "YES" : "NO", tone: bot.isRunning ? "warn" : "ok" }
                      : { id: "Is Running", label: "Start requested (saved)", value: botUnread, tone: "unread" },
                    // The paused flag is not a stop: no order path reads it, so it is never green.
                    bot
                      ? { id: "Is Paused", label: "Paused flag", value: bot.isPaused ? "SET" : "NOT SET", tone: bot.isPaused ? "warn" : "neutral" }
                      : { id: "Is Paused", label: "Paused flag", value: botUnread, tone: "unread" },
                    // The live mode lock is a preference, not a gate: shown neutral, never green/amber.
                    !settings
                      ? { id: "Live Locked", label: "Live lock (preference)", value: SETTINGS_UNREAD, tone: "unread", testId: "live-lock-status" }
                      : { id: "Live Locked", label: "Live lock (preference)", value: settings.liveLocked ? "ON" : "OFF", tone: "neutral", testId: "live-lock-status" },
                    !settings
                      ? { id: "Risk Mode", label: "Risk Mode", value: SETTINGS_UNREAD, tone: "unread" }
                      : {
                          id: "Risk Mode",
                          label: "Risk Mode",
                          value: labelMismatch ? `${currentMode} label · limits differ` : currentMode,
                          tone: currentMode !== "Aggressive" && !labelMismatch ? "ok" : "warn",
                        },
                  ];
                  return rows.map((row) => (
                    <div key={row.id} className="flex items-center justify-between text-xs" data-testid={`system-status-${row.id}`}>
                      <span className="text-muted-foreground">{row.label}</span>
                      <span
                        data-testid={row.testId ?? `risk-status-row-${row.label}`}
                        className={cn("font-mono font-semibold",
                          row.tone === "ok" ? "text-success"
                            : row.tone === "warn" ? "text-yellow-400"
                            : row.tone === "neutral" ? "text-foreground"
                            : "text-muted-foreground")}
                      >
                        {row.value}
                      </span>
                    </div>
                  ));
                })()}
                <p className="pt-1 text-[11px] text-muted-foreground" data-testid="system-status-bot-scope">
                  Bot rows are the saved Bot Control settings; no scanner or trading loop reads them.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Detailed Risk Audit in emergency tab */}
          <RiskAuditDetail />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Detailed Risk Audit Component ────────────────────────────────────────────

export function RiskAuditDetail() {
  const auditQ = useGetRiskAudit({}, { query: { queryKey: getGetRiskAuditQueryKey({}), refetchInterval: 30_000 } });
  const { data: audit, isLoading, refetch } = auditQ;

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  // A later read that failed leaves the old audit unproven: not shown as current.
  if (!audit || latestReadFailed(auditQ)) {
    const last = audit ? lastReadText(auditQ.dataUpdatedAt) : "";
    return (
      <Card className="border-yellow-500/30" data-testid="risk-audit-detail">
        <CardHeader className="bg-muted/20 border-b border-border/50 flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity size={16} /> Legacy Risk Audit
            </CardTitle>
            <CardDescription className="text-xs" data-testid="risk-audit-detail-error">
              The risk audit could not be loaded{audit ? ` (latest read failed${last ? `; ${last}` : ""})` : ""}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="text-xs">Retry</Button>
        </CardHeader>
        <CardContent className="p-6" data-testid="risk-audit-detail-unavailable">
          <p className="text-sm text-yellow-300">
            {audit
              ? `No metrics, blocked conditions or warnings are shown, because the latest read of the audit could not be loaded${last ? `; ${last}` : ""}.`
              : "No metrics, blocked conditions or warnings are shown, because the audit could not be checked."}
          </p>
        </CardContent>
      </Card>
    );
  }
  const basis = auditBasis(audit);
  const unmeasured = (field: string) => basis.notMeasured.has(field);
  const NOT_MEASURED = <span className="text-muted-foreground">Not measured</span>;
  // What a partly measured loss left out (closed rows with UNKNOWN P/L).
  const leftOut = (field: string, n: number | null) => !basis.partlyMeasured.has(field) ? undefined
    : n != null && n > 0 ? `${n} closed trade${n === 1 ? "" : "s"} with unknown P/L not counted`
      : "closed trades with unknown P/L not counted";

  return (
    <Card className="border-border/50">
      <CardHeader className="bg-muted/20 border-b border-border/50 flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2" data-testid="risk-audit-detail-title">
            <Activity size={16} /> {basis.legacy ? "Legacy Risk Audit" : "Risk Audit"}
          </CardTitle>
          <CardDescription className="text-xs" data-testid="risk-audit-detail-asof">
            Re-run on the server every 30s{basis.asOf ? ` · last run ${basis.asOf}` : ""}
          </CardDescription>
          {basis.notes.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="risk-audit-detail-basis">{basis.notes.join(" ")}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="text-xs">Refresh</Button>
      </CardHeader>
      <CardContent className="p-6 grid md:grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
            Metrics
          </h4>
          <div className="space-y-1">
            <StatRow label="Risk Per Trade" value={`${audit.riskPercent}%`} />
            <StatRow
              label={basis.placeholder ? `Daily Loss Used (vs $${basis.balance.toLocaleString("en-US")})` : "Daily Loss Used"}
              value={unmeasured("dailyLossUsed") ? NOT_MEASURED : `${audit.dailyLossUsed.toFixed(2)}%`}
              sub={leftOut("dailyLossUsed", basis.unknownToday)}
            />
            <StatRow
              label={basis.placeholder ? `Weekly Loss Used (vs $${basis.balance.toLocaleString("en-US")})` : "Weekly Loss Used"}
              value={unmeasured("weeklyLossUsed") ? NOT_MEASURED : `${audit.weeklyLossUsed.toFixed(2)}%`}
              sub={leftOut("weeklyLossUsed", basis.unknownWeek)}
            />
            <StatRow label={basis.legacyLog ? "Trades Remaining Today (legacy log)" : "Trades Remaining Today"} value={audit.tradesRemaining} />
            <StatRow
              label={basis.legacyLog ? `Open Trades (legacy log${basis.allAccounts && basis.scopeReported ? ", all accounts" : ""})` : "Open Trades"}
              value={audit.openTradesCount}
              sub={basis.ownRowsOnly ? "yours" : basis.scopeReported ? "all users" : "scope not reported"}
            />
            <StatRow label="Current Losing Streak" value={unmeasured("losingStreak") ? NOT_MEASURED : audit.losingStreak} />
            <StatRow
              label="Cooldown"
              value={audit.cooldownActive
                ? <span className="text-red-400">ACTIVE</span>
                : unmeasured("cooldownActive") ? NOT_MEASURED : <span className="text-success">Clear</span>}
            />
          </div>
        </div>

        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6 pb-32 md:pb-6">
          {audit.reasonsBlocked.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-red-400/80 mb-2 uppercase tracking-wider">
                Blocked ({audit.reasonsBlocked.length})
              </h4>
              <div className="space-y-1.5">
                {audit.reasonsBlocked.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-red-300/90">
                    <XCircle size={12} className="shrink-0 mt-0.5 text-red-400" />
                    {r}
                  </div>
                ))}
              </div>
            </div>
          )}

          {audit.warnings.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-yellow-400/80 mb-2 uppercase tracking-wider">
                Warnings ({audit.warnings.length})
              </h4>
              <div className="space-y-1.5">
                {audit.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-yellow-300/80">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5 text-yellow-400" />
                    {w}
                  </div>
                ))}
              </div>
            </div>
          )}

          {audit.passed && audit.warnings.length === 0 && basis.lossFullyMeasured && (basis.legacy ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-6" data-testid="risk-audit-detail-clear">
              <ShieldAlert size={32} className="text-muted-foreground" />
              <p className="text-sm font-semibold">No legacy rule tripped</p>
              <p className="text-xs text-muted-foreground text-center">This does not check your live account or your current trades.</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-6" data-testid="risk-audit-detail-clear">
              <ShieldCheck size={32} className="text-success" />
              <p className="text-sm text-success font-semibold">No rule tripped</p>
              <p className="text-xs text-muted-foreground text-center">No blocked conditions or warnings</p>
            </div>
          ))}
          {audit.passed && !basis.lossFullyMeasured && (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-6" data-testid="risk-audit-unmeasured">
              <ShieldAlert size={32} className="text-amber-400" />
              <p className="text-sm text-amber-300 font-semibold">Not all rules were measured</p>
              <p className="text-xs text-muted-foreground text-center">
                {!basis.lossMeasured
                  ? "Daily / weekly loss, losing streak and cooldown were not measured, so they are not shown as passing."
                  : `${basis.partlyLabel!.charAt(0).toUpperCase()}${basis.partlyLabel!.slice(1)} is not fully measured: closed trades with unknown P/L are left out, so it is not shown as passing.`}
                {basis.legacy && " This does not check your live account or your current trades."}
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
