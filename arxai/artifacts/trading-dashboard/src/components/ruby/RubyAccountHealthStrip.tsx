// RubyAccountHealthStrip — compact, read-only live-account summary pinned to
// the top of the Ruby Command Center. It mirrors the Dashboard's Account
// Snapshot numbers (balance / equity / open P/L) using the SAME shared
// snapshot hook so every surface shows identical figures. Display only — no
// execution affordances live on this surface.
//
// HONESTY
//   - Open P/L appears only in LIVE_SHARED mode; in DEMO/PAPER it is hidden
//     (an em dash), never a fabricated live number.
//   - Every snapshot field is nullable; nulls render as an em dash.
//   - The FreshnessBadge derives straight from the snapshot's freshness, so it
//     honestly reads "Unavailable" when the user isn't in live mode.

import { useLiveAccountSnapshot } from "@/hooks/useLiveAccountSnapshot";
import { useTradingMode } from "@/hooks/useTradingMode";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { formatPnl } from "@/lib/format";
import { cn } from "@/lib/utils";

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return "text-foreground";
  return n >= 0 ? "text-success" : "text-danger";
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate font-mono text-sm font-bold text-foreground sm:text-base",
          valueClass,
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function RubyAccountHealthStrip() {
  const mode = useTradingMode();
  const { snapshot, freshness, lastUpdatedMs, isEstimate, isUnavailable } =
    useLiveAccountSnapshot();

  const isLive = mode.isLiveShared;
  const label = isLive ? "LIVE" : mode.isDemo ? "DEMO" : "PAPER";

  // Balance / equity come straight from the shared snapshot (server-scoped per
  // user). Open P/L is a live-only figure — hide it outside LIVE_SHARED so a
  // non-live user never sees a number that doesn't apply to them.
  const balance = snapshot?.balance ?? null;
  const equity = snapshot?.equity ?? null;
  const openPL = isLive && !isUnavailable ? snapshot?.openPL ?? null : null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border border-border bg-card px-4 py-3"
      data-testid="ruby-account-health-strip"
    >
      <div className="flex items-center gap-6 sm:gap-8">
        <Stat label="Balance" value={money(balance)} />
        <Stat label="Equity" value={money(equity)} />
        <Stat
          label="Open P/L"
          value={openPL == null ? "—" : formatPnl(openPL)}
          valueClass={pnlClass(openPL)}
        />
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
            isLive
              ? "border-success/30 bg-success/10 text-success"
              : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          {label}
        </span>
        <FreshnessBadge
          freshness={freshness}
          lastUpdatedMs={lastUpdatedMs}
          isEstimate={isEstimate}
          compact
        />
      </div>
    </div>
  );
}

export default RubyAccountHealthStrip;
