import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, PlugZap } from "lucide-react";

// Feature Truth Audit (P0-4) — this page has NO backend FX macro provider. It
// previously rendered an auto-refreshing (30s) currency-strength meter and pair
// table whose numbers were fabricated in `lib/forexIntelligence.ts`:
//   - each currency's "strength" (0-100, drawn as a filled bar) was a hardcoded
//     base table plus `(Math.random() - 0.5) * 6`
//   - the "Risk Sentiment" regime was a coin flip during the New York session:
//     `Math.random() > 0.5 ? "Risk-On" : "Neutral"`
//   - every pair's macro bias, technical bias and CONFIDENCE percentage was
//     derived from those invented strengths
// Because the page refreshed on a timer, the fake strengths visibly moved like
// a live feed and a trader had no way to tell them from real data.
//
// That grid was removed: ARX never displays fabricated signals. This follows
// the same resolution `pages/stocks-center.tsx` already uses — an honest
// not-connected state, NOT a "SIMULATED" badge on invented numbers. The static
// notes below are clearly labelled editorial context, not live analysis.

const CURRENCY_NOTES: Record<string, { centralBank: string; note: string }> = {
  USD: { centralBank: "Federal Reserve", note: "World reserve currency; typically bid in risk-off conditions." },
  EUR: { centralBank: "European Central Bank", note: "Most-traded pair leg against USD; sensitive to euro-area growth and energy." },
  GBP: { centralBank: "Bank of England", note: "Historically higher realised volatility than EUR against USD." },
  JPY: { centralBank: "Bank of Japan", note: "Traditional funding currency; often bid in risk-off episodes." },
  CHF: { centralBank: "Swiss National Bank", note: "Safe-haven characteristics; SNB has intervened historically." },
  AUD: { centralBank: "Reserve Bank of Australia", note: "Commodity- and China-growth linked; risk-sensitive." },
  NZD: { centralBank: "Reserve Bank of New Zealand", note: "Commodity-linked and risk-sensitive; thinner liquidity than AUD." },
  CAD: { centralBank: "Bank of Canada", note: "Correlated with crude oil and US growth." },
};

export default function ForexCenter() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Forex Center</h1>
        <p className="text-txt-secondary text-sm">
          FX workspace — no FX macro data provider is connected yet
        </p>
      </div>

      <div
        role="note"
        aria-label="No FX macro data provider"
        data-testid="banner-forex-no-provider"
        className="flex gap-3 rounded-md border border-warning/50 bg-warning/30 p-3"
      >
        <AlertTriangle className="text-warning shrink-0 mt-0.5" size={18} />
        <div className="text-sm">
          <div className="font-semibold text-warning">No FX macro data provider connected</div>
          <div className="text-warning/80 text-xs mt-0.5">
            ARX has no live currency-strength or macro feed configured, so currency strength, pair
            bias and confidence are not shown. This page stays empty rather than display placeholder
            data. The currency notes below are static editorial context, not live analysis.
          </div>
        </div>
      </div>

      {/* Honest empty state — replaces the removed fabricated strength meter + pair table. */}
      <Card className="bg-card border-border" data-testid="forex-empty-state">
        <CardContent className="py-12 text-center space-y-2">
          <PlugZap className="mx-auto text-txt-muted" size="36" />
          <div className="text-foreground font-semibold">FX macro intelligence unavailable</div>
          <div className="text-txt-secondary text-sm max-w-md mx-auto">
            No backend FX macro provider is connected. Currency strength, rate differentials, pair
            bias and confidence cannot be shown honestly, so nothing is displayed. Live FX prices and
            signals remain fully wired on the Scanner, which uses real broker data.
          </div>
        </CardContent>
      </Card>

      {/* Static currency notes — clearly labeled, not live data. */}
      <div>
        <div className="text-xs uppercase tracking-wide text-txt-muted mb-2">
          Static currency notes (editorial — not live data)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(CURRENCY_NOTES).map(([code, t]) => (
            <Card key={code} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="font-bold text-foreground text-sm mb-0.5">{code}</div>
                <div className="text-xs text-txt-muted mb-1">{t.centralBank}</div>
                <div className="text-xs text-txt-secondary">{t.note}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
