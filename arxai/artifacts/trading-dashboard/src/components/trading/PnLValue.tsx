import React from "react";
import { pnlTone, STATUS_COLORS } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

interface Props {
  value: number | null | undefined;
  currency?: string;
  showSign?: boolean;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
}

export function PnLValue({ value, currency = "$", showSign = true, className, size = "md" }: Props) {
  const tone = pnlTone(value);
  const colors = STATUS_COLORS[tone];
  const sizeCls = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-lg",
    xl: "text-2xl",
  }[size];
  if (value === null || value === undefined) {
    return <span className={cn("font-mono text-muted-foreground", sizeCls, className)}>—</span>;
  }
  const abs = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = showSign ? (value > 0 ? "+" : value < 0 ? "−" : "") : "";
  return (
    <span className={cn("font-mono font-semibold tabular-nums", colors.text, sizeCls, className)}>
      {sign}{currency}{abs}
    </span>
  );
}
