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
//   - With automatic updates paused, or a Live Shared figure that is not
//     fresh, the equity tile reads "Last-known equity", never "Live equity".
//   - realizedPnLPendingCount > 0 (closed trades whose realized P/L the server
//     withheld) marks Realized P/L, Live equity and Equity after reserve
//     "incomplete" — freshness says nothing about completeness.
//   - floatingPnL null: the server builds liveEquity as allocated + realized +
//     (floatingPnL ?? 0), so the unknown floating P/L is counted as 0. Live
//     equity and Equity after reserve are marked "incomplete — floating P/L
//     not included", and Available (which subtracts open-trade losses) says
//     those losses are not included.
//   - floatingPnLUnknownCount > 0 with a non-null floatingPnL: the server sums
//     only the open trades whose P/L is known, so the unknown ones are left
//     out. Floating P/L, Live equity and Equity after reserve say "incomplete
//     — P/L of N of M open trades not included", and Available says those
//     trades' losses are not included.
//   - Open trades is only a count when the server read a live snapshot; with
//     no balance, or no live snapshot (floatingPnL null and count 0), it
//     reads "—", never a 0 nobody counted.
//   - marginUsed / freeMargin are computed from ARX reserved risk, not broker
//     margin, so they are labelled "Reserved risk" / "Equity after reserve".
//   - Live positions are read only for Live Shared data (source live_shared).
//     For demo / paper / unknown data the heading never says "Live", the
//     equity tile is "Equity" (no open P/L in it) and the open-trade count,
//     which was never read, is "—" rather than 0.

import { cn } from "@/lib/utils";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import type { Freshness, InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";
import { useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";

interface CanonicalBalancePanelProps {
  live: InvestorLiveBalance | null;
  updatesPaused?: boolean;
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

const SOURCE_TITLE: Record<InvestorLiveBalance["source"], string> = {
  live_shared: "Live balance",
  demo: "Demo balance",
  paper: "Paper balance",
  unknown: "Account balance",
};

/**
 * The panel heading. A caller's title that says "live" is used only for Live
 * Shared data; demo, paper or unknown data is titled by its source.
 */
export function canonicalBalanceTitle(live: InvestorLiveBalance | null, title?: string): string {
  if (live?.source === "live_shared") return title ?? "Account balance";
  if (title && !/\blive\b/i.test(title)) return title;
  return live ? SOURCE_TITLE[live.source] ?? "Account balance" : "Account balance";
}

export function CanonicalBalancePanel({ live, className, title, updatesPaused = false }: CanonicalBalancePanelProps) {
  const status = live?.freshness.status ?? "unavailable";
  // Live positions (floating P/L, open-trade count) are read only for Live Shared data.
  const livePositionsRead = live?.source === "live_shared";
  const lastUpdatedMs = live?.freshness.lastUpdatedAt ? Date.parse(live.freshness.lastUpdatedAt) : null;
  const floating = signedMoney(live?.floatingPnL ?? null);
  const realized = signedMoney(live?.realizedPnL ?? null);
  const floatingUnavailable = live != null && live.floatingPnL == null;
  // Some (not all) open trades' P/L unknown: floatingPnL is the known part only.
  const unknownPLCount =
    livePositionsRead && live != null && live.floatingPnL != null
      ? Math.max(0, Math.floor(live.floatingPnLUnknownCount ?? 0))
      : 0;
  const floatingPartial = unknownPLCount > 0;
  const openCount = live?.openTradeCount ?? 0;
  const partialOf = `${unknownPLCount} of ${Math.max(openCount, unknownPLCount)} open trade${Math.max(openCount, unknownPLCount) === 1 ? "" : "s"}`;
  const pendingCount = live?.realizedPnLPendingCount ?? 0;
  const pending = pendingCount > 0;
  const pendingSub = pending ? `incomplete — ${pendingCount} pending` : undefined;
  // Figures built from liveEquity inherit both gaps: withheld realized P/L
  // and an unavailable floating P/L (counted as 0 by the server).
  // Demo / paper / unknown data never had open P/L read, so it says that
  // instead of calling a floating P/L that was never measured "not included".
  const equityGaps: string[] = [];
  if (pending) equityGaps.push(`${pendingCount} realized P/L pending`);
  if (floatingUnavailable && livePositionsRead) equityGaps.push("floating P/L not included");
  if (floatingPartial) equityGaps.push(`P/L of ${partialOf} not included`);
  const equitySubParts: string[] = [];
  if (equityGaps.length > 0) equitySubParts.push(`incomplete — ${equityGaps.join("; ")}`);
  if (live && !livePositionsRead) equitySubParts.push("no open P/L included");
  const equitySub = equitySubParts.length > 0 ? equitySubParts.join(" · ") : undefined;
  // With no live snapshot the server reports openTradeCount 0 and floating
  // null without having counted anything; outside Live Shared the count is
  // never read at all.
  // A count that is not a whole number >= 0 was not really counted either.
  const openTradesUnread =
    live == null ||
    !livePositionsRead ||
    !(Number.isInteger(live.openTradeCount) && live.openTradeCount >= 0) ||
    (live.floatingPnL == null && live.openTradeCount === 0);
  // Paused updates, or a Live Shared figure that is not confirmed fresh, is a
  // last-known amount, never "Live equity". Demo / paper / unknown data has no
  // live feed to be fresh against, so it is plain "Equity" unless paused or stale.
  const equityLabel =
    updatesPaused || status === "stale" || (livePositionsRead && status !== "fresh")
      ? "Last-known equity"
      : livePositionsRead
        ? "Live equity"
        : "Equity";

  return (
    <div className={cn("rounded-xl border border-border bg-surface/40 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-txt" data-testid="canonical-balance-title">{canonicalBalanceTitle(live, title)}</span>
        <FreshnessBadge
          freshness={toBadgeFreshness(status)}
          lastUpdatedMs={Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : null}
          compact
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="Allocated" value={money(live?.allocatedBalance ?? null)} />
        <Tile label={equityLabel} value={money(live?.liveEquity ?? null)} sub={equitySub} />
        <Tile
          label="Available"
          value={money(live?.availableBalance ?? null)}
          sub={
            floatingUnavailable
              ? "open-trade losses not included"
              : floatingPartial
                ? `losses of ${unknownPLCount} open trade${unknownPLCount === 1 ? "" : "s"} not included`
                : undefined
          }
        />
        <Tile
          label="Floating P/L"
          value={floating.text}
          tone={floating.tone}
          sub={floatingUnavailable ? "unavailable" : floatingPartial ? `incomplete — ${partialOf} not included` : undefined}
        />
        <Tile label="Realized P/L" value={realized.text} tone={realized.tone} sub={pendingSub} />
        <Tile label="Reserved risk" value={money(live?.marginUsed ?? null)} sub="ARX reserve, not broker margin" />
        <Tile label="Equity after reserve" value={money(live?.freeMargin ?? null)} sub={equitySub} />
        <Tile
          label="Open trades"
          value={openTradesUnread || live == null ? "—" : String(live.openTradeCount)}
          sub={
            live == null
              ? undefined
              : !livePositionsRead
                ? "not read for this account mode"
                : openTradesUnread
                  ? "not read — no live snapshot"
                  : undefined
          }
        />
      </div>
      {updatesPaused && (
        <p className="mt-2 text-[11px] text-txt-muted" data-testid="canonical-balance-paused-note">
          Automatic updates are paused. These are the last received figures; Refresh checks them once.
        </p>
      )}
      {floatingUnavailable && livePositionsRead && live != null && live.openTradeCount > 0 && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-floating-missing-note">
          Live equity and equity after reserve are incomplete: the floating P/L of {live.openTradeCount} open
          trade{live.openTradeCount === 1 ? "" : "s"} could not be read, so it is not included. No estimate is shown in its place.
        </p>
      )}
      {floatingPartial && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-floating-partial-note">
          Floating P/L, live equity and equity after reserve are incomplete: the P/L of {partialOf} could not be read,
          so it is not included. No estimate is shown in its place.
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
          {livePositionsRead
            ? "Live balance is not confirmed current: part or all of the live data behind it was missing at the last read. Any figures shown are last known."
            : "Live balance is not available for this account mode."}
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
  const { live, autoRefreshEnabled } = useLiveAccountSnapshotCtx();
  return <CanonicalBalancePanel live={live} updatesPaused={!autoRefreshEnabled} className={className} title={title} />;
}
