// Compact "high-impact event nearby" badge for a single symbol.
// Reuses /api/economic-events/upcoming. Returns null when there's
// nothing to warn about so it's safe to drop into any toolbar.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface UpcomingEvent {
  id: number;
  eventName: string;
  currency: string;
  impactLevel: "HIGH" | "CRITICAL" | string;
  eventTime: string;
}

// Very small currency extractor for the common FX symbol shapes
// (EURUSD, XAUUSD, GBPJPY, etc). Always returns at most two ISO codes.
const KNOWN_CCY = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "CNY", "XAU", "XAG"]);
function extractCurrencies(symbol: string): string[] {
  const up = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  if (up.length < 6) return [];
  const a = up.slice(0, 3);
  const b = up.slice(3, 6);
  const out: string[] = [];
  if (KNOWN_CCY.has(a)) out.push(a);
  if (KNOWN_CCY.has(b) && b !== a) out.push(b);
  return out;
}

const IMPACT_COLOR: Record<string, string> = {
  CRITICAL: "bg-red-600/30 text-red-200 border border-red-500/60 animate-pulse",
  HIGH: "bg-orange-600/25 text-orange-200 border border-orange-500/60",
};

export function EventImpactBadge({
  symbol,
  hoursAhead = 2,
}: {
  symbol: string | null | undefined;
  hoursAhead?: number;
}) {
  const ccys = symbol ? extractCurrencies(symbol) : [];
  const enabled = ccys.length > 0;

  const { data } = useQuery<{ events: UpcomingEvent[] }>({
    queryKey: ["event-impact-badge", hoursAhead],
    queryFn: async () => {
      const r = await fetch(`/api/economic-events/upcoming?hours=${hoursAhead}&minImpact=HIGH`, { credentials: "include" });
      if (!r.ok) return { events: [] };
      return r.json();
    },
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!enabled) return null;
  const events = data?.events ?? [];
  const relevant = events.filter((e) => ccys.includes(e.currency.toUpperCase()));
  if (relevant.length === 0) return null;

  const next = relevant.sort((a, b) =>
    new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime(),
  )[0]!;
  const minutes = Math.max(
    0,
    Math.round((new Date(next.eventTime).getTime() - Date.now()) / 60_000),
  );
  const isCritical = relevant.some((e) => e.impactLevel === "CRITICAL");
  const tone = isCritical ? IMPACT_COLOR.CRITICAL! : IMPACT_COLOR.HIGH!;
  const label = isCritical ? "Critical event" : "High-impact event";

  return (
    <Badge
      className={`gap-1 text-xs font-medium ${tone}`}
      data-testid="badge-event-impact"
      title={`${next.currency} · ${next.eventName} in ~${minutes}m`}
    >
      <AlertTriangle className="h-3 w-3" />
      {label} · {next.currency} · {minutes}m
      {relevant.length > 1 ? ` (+${relevant.length - 1})` : ""}
    </Badge>
  );
}
