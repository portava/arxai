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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel,
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

// ── Risk mode config ─────────────────────────────────────────────────────────

const MODES = {
  Conservative: {
    icon: ShieldCheck,
    color: "text-success",
    border: "border-success/40",
    bg: "bg-success/10",
    activeBg: "bg-success/15",
    badge: "bg-success/20 text-success border-success/30",
    stats: [
      { label: "Risk/Trade", value: "0.25%" },
      { label: "Daily Limit", value: "1%" },
      { label: "Weekly Limit", value: "3%" },
      { label: "Max Trades", value: "3/day" },
      { label: "Loss Streak", value: "2 trades" },
      { label: "Min Confidence", value: "80%" },
      { label: "Max Open", value: "1 trade" },
    ],
    description: "Capital preservation first. Tight limits, high confidence bar. Ideal for volatile market conditions.",
  },
  Balanced: {
    icon: ShieldAlert,
    color: "text-primary",
    border: "border-primary/40",
    bg: "bg-primary/5",
    activeBg: "bg-primary/15",
    badge: "bg-primary/20 text-primary border-primary/30",
    stats: [
      { label: "Risk/Trade", value: "0.5%" },
      { label: "Daily Limit", value: "2%" },
      { label: "Weekly Limit", value: "5%" },
      { label: "Max Trades", value: "5/day" },
      { label: "Loss Streak", value: "3 trades" },
      { label: "Min Confidence", value: "75%" },
      { label: "Max Open", value: "2 trades" },
    ],
    description: "Optimized for consistent growth. Balanced exposure across all market conditions.",
  },
  Aggressive: {
    icon: Zap,
    color: "text-warning",
    border: "border-warning/40",
    bg: "bg-warning/5",
    activeBg: "bg-warning/15",
    badge: "bg-warning/20 text-warning border-warning/30",
    stats: [
      { label: "Risk/Trade", value: "1%" },
      { label: "Daily Limit", value: "3%" },
      { label: "Weekly Limit", value: "7%" },
      { label: "Max Trades", value: "8/day" },
      { label: "Loss Streak", value: "3 trades" },
      { label: "Min Confidence", value: "70%" },
      { label: "Max Open", value: "3 trades" },
    ],
    description: "Maximum opportunity capture. Higher drawdown tolerance. Use only in favorable conditions.",
  },
  Custom: {
    icon: BarChart3,
    color: "text-premium",
    border: "border-premium/40",
    bg: "bg-premium/5",
    activeBg: "bg-premium/15",
    badge: "bg-premium/20 text-premium border-premium/30",
    stats: [],
    description: "Full manual control. Every parameter editable. Your rules, your risk.",
  },
};

// ── Custom limits form schema ────────────────────────────────────────────────

const limitsSchema = z.object({
  riskPerTradePct:          z.coerce.number().min(0.01).max(10),
  maxDailyLossPct:          z.coerce.number().min(0.1).max(20),
  maxWeeklyLossPct:         z.coerce.number().min(0.1).max(50),
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
        <span className="text-sm font-mono font-semibold tabular-nums text-foreground">{value}</span>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

// ── Live Audit Banner ────────────────────────────────────────────────────────

function AuditBanner({ symbol }: { symbol?: string }) {
  const auditParams = symbol ? { symbol } : {};
  const { data: audit, isLoading } = useGetRiskAudit(
    auditParams,
    { query: { queryKey: getGetRiskAuditQueryKey(auditParams), refetchInterval: 30_000 } }
  );

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!audit) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-lg border px-5 py-3",
        audit.passed
          ? "border-success/30 bg-success/10"
          : "border-danger/30 bg-danger/5"
      )}
    >
      <div className="shrink-0">
        {audit.passed
          ? <ShieldCheck className="h-8 w-8 text-success" />
          : <ShieldX className="h-8 w-8 text-danger" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn("font-semibold text-sm", audit.passed ? "text-success" : "text-danger")}>
          {audit.passed ? "Trading conditions GREEN — all risk checks passed" : "Trading BLOCKED — risk rule violation"}
        </p>
        {!audit.passed && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {audit.reasonsBlocked[0]}
            {audit.reasonsBlocked.length > 1 && ` (+${audit.reasonsBlocked.length - 1} more)`}
          </p>
        )}
        {audit.warnings.length > 0 && audit.passed && (
          <p className="text-xs text-warning/80 truncate mt-0.5">
            ⚠ {audit.warnings[0]}
          </p>
        )}
      </div>
      <div className="hidden md:flex gap-6 shrink-0 text-center">
        <div>
          <div className="text-xs text-muted-foreground">Daily Loss</div>
          <div className="font-mono font-bold text-sm tabular-nums">{audit.dailyLossUsed.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Trades Left</div>
          <div className="font-mono font-bold text-sm tabular-nums">{audit.tradesRemaining}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Open</div>
          <div className="font-mono font-bold text-sm tabular-nums">{audit.openTradesCount}</div>
        </div>
        {audit.cooldownActive && (
          <div>
            <div className="text-xs text-danger">Cooldown</div>
            <div className="font-mono font-bold text-sm text-danger">ACTIVE</div>
          </div>
        )}
      </div>
    </div>
  );
}

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
  const { data: botStatus } = useGetBotStatus();
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
          toast({
            title: next ? "Live mode LOCKED" : "Live mode unlocked",
            description: next
              ? "Manual unlock required before going live."
              : "Live trading is now permitted.",
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
        toast({
          title: "⛔ Emergency Stop Executed",
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
        onSuccess: () => toast({ title: "Trading paused", description: "Bot will not open new positions." }),
        onError: () => toast({ title: "Failed to pause", variant: "destructive" }),
      }
    );
  }

  function handleResumeTrading() {
    updateBotStatus.mutate(
      { data: { isPaused: false } },
      {
        onSuccess: () => toast({ title: "Trading resumed" }),
        onError: () => toast({ title: "Failed to resume", variant: "destructive" }),
      }
    );
  }

  function handleCalcSubmit(data: z.infer<typeof calcSchema>) {
    setCalcParams(data);
    setCalcSymbol(data.symbol);
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 pb-32 md:pb-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const currentMode = settings?.riskMode ?? "Balanced";
  const modeConfig = MODES[currentMode as keyof typeof MODES] ?? MODES.Custom;
  const ModeIcon = modeConfig.icon;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 pb-32 md:pb-6 animate-in fade-in duration-500">

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
          <Badge
            className={cn("px-3 py-1 font-semibold border", modeConfig.badge)}
          >
            <ModeIcon size={13} className="mr-1.5" />
            {currentMode} Mode
          </Badge>
          {settings?.liveLocked && (
            <Badge className="bg-danger/20 text-danger border-danger/30 px-3 py-1 border">
              <Lock size={12} className="mr-1.5" /> Live Locked
            </Badge>
          )}
          {botStatus?.isPaused && (
            <Badge className="bg-warning/20 text-warning border-warning/30 px-3 py-1 border">
              <PauseCircle size={12} className="mr-1.5" /> Paused
            </Badge>
          )}
        </div>
      </div>

      {/* Canonical balance (Task #430) — risk caps are evaluated against this
          same live equity, so the panel matches the Dashboard, account,
          Open Trades, wallet and admin. */}
      <CanonicalBalancePanel live={liveAcct.live} title="Live balance" />

      {/* ── Compliance + Live Audit Banner ── */}
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
          <TabsTrigger value="emergency" className="gap-1.5 text-xs sm:text-sm text-danger data-[state=active]:text-danger">
            <AlertTriangle size={14} /> Emergency
          </TabsTrigger>
        </TabsList>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 1 — RISK MODE
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="mode" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(["Conservative", "Balanced", "Aggressive", "Custom"] as const).map((mode) => {
              const cfg = MODES[mode];
              const Icon = cfg.icon;
              const isActive = currentMode === mode;
              return (
                <Card
                  key={mode}
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
                        <span className="text-premium font-semibold">Limits</span> tab to
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
                        {isActive ? "Currently Active" : `Apply ${mode} Preset`}
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
                <div
                  className="h-2 rounded-full"
                  style={{
                    background:
                      "linear-gradient(to right, hsl(var(--success)), hsl(var(--primary)), hsl(var(--warning)), hsl(var(--danger)))",
                  }}
                />
                <div
                  className="absolute top-0 w-4 h-4 rounded-full border-2 border-background shadow-md transition-all duration-500"
                  style={{
                    left: currentMode === "Conservative" ? "2%" :
                          currentMode === "Balanced" ? "33%" :
                          currentMode === "Aggressive" ? "65%" : "90%",
                    backgroundColor: currentMode === "Conservative" ? "hsl(var(--success))" :
                                     currentMode === "Balanced" ? "hsl(var(--primary))" :
                                     currentMode === "Aggressive" ? "hsl(var(--warning))" : "hsl(var(--premium))",
                  }}
                />
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
          {currentMode !== "Custom" && (
            <Alert className="mb-4 border-primary/30 bg-primary/5">
              <ShieldAlert className="h-4 w-4 text-primary" />
              <AlertTitle className="text-primary text-sm">Preset Active — {currentMode}</AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                Editing any limit below will switch you to <strong className="text-premium">Custom</strong> mode automatically.
              </AlertDescription>
            </Alert>
          )}
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
                      </FormItem>
                    )} />
                  <FormField control={limitsForm.control} name="maxWeeklyLossPct"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex justify-between text-xs">
                          Max Weekly Loss <span className="font-mono text-primary">{field.value}%</span>
                        </FormLabel>
                        <FormControl>
                          <Slider min={0.1} max={50} step={0.1}
                            value={[field.value]} onValueChange={(v) => field.onChange(v[0])} />
                        </FormControl>
                        <FormDescription className="text-xs">Weekly cumulative drawdown cap</FormDescription>
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
                          <FormDescription className="text-xs">Pause during abnormal tick volatility to avoid slippage</FormDescription>
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
                  desc: "Adds +10% to the minimum confidence threshold when trading V75 1s. Extreme tick speed requires higher certainty.",
                  accent: "text-warning",
                },
                {
                  key: "vol75SmallLot" as const,
                  label: "Volatility 75 — Reduced Lot Size",
                  desc: "Automatically halves the calculated lot size for V75 instruments to account for higher pip volatility.",
                  accent: "text-warning",
                },
              ].map(({ key, label, desc, accent }) => (
                <div key={key} className="flex items-start justify-between px-6 py-4 gap-4">
                  <div>
                    <p className={cn("text-sm font-medium", accent)}>{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-sm">{desc}</p>
                  </div>
                  <Switch
                    checked={settings?.[key] ?? true}
                    onCheckedChange={(v) => handleSaveSpecialRules({ [key]: v })}
                    disabled={updateSettings.isPending}
                    className="shrink-0 mt-0.5"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="bg-muted/20 border-b border-border/50">
              <CardTitle className="text-base">News & Event Blocks</CardTitle>
              <CardDescription className="text-xs">Prevent trading around high-impact economic events</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border/30 px-0">
              {[
                {
                  key: "us30BlockNews" as const,
                  label: "US30 — Block During Major U.S. News",
                  desc: "Warns when US30 trades are detected near NFP, FOMC, CPI and other tier-1 U.S. economic releases.",
                  accent: "text-primary",
                },
                {
                  key: "stocksBlockEarnings" as const,
                  label: "Stocks — Block Around Earnings",
                  desc: "Flags stock trades during earnings season. Can be overridden manually if you have a directional view.",
                  accent: "text-primary",
                },
                {
                  key: "forexBlockEvents" as const,
                  label: "Forex — Block Around Central Bank Events",
                  desc: "Generates warnings for forex pairs during ECB, Fed, BoE, BoJ decisions and high-impact news.",
                  accent: "text-primary",
                },
              ].map(({ key, label, desc, accent }) => (
                <div key={key} className="flex items-start justify-between px-6 py-4 gap-4">
                  <div>
                    <p className={cn("text-sm font-medium", accent)}>{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-sm">{desc}</p>
                  </div>
                  <Switch
                    checked={settings?.[key] ?? true}
                    onCheckedChange={(v) => handleSaveSpecialRules({ [key]: v })}
                    disabled={updateSettings.isPending}
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
            <CardContent className="space-y-1">
              {settings && [
                settings.vol75ExtraConfidence && "V75 (1s): +10 confidence required above global minimum",
                settings.vol75SmallLot && "V75: Position size capped at 50% of calculated lot",
                settings.us30BlockNews && "US30: News proximity warnings active",
                settings.stocksBlockEarnings && "Stocks: Earnings block warnings active",
                settings.forexBlockEvents && "Forex: Central bank event warnings active",
                !settings.vol75ExtraConfidence && !settings.vol75SmallLot && !settings.us30BlockNews && !settings.stocksBlockEarnings && !settings.forexBlockEvents && "No special rules active",
              ].filter(Boolean).map((rule, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                  {rule}
                </div>
              ))}
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
                  Calculate optimal lot size based on your account and risk parameters.
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
                    <StatRow label="Suggested Lot" value={calcResult.suggestedLot.toFixed(2)} />
                    <StatRow label="Max Allowed Lot" value={calcResult.maxLotAllowed.toFixed(2)} />
                    <div className="mt-3 pt-3 border-t border-border/50">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">Final Lot Size</span>
                        <span className="text-xl font-mono font-bold text-primary">
                          {calcResult.finalLot.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    {calcResult.warning && (
                      <Alert className="mt-3 border-warning/30 bg-warning/5 py-2">
                        <AlertTriangle className="h-3 w-3 text-warning" />
                        <AlertDescription className="text-xs text-warning/90 ml-1">
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
                      { sym: "EURUSD (30pip SL)", v: [0.08, 0.17, 0.33] },
                      { sym: "US30 (50pt SL)", v: [0.05, 0.10, 0.20] },
                    ].map((row) => (
                      <tr key={row.sym}>
                        <td className="py-2 font-medium">{row.sym}</td>
                        {row.v.map((v, i) => (
                          <td key={i} className="py-2 text-right font-mono text-primary">{v.toFixed(2)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 5 — EMERGENCY
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="emergency" className="space-y-4">

          {/* Kill Switch */}
          <Card className="border-danger/40 bg-danger/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-danger">
                <XCircle size={20} /> Emergency Kill Switch
              </CardTitle>
              <CardDescription className="text-muted-foreground text-sm">
                Immediately stops the bot, cancels all open mock trades, and resets to OFF mode.
                This cannot be undone — the bot must be manually restarted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Dialog open={confirmKill} onOpenChange={setConfirmKill}>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="lg"
                    className="w-full h-16 text-lg font-black tracking-widest gap-3 shadow-lg"
                  >
                    <XCircle size={24} />
                    ⛔ EMERGENCY STOP ALL TRADING
                  </Button>
                </DialogTrigger>
                <DialogContent className="border-danger/40">
                  <DialogHeader>
                    <DialogTitle className="text-danger flex items-center gap-2">
                      <AlertTriangle /> Confirm Emergency Stop
                    </DialogTitle>
                    <DialogDescription className="text-sm text-muted-foreground space-y-2 pt-2">
                      <p>This will immediately:</p>
                      <ul className="list-disc list-inside space-y-1 text-foreground/80">
                        <li>Stop all active bot scanning</li>
                        <li>Cancel every open mock trade</li>
                        <li>Set bot mode to <strong>OFF</strong></li>
                        <li>Require manual restart to resume</li>
                      </ul>
                      <p className="text-danger font-medium pt-2">Are you sure?</p>
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
            <Card className="border-warning/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-warning">
                  <PauseCircle size={16} /> Pause Trading
                </CardTitle>
                <CardDescription className="text-xs">
                  Suspends new trade entries while keeping the bot running and open positions intact.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {botStatus?.isPaused ? (
                  <Alert className="border-warning/30 bg-warning/5 py-2">
                    <PauseCircle className="h-3 w-3 text-warning" />
                    <AlertDescription className="text-xs text-warning ml-1">Bot is currently paused</AlertDescription>
                  </Alert>
                ) : null}
                <Button
                  variant="outline"
                  className={cn(
                    "w-full gap-2 border",
                    botStatus?.isPaused
                      ? "border-success/40 text-success hover:bg-success/10"
                      : "border-warning/40 text-warning hover:bg-warning/10"
                  )}
                  onClick={botStatus?.isPaused ? handleResumeTrading : handlePauseTrading}
                  disabled={updateBotStatus.isPending}
                >
                  {botStatus?.isPaused ? (
                    <><Activity size={14} /> Resume Trading</>
                  ) : (
                    <><PauseCircle size={14} /> Pause All Trading</>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Live Bridge Lock */}
            <Card className={cn("border", settings?.liveLocked ? "border-danger/40" : "border-border/50")}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  {settings?.liveLocked
                    ? <><Lock size={16} className="text-danger" /> <span className="text-danger">Live Locked</span></>
                    : <><Unlock size={16} className="text-muted-foreground" /> <span>Live Mode Lock</span></>}
                </CardTitle>
                <CardDescription className="text-xs">
                  When locked, switching to LIVE trading mode is disabled until manually unlocked.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {settings?.liveLocked && (
                  <Alert className="border-danger/30 bg-danger/5 py-2">
                    <Lock className="h-3 w-3 text-danger" />
                    <AlertDescription className="text-xs text-danger ml-1">Live trading is locked</AlertDescription>
                  </Alert>
                )}
                <Button
                  variant="outline"
                  className={cn(
                    "w-full gap-2 border",
                    settings?.liveLocked
                      ? "border-success/40 text-success hover:bg-success/10"
                      : "border-danger/40 text-danger hover:bg-danger/10"
                  )}
                  onClick={handleToggleLiveLock}
                  disabled={setLiveLock.isPending}
                >
                  {settings?.liveLocked ? (
                    <><Unlock size={14} /> Unlock Live Mode</>
                  ) : (
                    <><Lock size={14} /> Lock Live Mode</>
                  )}
                </Button>

                {settings?.liveLocked && (
                  <div className="mt-3">
                    <DisclaimerBanner kind="liveUnlock" compact />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Status Overview */}
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                  <ShieldAlert size={16} /> System Status
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  {
                    label: "Bot Mode",
                    value: botStatus?.mode ?? "—",
                    ok: botStatus?.mode === "OFF" || !botStatus?.isRunning,
                  },
                  {
                    label: "Is Running",
                    value: botStatus?.isRunning ? "YES" : "NO",
                    ok: !botStatus?.isRunning,
                  },
                  {
                    label: "Is Paused",
                    value: botStatus?.isPaused ? "YES" : "NO",
                    ok: true,
                  },
                  {
                    label: "Live Locked",
                    value: settings?.liveLocked ? "LOCKED" : "OPEN",
                    ok: settings?.liveLocked,
                  },
                  {
                    label: "Risk Mode",
                    value: currentMode,
                    ok: currentMode !== "Aggressive",
                  },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className={cn("font-mono font-semibold tabular-nums", row.ok ? "text-success" : "text-warning")}>
                      {row.value}
                    </span>
                  </div>
                ))}
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

function RiskAuditDetail() {
  const { data: audit, isLoading, refetch } = useGetRiskAudit({}, { query: { queryKey: getGetRiskAuditQueryKey({}), refetchInterval: 30_000 } });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!audit) return null;

  return (
    <Card className="border-border/50">
      <CardHeader className="bg-muted/20 border-b border-border/50 flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity size={16} /> Live Risk Audit
          </CardTitle>
          <CardDescription className="text-xs">Real-time evaluation of all risk rules — refreshes every 30s</CardDescription>
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
            <StatRow label="Daily Loss Used" value={`${audit.dailyLossUsed.toFixed(2)}%`} />
            <StatRow label="Weekly Loss Used" value={`${audit.weeklyLossUsed.toFixed(2)}%`} />
            <StatRow label="Trades Remaining Today" value={audit.tradesRemaining} />
            <StatRow label="Open Trades" value={audit.openTradesCount} />
            <StatRow label="Current Losing Streak" value={audit.losingStreak} />
            <StatRow
              label="Cooldown"
              value={audit.cooldownActive
                ? <span className="text-danger">ACTIVE</span>
                : <span className="text-success">Clear</span>}
            />
          </div>
        </div>

        <div className="space-y-4">
          {audit.reasonsBlocked.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-danger/80 mb-2 uppercase tracking-wider">
                Blocked ({audit.reasonsBlocked.length})
              </h4>
              <div className="space-y-1.5">
                {audit.reasonsBlocked.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-danger/90">
                    <XCircle size={12} className="shrink-0 mt-0.5 text-danger" />
                    {r}
                  </div>
                ))}
              </div>
            </div>
          )}

          {audit.warnings.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-warning/80 mb-2 uppercase tracking-wider">
                Warnings ({audit.warnings.length})
              </h4>
              <div className="space-y-1.5">
                {audit.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-warning/80">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5 text-warning" />
                    {w}
                  </div>
                ))}
              </div>
            </div>
          )}

          {audit.passed && audit.warnings.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-6">
              <ShieldCheck size={32} className="text-success" />
              <p className="text-sm text-success font-semibold">All clear</p>
              <p className="text-xs text-muted-foreground text-center">No blocked conditions or warnings</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
