import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, PlugZap } from "lucide-react";

// Feature Truth Audit (P0-4) — this page has NO backend synthetic-analytics
// provider. It previously rendered auto-refreshing (30s) per-symbol cards whose
// readings came from a hardcoded table in `lib/indicesIntelligence.ts`
// (`getSyntheticAnalysis`) and were presented as live market analysis:
//   - "ATR" values (64.2, 82.5, 4.8) and "ATR State" (Expanding / Contracting)
//   - "Trend" labels (Uptrend / Sideways / Noisy)
//   - a "Recommended Lot Size" derived from those invented readings
// None of it was measured from market data. A recommended position size
// presented on top of a fabricated volatility reading is the most dangerous
// shape this can take.
//
// Those cards were removed: ARX never displays fabricated signals. This follows
// the same resolution `pages/stocks-center.tsx` already uses — an honest
// not-connected state, NOT a "SIMULATED" badge on invented numbers.
//
// The explainer below is retained deliberately: it is static, factual product
// education about what Deriv synthetic instruments ARE, contains no market
// reading, and is clearly labelled as such.

const SYNTHETIC_EXPLAINER = [
  {
    title: "What are Synthetic Indices?",
    body: "Synthetic volatility indices are markets created by Deriv that run 24/7 and are not driven by real-world news events or economic releases.",
  },
  {
    title: "Volatility 75 Index (V75)",
    body: "Simulates 75% volatility. Large price movements with strong trending phases. Suited to experienced traders with strict risk management.",
  },
  {
    title: "Volatility 25 1s Index (V25 1s)",
    body: "Simulates 25% volatility on 1-second candles. Lower volatility and more predictable structure — commonly used for strategy development.",
  },
  {
    title: "Volatility 75 1s Index (V75 1s)",
    body: "1-second candles at the highest volatility of the three. For highly experienced traders only; size down significantly.",
  },
];

export default function SyntheticCenter() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Synthetic Volatility Center</h1>
        <p className="text-txt-secondary text-sm">
          Synthetics workspace — no synthetic analytics provider is connected yet
        </p>
      </div>

      <div
        role="note"
        aria-label="No synthetic analytics provider"
        data-testid="banner-synthetic-no-provider"
        className="flex gap-3 rounded-md border border-warning/50 bg-warning/30 p-3"
      >
        <AlertTriangle className="text-warning shrink-0 mt-0.5" size={18} />
        <div className="text-sm">
          <div className="font-semibold text-warning">No synthetic analytics provider connected</div>
          <div className="text-warning/80 text-xs mt-0.5">
            ARX has no live synthetic-index analytics feed configured, so ATR, trend and volatility
            readings — and any position size derived from them — are not shown. This page stays empty
            rather than display placeholder data. The explainer below is static product education,
            not live analysis.
          </div>
        </div>
      </div>

      {/* Honest empty state — replaces the removed fabricated analysis cards. */}
      <Card className="bg-card border-border" data-testid="synthetic-empty-state">
        <CardContent className="py-12 text-center space-y-2">
          <PlugZap className="mx-auto text-txt-muted" size="36" />
          <div className="text-foreground font-semibold">Synthetic analytics unavailable</div>
          <div className="text-txt-secondary text-sm max-w-md mx-auto">
            No backend synthetic-analytics provider is connected. ATR, trend, volatility state and
            recommended lot size cannot be shown honestly, so nothing is displayed. Synthetic
            instruments remain fully tradable on the Scanner, which uses real broker data.
          </div>
        </CardContent>
      </Card>

      {/* Static product education — clearly labeled, not live data. */}
      <div>
        <div className="text-xs uppercase tracking-wide text-txt-muted mb-2">
          About synthetic indices (static — not live data)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SYNTHETIC_EXPLAINER.map((e) => (
            <Card key={e.title} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="font-semibold text-foreground text-sm mb-1">{e.title}</div>
                <div className="text-txt-secondary text-xs leading-relaxed">{e.body}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
