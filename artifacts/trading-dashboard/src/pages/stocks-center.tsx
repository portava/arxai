import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, PlugZap } from "lucide-react";

// Feature Truth Audit — this page has NO backend stock-data provider. It
// previously rendered a client-side randomized "signals" grid (fake BUY/SELL,
// fake prices, fake confidence). That grid was removed: ARX never displays
// fabricated signals. Until a real stock provider is wired, this page shows an
// honest not-connected state plus clearly-labeled static sector notes.

// General, timeless sector background only. No directional view (bullish /
// bearish / neutral): these notes have no author or as-of date, so a market
// call here could not be checked or dated.
const SECTOR_THEMES: Record<string, { driver: string; risk: string }> = {
  Technology: { driver: "Corporate IT and cloud spending; interest-rate expectations", risk: "Rate sensitivity (long-duration valuations)" },
  Semiconductors: { driver: "Chip demand cycles (data centres, consumer devices, autos)", risk: "Export controls, inventory cycles" },
  "EV / Auto": { driver: "EV adoption, battery and energy-storage costs", risk: "Price competition, margin pressure" },
  "E-commerce / Cloud": { driver: "Consumer spending, cloud and advertising demand", risk: "Regulatory scrutiny, consumer slowdown" },
};

export default function StocksCenter() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Stocks Center</h1>
        <p className="text-txt-secondary text-sm">Stocks workspace — no stock data provider is connected yet</p>
      </div>

      <div
        role="note"
        aria-label="No stock data provider"
        data-testid="banner-stocks-mock-data"
        className="flex gap-3 rounded-md border border-warning/50 bg-warning/30 p-3"
      >
        <AlertTriangle className="text-warning shrink-0 mt-0.5" size={18} />
        <div className="text-sm">
          <div className="font-semibold text-warning">No stock data provider connected</div>
          <div className="text-warning/80 text-xs mt-0.5">
            ARX has no live stock-market feed configured, so no stock prices or signals are shown. This page will
            stay empty rather than display placeholder data. The sector notes below are static editorial context,
            not live analysis.
          </div>
        </div>
      </div>

      {/* Honest empty state — replaces the removed fake signal grid. */}
      <Card className="bg-card border-border" data-testid="stocks-empty-state">
        <CardContent className="py-12 text-center space-y-2">
          <PlugZap className="mx-auto text-txt-muted" size="36" />
          <div className="text-foreground font-semibold">Stock signals unavailable</div>
          <div className="text-txt-secondary text-sm max-w-md mx-auto">
            No backend stock-data provider is connected. Stock prices, directions, and signals cannot be shown
            honestly, so nothing is displayed. Forex and synthetic markets remain fully wired on the Scanner.
          </div>
        </CardContent>
      </Card>

      {/* Static sector notes — clearly labeled, not live data. */}
      <div>
        <div className="text-xs uppercase tracking-wide text-txt-muted mb-2">Static sector background (editorial — not live data, not a market view)</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(SECTOR_THEMES).map(([sector, t]) => (
            <Card key={sector} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="font-bold text-foreground text-sm mb-1">{sector}</div>
                <div className="text-xs text-txt-secondary mb-0.5"><span className="text-txt-muted">Typically driven by:</span> {t.driver}</div>
                <div className="text-xs text-txt-secondary"><span className="text-txt-muted">Common risks:</span> {t.risk}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
