import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Clock } from "lucide-react";
import { SignalDirectionBadge } from "./SignalDirectionBadge";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { VolatilityBadge } from "./VolatilityBadge";
import { MarketConditionBadge } from "./MarketConditionBadge";
import { RiskBadge } from "./RiskBadge";
import { StatusBadge } from "./StatusBadge";
import { cn } from "@/lib/utils";
import { directionTone, STATUS_COLORS, type VolatilityState, type MarketCondition, type RiskState } from "@/lib/design-tokens";
import { formatPrice } from "@/lib/format";

interface Props {
  symbol: string;
  direction: string | null | undefined;
  confidence: number | null | undefined;
  strategy?: string | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  createdAt?: string | Date | null;
  marketCondition?: MarketCondition | null;
  volatility?: VolatilityState | null;
  riskApproval?: RiskState | null;
  session?: string | null;
  newsRisk?: boolean | null;
  aiSummary?: string | null;
  className?: string;
  onClick?: () => void;
}

export function SignalCard({
  symbol, direction, confidence, strategy, entryPrice, stopLoss, takeProfit, createdAt,
  marketCondition, volatility, riskApproval, session, newsRisk, aiSummary, className, onClick,
}: Props) {
  const accent = STATUS_COLORS[directionTone(direction)];
  const isLive = createdAt ? Date.now() - new Date(createdAt).getTime() < 30_000 : false;

  return (
    <Card
      onClick={onClick}
      className={cn(
        "border-card-border transition-all duration-200 group",
        accent.border,
        onClick && "cursor-pointer hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-0.5",
        className
      )}
      data-testid={`signal-card-${symbol}`}
    >
      {/* Accent stripe */}
      <div className={cn("h-0.5 w-full", accent.solid)} />
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-bold text-base">{symbol}</span>
              <SignalDirectionBadge direction={direction} size="sm" />
              {isLive && (
                <span className="relative inline-flex items-center justify-center w-2 h-2" title="Live signal">
                  <span className={cn("absolute inset-0 rounded-full opacity-60 animate-ping", accent.solid)} />
                  <span className={cn("relative w-2 h-2 rounded-full", accent.solid)} />
                </span>
              )}
            </div>
            {strategy && <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{strategy}</div>}
          </div>
          {createdAt && (
            <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-1 shrink-0">
              <Clock size={10} />
              {new Date(createdAt).toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* Confidence */}
        <ConfidenceMeter value={confidence} size="md" />

        {/* Intelligence badges */}
        <div className="flex flex-wrap gap-1.5">
          {marketCondition && <MarketConditionBadge state={marketCondition} size="sm" />}
          {volatility && <VolatilityBadge state={volatility} size="sm" />}
          {riskApproval && <RiskBadge state={riskApproval} size="sm" />}
          {session && <StatusBadge tone="info" size="sm">{session}</StatusBadge>}
          {newsRisk && <StatusBadge tone="warning" size="sm">News Risk</StatusBadge>}
        </div>

        {/* Levels */}
        {(entryPrice ?? stopLoss ?? takeProfit) !== null && (entryPrice ?? stopLoss ?? takeProfit) !== undefined && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/60">
            <Level label="Entry" value={entryPrice} />
            <Level label="SL" value={stopLoss} tone="bearish" />
            <Level label="TP" value={takeProfit} tone="bullish" />
          </div>
        )}

        {/* AI summary */}
        {aiSummary && (
          <p className="text-xs text-muted-foreground italic leading-relaxed border-t border-border/60 pt-2">
            {aiSummary}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Level({ label, value, tone }: { label: string; value: number | null | undefined; tone?: "bullish" | "bearish" }) {
  const colorClass = tone === "bullish" ? "text-success" : tone === "bearish" ? "text-danger" : "text-foreground";
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-xs font-mono tabular-nums mt-0.5", colorClass)}>
        {value !== null && value !== undefined ? formatPrice(value) : "—"}
      </div>
    </div>
  );
}
