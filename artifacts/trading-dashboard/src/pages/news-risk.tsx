// News Risk — repointed onto the real, DB-backed news-risk pipeline.
//
// WHAT THIS PAGE USED TO BE
//   A CRUD form over `/api/news-risk/events`, which is an admin-gated
//   IN-MEMORY store in marketDataLayer that reports `dataSource: "SIMULATOR"`.
//   Traders opening "News Risk" saw a hand-maintained list of made-up events —
//   and because the endpoints are admin-only, a non-admin approved trader got a
//   403 and an empty page. Nothing on it came from a real calendar, and nothing
//   an admin typed into it ever reached the risk engine that trade surfaces
//   consult.
//
// WHAT IT IS NOW
//   The same three components the rest of the app already uses for news risk,
//   all reading real DB-backed endpoints:
//     HighImpactEventBanner  → /api/economic-events/upcoming (economic_events)
//     NewsRiskCard           → /api/news-risk/latest  (news_risk_reports), plus
//                              /api/market-heat/diagnostics for provider honesty
//     UpcomingEventsList     → /api/economic-events/upcoming (economic_events)
//
//   NewsRiskCard is the surface the Trade Plan Builder already renders, so this
//   page and the trade path now show the SAME verdict from the SAME source —
//   no second opinion, no simulator.
//
// HONESTY
//   None of these components fabricate. NewsRiskCard reads provider status and
//   refuses to present a green "CLEAR" as a confident all-clear when the
//   calendar/news providers are not connected; an empty upcoming list means the
//   synced calendar has no qualifying events, not that risk is absent.
//
// Read-only: this page places no trades and mutates nothing.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Newspaper } from "lucide-react";

import { HighImpactEventBanner, NewsRiskCard, UpcomingEventsList } from "@/components/news";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";

export default function NewsRiskPage() {
  // Follows the app-wide chart symbol so the page opens on whatever the trader
  // is already looking at, while staying overridable here.
  const [chartSymbol] = useChartSymbol();
  const [override, setOverride] = useState<string>("");
  const symbol = (override.trim() || bareSymbol(chartSymbol)).toUpperCase();

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-news-risk">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Newspaper className="h-5 w-5" /> News Risk
          </h1>
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
