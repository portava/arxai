import React from "react";
import { Wind, Waves, Activity, AlertTriangle } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { volatilityTone, VOLATILITY_LABEL, type VolatilityState } from "@/lib/design-tokens";

const ICON = { CALM: Wind, NORMAL: Waves, EXPANDING: Activity, DANGEROUS: AlertTriangle } as const;

export function VolatilityBadge({ state, size = "md" }: { state: VolatilityState; size?: "sm" | "md" }) {
  const Icon = ICON[state];
  return (
    <StatusBadge tone={volatilityTone(state)} icon={Icon} size={size} data-testid={`badge-volatility-${state.toLowerCase()}`}>
      {VOLATILITY_LABEL[state]}
    </StatusBadge>
  );
}
