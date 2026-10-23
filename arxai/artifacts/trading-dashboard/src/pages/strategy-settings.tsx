import React, { useState, useEffect } from "react";
import {
  useGetStrategies,
  useUpdateStrategy,
  useResetStrategies,
  getGetStrategiesQueryKey,
  type Strategy,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Settings2,
  RotateCcw,
  Save,
  Activity,
  Zap,
  TrendingUp,
  BarChart2,
  GitBranch,
  Droplets,
  Shield,
  Clock,
} from "lucide-react";

// ── Parameter metadata ──────────────────────────────────────────────────────

type ParamMeta =
  | { type: "number"; label: string; min: number; max: number; step: number; unit?: string }
  | { type: "boolean"; label: string }
  | { type: "select"; label: string; options: string[] };

const PARAM_META: Record<string, Record<string, ParamMeta>> = {
  "Trend Continuation": {
    fastEma:           { type: "number",  label: "Fast EMA",           min: 5,    max: 50,  step: 1 },
    mediumEma:         { type: "number",  label: "Medium EMA",         min: 20,   max: 100, step: 1 },
    slowEma:           { type: "number",  label: "Slow EMA",           min: 50,   max: 500, step: 10 },
    rsiMin:            { type: "number",  label: "RSI Min",            min: 40,   max: 60,  step: 1 },
    rsiMax:            { type: "number",  label: "RSI Max",            min: 60,   max: 80,  step: 1 },
    atrFilter:         { type: "boolean", label: "ATR Filter" },
    pullbackRequired:  { type: "boolean", label: "Require Pullback" },
    minimumConfidence: { type: "number",  label: "Min Confidence",     min: 40,   max: 90,  step: 1, unit: "%" },
  },
  "Break of Structure": {
    swingLookback:           { type: "number",  label: "Swing Lookback",      min: 5,  max: 50,  step: 1 },
    candleCloseConfirmation: { type: "boolean", label: "Candle Close Confirm" },
    retestRequired:          { type: "boolean", label: "Require Retest" },
    wickTolerance:           { type: "number",  label: "Wick Tolerance",      min: 0,  max: 1,   step: 0.05 },
    minimumConfidence:       { type: "number",  label: "Min Confidence",      min: 40, max: 90,  step: 1, unit: "%" },
  },
  "Liquidity Sweep Reversal": {
    lookbackCandles:            { type: "number",  label: "Lookback Candles",        min: 5,  max: 50, step: 1 },
    wickRejectionRequired:      { type: "boolean", label: "Require Wick Rejection" },
    rsiExhaustionThreshold:     { type: "number",  label: "RSI Exhaustion Threshold", min: 50, max: 80, step: 1 },
    candleCloseBackInsideRange: { type: "boolean", label: "Close Back Inside Range" },
    minimumConfidence:          { type: "number",  label: "Min Confidence",           min: 40, max: 90, step: 1, unit: "%" },
  },
  "Volatility Expansion": {
    atrPeriod:            { type: "number",  label: "ATR Period",       min: 5,   max: 50,  step: 1 },
    atrMultiplier:        { type: "number",  label: "ATR Multiplier",   min: 0.5, max: 5,   step: 0.1 },
    candleBodyMinimumPct: { type: "number",  label: "Min Candle Body",  min: 30,  max: 90,  step: 5, unit: "%" },
    trendFilterRequired:  { type: "boolean", label: "Require Trend Filter" },
    minimumConfidence:    { type: "number",  label: "Min Confidence",   min: 40,  max: 90,  step: 1, unit: "%" },
  },
  "Mean Reversion": {
    rangeDetectionRequired:     { type: "boolean", label: "Require Range Detection" },
    rsiOverbought:              { type: "number",  label: "RSI Overbought",  min: 60, max: 85, step: 1 },
    rsiOversold:                { type: "number",  label: "RSI Oversold",    min: 15, max: 40, step: 1 },
    bollingerBandTouchRequired: { type: "boolean", label: "Require BB Touch" },
    takeProfitAtMidline:        { type: "boolean", label: "Take Profit at Midline" },
    minimumConfidence:          { type: "number",  label: "Min Confidence",  min: 40, max: 90, step: 1, unit: "%" },
  },
  "Session Breakout": {
    session:             { type: "select",  label: "Session",              options: ["London", "New York", "Asia"] },
    openingRangeMinutes: { type: "number",  label: "Opening Range",        min: 15, max: 120, step: 15, unit: " min" },
    breakoutConfirmation:{ type: "boolean", label: "Require Confirmation" },
    retestRequired:      { type: "boolean", label: "Require Retest" },
    maxFakeoutCount:     { type: "number",  label: "Max Fakeouts",         min: 0,  max: 5,   step: 1 },
    minimumConfidence:   { type: "number",  label: "Min Confidence",       min: 40, max: 90,  step: 1, unit: "%" },
  },
  "No Trade Filter": {
    minConfidence:  { type: "number", label: "Min Confidence",   min: 40, max: 90,  step: 1, unit: "%" },
    maxAtrMultiple: { type: "number", label: "Max ATR Multiple", min: 1,  max: 10,  step: 0.5 },
    rsiOverbought:  { type: "number", label: "RSI Overbought",   min: 60, max: 90,  step: 1 },
    rsiOversold:    { type: "number", label: "RSI Oversold",     min: 10, max: 40,  step: 1 },
  },
};

const STRATEGY_ICONS: Record<string, React.ReactNode> = {
  "Trend Continuation":       <TrendingUp size={16} />,
  "Break of Structure":       <GitBranch size={16} />,
  "Liquidity Sweep Reversal": <Droplets size={16} />,
  "Volatility Expansion":     <Zap size={16} />,
  "Mean Reversion":           <BarChart2 size={16} />,
  "Session Breakout":         <Clock size={16} />,
  "No Trade Filter":          <Shield size={16} />,
};

const MARKET_TYPES = [
  { value: "synthetic", label: "Synthetic Indices" },
  { value: "forex",     label: "Forex" },
  { value: "indices",   label: "Indices" },
  { value: "stocks",    label: "Stocks" },
] as const;

type MarketType = "forex" | "indices" | "stocks" | "synthetic";

// ── Parameter editor component ───────────────────────────────────────────────

function ParamEditor({
  stratName,
  params,
  onChange,
}: {
  stratName: string;
  params: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const meta = PARAM_META[stratName];
  if (!meta) {
    return <p className="text-sm text-muted-foreground">No configurable parameters.</p>;
  }

  return (
    <div className="space-y-6">
      {Object.entries(meta).map(([key, m]) => {
        const val = params[key];

        if (m.type === "boolean") {
          return (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm font-medium">{m.label}</span>
              <Switch
                checked={Boolean(val)}
                onCheckedChange={(v) => onChange(key, v)}
              />
            </div>
          );
        }

        if (m.type === "select") {
          return (
            <div key={key} className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{m.label}</span>
                <span className="text-sm text-muted-foreground font-mono">{String(val)}</span>
              </div>
              <Select value={String(val)} onValueChange={(v) => onChange(key, v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {m.options.map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }

        // number with slider
        const numVal = typeof val === "number" ? val : (Number(val) || m.min);
        return (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{m.label}</span>
              <span className="text-sm font-mono text-primary font-semibold">
                {numVal}{m.unit ?? ""}
              </span>
            </div>
            <Slider
              value={[numVal]}
              min={m.min}
              max={m.max}
              step={m.step}
              onValueChange={([v]) => onChange(key, v)}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-0.5">
              <span>{m.min}{m.unit ?? ""}</span>
              <span>{m.max}{m.unit ?? ""}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function StrategySettings() {
  const { data: strategies, isLoading } = useGetStrategies();
  const updateStrategy = useUpdateStrategy();
  const resetStrategies = useResetStrategies();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftParams, setDraftParams] = useState<Record<string, unknown>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [marketType, setMarketType] = useState<MarketType>("synthetic");

  // Auto-select first strategy on load
  const selected = strategies?.find((s) => s.id === selectedId) ?? strategies?.[0] ?? null;

  useEffect(() => {
    if (selected && selectedId === null) {
      setSelectedId(selected.id);
      setDraftParams((selected.parameters as Record<string, unknown>) ?? {});
    }
  }, [selected, selectedId]);

  const handleSelectStrategy = (strat: Strategy) => {
    if (isDirty) {
      if (!window.confirm("You have unsaved changes. Discard them?")) return;
    }
    setSelectedId(strat.id);
    setDraftParams((strat.parameters as Record<string, unknown>) ?? {});
    setIsDirty(false);
  };

  const handleToggle = (strat: Strategy, e: React.MouseEvent) => {
    e.stopPropagation();
    updateStrategy.mutate(
      { data: { id: strat.id, enabled: !strat.enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
        },
        onError: () => {
          toast({ title: "Update Failed", variant: "destructive" });
        },
      }
    );
  };

  const handleParamChange = (key: string, value: unknown) => {
    setDraftParams((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = () => {
    if (!selected) return;
    updateStrategy.mutate(
      { data: { id: selected.id, parameters: draftParams } },
      {
        onSuccess: () => {
          setIsDirty(false);
          toast({ title: "Parameters Saved", description: `${selected.name} updated successfully.` });
          queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
        },
        onError: () => {
          toast({ title: "Save Failed", description: "Could not save parameters.", variant: "destructive" });
        },
      }
    );
  };

  const handleDiscard = () => {
    if (!selected) return;
    setDraftParams((selected.parameters as Record<string, unknown>) ?? {});
    setIsDirty(false);
  };

  const handleApplyPreset = () => {
    resetStrategies.mutate(
      { data: { marketType } },
      {
        onSuccess: (data) => {
          toast({
            title: "Preset Applied",
            description: `All strategies reset to ${marketType} defaults.`,
          });
          queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
          const refreshed = data?.find((s: Strategy) => s.id === selectedId);
          if (refreshed) {
            setDraftParams((refreshed.parameters as Record<string, unknown>) ?? {});
            setIsDirty(false);
          }
        },
        onError: () => {
          toast({ title: "Reset Failed", variant: "destructive" });
        },
      }
    );
  };

  const activeCount = strategies?.filter((s) => s.enabled).length ?? 0;
  const totalCount = strategies?.length ?? 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Settings2 className="text-primary" /> Visual Strategy Builder
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            Select a strategy to edit its parameters. Toggle on/off individually or apply a market preset.
          </p>
          {!isLoading && (
            <p className="text-xs text-muted-foreground font-mono mt-1">
              {activeCount}/{totalCount} strategies active
            </p>
          )}
        </div>

        {/* Preset selector */}
        <div className="flex items-center gap-2 shrink-0">
          <Select value={marketType} onValueChange={(v) => setMarketType(v as MarketType)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MARKET_TYPES.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={handleApplyPreset}
            disabled={resetStrategies.isPending}
          >
            <RotateCcw size={13} />
            {resetStrategies.isPending ? "Applying…" : "Apply Preset"}
          </Button>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start">

        {/* ── Left panel: strategy list ── */}
        <div className="space-y-1.5">
          {isLoading
            ? Array.from({ length: 7 }).map((_, i) => (
                <Card key={i} className="p-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                </Card>
              ))
            : strategies?.map((strat) => {
                const isSelected = strat.id === (selectedId ?? strategies[0]?.id);
                return (
                  <Card
                    key={strat.id}
                    className={`cursor-pointer transition-all hover:border-primary/40 ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : strat.enabled
                        ? "border-border/50"
                        : "border-border/25 opacity-55"
                    }`}
                    onClick={() => handleSelectStrategy(strat)}
                  >
                    <CardContent className="p-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                            strat.enabled
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {STRATEGY_ICONS[strat.name] ?? <Activity size={16} />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate leading-tight">{strat.name}</p>
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            <Badge
                              variant={strat.enabled ? "default" : "secondary"}
                              className="text-[9px] px-1 py-0 h-4"
                            >
                              {strat.enabled ? "ON" : "OFF"}
                            </Badge>
                            {strat.winRate > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 h-4 font-mono text-primary border-primary/25"
                              >
                                {strat.winRate.toFixed(1)}%
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <Switch
                        checked={strat.enabled}
                        onCheckedChange={() => {}}
                        onClick={(e) => handleToggle(strat, e)}
                        disabled={updateStrategy.isPending}
                        className="shrink-0"
                      />
                    </CardContent>
                  </Card>
                );
              })}
        </div>

        {/* ── Right panel: parameter editor ── */}
        {isLoading ? (
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-4 w-2/3 mt-1" />
            </CardHeader>
            <CardContent className="space-y-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex justify-between">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : selected ? (
          <Card className="sticky top-4">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                      selected.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {STRATEGY_ICONS[selected.name] ?? <Activity size={20} />}
                  </div>
                  <div>
                    <CardTitle className="text-lg leading-tight">{selected.name}</CardTitle>
                    <CardDescription className="mt-1 text-sm leading-relaxed">
                      {selected.description}
                    </CardDescription>
                  </div>
                </div>
                <Badge variant={selected.enabled ? "default" : "secondary"} className="shrink-0 mt-1">
                  {selected.enabled ? "Active" : "Inactive"}
                </Badge>
              </div>

              {/* Stats */}
              {(selected.winRate > 0 || selected.totalSignals > 0) && (
                <div className="flex gap-5 pt-2 text-sm text-muted-foreground font-mono">
                  {selected.winRate > 0 && (
                    <span>
                      Win Rate:{" "}
                      <span className="text-primary font-semibold">{selected.winRate.toFixed(1)}%</span>
                    </span>
                  )}
                  {selected.totalSignals > 0 && (
                    <span>
                      Signals:{" "}
                      <span className="text-foreground font-semibold">{selected.totalSignals}</span>
                    </span>
                  )}
                </div>
              )}
            </CardHeader>

            <Separator />

            <CardContent className="pt-5">
              {/* Parameters header */}
              <div className="flex items-center justify-between mb-5">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Parameters
                </p>
                {isDirty && (
                  <Badge
                    variant="outline"
                    className="text-amber-500 border-amber-500/40 text-[10px] animate-pulse"
                  >
                    Unsaved changes
                  </Badge>
                )}
              </div>

              <ParamEditor
                stratName={selected.name}
                params={draftParams}
                onChange={handleParamChange}
              />

              {/* Action buttons */}
              <div className="flex gap-2 mt-8 pt-4 border-t border-border/40">
                <Button
                  className="flex-1 gap-1.5"
                  onClick={handleSave}
                  disabled={!isDirty || updateStrategy.isPending}
                >
                  <Save size={13} />
                  {updateStrategy.isPending ? "Saving…" : "Save Parameters"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDiscard}
                  disabled={!isDirty}
                >
                  Discard
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
