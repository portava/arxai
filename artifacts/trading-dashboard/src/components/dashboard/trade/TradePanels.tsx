// Trade Command Room supporting components. UI only; every link/route and
// data source is the existing one, passed in or hardcoded to the same paths
// the legacy page used. Empty states preserved + still wired for future data.

import { Link } from "wouter";
import {
  Crosshair, Send, Layers, ListChecks, Wrench, ShieldCheck, Activity,
  ChevronRight, ArrowRight, GitBranch,
} from "lucide-react";
import { CockpitCard, Pill, ActionButton, SectionLink } from "@/components/dashboard/cockpit/primitives";
import { cn } from "@/lib/utils";

/* ── 1 · Top status bar ─────────────────────────────────────────────── */
export function TradeStatusBar({
  modeLabel, isLive, gatesLabel, intentCount,
}: { modeLabel: string; isLive: boolean; gatesLabel: string; intentCount: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className={cn("inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold", isLive ? "text-success" : "text-primary")}>
        <span className={cn("h-2 w-2 rounded-full", isLive ? "bg-success" : "bg-primary")} />
        {modeLabel}
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs text-txt-secondary">
        <ShieldCheck className="h-3.5 w-3.5 text-success" /> {gatesLabel}
      </span>
      <Link href="/live-intent-queue" className="ml-auto" data-testid="trade-intent-badge">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 px-3 py-1 text-sm font-semibold text-primary hover:bg-primary/10">
          {intentCount} intents
        </span>
      </Link>
    </div>
  );
}

/* ── 2 · Hero + connection card ─────────────────────────────────────── */
export function TradeHero({
  description, connStatus, isLive, broker, account,
}: { description: string; connStatus: string; isLive: boolean; broker: string; account: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex items-start gap-3">
        <span className="mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 ring-1 ring-primary/25">
          <Crosshair className="h-5 w-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Trade Command Room</h1>
          <p className="text-sm font-medium text-primary">Scanner → Setup → Ticket → Confirmation</p>
          <p className="mt-1 text-sm text-txt-secondary">{description}</p>
        </div>
      </div>

      <CockpitCard accent="blue" data-testid="trade-connection-card">
        <div className="flex items-start justify-between">
          <span className="text-sm text-txt-secondary">Connection</span>
          <Pill tone={isLive ? "success" : connStatus === "Disconnected" ? "danger" : "info"}>{connStatus}</Pill>
        </div>
        <div className="mt-1 text-lg font-semibold">Shared Master MT5</div>
        <div className="mt-1 text-sm text-txt-secondary">Broker: {broker}</div>
        <div className="text-sm text-txt-secondary">Acc: {account}</div>
        <ActionButton href="/live-shared" subtle data-testid="trade-view-account">View account</ActionButton>
      </CockpitCard>
    </div>
  );
}

/* ── 3 · Positions tab ──────────────────────────────────────────────── */
export function PositionsPanel({ positions }: { positions: Array<{ id: string | number; symbol: string; side: string; lotSize: number; entry?: number; pnl?: number | null; stopLoss?: number | null; takeProfit?: number | null; status?: string }> }) {
  return (
    <CockpitCard title="Positions" subtitle="Live MT5-confirmed positions." icon={<Layers className="h-[18px] w-[18px]" />} accent="blue" data-testid="positions-tab">
      {positions.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm font-medium text-foreground">No open positions</p>
          <p className="text-xs text-txt-muted">Live MT5-confirmed positions will appear here once opened.</p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ActionButton href="/live-trades" subtle data-testid="positions-link-live">Open Live Positions</ActionButton>
            <ActionButton href="/trade-logs" subtle>View Trade Logs</ActionButton>
            <ActionButton href="/positions" subtle data-testid="positions-link-all">View P&amp;L</ActionButton>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {positions.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5" data-testid={`position-${p.id}`}>
              <Pill tone={p.side === "BUY" ? "success" : "danger"}>{p.side}</Pill>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm font-semibold">{p.symbol}</div>
                <div className="text-[11px] text-txt-muted">{p.lotSize} lot{p.entry ? ` · @${p.entry}` : ""}{p.stopLoss ? ` · SL ${p.stopLoss}` : ""}{p.takeProfit ? ` · TP ${p.takeProfit}` : ""}</div>
              </div>
              <div className={cn("font-mono text-sm font-semibold", (p.pnl ?? 0) > 0 ? "text-success" : (p.pnl ?? 0) < 0 ? "text-danger" : "text-foreground")}>
                {p.pnl == null ? "—" : (p.pnl > 0 ? "+" : "") + p.pnl.toFixed(2)}
              </div>
              <Link href="/live-trades" className="text-xs font-medium text-primary">Manage</Link>
            </li>
          ))}
        </ul>
      )}
    </CockpitCard>
  );
}

/* ── 4 · Orders tab (scanner opps + intent queue) ───────────────────── */
export type Opp = { symbol: string; timeframe: string; recommendedAction: string; confidenceScore: number; opportunity: { score: number; label: string } };

export function OrdersPanel({
  opps, intentCount, picked, onPick,
}: { opps: Opp[]; intentCount: number; picked: { symbol: string; timeframe: string } | null; onPick: (o: Opp) => void }) {
  return (
    <div className="space-y-4" data-testid="orders-tab">
      <CockpitCard title="Scanner Opportunities" icon={<Crosshair className="h-[18px] w-[18px]" />} accent="ruby" badge={opps.length ? String(opps.length) : undefined}>
        {opps.length === 0 ? (
          <p className="py-4 text-center text-sm text-txt-secondary">No scan results yet — start the scanner from the Market Scanner page.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {opps.map((o, i) => (
              <button key={i} onClick={() => onPick(o)}
                className={cn("rounded-lg border p-2 text-left text-xs transition-colors hover:bg-secondary/40",
                  picked?.symbol === o.symbol && picked.timeframe === o.timeframe ? "border-primary ring-1 ring-primary" : "border-border")}
                data-testid={`order-opp-${o.symbol}-${o.timeframe}`}>
                <div className="flex justify-between"><span className="font-bold">{o.symbol}</span><span className="text-txt-muted">{o.timeframe}</span></div>
                <div className="mt-1 flex items-center gap-1">
                  <Pill tone={o.recommendedAction === "BUY" ? "success" : o.recommendedAction === "SELL" ? "danger" : "muted"}>{o.recommendedAction}</Pill>
                  <span className="ml-auto font-bold">{o.opportunity.score}</span>
                </div>
              </button>
            ))}
          </div>
        )}
        <SectionLink href="/market-scanner">Full Scanner</SectionLink>
      </CockpitCard>

      <CockpitCard title="Live Intent Queue" icon={<ListChecks className="h-[18px] w-[18px]" />} accent="blue">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-3xl font-bold" data-testid="orders-intent-count">{intentCount}</span>
          <ActionButton href="/live-intent-queue" subtle data-testid="orders-open-queue">Open Queue</ActionButton>
        </div>
        {intentCount === 0 && <p className="mt-2 text-xs text-txt-muted">No live intents queued.</p>}
      </CockpitCard>
    </div>
  );
}

/* ── 5 · Advanced tab ───────────────────────────────────────────────── */
export function AdvancedPanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="space-y-4" data-testid="advanced-tab">
      <CockpitCard title="Advanced Order Types & broker routes" subtitle="Place limit, stop, and stop-limit orders when supported by your account route." icon={<GitBranch className="h-[18px] w-[18px]" />} accent="blue">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ActionButton href="/live-manual" subtle>Buy / Sell Limit</ActionButton>
          <ActionButton href="/live-manual" subtle>Stop / Stop-Limit</ActionButton>
          <ActionButton href="/mt5-setup" subtle>MT5 Setup</ActionButton>
          <ActionButton href="/live-trading" subtle>Advanced Panel</ActionButton>
        </div>
      </CockpitCard>

      {isAdmin && (
        <CockpitCard title="Broker route diagnostics" subtitle="Admin only." icon={<Wrench className="h-[18px] w-[18px]" />} accent="warning">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ActionButton href="/live-trading-control" subtle>Live trading control</ActionButton>
            <ActionButton href="/live-shared" subtle>Shared master live</ActionButton>
            <ActionButton href="/broker-readonly" subtle>Broker read-only</ActionButton>
            <ActionButton href="/risk-command-center" subtle>Risk command center</ActionButton>
          </div>
        </CockpitCard>
      )}
    </div>
  );
}

/* ── 6 · Risk Governor card ─────────────────────────────────────────── */
export function RiskGovernorCard({
  statusLabel, statusTone, riskLevel, bridge, approval, isAdmin, rawCanPlace, rawMode,
}: {
  statusLabel: string; statusTone: "success" | "warning" | "danger";
  riskLevel: string; bridge: string; approval: string;
  isAdmin: boolean; rawCanPlace: boolean; rawMode: string;
}) {
  return (
    <CockpitCard title="Risk Governor" subtitle="Account risk status and controls" icon={<ShieldCheck className="h-[18px] w-[18px]" />} accent={statusTone} data-testid="risk-governor-card">
      <div className="grid grid-cols-2 gap-y-2.5 text-sm sm:grid-cols-4">
        <Stat label="Status" value={statusLabel} tone={statusTone} />
        <Stat label="Risk level" value={riskLevel} tone="success" />
        <Stat label="Bridge" value={bridge} />
        <Stat label="Approval" value={approval} />
      </div>
      <div className="mt-3 flex gap-4 border-t border-border/60 pt-3 text-sm">
        <Link href="/risk-settings" className="text-primary hover:underline">Open risk governor →</Link>
        <Link href="/risk-command-center" className="text-primary hover:underline">Risk command center →</Link>
      </div>
      {isAdmin && (
        <details className="mt-3 rounded-lg border border-border/60 p-2 text-xs">
          <summary className="cursor-pointer text-txt-muted">Technical detail (admin)</summary>
          <div className="mt-2 flex gap-4 font-mono">
            <span className="text-txt-muted">canPlaceTrades: <span className={rawCanPlace ? "text-success" : "text-danger"}>{String(rawCanPlace)}</span></span>
            <span className="text-txt-muted">mode: <span className="text-foreground">{rawMode}</span></span>
          </div>
        </details>
      )}
    </CockpitCard>
  );
}

/* ── 7 · Decision Stream ────────────────────────────────────────────── */
export function DecisionStreamCard({ decisions }: { decisions: Array<{ id: string; type: string; summary: string; createdAt: string }> }) {
  return (
    <CockpitCard title="Decision Stream" subtitle="Live trade decisions and confirmations." icon={<Activity className="h-[18px] w-[18px]" />} accent="ruby" badge={decisions.length ? String(decisions.length) : undefined}>
      {decisions.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary">No decisions yet.</p>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto text-xs">
          {decisions.map((d) => (
            <li key={d.id} className="flex items-center gap-2 border-b border-border/40 py-1.5">
              <Pill tone="info">{d.type}</Pill>
              <span className="min-w-0 flex-1 truncate text-txt-secondary">{d.summary}</span>
              <span className="whitespace-nowrap text-txt-muted">{new Date(d.createdAt).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </CockpitCard>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "danger" }) {
  const c = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-foreground";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={cn("font-semibold", c)}>{value}</div>
    </div>
  );
}
