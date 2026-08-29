import React from "react";
import { useGetPermissionStatus, getGetPermissionStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, ShieldAlert, ShieldX, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTradingMode } from "@/hooks/useTradingMode";

// Status → icon/tone only. The textual label comes from the unified
// trading-mode resolver (T003) — never from this static map — so that
// every page agrees on whether the user is in LIVE_SHARED / DEMO / PAPER
// and we don't leak legacy phrases like "OBSERVE_ONLY + PAPER_TRADING".
const STATUS_STYLE = {
  CLEAR:                 { icon: ShieldCheck, tone: "border-success/40 bg-success/5  text-success" },
  CAUTION:               { icon: ShieldAlert, tone: "border-warning/40   bg-warning/5    text-warning" },
  LOCKED:                { icon: ShieldX,     tone: "border-danger/40     bg-danger/5      text-danger" },
  LIVE_TRADING_DISABLED: { icon: Info,        tone: "border-border/40   bg-muted    text-foreground" },
} as const;

const RISK_TONE = {
  LOW:      "text-success",
  MEDIUM:   "text-warning",
  HIGH:     "text-warning",
  CRITICAL: "text-danger",
} as const;

export function TradingPermissionCard({ className }: { className?: string }) {
  const { data, isLoading } = useGetPermissionStatus({
    query: { queryKey: getGetPermissionStatusQueryKey(), refetchInterval: 10_000 },
  });
  const mode = useTradingMode();

  if (isLoading || !data || mode.isLoading) {
    return (
      <Card className={cn("border-border/50 bg-muted/40", className)}>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Trading Permission</CardTitle></CardHeader>
        <CardContent className="text-xs text-txt-secondary">Loading…</CardContent>
      </Card>
    );
  }

  const style = STATUS_STYLE[data.status as keyof typeof STATUS_STYLE] ?? STATUS_STYLE.LIVE_TRADING_DISABLED;
  const Icon = style.icon;
  const exp = (data as { explanation?: { headline: string; detail: string; recommendation: string } }).explanation;

  return (
    <Card className={cn("border", style.tone, className)} data-testid="trading-permission-card">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon size={16} />
          Trading Permission · <span data-testid="trading-permission-mode-label">{mode.cleanModeLabel}</span>
        </CardTitle>
        <span className={cn("text-xs font-medium", RISK_TONE[data.riskLevel as keyof typeof RISK_TONE])}>
          Risk: {data.riskLevel}
        </span>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {exp && (
          <>
            <div className="font-semibold text-foreground">{exp.headline}</div>
            <div className="text-txt-secondary">{exp.detail}</div>
            <div className="text-txt-secondary italic">→ {exp.recommendation}</div>
          </>
        )}
        {mode.cleanBlockedReason && (
          <div className="text-[11px] text-warning/80 mt-2" data-testid="trading-permission-blocked-reason">
            {mode.cleanBlockedReason}
          </div>
        )}
        {!mode.cleanBlockedReason && mode.cleanUserMessage && (
          <div className="text-[11px] text-txt-secondary mt-2" data-testid="trading-permission-user-message">
            {mode.cleanUserMessage}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
