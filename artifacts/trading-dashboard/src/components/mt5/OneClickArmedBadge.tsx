// OneClickArmedBadge (Task #354) — in-ticket confirmation that one-click
// trading is ARMED. When armed, Buy/Sell surfaces (LiveSharedTradeTicket,
// ScannerChartPanel) execute immediately with no extra confirmation step, so
// the user needs an unmistakable signal that the next click is live.
//
// Self-contained: reads GET /api/me/one-click/status (shared React Query key,
// so multiple mounts dedupe to one request) and renders NOTHING unless armed —
// no extra noise in the UI when disarmed. Clicking the chip routes to MT5 Setup
// where the arm/disarm flow lives. This is purely an indicator: all 16 Phase B
// safety gates still run server-side on every dispatch.
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Zap } from "lucide-react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type OneClickStatus = { armed?: boolean };

async function fetchOneClickStatus(): Promise<OneClickStatus> {
  const r = await fetch(`${BASE}/api/me/one-click/status`, { credentials: "include" });
  if (!r.ok) return { armed: false };
  return (await r.json().catch(() => ({ armed: false }))) as OneClickStatus;
}

export function OneClickArmedBadge({ className }: { className?: string }) {
  const [, setLocation] = useLocation();
  const { data } = useQuery({
    queryKey: ["one-click-status"],
    queryFn: fetchOneClickStatus,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // Absent when not armed — keeps the ticket clean unless the fast-trade path
  // is actually active.
  if (!data?.armed) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setLocation("/mt5-setup")}
            className={className}
            data-testid="one-click-armed-badge"
            aria-label="One-click trading armed — manage in MT5 Setup"
          >
            <Badge className="gap-1 bg-amber-600 text-[10px] font-semibold text-white hover:bg-amber-700">
              <Zap className="h-3 w-3" />
              One-click armed
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          Buy and Sell execute immediately with no extra confirmation. Click to
          manage or disarm in MT5 Setup. All 16 safety gates still run on every
          trade.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
