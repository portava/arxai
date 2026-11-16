import React from "react";
import { confidenceTone, STATUS_COLORS } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

interface Props {
  value: number | null | undefined;
  showLabel?: boolean;
  className?: string;
  variant?: "bar" | "ring";
  size?: "sm" | "md" | "lg";
}

export function ConfidenceMeter({ value, showLabel = true, className, variant = "bar", size = "md" }: Props) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const tone = confidenceTone(v);
  const colors = STATUS_COLORS[tone];

  if (variant === "ring") {
    const sz = { sm: 32, md: 44, lg: 64 }[size];
    const stroke = { sm: 3, md: 4, lg: 6 }[size];
    const r = (sz - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c - (v / 100) * c;
    return (
      <div
        className={cn("relative inline-flex items-center justify-center", className)}
        style={{ width: sz, height: sz }}
        role="progressbar"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confidence"
      >
        <svg width={sz} height={sz} className="-rotate-90">
          <circle cx={sz / 2} cy={sz / 2} r={r} stroke="currentColor" strokeWidth={stroke} fill="none" className="text-muted/40" />
          <circle
            cx={sz / 2} cy={sz / 2} r={r}
            stroke="currentColor" strokeWidth={stroke} fill="none"
            strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
            className={cn("transition-all duration-500", colors.text)}
          />
        </svg>
        {showLabel && (
          <div className={cn("absolute font-mono font-bold", colors.text, size === "sm" ? "text-[10px]" : size === "lg" ? "text-sm" : "text-xs")}>
            {v}
          </div>
        )}
      </div>
    );
  }

  const heightClass = { sm: "h-1", md: "h-1.5", lg: "h-2" }[size];

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn("flex-1 rounded-full overflow-hidden bg-muted/40", heightClass)}
        role="progressbar"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confidence"
      >
        <div
          className={cn("h-full transition-all duration-500", colors.solid)}
          style={{ width: `${v}%` }}
        />
      </div>
      {showLabel && (
        <span className={cn("font-mono w-9 text-right tabular-nums", colors.text, size === "sm" ? "text-[10px]" : "text-xs")}>
          {v}%
        </span>
      )}
    </div>
  );
}
