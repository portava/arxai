import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, PlugZap } from "lucide-react";

// Feature Truth Audit (P0-4) — this page has NO backend index-data provider.
// It previously rendered an auto-refreshing (30s) macro dashboard and per-index
// grid whose numbers were fabricated in `lib/indicesIntelligence.ts`:
//   - "VIX Estimate"      = 14 + Math.random() * 8
//   - "10Y Bond Yield"    = 4.45 + (Math.random() - 0.5) * 0.3
//   - per-index Confidence = ... + Math.random() * 10
//   - each index's current level = a hardcoded 2024-era level jittered by
//     (Math.random() - 0.5) * level * 0.002
//   - "Dollar Strength" / "Fed Expectation" = hardcoded constants
// Because the page refreshed on a timer, those invented numbers visibly moved
// like a live feed and a trader had no way to tell them from real data.
//
// That grid was removed: ARX never displays fabricated signals. This follows
// the same resolution `pages/stocks-center.tsx` already uses — an honest
// not-connected state, NOT a "SIMULATED" badge on invented numbers. The static
// notes below are clearly labelled editorial context, not live analysis.

const INDEX_NOTES: Record<string, { region: string; drivers: string; risks: string }> = {
  "US30 · Dow Jones Industrial Average": {
    region: "United States",
    drivers: "Price-weighted, industrials- and financials-heavy; sensitive to rate expectations",
    risks: "Concentration in a few high-priced constituents",
  },
  "NAS100 · NASDAQ 100": {
    region: "United States",
    drivers: "Mega-cap technology; long-duration, so rate-sensitive",
    risks: "Single-name concentration, valuation compression on rate moves",
  },
  "SPX500 · S&P 500": {
    region: "United States",
    drivers: "Broad large-cap benchmark; earnings breadth and rate path",
    risks: "Top-heavy index weights, macro shocks",
  },
  "GER40 · DAX 40": {
    region: "Germany",
    drivers: "Export-heavy industrials; EUR strength and energy input costs matter",
    risks: "Energy prices, China demand, ECB policy",
  },
  "UK100 · FTSE 100": {
    region: "United Kingdom",
    drivers: "Commodity and financial weightings; large overseas revenue share",
    risks: "GBP swings, commodity cycles",
  },
  "JP225 · Nikkei 225": {
    region: "Japan",
    drivers: "Exporter-heavy; JPY weakness historically supportive",
    risks: "BoJ policy shifts, JPY intervention, China demand",
  },
};

export default function IndicesCenter() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Indices Center</h1>
        <p className="text-txt-secondary text-sm">
          Indices workspace — no index market-data provider is connected yet
        </p>
      </div>

      <div
        role="note"
        aria-label="No index data provider"
        data-testid="banner-indices-no-provider"
        className="flex gap-3 rounded-md border border-warning/50 bg-warning/30 p-3"
      >
        <AlertTriangle className="text-warning shrink-0 mt-0.5" size={18} />
        <div className="text-sm">
          <div className="font-semibold text-warning">No index data provider connected</div>
          <div className="text-warning/80 text-xs mt-0.5">
            ARX has no live equity-index feed configured, so index levels, VIX, bond yields, bias and
            confidence are not shown. This page stays empty rather than display placeholder data. The
            index notes below are static editorial context, not live analysis.
          </div>
        </div>
      </div>

      {/* Honest empty state — replaces the removed fabricated macro + index grid. */}
      <Card className="bg-card border-border" data-testid="indices-empty-state">
        <CardContent className="py-12 text-center space-y-2">
          <PlugZap className="mx-auto text-txt-muted" size="36" />
          <div className="text-foreground font-semibold">Index intelligence unavailable</div>
          <div className="text-txt-secondary text-sm max-w-md mx-auto">
            No backend index market-data provider is connected. Index levels, macro readings,
            direction and confidence cannot be shown honestly, so nothing is displayed. Forex and
            synthetic markets remain fully wired on the Scanner, which uses real broker data.
          </div>
        </CardContent>
      </Card>

      {/* Static index notes — clearly labeled, not live data. */}
      <div>
        <div className="text-xs uppercase tracking-wide text-txt-muted mb-2">
          Static index notes (editorial — not live data)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(INDEX_NOTES).map(([name, t]) => (
            <Card key={name} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="font-bold text-foreground text-sm mb-1">{name}</div>
                <div className="text-xs text-txt-muted mb-0.5">{t.region}</div>
                <div className="text-xs text-txt-secondary mb-0.5">
                  <span className="text-txt-muted">Structure:</span> {t.drivers}
                </div>
                <div className="text-xs text-danger">
                  <span className="text-txt-muted">Risk:</span> {t.risks}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
