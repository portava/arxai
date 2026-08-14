import React from "react";
import { TrendingUp, MoveHorizontal, Shuffle, Rocket, RotateCcw } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { marketConditionTone, MARKET_CONDITION_LABEL, type MarketCondition } from "@/lib/design-tokens";

const ICON = { TRENDING: TrendingUp, RANGE: MoveHorizontal, CHOP: Shuffle, BREAKOUT: Rocket, REVERSAL_RISK: RotateCcw } as const;

export function MarketConditionBadge({ state, size = "md" }: { state: MarketCondition; size?: "sm" | "md" }) {
  const Icon = ICON[state];
  return (
    <StatusBadge tone={marketConditionTone(state)} icon={Icon} size={size} data-testid={`badge-condition-${state.toLowerCase()}`}>
      {MARKET_CONDITION_LABEL[state]}
    </StatusBadge>
  );
}
