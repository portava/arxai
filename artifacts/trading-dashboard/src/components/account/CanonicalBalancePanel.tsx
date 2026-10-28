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
//   - realizedPnLPendingCount > 0 (closed trades whose realized P/L the server
//     withheld) marks Realized P/L, Live equity and Equity after reserve
//     "incomplete" — freshness says nothing about completeness.
//   - floatingPnL null: the server builds liveEquity as allocated + realized +
//     (floatingPnL ?? 0), so the unknown floating P/L is counted as 0. Live
//     equity and Equity after reserve are marked "incomplete — floating P/L
//     not included", and Available (which subtracts open-trade losses) says
//     those losses are not included.
//   - Open trades is only a count when the server read a live snapshot; with
//     no balance, or no live snapshot (floatingPnL null and count 0), it
//     reads "—", never a 0 nobody counted.
//   - marginUsed / freeMargin are computed from ARX reserved risk, not broker
//     margin, so they are labelled "Reserved risk" / "Equity after reserve".

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
  const pendingCount = live?.realizedPnLPendingCount ?? 0;
  const pending = pendingCount > 0;
  const pendingSub = pending ? `incomplete — ${pendingCount} pending` : undefined;
  // Figures built from liveEquity inherit both gaps: withheld realized P/L
  // and an unavailable floating P/L (counted as 0 by the server).
  const equityGaps: string[] = [];
  if (pending) equityGaps.push(`${pendingCount} realized P/L pending`);
  if (floatingUnavailable) equityGaps.push("floating P/L not included");
  const equitySub = equityGaps.length > 0 ? `incomplete — ${equityGaps.join("; ")}` : undefined;
  // With no live snapshot the server reports openTradeCount 0 and floating
  // null without having counted anything.
  const openTradesUnread = live == null || (live.floatingPnL == null && live.openTradeCount === 0);

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
        <Tile label="Live equity" value={money(live?.liveEquity ?? null)} sub={equitySub} />
        <Tile
          label="Available"
          value={money(live?.availableBalance ?? null)}
          sub={floatingUnavailable ? "open-trade losses not included" : undefined}
        />
        <Tile
          label="Floating P/L"
          value={floating.text}
          tone={floating.tone}
          sub={floatingUnavailable ? "unavailable" : undefined}
        />
        <Tile label="Realized P/L" value={realized.text} tone={realized.tone} sub={pendingSub} />
        <Tile label="Reserved risk" value={money(live?.marginUsed ?? null)} sub="ARX reserve, not broker margin" />
        <Tile label="Equity after reserve" value={money(live?.freeMargin ?? null)} sub={equitySub} />
        <Tile
          label="Open trades"
          value={openTradesUnread || live == null ? "—" : String(live.openTradeCount)}
          sub={live != null && openTradesUnread ? "not read — no live snapshot" : undefined}
        />
      </div>
      {floatingUnavailable && live != null && live.openTradeCount > 0 && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-floating-missing-note">
          Live equity and equity after reserve are incomplete: the floating P/L of {live.openTradeCount} open
          trade{live.openTradeCount === 1 ? "" : "s"} could not be read, so it is not included. No estimate is shown in its place.
        </p>
      )}
      {pending && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-pnl-pending-note">
          Realized P/L and live equity are incomplete: {pendingCount} closed trade{pendingCount === 1 ? " is" : "s are"} awaiting
          their broker contract size, so their P/L is not included. No estimate is shown in its place.
        </p>
      )}
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
