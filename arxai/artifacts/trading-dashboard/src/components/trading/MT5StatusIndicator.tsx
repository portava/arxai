import React from "react";
import { useGetMt5Status, getGetMt5StatusQueryKey } from "@workspace/api-client-react";
import { Wifi, WifiOff, Clock } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import { useFeatureUnlock } from "@/hooks/useFeatureUnlock";

interface Props {
  variant?: "badge" | "dot";
  className?: string;
}

export function MT5StatusIndicator({ variant = "badge", className }: Props) {
  // First-load gate: don't leak bridge connection state until MT5 is unlocked.
  const { unlocked: mt5Unlocked } = useFeatureUnlock("mt5");
  const { data: mt5 } = useGetMt5Status({
    query: {
      queryKey: getGetMt5StatusQueryKey(),
      refetchInterval: 5000,
      enabled: mt5Unlocked,
    },
  });
  if (!mt5Unlocked) return null;

  // Determine connection status: connected / delayed / disconnected
  let tone: StatusTone = "inactive";
  let label = "Disconnected";
  let Icon = WifiOff;
  if (mt5?.connected) {
    const ageSec = mt5.lastHeartbeatAt
      ? (Date.now() - new Date(mt5.lastHeartbeatAt).getTime()) / 1000
      : 0;
    if (ageSec > 8) {
      tone = "warning"; label = "Delayed"; Icon = Clock;
    } else {
      tone = "success"; label = "Connected"; Icon = Wifi;
    }
  }

  if (variant === "dot") {
    const colors = STATUS_COLORS[tone];
    return (
      <span
        className={cn("relative inline-flex items-center justify-center w-2.5 h-2.5", className)}
        title={`MT5 ${label}`}
        aria-label={`MT5 ${label}`}
      >
        <span className={cn("absolute inset-0 rounded-full opacity-50 animate-ping", colors.solid)} />
        <span className={cn("relative w-2 h-2 rounded-full", colors.solid)} />
      </span>
    );
  }

  return (
    <StatusBadge tone={tone} icon={Icon} className={className} data-testid="mt5-status-indicator">
      System MT5 · {label}
    </StatusBadge>
  );
}
