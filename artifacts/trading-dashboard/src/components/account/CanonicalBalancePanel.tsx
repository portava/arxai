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

export function CanonicalBalancePanel({ live, className, title, updatesPaused = false }: CanonicalBalancePanelProps) {
  const reportedStatus = live?.freshness.status ?? "unavailable";
  const lastUpdatedMs = live?.freshness.lastUpdatedAt ? Date.parse(live.freshness.lastUpdatedAt) : null;
  const incomplete = live != null && (live.positionPnlComplete !== true || typeof live.floatingPnL !== "number" || !Number.isFinite(live.floatingPnL));
  const estimated = live?.positionPnlEstimated === true;
  const scopeUnverified = live?.monetaryScopeVerified !== true;
  const realizedComplete = Number.isSafeInteger(live?.realizedPnLPendingCount) && live!.realizedPnLPendingCount === 0;
  const derivedUnavailable = incomplete || estimated || scopeUnverified || !realizedComplete;
  const status = derivedUnavailable ? "unavailable" : reportedStatus;
  const floating = signedMoney(incomplete ? null : live?.floatingPnL ?? null);
  if (!incomplete && live?.floatingPnL != null) floating.text = `${estimated ? "~" : ""}${live.floatingPnL} (currency unverified)`;
  if (estimated || scopeUnverified) floating.tone = "text-txt-muted";
  const realized = signedMoney(realizedComplete ? live?.realizedPnL ?? null : null);
  const floatingUnavailable = live != null && live.floatingPnL == null;

  return (
    <div className={cn("rounded-xl border border-border bg-surface/40 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-txt">{title && title !== "Live balance" ? title : "ARX allocation"}</span>
        <FreshnessBadge
          freshness={toBadgeFreshness(status)}
          lastUpdatedMs={Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : null}
          compact
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="Allocated" value={money(live?.allocatedBalance ?? null)} />
        <Tile label={updatesPaused || status !== "fresh" ? "Last-known allocation equity" : "Allocation equity"} value={money(derivedUnavailable ? null : live?.liveEquity ?? null)} />
        <Tile label="Allocation available" value={money(incomplete || scopeUnverified ? null : live?.availableBalance ?? null)} />
        <Tile
          label="Position P/L"
          value={floating.text}
          tone={floating.tone}
          sub={floatingUnavailable ? "unavailable" : undefined}
        />
        <Tile label="Realized P/L" value={realized.text} tone={realized.tone} />
        <Tile label="Reserved risk" value={money(live?.marginUsed ?? null)} />
        <Tile label="Allocation less reserved risk" value={money(derivedUnavailable ? null : live?.freeMargin ?? null)} />
        <Tile label="Open trades" value={live?.openTradeCount != null && Number.isInteger(live.openTradeCount) && live.openTradeCount >= 0 ? String(live.openTradeCount) : "—"} />
      </div>
      <p className="mt-2 text-[11px] text-txt-muted">ARX allocation accounting, not broker account balance, equity or margin.</p>
      {scopeUnverified && <p className="mt-2 text-[11px] text-warning">Position totals have no verified shared account and currency scope. They cannot establish allocation equity or available funds.</p>}
      {estimated && <p className="mt-2 text-[11px] text-txt-muted">Quote-derived position P/L is an estimate; account-currency conversion is unverified.</p>}
      {derivedUnavailable && <p className="mt-2 text-[11px] text-warning">Position or realized P/L evidence is incomplete, estimated, or has unverified monetary scope. Derived allocation figures are unavailable.</p>}
      {updatesPaused && (
        <p className="mt-2 text-[11px] text-txt-muted" data-testid="canonical-balance-paused-note">
          Automatic updates are paused. These are the last received figures; Refresh checks them once.
        </p>
      )}
      {status === "stale" && (
        <p className="mt-2 text-[11px] text-warning/80" data-testid="canonical-balance-stale-note">
          Showing last known values — the live feed is overdue. Figures may be out of date.
        </p>
      )}
      {status === "unavailable" && (
        <p className="mt-2 text-[11px] text-txt-muted" data-testid="canonical-balance-unavailable-note">
          Current balance freshness is unavailable. Any figures shown are last known.
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
