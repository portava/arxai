import React from "react";
import { tradeHealthTone, STATUS_COLORS } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

interface Props {
  score: number | null | undefined;
  showLabel?: boolean;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const HEALTH_LABEL = (v: number) => v >= 75 ? "Healthy" : v >= 50 ? "Stable" : v >= 30 ? "Stressed" : "Critical";

export function TradeHealthMeter({ score, showLabel = true, className, size = "md" }: Props) {
  const v = Math.max(0, Math.min(100, score ?? 0));
  const tone = tradeHealthTone(v);
  const colors = STATUS_COLORS[tone];
  const label = HEALTH_LABEL(v);
  const heightClass = { sm: "h-1", md: "h-1.5", lg: "h-2" }[size];

  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Trade health"
    >
      <div className="flex items-center justify-between">
        {showLabel && <span className={cn("text-[10px] uppercase tracking-wider font-semibold", colors.text)}>{label}</span>}
        <span className={cn("text-xs font-mono tabular-nums", colors.text)}>{v}%</span>
      </div>
      <div className={cn("rounded-full overflow-hidden bg-muted/40 w-full", heightClass)}>
        <div className={cn("h-full transition-all duration-500", colors.solid)} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
