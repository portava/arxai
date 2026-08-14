import React from "react";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface Props {
  tone?: StatusTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
  "data-testid"?: string;
}

export function StatusBadge({ tone = "neutral", icon: Icon, children, size = "md", className, ...rest }: Props) {
  const colors = STATUS_COLORS[tone];
  const sizeCls = size === "sm" ? "text-[10px] px-1.5 py-0 h-5" : "text-xs px-2 py-0.5 h-6";
  const iconSize = size === "sm" ? 10 : 12;
  return (
    <Badge
      className={cn("font-mono uppercase border inline-flex items-center gap-1 tracking-wider", colors.badge, sizeCls, className)}
      data-testid={rest["data-testid"]}
    >
      {Icon && <Icon size={iconSize} />}
      {children}
    </Badge>
  );
}
