import React from "react";
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { riskTone, RISK_LABEL, type RiskState } from "@/lib/design-tokens";

const ICON = { LOW: ShieldCheck, MODERATE: ShieldQuestion, HIGH: ShieldAlert, BLOCKED: ShieldX } as const;

export function RiskBadge({ state, size = "md" }: { state: RiskState; size?: "sm" | "md" }) {
  const Icon = ICON[state];
  return (
    <StatusBadge tone={riskTone(state)} icon={Icon} size={size} data-testid={`badge-risk-${state.toLowerCase()}`}>
      {RISK_LABEL[state]}
    </StatusBadge>
  );
}
