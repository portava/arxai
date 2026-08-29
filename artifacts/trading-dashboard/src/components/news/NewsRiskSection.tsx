// NewsRiskSection — the News Risk surface, rendered as the "News Risk" tab of
// the unified Economic Calendar page (surface consolidation item E). This is
// the same composition the standalone /news-risk page carried after Theme
// G-FINISH repointed it onto the real, DB-backed pipeline:
//   HighImpactEventBanner  → /api/economic-events/upcoming (economic_events)
//   NewsRiskCard           → /api/news-risk/latest  (news_risk_reports), plus
//                            /api/market-heat/diagnostics for provider honesty
//   UpcomingEventsList     → /api/economic-events/upcoming (economic_events)
//
// NewsRiskCard is the surface the Trade Plan Builder already renders, so this
// tab and the trade path show the SAME verdict from the SAME source — no
// second opinion, no simulator.
//
// HONESTY
//   None of these components fabricate. NewsRiskCard reads provider status and
//   refuses to present a green "CLEAR" as a confident all-clear when the
//   calendar/news providers are not connected; an empty upcoming list means the
//   synced calendar has no qualifying events, not that risk is absent.
//
// Read-only: this section places no trades and mutates nothing.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Newspaper } from "lucide-react";

import { HighImpactEventBanner } from "./HighImpactEventBanner";
import { NewsRiskCard } from "./NewsRiskCard";
import { UpcomingEventsList } from "./UpcomingEventsList";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";

export function NewsRiskSection() {
  // Follows the app-wide chart symbol so the tab opens on whatever the trader
  // is already looking at, while staying overridable here.
  const [chartSymbol] = useChartSymbol();
  const [override, setOverride] = useState<string>("");
  const symbol = (override.trim() || bareSymbol(chartSymbol)).toUpperCase();

  return (
    <div className="space-y-4" data-testid="page-news-risk">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Newspaper className="h-5 w-5" /> News Risk
          </h2>
          <p className="text-sm text-muted-foreground">
            Economic-calendar risk for the symbol you are trading, from the synced calendar.
          </p>
        </div>
        <div className="w-full sm:w-56">
          <Input
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder={bareSymbol(chartSymbol) || "Symbol"}
            aria-label="Symbol"
            data-testid="input-news-risk-symbol"
          />
        </div>
      </div>

      <HighImpactEventBanner />

      <NewsRiskCard symbol={symbol || null} />

      <Card data-testid="card-news-risk-upcoming">
        <CardHeader>
          <CardTitle className="text-base">Upcoming events</CardTitle>
          <CardDescription>
            Medium-impact and above in the next 24 hours, from the synced economic calendar.
            An empty list means no qualifying events are scheduled — not that risk is absent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UpcomingEventsList hours={24} minImpact="MEDIUM" />
        </CardContent>
      </Card>
    </div>
  );
}

export default NewsRiskSection;
