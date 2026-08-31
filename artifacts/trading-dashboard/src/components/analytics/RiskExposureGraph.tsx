import type { AnalyticsSnapshot } from "./types";

export function RiskExposureGraph({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const items: Array<{ label: string; value: number; max: number; tone: string; suffix: string }> = [
    { label: "Profit factor", value: Math.min(snapshot.profitFactor, 3), max: 3, tone: "bg-success", suffix: snapshot.profitFactor === 999 ? "∞" : snapshot.profitFactor.toFixed(2) },
    { label: "Avg R-multiple", value: Math.max(0, Math.min(snapshot.averageRr, 3)), max: 3, tone: "bg-ruby", suffix: snapshot.averageRr.toFixed(2) + "R" },
    { label: "Win rate",       value: snapshot.winRate * 100, max: 100, tone: "bg-premium", suffix: (snapshot.winRate * 100).toFixed(1) + "%" },
    // Max drawdown is a SYNTHETIC unit ((exit − entry) × lots × 100), not
    // account currency — never rendered with a "$" sign.
    { label: "Max drawdown (units)", value: Math.min(snapshot.maxDrawdown, 1000), max: 1000, tone: "bg-danger", suffix: snapshot.maxDrawdown.toFixed(0) },
  ];
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Risk Exposure</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.label}>
            <div className="mb-0.5 flex items-baseline justify-between text-[11px]">
              <span className="text-txt-secondary">{it.label}</span>
              <span className="font-semibold text-foreground">{it.suffix}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-secondary">
              <div className={`h-full ${it.tone}`} style={{ width: `${Math.min(100, (it.value / it.max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
