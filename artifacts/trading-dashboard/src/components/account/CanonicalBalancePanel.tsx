// CanonicalBalancePanel — Task #430 single shared balance readout.
//
// Every balance surface (Dashboard, account, Open Trades, risk panel, wallet,
// admin) renders THIS component off the canonical `live` block from
// useLiveAccountSnapshot, so they always agree on live equity. There is no
// per-page balance maths — the numbers come straight from the server's
// canonical buildInvestorLiveBalanceSnapshot.
//
// HONESTY
//   - floatingPnL null ⇒ rendered as "—" with an "unavailable" note, never
//     0-faked.
//   - The canonical freshness.status (fresh|stale|unavailable) drives a
//     FreshnessBadge so a stale figure is clearly marked, never relabelled live.

import { cn } from "@/lib/utils";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import type { Freshness, InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";
import { useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";

interface CanonicalBalancePanelProps {
  live: InvestorLiveBalance | null;
  className?: string;
  /** Optional heading; omit for an embedded/compact placement. */
  title?: string;
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(n: number | null | undefined): { text: string; tone: string } {
  if (n == null || !Number.isFinite(n)) return { text: "—", tone: "text-txt-muted" };
  const tone = n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-txt";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return { text: `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, tone };
}

/** Map the canonical freshness status onto the FreshnessBadge enum. */
function toBadgeFreshness(status: "fresh" | "stale" | "unavailable"): Freshness {
  return status; // shared values: fresh | stale | unavailable
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", tone ?? "text-txt")}>{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-txt-muted">{sub}</div> : null}
    </div>
  );
}

export function CanonicalBalancePanel({ live, className, title }: CanonicalBalancePanelProps) {
  const status = live?.freshness.status ?? "unavailable";
  const lastUpdatedMs = live?.freshness.lastUpdatedAt ? Date.parse(live.freshness.lastUpdatedAt) : null;
  const floating = signedMoney(live?.floatingPnL ?? null);
  const realized = signedMoney(live?.realizedPnL ?? null);
  const floatingUnavailable = live != null && live.floatingPnL == null;

  return (
    <div className={cn("rounded-xl border border-border bg-surface/40 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-txt">{title ?? "Account balance"}</span>
        <FreshnessBadge
          freshness={toBadgeFreshness(status)}
          lastUpdatedMs={Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : null}
          compact
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="Allocated" value={money(live?.allocatedBalance ?? null)} />
        <Tile label="Live equity" value={money(live?.liveEquity ?? null)} />
        <Tile label="Available" value={money(live?.availableBalance ?? null)} />
        <Tile
          label="Floating P/L"
          value={floating.text}
          tone={floating.tone}
          sub={floatingUnavailable ? "unavailable" : undefined}
        />
        <Tile label="Realized P/L" value={realized.text} tone={realized.tone} />
        <Tile label="Margin used" value={money(live?.marginUsed ?? null)} />
        <Tile label="Free margin" value={money(live?.freeMargin ?? null)} />
        <Tile label="Open trades" value={String(live?.openTradeCount ?? 0)} />
      </div>
      {status === "stale" && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-stale-note">
          Showing last known values — the live feed is overdue. Figures may be out of date.
        </p>
      )}
      {status === "unavailable" && (
        <p className="mt-2 text-[11px] text-txt-muted" data-testid="canonical-balance-unavailable-note">
          Live balance is not available for this account mode.
        </p>
      )}
    </div>
  );
}

/**
 * Context-bound variant for pages already wrapped in
 * <LiveAccountSnapshotProvider> (e.g. the Dashboard). Reads the shared SSE
 * stream so it never opens a second connection.
 */
export function CanonicalBalanceCard({ className, title }: { className?: string; title?: string }) {
  const { live } = useLiveAccountSnapshotCtx();
  return <CanonicalBalancePanel live={live} className={className} title={title} />;
}
