import { useEffect, useMemo, useRef, useState } from "react";
import {
  ShieldCheck,
  Eye,
  Wallet,
  PieChart,
  TrendingUp,
  Layers,
  ScrollText,
  FileText,
  ExternalLink,
  Info,
  CheckCircle2,
  Clock,
  Coins,
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Gauge,
  AlertTriangle,
  CalendarDays,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAssistantName } from "@/lib/assistant-name";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMeInvestorOverview,
  useGetMeInvestorAllocation,
  useGetMeInvestorPerformance,
  useGetMeInvestorExposure,
  useGetMeInvestorActivity,
  useGetMeInvestorDocuments,
  useSubmitMeInvestorAllocation,
  useGetMeFundBook,
  useGetMeFundBookDrawdown,
  useGetMeFundBookValueStatus,
  useGetMeCapitalAvailable,
  useGetMeCapitalSettings,
  usePreviewMeCapitalDeposit,
  useCreateMeCapitalDeposit,
  usePreviewMeCapitalWithdrawal,
  useCreateMeCapitalWithdrawal,
  useListMeCapitalRequests,
  useGetMeWeeklyReports,
  useGetMeWeeklyReport,
  getGetMeWeeklyReportQueryKey,
  useGetMeFundBookTier,
} from "@workspace/api-client-react";
import type {
  CapitalSpeedTier,
  CapitalDepositPreviewResp,
  CapitalWithdrawalPreviewResp,
  FundBookInvestorPool,
  WeeklyReportDto,
} from "@workspace/api-client-react";

function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function fmtUnits(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function fmtTimeAgo(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 0) return fmtDate(s);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return fmtDate(s);
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Info; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ACTIVE: "bg-success/15 text-success",
    APPROVED: "bg-success/15 text-success",
    SETTLED: "bg-success/15 text-success",
    PENDING_APPROVAL: "bg-warning/15 text-warning",
    PENDING: "bg-warning/15 text-warning",
    REVIEWING: "bg-warning/15 text-warning",
    UNDER_REVIEW: "bg-warning/15 text-warning",
    REJECTED: "bg-danger/15 text-danger",
    CANCELLED: "bg-muted text-muted-foreground",
    SUPERSEDED: "bg-muted text-muted-foreground",
    DRAFT: "bg-muted text-muted-foreground",
  };
  const label = status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return <Badge className={map[status] ?? "bg-muted text-muted-foreground"}>{label}</Badge>;
}

// Freshness chip — every live value in the portal carries one so the reader
// always knows how current the number is. Never asserts data that isn't there.
function FreshnessBadge({
  freshness,
  asOf,
  className,
}: {
  freshness: string | null | undefined;
  asOf?: string | null;
  className?: string;
}) {
  const f = (freshness ?? "MISSING").toUpperCase();
  const map: Record<string, { cls: string; label: string }> = {
    FRESH: { cls: "bg-success/15 text-success", label: "Live" },
    DELAYED: { cls: "bg-warning/15 text-warning", label: "Delayed" },
    STALE: { cls: "bg-danger/15 text-danger", label: "Stale" },
    UNDER_REVIEW: { cls: "bg-ruby/15 text-ruby", label: "Under review" },
    MISSING: { cls: "bg-muted text-muted-foreground", label: "Unavailable" },
  };
  const m = map[f] ?? map.MISSING;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.cls} ${className ?? ""}`}
      data-testid="freshness-badge"
      title={asOf ? `As of ${fmtDate(asOf)}` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
      {asOf ? <span className="font-normal opacity-80">· {fmtTimeAgo(asOf)}</span> : null}
    </span>
  );
}

// A signed money figure that colours gains green and losses red.
function PnlValue({ value, currency }: { value: number | null | undefined; currency: string }) {
  if (value == null) return <span className="tabular-nums">—</span>;
  const cls = value > 0 ? "text-success" : value < 0 ? "text-danger" : "";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`tabular-nums ${cls}`}>
      {sign}
      {fmtMoney(value, currency)}
    </span>
  );
}

function StatCard({
  label,
  children,
  testid,
}: {
  label: string;
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-black tabular-nums" data-testid={testid}>
          {children}
        </p>
      </CardContent>
    </Card>
  );
}

// Section-level freshness label so every group of live-derived values carries
// an explicit "as of" indicator, not just the headline figure.
function SectionHeader({
  title,
  freshness,
  asOf,
}: {
  title: string;
  freshness: string | null | undefined;
  asOf?: string | null;
}) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <FreshnessBadge freshness={freshness} asOf={asOf} />
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────
function OverviewTab() {
  const overviewQ = useGetMeInvestorOverview();
  const fundBookQ = useGetMeFundBook();
  const capitalQ = useGetMeCapitalAvailable();
  const drawdownQ = useGetMeFundBookDrawdown();
  const valueStatusQ = useGetMeFundBookValueStatus();

  if (overviewQ.isLoading || fundBookQ.isLoading) return <Skeleton className="h-64 w-full" />;
  const overview = overviewQ.data;
  const fundBook = fundBookQ.data;
  if (!overview) return null;

  const ccy = fundBook?.baseCurrency ?? overview.baseCurrency;
  const valuation = capitalQ.data?.valuation;
  const own = drawdownQ.data?.own;
  const valueStatus = valueStatusQ.data;

  const realized = fundBook?.realizedPnl ?? overview.realizedPnl;
  const floating = fundBook?.unrealizedFloatingPl ?? overview.unrealizedPnl;
  const netPnl = realized + floating;
  const realtimeValue = fundBook?.realtimeValue ?? overview.currentValue;
  const settledValue = fundBook?.settledValue ?? null;
  const pendingSettlement =
    fundBook != null ? fundBook.totalValue - fundBook.settledValue : null;

  if (!overview.hasFunds) {
    return (
      <div className="space-y-4" data-testid="investor-overview">
        <EmptyState
          icon={Wallet}
          title="No funds recorded yet"
          body="Once your first deposit is recorded, your portfolio value, holdings, and balance breakdown will appear here."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="investor-overview">
      {overview.status === "paused" && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          Allocation changes are paused on your account.
          {overview.pausedReason ? ` ${overview.pausedReason}` : ""}
        </div>
      )}

      {valueStatus && valueStatus.status !== "FRESH" && (
        <div
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
          data-testid="value-status-banner"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{valueStatus.message}</span>
        </div>
      )}

      {/* Headline real-time value with freshness */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Real-time account value
            </p>
            <FreshnessBadge
              freshness={fundBook?.freshness}
              asOf={fundBook?.freshnessAsOf ?? valueStatus?.asOf}
            />
          </div>
          <p className="mt-1 text-4xl font-black tabular-nums" data-testid="realtime-value">
            {fmtMoney(realtimeValue, ccy)}
          </p>
          {settledValue != null && (
            <p className="mt-1 text-xs text-muted-foreground">
              Settled value {fmtMoney(settledValue, ccy)}
              {pendingSettlement != null && Math.abs(pendingSettlement) >= 0.005
                ? ` · ${fmtMoney(pendingSettlement, ccy)} awaiting the next valuation cycle`
                : ""}
            </p>
          )}
        </CardContent>
      </Card>

      {/* P/L grid */}
      <div className="space-y-2">
        <SectionHeader
          title="Profit & loss"
          freshness={fundBook?.freshness}
          asOf={fundBook?.freshnessAsOf ?? valueStatus?.asOf}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Net Invested" testid="stat-net-invested">
            {fmtMoney(overview.netContributed, ccy)}
          </StatCard>
          <StatCard label="Realized P/L" testid="stat-realized">
            <PnlValue value={realized} currency={ccy} />
          </StatCard>
          <StatCard label="Floating P/L" testid="stat-floating">
            <PnlValue value={floating} currency={ccy} />
          </StatCard>
          <StatCard label="Net P/L" testid="stat-net-pnl">
            <PnlValue value={netPnl} currency={ccy} />
          </StatCard>
        </div>
      </div>

      {/* Balance breakdown */}
      <Card data-testid="balance-breakdown">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">Balance breakdown</CardTitle>
            <FreshnessBadge
              freshness={fundBook?.freshness}
              asOf={fundBook?.freshnessAsOf ?? valueStatus?.asOf}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {fundBook && (
            <>
              <BreakdownRow
                label="Current value"
                value={fmtMoney(fundBook.realtimeValue, ccy)}
                strong
              />
              <BreakdownRow label="Settled value" value={fmtMoney(fundBook.settledValue, ccy)} />
              <BreakdownRow
                label="Pending settlement"
                value={fmtMoney(fundBook.totalValue - fundBook.settledValue, ccy)}
                hint="Value not yet settled into your account"
              />
            </>
          )}
          <BreakdownRow label="Allocated to strategies" value={fmtMoney(overview.allocatedFunds, ccy)} />
          {valuation && (
            <>
              <BreakdownRow
                label="Locked principal"
                value={fmtMoney(valuation.lockedPrincipal, ccy)}
                hint={
                  valuation.nextLockReleaseAt
                    ? `Next release ${fmtDate(valuation.nextLockReleaseAt)}`
                    : undefined
                }
              />
              <BreakdownRow label="Reserved (pending requests)" value={fmtMoney(valuation.reservedValue, ccy)} />
              <BreakdownRow
                label="Available to withdraw"
                value={fmtMoney(valuation.availableForWithdrawal, ccy)}
                strong
                testid="stat-available-withdraw"
              />
            </>
          )}
          {!valuation && capitalQ.isLoading && <Skeleton className="h-6 w-full" />}
        </CardContent>
      </Card>

      {/* Drawdown summary */}
      {own && (
        <div className="space-y-2" data-testid="drawdown-summary">
          <SectionHeader
            title="Drawdown"
            freshness={fundBook?.freshness}
            asOf={fundBook?.freshnessAsOf ?? valueStatus?.asOf}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="High-water mark">{fmtMoney(own.highWaterValue, ccy)}</StatCard>
            <StatCard label="Current value">{fmtMoney(own.currentValue, ccy)}</StatCard>
            <StatCard label="Drawdown from peak">
              <span className={own.drawdownUsd > 0 ? "text-danger" : ""}>
                {fmtMoney(own.drawdownUsd, ccy)}
                {own.drawdownPercent ? ` · ${fmtPct(own.drawdownPercent)}` : ""}
              </span>
            </StatCard>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Current risk profile
            </p>
            <p className="mt-1 text-lg font-bold">{overview.currentRiskProfile ?? "Not set"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Last updated</p>
            <p className="mt-1 text-lg font-bold">{fmtDate(overview.lastUpdatedAt)}</p>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Figures reflect the values recorded against your account only. Returns are shown when
        data is available and are never projected or implied.
      </p>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  hint,
  strong,
  testid,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  testid?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-2 last:border-0">
      <div>
        <p className={`text-sm ${strong ? "font-semibold" : "text-muted-foreground"}`}>{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      <p
        className={`tabular-nums ${strong ? "text-base font-black" : "text-sm font-semibold"}`}
        data-testid={testid}
      >
        {value}
      </p>
    </div>
  );
}

// ── Holdings (Fund Book) tab ─────────────────────────────────────────────────
function HoldingsTab() {
  const fundBookQ = useGetMeFundBook();
  const drawdownQ = useGetMeFundBookDrawdown();

  if (fundBookQ.isLoading) return <Skeleton className="h-64 w-full" />;
  const fundBook = fundBookQ.data;
  if (!fundBook) return null;

  const ccy = fundBook.baseCurrency;
  const pools = fundBook.pools ?? [];
  const poolDrawdowns = drawdownQ.data?.pools ?? [];

  if (pools.length === 0) {
    return (
      <EmptyState
        icon={Coins}
        title="No holdings yet"
        body="When your capital is allocated into a strategy pool, your unit holdings and their value will appear here."
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="investor-holdings">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Your unit holdings in each strategy pool, valued at the latest unit price.
        </p>
        <FreshnessBadge freshness={fundBook.freshness} asOf={fundBook.freshnessAsOf} />
      </div>
      {pools.filter((p: FundBookInvestorPool) => p.poolKey === "BALANCED").map((p: FundBookInvestorPool) => {
        const dd = poolDrawdowns.find((d) => d.poolKey === p.poolKey);
        return (
          <Card key={p.poolKey} data-testid={`holding-${p.poolKey}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">{p.name}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[11px]">
                    {p.riskLevel}
                  </Badge>
                  <FreshnessBadge freshness={p.navStatus} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current value
                  </p>
                  <p className="text-2xl font-black tabular-nums" data-testid={`holding-value-${p.poolKey}`}>
                    {fmtMoney(p.currentValue, ccy)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Share of floating P/L
                  </p>
                  <p className="text-lg font-bold">
                    <PnlValue value={p.floatingPlShare} currency={ccy} />
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                <HoldingStat label="Units owned" value={fmtUnits(p.unitsOwned)} />
                <HoldingStat label="Unit price (NAV)" value={fmtMoney(p.navPerUnit, ccy)} />
                <HoldingStat label="Average cost / unit" value={fmtMoney(p.averageNav, ccy)} />
                <HoldingStat label="Cost basis" value={fmtMoney(p.costBasis, ccy)} />
                <HoldingStat label="Ownership of pool" value={fmtPct(p.ownershipPct)} />
                {dd && <HoldingStat label="Drawdown from peak" value={fmtPct(dd.drawdownPercent)} />}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Buy-in tier pricing block — shows the current entry price for new
          investors. Read-only, no execution gate involvement. */}
      <InvestorTierCard />

      <p className="text-xs text-muted-foreground">
        Unit values update with each valuation cycle. Figures reflect recorded values only and are
        never projected or implied.
      </p>
    </div>
  );
}

function InvestorTierCard() {
  const tierQ = useGetMeFundBookTier({});
  if (tierQ.isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (tierQ.isError || !tierQ.data?.tier) return null;
  const t = tierQ.data.tier;
  const isDynamic = t.activePricingMode === "DYNAMIC";

  // Within-tier progress: (finalizedNav - tierFloor) / (nextThreshold - tierFloor)
  const tierFloor = t.activeTierNavMin ?? 0;
  const hasNextTier = t.nextTierThreshold != null;
  const tierProgress = hasNextTier
    ? (() => {
        const range = t.nextTierThreshold! - tierFloor;
        return range > 0
          ? Math.min(1, Math.max(0, (t.finalizedTotalNav - tierFloor) / range))
          : 1;
      })()
    : null;

  const hasJoinSnapshot = t.joinTierNum != null || t.joinPrice != null;

  return (
    <Card data-testid="investor-tier-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Buy-in Tier &amp; Account Value</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" data-testid="investor-tier-label">{t.activeTierLabel}</Badge>
            {isDynamic && (
              <Badge className="bg-warning/15 text-warning text-[11px]">Dynamic</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* ── Active tier pricing ── */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Buy-in price / unit</p>
            <p className="text-xl font-bold tabular-nums" data-testid="investor-tier-buyin-price">
              {fmtMoney(t.activeBuyInPrice)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1" data-testid="investor-tier-buyin-note">
              Later investors may receive fewer shares as ARX grows.
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Finalized NAV / unit</p>
            <p className="text-lg font-semibold tabular-nums">{fmtMoney(t.finalizedNavPerUnit)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Units owned</p>
            <p className="font-semibold tabular-nums" data-testid="investor-units-owned">
              {t.unitsOwned.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Avg buy-in</p>
            <p className="font-semibold tabular-nums">{fmtMoney(t.averageBuyIn)}</p>
          </div>
        </div>

        {/* ── Account value: finalized vs estimated ── */}
        <div className="rounded-md border border-border/40 p-3 space-y-2 bg-muted/20">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Account value
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Finalized (realized only)</p>
              <p className="font-bold tabular-nums" data-testid="investor-finalized-value">
                {fmtMoney(t.currentFinalizedValue)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Estimated (incl. floating)</p>
              <p className="font-semibold tabular-nums text-muted-foreground" data-testid="investor-estimated-value">
                {fmtMoney(t.currentEstimatedValue)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Realized P/L</p>
              <p className={`font-semibold tabular-nums ${t.realizedPl >= 0 ? "text-success" : "text-danger"}`}
                data-testid="investor-realized-pl">
                {t.realizedPl >= 0 ? "+" : ""}{fmtMoney(t.realizedPl)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unrealized P/L</p>
              <p className={`font-semibold tabular-nums ${t.unrealizedPl >= 0 ? "text-success" : "text-danger"}`}
                data-testid="investor-unrealized-pl">
                {t.unrealizedPl >= 0 ? "+" : ""}{fmtMoney(t.unrealizedPl)}
              </p>
            </div>
          </div>
        </div>

        {/* ── Join-time snapshot ── */}
        {hasJoinSnapshot && (
          <div className="rounded-md border border-border/40 p-3 space-y-1 bg-muted/10">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Your entry snapshot
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {t.joinTierNum != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Entry tier</p>
                  <p className="font-semibold" data-testid="investor-join-tier">
                    T{t.joinTierNum}{t.joinTierLabel ? ` — ${t.joinTierLabel}` : ""}
                  </p>
                </div>
              )}
              {t.joinPrice != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Entry price / unit</p>
                  <p className="font-semibold tabular-nums" data-testid="investor-join-price">
                    {fmtMoney(t.joinPrice)}
                  </p>
                </div>
              )}
              {t.joinUnits != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Units at entry</p>
                  <p className="font-semibold tabular-nums">
                    {t.joinUnits.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  </p>
                </div>
              )}
              {t.joinedAt != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Entry date</p>
                  <p className="font-semibold">
                    {new Date(t.joinedAt).toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Next-tier progress bar ── */}
        {hasNextTier && tierProgress != null && (
          <div className="space-y-1" data-testid="investor-tier-progress">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Pool progress to next tier</span>
              <span className="tabular-nums font-medium">
                {Math.round(tierProgress * 100)}% —{" "}
                {fmtMoney(t.nextTierThreshold! - t.finalizedTotalNav)} remaining
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.round(tierProgress * 100)}%` }}
              />
            </div>
            {t.nextTierEstimatedPrice != null && (
              <p className="text-xs text-muted-foreground">
                Next tier price: {fmtMoney(t.nextTierEstimatedPrice)} / unit
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Finalized value reflects realized P/L only. Estimated includes floating gains/losses.
          {isDynamic ? " T10: price steps up dynamically above $1.5M pool NAV." : ""}
        </p>
      </CardContent>
    </Card>
  );
}

function HoldingStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// ── Allocation tab ──────────────────────────────────────────────────────────
function AllocationTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetMeInvestorAllocation();
  const submit = useSubmitMeInvestorAllocation();

  const [profileKey, setProfileKey] = useState<string>("");
  const [custom, setCustom] = useState({ conservativePct: 34, balancedPct: 33, aggressivePct: 33 });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profiles = data?.profiles ?? [];
  const maxAgg = data?.maxAggressivePct ?? 50;
  const isCustom = profileKey === "CUSTOM";

  const split = useMemo(() => {
    if (!profileKey) return null;
    if (isCustom) return custom;
    const p = profiles.find((x) => x.profileKey === profileKey);
    return p
      ? { conservativePct: p.conservativePct, balancedPct: p.balancedPct, aggressivePct: p.aggressivePct }
      : null;
  }, [profileKey, isCustom, custom, profiles]);

  const sum = split ? split.conservativePct + split.balancedPct + split.aggressivePct : 0;
  const aggOk = split ? split.aggressivePct <= maxAgg : true;
  const canSubmit =
    Boolean(data?.canSubmit) && Boolean(profileKey) && accepted && sum === 100 && aggOk && !submit.isPending;

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  async function onSubmit() {
    setError(null);
    try {
      await submit.mutateAsync({
        data: {
          profileKey: profileKey as "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" | "CUSTOM",
          ...(isCustom ? custom : {}),
          riskDisclosureAccepted: accepted,
        },
      });
      setProfileKey("");
      setAccepted(false);
      qc.invalidateQueries();
    } catch (e) {
      const msg =
        (e as { data?: { message?: string } })?.data?.message ??
        "Could not submit your allocation request.";
      setError(msg);
    }
  }

  return (
    <div className="space-y-4" data-testid="investor-allocation">
      {data.active && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Active Allocation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-bold">{data.active.profileKey}</span>
              <StatusBadge status={data.active.status} />
            </div>
            <SleeveBar
              conservativePct={data.active.conservativePct}
              balancedPct={data.active.balancedPct}
              aggressivePct={data.active.aggressivePct}
            />
            <p className="text-xs text-muted-foreground">Approved {fmtDate(data.active.activatedAt)}</p>
          </CardContent>
        </Card>
      )}

      {data.pending && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <div className="flex items-center gap-2 font-semibold">
            <Clock className="h-4 w-4" /> Request awaiting review
          </div>
          <p className="mt-1">
            Your {data.pending.profileKey} allocation request was submitted{" "}
            {fmtDate(data.pending.submittedAt)} and is pending administrator approval.
          </p>
        </div>
      )}

      {data.allocationPaused && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          Allocation changes are paused on your account.
          {data.pausedReason ? ` ${data.pausedReason}` : ""}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Request an Allocation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose a strategy profile or build a custom split. This is a preference request —
            it is reviewed and approved by an administrator before taking effect, and does not
            promise any outcome or return.
          </p>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Strategy Profile
            </label>
            <Select value={profileKey} onValueChange={setProfileKey} disabled={!data.canSubmit}>
              <SelectTrigger data-testid="select-profile">
                <SelectValue placeholder="Select a profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.profileKey} value={p.profileKey}>
                    {p.label} · {p.conservativePct}/{p.balancedPct}/{p.aggressivePct}
                  </SelectItem>
                ))}
                <SelectItem value="CUSTOM">Custom split</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isCustom && (
            <div className="grid grid-cols-3 gap-3">
              {(["conservativePct", "balancedPct", "aggressivePct"] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <label className="text-xs capitalize text-muted-foreground">
                    {k.replace("Pct", "")}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={custom[k]}
                    onChange={(e) =>
                      setCustom((c) => ({ ...c, [k]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))
                    }
                    data-testid={`input-${k}`}
                  />
                </div>
              ))}
            </div>
          )}

          {split && (
            <div className="space-y-2">
              <SleeveBar {...split} />
              <div className="flex items-center justify-between text-xs">
                <span className={sum === 100 ? "text-muted-foreground" : "text-danger"}>
                  Total: {sum}% {sum !== 100 && "(must equal 100%)"}
                </span>
                <span className={aggOk ? "text-muted-foreground" : "text-danger"}>
                  Aggressive cap: {maxAgg}%
                </span>
              </div>
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={!data.canSubmit}
              data-testid="checkbox-disclosure"
            />
            <span className="text-muted-foreground">
              I understand that trading involves risk, that allocation preferences are an intent
              subject to administrator approval, and that no return is promised or implied.
              (Disclosure {data.riskDisclosureVersion})
            </span>
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button onClick={onSubmit} disabled={!canSubmit} data-testid="button-submit-allocation">
            {submit.isPending ? "Submitting…" : "Submit allocation request"}
          </Button>
          {!data.canSubmit && (
            <p className="text-xs text-muted-foreground">
              {data.allocationPaused
                ? "Submissions are paused on your account."
                : "You already have a request awaiting review."}
            </p>
          )}
        </CardContent>
      </Card>

      {data.history.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Request History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.history.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between border-b border-border/50 py-2 text-sm last:border-0"
              >
                <div>
                  <span className="font-medium">{h.profileKey}</span>{" "}
                  <span className="text-muted-foreground">
                    {h.conservativePct}/{h.balancedPct}/{h.aggressivePct}
                  </span>
                  {h.reviewNote && (
                    <p className="text-xs text-muted-foreground">Note: {h.reviewNote}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={h.status} />
                  <span className="text-xs text-muted-foreground">{fmtDate(h.createdAt)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SleeveBar({
  conservativePct,
  balancedPct,
  aggressivePct,
}: {
  conservativePct: number;
  balancedPct: number;
  aggressivePct: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        <div className="bg-ruby" style={{ width: `${conservativePct}%` }} />
        <div className="bg-primary" style={{ width: `${balancedPct}%` }} />
        <div className="bg-warning" style={{ width: `${aggressivePct}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>Conservative {conservativePct}%</span>
        <span>Balanced {balancedPct}%</span>
        <span>Aggressive {aggressivePct}%</span>
      </div>
    </div>
  );
}

// ── Performance tab ─────────────────────────────────────────────────────────
function PerformanceTab() {
  const { data, isLoading } = useGetMeInvestorPerformance();
  const drawdownQ = useGetMeFundBookDrawdown();
  const fundBookQ = useGetMeFundBook();
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;
  if (!data.hasPerformanceData) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No performance recorded yet"
        body="Your equity history will appear here once activity is recorded against your account. Nothing here is projected or implied."
      />
    );
  }
  const ccy = data.baseCurrency;
  const series = data.series ?? [];
  const own = drawdownQ.data?.own;
  return (
    <div className="space-y-4" data-testid="investor-performance">
      {series.length > 0 && <EquityHistoryChart series={series} currency={ccy} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Realized P/L">
          <PnlValue value={data.realizedPnl} currency={ccy} />
        </StatCard>
        <StatCard label="Unrealized P/L">
          <PnlValue value={data.unrealizedPnl} currency={ccy} />
        </StatCard>
        <StatCard label="Monthly Return">
          {data.monthlyReturnPct == null ? "—" : fmtPct(data.monthlyReturnPct)}
        </StatCard>
        <StatCard label="All-time Return">
          {data.allTimeReturnPct == null ? "—" : fmtPct(data.allTimeReturnPct)}
        </StatCard>
      </div>
      {own && (
        <div className="space-y-2" data-testid="performance-drawdown">
          <SectionHeader
            title="High-water & drawdown"
            freshness={fundBookQ.data?.freshness}
            asOf={fundBookQ.data?.freshnessAsOf}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="High-water mark">{fmtMoney(own.highWaterValue, ccy)}</StatCard>
            <StatCard label="Peak reached">
              <span className="text-base">{own.peakAt ? fmtDate(own.peakAt) : "—"}</span>
            </StatCard>
            <StatCard label="Current drawdown">
              <span className={own.drawdownUsd > 0 ? "text-danger" : ""}>
                {fmtMoney(own.drawdownUsd, ccy)}
                {own.drawdownPercent ? ` · ${fmtPct(own.drawdownPercent)}` : ""}
              </span>
            </StatCard>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The curve plots your recorded account value over time — your deposits, withdrawals, any
        adjustments, and recorded performance. The high-water mark is the highest value your
        account has reached; the drawdown is how far below that peak it sits today. Figures are
        the real values recorded against your account only, and are never projected or implied.
      </p>
    </div>
  );
}

function EquityHistoryChart({
  series,
  currency,
}: {
  series: Array<{ at: string; label: string; value: number }>;
  currency: string;
}) {
  return (
    <Card data-testid="investor-equity-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Equity History</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="investorEquityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => fmtMoney(v, currency)}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                formatter={(v: number) => [fmtMoney(v, currency), "Account Value"]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#investorEquityFill)"
                dot={series.length <= 12}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Move Funds tab (deposit / withdrawal requests) ───────────────────────────
function MoveFundsTab() {
  const qc = useQueryClient();
  const settingsQ = useGetMeCapitalSettings();
  const requestsQ = useListMeCapitalRequests();
  const [mode, setMode] = useState<"deposit" | "withdrawal">("deposit");

  if (settingsQ.isLoading) return <Skeleton className="h-72 w-full" />;
  const settings = settingsQ.data;
  if (!settings) return null;

  return (
    <div className="space-y-4" data-testid="investor-move-funds">
      <div className="inline-flex rounded-lg border border-border bg-muted/30 p-1">
        <button
          type="button"
          onClick={() => setMode("deposit")}
          className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold ${
            mode === "deposit" ? "bg-background shadow" : "text-muted-foreground"
          }`}
          data-testid="toggle-deposit"
        >
          <ArrowDownToLine className="h-4 w-4" /> Deposit
        </button>
        <button
          type="button"
          onClick={() => setMode("withdrawal")}
          className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold ${
            mode === "withdrawal" ? "bg-background shadow" : "text-muted-foreground"
          }`}
          data-testid="toggle-withdrawal"
        >
          <ArrowUpFromLine className="h-4 w-4" /> Withdraw
        </button>
      </div>

      {mode === "deposit" ? (
        <DepositForm
          tiers={settings.depositTiers}
          minAmount={settings.settings.minDepositAmount}
          onDone={() => qc.invalidateQueries()}
        />
      ) : (
        <WithdrawalForm
          tiers={settings.withdrawalTiers}
          minAmount={settings.settings.minWithdrawalAmount}
          onDone={() => qc.invalidateQueries()}
        />
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Your requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {requestsQ.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (requestsQ.data?.requests.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deposit or withdrawal requests yet.
            </p>
          ) : (
            requestsQ.data!.requests.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between border-b border-border/50 py-2 text-sm last:border-0"
                data-testid={`capital-request-${r.id}`}
              >
                <div>
                  <p className="font-medium capitalize">
                    {r.movementType.toLowerCase()} · {fmtMoney(r.grossAmount, r.currency)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Net {fmtMoney(r.netAmount, r.currency)} · fee{" "}
                    {fmtMoney(r.totalFeeAmount, r.currency)} · {fmtDate(r.submittedAt)}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Deposits and withdrawals are <span className="font-semibold">requests</span> reviewed by an
        administrator. Amounts settle at the unit value of the applicable valuation cycle; fees shown
        are estimates for the selected speed and are confirmed at settlement.
      </div>
    </div>
  );
}

function TierSelect({
  tiers,
  value,
  onChange,
  testid,
}: {
  tiers: CapitalSpeedTier[];
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid={testid}>
        <SelectValue placeholder="Select a speed" />
      </SelectTrigger>
      <SelectContent>
        {tiers.map((t) => (
          <SelectItem key={t.tierKey} value={t.tierKey}>
            {t.label}
            {t.slaLabel ? ` · ${t.slaLabel}` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FeeLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</span>
      <span className={`tabular-nums ${strong ? "text-base font-black" : "font-semibold"}`}>
        {value}
      </span>
    </div>
  );
}

function DepositForm({
  tiers,
  minAmount,
  onDone,
}: {
  tiers: CapitalSpeedTier[];
  minAmount: number;
  onDone: () => void;
}) {
  const preview = usePreviewMeCapitalDeposit();
  const create = useCreateMeCapitalDeposit();
  const [amount, setAmount] = useState("");
  const [tierKey, setTierKey] = useState(tiers[0]?.tierKey ?? "");
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<CapitalDepositPreviewResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const gross = Number(amount);
  const valid = Number.isFinite(gross) && gross > 0 && Boolean(tierKey);
  const selectedTier = tiers.find((t) => t.tierKey === tierKey);
  const needsAck = selectedTier?.requiresDisclosure ?? false;

  // Debounced fee preview whenever amount or speed tier changes.
  const previewMutate = preview.mutate;
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (!valid) {
      reqIdRef.current++;
      setResult(null);
      return;
    }
    const handle = setTimeout(() => {
      const myId = ++reqIdRef.current;
      previewMutate(
        { data: { grossAmount: gross, speedTierKey: tierKey } },
        {
          onSuccess: (r) => {
            if (myId !== reqIdRef.current) return;
            setResult(r);
            setError(null);
          },
          onError: () => {
            if (myId === reqIdRef.current) setResult(null);
          },
        },
      );
    }, 350);
    return () => clearTimeout(handle);
  }, [gross, tierKey, valid, previewMutate]);

  const belowMin = valid && gross < minAmount;
  const canSubmit = valid && !belowMin && (!needsAck || ack) && !create.isPending;

  async function onSubmit() {
    setError(null);
    setSubmitted(false);
    try {
      await create.mutateAsync({
        data: {
          grossAmount: gross,
          speedTierKey: tierKey,
          requestNote: note || undefined,
          acknowledgeDisclosures: ack,
        },
      });
      setAmount("");
      setNote("");
      setAck(false);
      setResult(null);
      setSubmitted(true);
      onDone();
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Could not submit your deposit request.",
      );
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Request a deposit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Amount
          </label>
          <Input
            type="number"
            min={0}
            inputMode="decimal"
            placeholder={`Minimum ${fmtMoney(minAmount)}`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="input-deposit-amount"
          />
          {belowMin && (
            <p className="text-xs text-danger">Minimum deposit is {fmtMoney(minAmount)}.</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Speed
          </label>
          <TierSelect tiers={tiers} value={tierKey} onChange={setTierKey} testid="select-deposit-tier" />
          {selectedTier?.description && (
            <p className="text-xs text-muted-foreground">{selectedTier.description}</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Note (optional)
          </label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the reviewer"
            data-testid="input-deposit-note"
          />
        </div>

        {result && (
          <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-3" data-testid="deposit-preview">
            <FeeLine label="Amount" value={fmtMoney(result.grossAmount)} />
            <FeeLine label="Speed fee" value={fmtMoney(result.speedFee)} />
            <FeeLine label="Total fee" value={fmtMoney(result.totalFee)} />
            <FeeLine label="Invested after fees" value={fmtMoney(result.netAmount)} strong />
          </div>
        )}

        {needsAck && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              data-testid="checkbox-deposit-ack"
            />
            <span className="text-muted-foreground">
              I have read and acknowledge the deposit disclosures. Trading involves risk and no
              return is promised or implied.
            </span>
          </label>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
        {submitted && (
          <p className="text-sm text-success" data-testid="deposit-success">
            Your deposit request was submitted for review.
          </p>
        )}

        <Button onClick={onSubmit} disabled={!canSubmit} data-testid="button-submit-deposit">
          {create.isPending ? "Submitting…" : "Submit deposit request"}
        </Button>
      </CardContent>
    </Card>
  );
}

function WithdrawalForm({
  tiers,
  minAmount,
  onDone,
}: {
  tiers: CapitalSpeedTier[];
  minAmount: number;
  onDone: () => void;
}) {
  const preview = usePreviewMeCapitalWithdrawal();
  const create = useCreateMeCapitalWithdrawal();
  const [amount, setAmount] = useState("");
  const [tierKey, setTierKey] = useState(tiers[0]?.tierKey ?? "");
  const [fullExit, setFullExit] = useState(false);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<CapitalWithdrawalPreviewResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const gross = Number(amount);
  const valid = Boolean(tierKey) && (fullExit || (Number.isFinite(gross) && gross > 0));
  const selectedTier = tiers.find((t) => t.tierKey === tierKey);
  const needsAck = selectedTier?.requiresDisclosure ?? false;

  const previewMutate = preview.mutate;
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (!valid) {
      reqIdRef.current++;
      setResult(null);
      return;
    }
    const handle = setTimeout(() => {
      const myId = ++reqIdRef.current;
      previewMutate(
        {
          data: {
            grossAmount: fullExit ? 0 : gross,
            speedTierKey: tierKey,
            isFullExit: fullExit,
          },
        },
        {
          onSuccess: (r) => {
            if (myId !== reqIdRef.current) return;
            setResult(r);
            setError(null);
          },
          onError: () => {
            if (myId === reqIdRef.current) setResult(null);
          },
        },
      );
    }, 350);
    return () => clearTimeout(handle);
  }, [gross, tierKey, fullExit, valid, previewMutate]);

  const belowMin = valid && !fullExit && gross < minAmount;
  const overAvailable = Boolean(result) && !result!.fullyCovered;
  const canSubmit = valid && !belowMin && (!needsAck || ack) && !create.isPending;

  async function onSubmit() {
    setError(null);
    setSubmitted(false);
    try {
      await create.mutateAsync({
        data: {
          grossAmount: fullExit ? 0 : gross,
          speedTierKey: tierKey,
          isFullExit: fullExit,
          requestNote: note || undefined,
          acknowledgeDisclosures: ack,
        },
      });
      setAmount("");
      setNote("");
      setAck(false);
      setFullExit(false);
      setResult(null);
      setSubmitted(true);
      onDone();
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Could not submit your withdrawal request.",
      );
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Request a withdrawal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fullExit}
            onChange={(e) => setFullExit(e.target.checked)}
            data-testid="checkbox-full-exit"
          />
          <span>Withdraw my full available balance</span>
        </label>

        {!fullExit && (
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Amount
            </label>
            <Input
              type="number"
              min={0}
              inputMode="decimal"
              placeholder={`Minimum ${fmtMoney(minAmount)}`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="input-withdrawal-amount"
            />
            {belowMin && (
              <p className="text-xs text-danger">Minimum withdrawal is {fmtMoney(minAmount)}.</p>
            )}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Speed
          </label>
          <TierSelect tiers={tiers} value={tierKey} onChange={setTierKey} testid="select-withdrawal-tier" />
          {selectedTier?.description && (
            <p className="text-xs text-muted-foreground">{selectedTier.description}</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Note (optional)
          </label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the reviewer"
            data-testid="input-withdrawal-note"
          />
        </div>

        {result && (
          <div
            className="space-y-1 rounded-lg border border-border bg-muted/20 p-3"
            data-testid="withdrawal-preview"
          >
            <FeeLine label="Amount" value={fmtMoney(result.grossAmount)} />
            <FeeLine label="Speed fee" value={fmtMoney(result.speedFee)} />
            <FeeLine label="Liquidity fee" value={fmtMoney(result.liquidityFee)} />
            <FeeLine label="Performance fee" value={fmtMoney(result.performanceFee)} />
            <FeeLine label="Total fee" value={fmtMoney(result.totalFee)} />
            <FeeLine label="You receive" value={fmtMoney(result.netAmount)} strong />
            <p className="pt-1 text-xs text-muted-foreground">
              Available to withdraw: {fmtMoney(result.availableForWithdrawal)}
            </p>
            {overAvailable && (
              <p className="text-xs text-warning">
                This exceeds your currently available balance and may settle in part or after
                review.
              </p>
            )}
          </div>
        )}

        {needsAck && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              data-testid="checkbox-withdrawal-ack"
            />
            <span className="text-muted-foreground">
              I have read and acknowledge the withdrawal disclosures, including any applicable fees
              and lock-up terms.
            </span>
          </label>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
        {submitted && (
          <p className="text-sm text-success" data-testid="withdrawal-success">
            Your withdrawal request was submitted for review.
          </p>
        )}

        <Button onClick={onSubmit} disabled={!canSubmit} data-testid="button-submit-withdrawal">
          {create.isPending ? "Submitting…" : "Submit withdrawal request"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Exposure tab ────────────────────────────────────────────────────────────
function ExposureTab() {
  const exposureQ = useGetMeInvestorExposure();
  const fundBookQ = useGetMeFundBook();
  const data = exposureQ.data;
  const fundBook = fundBookQ.data;

  if (exposureQ.isLoading && fundBookQ.isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  const pools = (fundBook?.pools ?? []).filter(
    (p) => p.unitsOwned > 0 || p.currentValue !== 0 || p.floatingPlShare !== 0,
  );
  const totalValue = fundBook?.totalValue ?? 0;
  const fbCcy = fundBook?.baseCurrency ?? data?.baseCurrency ?? "USD";
  const hasPoolExposure = pools.length > 0;
  const hasSleeves = Boolean(data?.hasActiveAllocation && data.sleeves.length > 0);

  if (!hasPoolExposure && !hasSleeves) {
    return (
      <EmptyState
        icon={Layers}
        title="No exposure yet"
        body="Once your funds are allocated, your exposure across strategy pools — including your share of floating profit or loss — will appear here."
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="investor-exposure">
      {hasPoolExposure && (
        <div className="space-y-2">
          <SectionHeader
            title="Pool exposure & floating P/L share"
            freshness={fundBook?.freshness}
            asOf={fundBook?.freshnessAsOf}
          />
          {pools.filter((p) => p.poolKey === "BALANCED").map((p) => {
            const sharePct = totalValue > 0 ? (p.currentValue / totalValue) * 100 : 0;
            return (
              <Card key={p.poolKey} data-testid={`exposure-pool-${p.poolKey}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {fmtPct(sharePct)} of portfolio value
                      </p>
                    </div>
                    <p className="text-lg font-black tabular-nums">
                      {fmtMoney(p.currentValue, fbCcy)}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-sm">
                    <span className="text-muted-foreground">Your floating P/L share</span>
                    <PnlValue value={p.floatingPlShare} currency={fbCcy} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
          <p className="text-[11px] text-muted-foreground">
            Exposure reflects the current value held in each strategy pool and your share of that
            pool&apos;s floating profit or loss.
          </p>
        </div>
      )}

      {hasSleeves && data && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Intended allocation
          </p>
          <p className="text-sm text-muted-foreground">
            Your <span className="font-semibold">intended</span> allocation across strategy
            sleeves — not live open positions.
          </p>
          {data.sleeves.map((s) => (
            <Card key={s.key}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="font-semibold">{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.pct}% of portfolio</p>
                </div>
                <p className="text-lg font-black tabular-nums">
                  {fmtMoney(s.amount, data.baseCurrency)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Activity tab ────────────────────────────────────────────────────────────
function ActivityTab() {
  const { data, isLoading } = useGetMeInvestorActivity();
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No activity yet"
        body="Deposits, withdrawals, and allocation events will appear here as they happen."
      />
    );
  }
  return (
    <div className="space-y-2" data-testid="investor-activity">
      {data.items.map((it) => (
        <Card key={it.id}>
          <CardContent className="flex items-center justify-between p-3 text-sm">
            <div>
              <p className="font-medium">{it.title}</p>
              {it.detail && <p className="text-xs text-muted-foreground">{it.detail}</p>}
              <p className="text-[11px] text-muted-foreground">{fmtDate(it.at)}</p>
            </div>
            {it.amount != null && (
              <span
                className={`font-bold tabular-nums ${it.amount < 0 ? "text-danger" : "text-success"}`}
              >
                {fmtMoney(it.amount)}
              </span>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Documents tab ───────────────────────────────────────────────────────────
function DocumentsTab() {
  const { data, isLoading } = useGetMeInvestorDocuments();
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents available"
        body="Statements and documents shared with you will appear here."
      />
    );
  }
  const docs = data.items;
  return (
    <div className="space-y-2" data-testid="investor-documents">
      {docs.map((d) => {
        const isRemoved = d.status === "REMOVED";
        const showStatusBadge = d.status !== "ACTIVE";
        return (
          <Card key={d.id} className={isRemoved ? "opacity-80" : undefined}>
            <CardContent className="flex items-start justify-between gap-2 p-3 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{d.title}</p>
                  {showStatusBadge && (
                    <Badge
                      variant={isRemoved ? "destructive" : "outline"}
                      data-testid={`document-status-${d.id}`}
                    >
                      {d.statusLabel}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {d.statementType}
                  {d.periodLabel ? ` · ${d.periodLabel}` : ""}
                </p>
                {d.updatedAt && (
                  <p
                    className="text-[11px] text-muted-foreground"
                    data-testid={`document-updated-${d.id}`}
                  >
                    Updated {fmtDate(d.updatedAt)}
                  </p>
                )}
                {d.summary && <p className="text-xs text-muted-foreground">{d.summary}</p>}
                {d.note && (
                  <p className="mt-1 text-xs text-warning" data-testid={`document-note-${d.id}`}>
                    {d.note}
                  </p>
                )}
                {d.downloadable && d.fileUrl ? (
                  <a
                    href={
                      d.fileUrl.startsWith("/objects/")
                        ? `/api/me/investor/documents/${d.id}/file`
                        : d.fileUrl
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    data-testid={`link-document-${d.id}`}
                  >
                    <ExternalLink className="h-3 w-3" /> View document
                  </a>
                ) : isRemoved ? (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid={`download-disabled-${d.id}`}
                  >
                    <ExternalLink className="h-3 w-3" /> Download unavailable
                  </span>
                ) : null}
                {d.replacementStatementId != null && d.replacementTitle && (
                  <p className="mt-1 text-xs">
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      data-testid={`view-current-${d.id}`}
                      onClick={() => {
                        const el = document.querySelector(
                          `[data-doc-id="${d.replacementStatementId}"]`,
                        );
                        el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                    >
                      View current statement: {d.replacementTitle}
                    </button>
                  </p>
                )}
              </div>
              <span
                className="shrink-0 text-[11px] text-muted-foreground"
                data-doc-id={d.id}
              >
                {fmtDate(d.createdAt)}
              </span>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Weekly Account Story tab ─────────────────────────────────────────────────
function weekLabel(periodStart: string, periodEnd: string): string {
  const s = new Date(periodStart);
  const e = new Date(periodEnd);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "—";
  const end = new Date(e.getTime() - 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(s)} – ${fmt(end)}, ${end.getFullYear()}`;
}

function freshnessTone(freshness: string): string {
  const f = freshness.toUpperCase();
  if (f === "FRESH") return "bg-success/15 text-success";
  if (f === "STALE") return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

export function WeeklyStoryReport({ report }: { report: WeeklyReportDto }) {
  const { name } = useAssistantName();
  const n = report.narrative;
  const ei = n.economicImpact;
  const underReview = (n.dataQuality.navStatus || "").toUpperCase() === "UNDER_REVIEW";
  const stale = (n.dataQuality.freshness || "").toUpperCase() !== "FRESH";
  return (
    <div className="space-y-4" data-testid="weekly-story-report">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">{n.headline}</CardTitle>
            <div className="flex items-center gap-2">
              <Badge className={freshnessTone(n.dataQuality.freshness)} data-testid="weekly-freshness">
                {n.dataQuality.freshness}
              </Badge>
              {underReview && (
                <Badge className="bg-warning/15 text-warning" data-testid="weekly-under-review">
                  Under review
                </Badge>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {weekLabel(n.periodStart, n.periodEnd)}
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">{n.summary}</p>
          {(underReview || stale) && (
            <div
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
              data-testid="weekly-quality-note"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{n.dataQuality.freshnessMessage}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">This week's change</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {ei.changeVerifiable && ei.baselineAvailable ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="weekly-economic-impact">
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">Net change</p>
                <p
                  className={`text-lg font-bold tabular-nums ${
                    (ei.netChange ?? 0) < 0 ? "text-danger" : "text-success"
                  }`}
                >
                  {fmtMoney(ei.netChange)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">From deposits &amp; withdrawals</p>
                <p className="text-lg font-bold tabular-nums">{fmtMoney(ei.flows)}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">From market performance</p>
                <p
                  className={`text-lg font-bold tabular-nums ${
                    (ei.marketChange ?? 0) < 0 ? "text-danger" : "text-success"
                  }`}
                >
                  {fmtMoney(ei.marketChange)}
                </p>
              </div>
            </div>
          ) : !ei.baselineAvailable ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground"
              data-testid="weekly-no-baseline"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                This is your starting baseline week, so there is no prior week to compare against
                yet. Week-over-week change will appear from your next published report.
              </span>
            </div>
          ) : (
            <div
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
              data-testid="weekly-change-withheld"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Your week-over-week change is being held back until this week's values are
                verified. Only your recorded deposits, withdrawals, and distributions below are
                shown — exactly as booked.
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
            <div>
              <p>Deposits</p>
              <p className="font-semibold text-foreground tabular-nums">{fmtMoney(ei.deposits)}</p>
            </div>
            <div>
              <p>Withdrawals</p>
              <p className="font-semibold text-foreground tabular-nums">{fmtMoney(ei.withdrawals)}</p>
            </div>
            <div>
              <p>Distributions</p>
              <p className="font-semibold text-foreground tabular-nums">{fmtMoney(ei.distributions)}</p>
            </div>
            <div>
              <p>End value</p>
              <p className="font-semibold text-foreground tabular-nums">{fmtMoney(ei.endValue)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {n.pools.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Where your money is working</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="weekly-pools">
            {n.pools.map((p) => (
              <div
                key={p.poolKey}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{p.name}</p>
                    {p.underReview && (
                      <Badge className="bg-warning/15 text-warning">Under review</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.riskLevel} · {fmtPct(p.sharePct)} of your account
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">{fmtMoney(p.endValue)}</p>
                  {p.floatingPlShare != null && (
                    <p
                      className={`text-xs tabular-nums ${
                        p.floatingPlShare < 0 ? "text-danger" : "text-success"
                      }`}
                    >
                      {fmtMoney(p.floatingPlShare)} open P/L
                    </p>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(n.topPositive.length > 0 || n.topNegative.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1 text-sm">
                <ArrowUpRight className="h-4 w-4 text-success" /> Top contributors
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm" data-testid="weekly-top-positive">
              {n.topPositive.length === 0 ? (
                <p className="text-xs text-muted-foreground">No positive contributors this week.</p>
              ) : (
                n.topPositive.map((c) => (
                  <div key={c.poolKey} className="flex items-center justify-between">
                    <span className="truncate">{c.name}</span>
                    <span className="font-semibold tabular-nums text-success">
                      {fmtMoney(c.floatingPlShare)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1 text-sm">
                <ArrowDownRight className="h-4 w-4 text-danger" /> Biggest detractors
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm" data-testid="weekly-top-negative">
              {n.topNegative.length === 0 ? (
                <p className="text-xs text-muted-foreground">No detractors this week.</p>
              ) : (
                n.topNegative.map((c) => (
                  <div key={c.poolKey} className="flex items-center justify-between">
                    <span className="truncate">{c.name}</span>
                    <span className="font-semibold tabular-nums text-danger">
                      {fmtMoney(c.floatingPlShare)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1 text-sm">
              <Gauge className="h-4 w-4" /> Risk &amp; drawdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="weekly-risk">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Drawdown</span>
              <span
                className={`font-semibold tabular-nums ${
                  n.risk.elevated ? "text-warning" : "text-foreground"
                }`}
              >
                {fmtPct(n.risk.drawdownPercent)}
              </span>
            </div>
            {n.risk.drawdownUsd != null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Peak-to-current</span>
                <span className="font-semibold tabular-nums">{fmtMoney(n.risk.drawdownUsd)}</span>
              </div>
            )}
            {n.risk.elevated && (
              <p className="text-xs text-warning">Drawdown is elevated relative to recent peaks.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1 text-sm">
              <Clock className="h-4 w-4" /> Deposit lock
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="weekly-deposit-lock">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Locked principal</span>
              <span className="font-semibold tabular-nums">{fmtMoney(n.depositLock.lockedPrincipal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Withdrawable now</span>
              <span className="font-semibold tabular-nums">{fmtMoney(n.depositLock.withdrawableValue)}</span>
            </div>
            {n.depositLock.nextReleaseAt && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Next release</span>
                <span className="font-semibold">{fmtDate(n.depositLock.nextReleaseAt)}</span>
              </div>
            )}
            {n.depositLock.releasesNextWeek && (
              <p className="text-xs text-primary">A deposit lock releases within the next week.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {n.watching.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1 text-sm">
              <Eye className="h-4 w-4" /> What {name} is watching next week
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="weekly-watching">
            {n.watching.map((w, i) => (
              <div key={`${w.kind}-${i}`} className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="text-muted-foreground">{w.message}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {n.disclosures.length > 0 && (
        <div
          className="space-y-1 rounded-lg border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground"
          data-testid="weekly-disclosures"
        >
          {n.disclosures.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function WeeklyStoryTab() {
  const { data: list, isLoading: listLoading } = useGetMeWeeklyReports();
  const [periodKey, setPeriodKey] = useState<string>("");
  const reports = list?.reports ?? [];
  const selectedKey = periodKey || reports[0]?.periodKey || "";
  const { data: detail, isLoading: detailLoading } = useGetMeWeeklyReport(selectedKey, {
    query: { queryKey: getGetMeWeeklyReportQueryKey(selectedKey), enabled: !!selectedKey },
  });

  if (listLoading) return <Skeleton className="h-48 w-full" />;
  if (reports.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No weekly stories yet"
        body="Your weekly account story is published once your first full week of recorded activity is reviewed. It will appear here automatically."
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="investor-weekly-story">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <Select value={selectedKey} onValueChange={setPeriodKey}>
          <SelectTrigger className="w-full sm:w-72" data-testid="select-week">
            <SelectValue placeholder="Select a week" />
          </SelectTrigger>
          <SelectContent>
            {reports.map((r) => (
              <SelectItem key={r.id} value={r.periodKey} data-testid={`week-option-${r.periodKey}`}>
                {r.periodKey} · {r.headline}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {detailLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : detail?.report ? (
        <WeeklyStoryReport report={detail.report} />
      ) : (
        <EmptyState
          icon={CalendarDays}
          title="Report unavailable"
          body="This week's report could not be loaded. Please try another week."
        />
      )}
    </div>
  );
}

export default function InvestorPortal() {
  return (
    <div className="mx-auto mt-6 max-w-5xl space-y-6 px-2" data-testid="investor-portal">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Investor Portal</h1>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <Eye className="h-3.5 w-3.5" /> View-only access to your account
          </p>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="overview" data-testid="tab-overview">
            <Wallet className="mr-1 h-4 w-4" /> Overview
          </TabsTrigger>
          <TabsTrigger value="weekly-story" data-testid="tab-weekly-story">
            <CalendarDays className="mr-1 h-4 w-4" /> Weekly Story
          </TabsTrigger>
          <TabsTrigger value="holdings" data-testid="tab-holdings">
            <Coins className="mr-1 h-4 w-4" /> Holdings
          </TabsTrigger>
          <TabsTrigger value="performance" data-testid="tab-performance">
            <TrendingUp className="mr-1 h-4 w-4" /> Performance
          </TabsTrigger>
          <TabsTrigger value="move-funds" data-testid="tab-move-funds">
            <ArrowLeftRight className="mr-1 h-4 w-4" /> Move Funds
          </TabsTrigger>
          <TabsTrigger value="allocation" data-testid="tab-allocation">
            <PieChart className="mr-1 h-4 w-4" /> Allocation
          </TabsTrigger>
          <TabsTrigger value="exposure" data-testid="tab-exposure">
            <Layers className="mr-1 h-4 w-4" /> Exposure
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            <ScrollText className="mr-1 h-4 w-4" /> Activity
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-documents">
            <FileText className="mr-1 h-4 w-4" /> Documents
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="weekly-story" className="mt-4">
          <WeeklyStoryTab />
        </TabsContent>
        <TabsContent value="holdings" className="mt-4">
          <HoldingsTab />
        </TabsContent>
        <TabsContent value="performance" className="mt-4">
          <PerformanceTab />
        </TabsContent>
        <TabsContent value="move-funds" className="mt-4">
          <MoveFundsTab />
        </TabsContent>
        <TabsContent value="allocation" className="mt-4">
          <AllocationTab />
        </TabsContent>
        <TabsContent value="exposure" className="mt-4">
          <ExposureTab />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="documents" className="mt-4">
          <DocumentsTab />
        </TabsContent>
      </Tabs>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your investor account is view-only. It cannot place, modify, or close trades and does
        not include trading or administrative controls.
      </div>
    </div>
  );
}
