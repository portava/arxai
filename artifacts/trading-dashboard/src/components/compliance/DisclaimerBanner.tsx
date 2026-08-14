import React from "react";
import { AlertTriangle, Info, ShieldAlert, Sparkles, BookOpen, Crosshair, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import { COMPLIANCE, type ComplianceKey } from "@/lib/compliance";

// Default tone + icon mapping per disclaimer type.
const KIND_DEFAULTS: Record<ComplianceKey, { tone: StatusTone; icon: LucideIcon }> = {
  footer:        { tone: "neutral", icon: Info },
  liveUnlock:    { tone: "danger",  icon: ShieldAlert },
  aiAssistant:   { tone: "info",    icon: Sparkles },
  backtest:      { tone: "warning", icon: BookOpen },
  entrySniper:   { tone: "warning", icon: Crosshair },
  riskCenter:    { tone: "warning", icon: ShieldAlert },
  mt5Bridge:     { tone: "warning", icon: AlertTriangle },
  onboarding:    { tone: "info",    icon: Info },
};

interface Props {
  kind: ComplianceKey;
  tone?: StatusTone;
  icon?: LucideIcon;
  compact?: boolean;
  className?: string;
}

export function DisclaimerBanner({ kind, tone, icon, compact, className }: Props) {
  const defaults = KIND_DEFAULTS[kind];
  const t = tone ?? defaults.tone;
  const Icon = icon ?? defaults.icon;
  const colors = STATUS_COLORS[t];
  const copy = COMPLIANCE[kind];

  return (
    <div
      role="note"
      aria-label={copy.title}
      data-testid={`disclaimer-${kind}`}
      className={cn(
        "flex gap-3 rounded-md border",
        colors.bg, colors.border,
        compact ? "p-2.5" : "p-3.5",
        className,
      )}
    >
      <Icon size={compact ? 14 : 16} className={cn("shrink-0 mt-0.5", colors.text)} />
      <div className="min-w-0">
        <div className={cn("font-semibold uppercase tracking-wider", compact ? "text-[10px]" : "text-[11px]", colors.text)}>
          {copy.title}
        </div>
        <p className={cn("text-foreground/80 leading-relaxed mt-0.5", compact ? "text-[11px]" : "text-xs")}>
          {copy.body}
        </p>
      </div>
    </div>
  );
}
