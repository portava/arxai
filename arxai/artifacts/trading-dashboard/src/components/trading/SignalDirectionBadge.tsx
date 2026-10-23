import React from "react";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { STATUS_COLORS, directionTone } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

interface Props {
  direction: string | null | undefined;
  size?: "sm" | "md" | "lg";
  withIcon?: boolean;
  className?: string;
}

export function SignalDirectionBadge({ direction, size = "md", withIcon = true, className }: Props) {
  const tone = directionTone(direction);
  const colors = STATUS_COLORS[tone];
  const Icon = direction === "BUY" ? TrendingUp : direction === "SELL" ? TrendingDown : Minus;
  const label = direction ?? "WAIT";

  const sizeClasses = {
    sm: "text-[10px] px-1.5 py-0 h-5",
    md: "text-xs px-2 py-0.5 h-6",
    lg: "text-sm px-3 py-1 h-7",
  }[size];

  const iconSize = { sm: 10, md: 12, lg: 14 }[size];

  return (
    <Badge
      className={cn("font-mono uppercase border inline-flex items-center gap-1 justify-center", colors.badge, sizeClasses, className)}
      data-testid={`badge-direction-${label.toLowerCase()}`}
    >
      {withIcon && <Icon size={iconSize} />}
      {label}
    </Badge>
  );
}
