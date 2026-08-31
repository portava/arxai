import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ChevronDown, ChevronUp, Layers, AlertTriangle } from "lucide-react";
import { useGetMeScalpBaskets } from "@workspace/api-client-react";
import type { ScalpBasket } from "@workspace/api-client-react";
import {
  ADD_ON_LABEL,
  ADD_ON_TONE,
  EXIT_URGENCY_LABEL,
  EXIT_URGENCY_TONE,
  FLAME_STAGE_LABEL,
  FLAME_STAGE_TONE,
  directionTone,
  fmtMoney,
} from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// RubyScalpBasketPanel (Phase 2) — manage-side intelligence for the open
// positions the user already holds. It groups open positions into baskets
// (symbol + direction), and shows Ruby's live read on each: flame stage,
// exit urgency, and add-on guidance.
//
// SAFETY: 100% read-only / ALERT_ONLY. Ruby never closes, modifies, or adds
// to a position from here — every line is guidance. No trade buttons.

function pl(v: number | null | undefined): { text: string; tone: string } {
  if (v == null || !Number.isFinite(v)) return { text: "—", tone: "text-muted-foreground" };
  const tone = v > 0 ? "text-success" : v < 0 ? "text-danger" : "text-muted-foreground";
  return { text: fmtMoney(v), tone };
}

// ── Broker-sync freshness (STALE_UNLABELED fix) ─────────────────────────────
// The server now stamps every basket with a `sync` block: the newest broker
// sync time for the feed the legs came from, judged against NOW. When the
// bridge is down the rows can be hours old — positions may already be closed
// at the broker — so a stale basket must render "as of HH:MM", never bare
// live-looking P/L. The generated client type does not yet carry the block
// (real wiring: add ScalpBasketSync to ScalpBasket in lib/api-spec/openapi.yaml
// and regenerate the orval clients), so it is read structurally with runtime
// guards; a missing/garbled block degrades to null and renders nothing new —
// never a fabricated "live" claim.
interface BasketSyncInfo {
  syncedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
}

function basketSyncOf(b: ScalpBasket): BasketSyncInfo | null {
  const s = (b as { sync?: unknown }).sync;
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  return {
    syncedAt: typeof o.syncedAt === "string" ? o.syncedAt : null,
    ageSeconds:
      typeof o.ageSeconds === "number" && Number.isFinite(o.ageSeconds) ? o.ageSeconds : null,
    stale: o.stale === true,
  };
}

// ── Partial P/L disclosure (CONFIDENT_ABSENT fix) ──────────────────────────
// The server withholds `combinedFloatingPl` (null) unless EVERY leg reported a
// floating P/L, so a partial sum can never be shown as the basket total. It
// also stamps `plKnownLegCount` — how many legs actually reported. A bare "—"
// is honest but silent; when some-but-not-all legs reported, say which. The
// generated client type does not carry the count yet (real wiring: add
// `plKnownLegCount` to ScalpBasket in lib/api-spec/openapi.yaml and regenerate
// the orval clients), so it is read structurally; absent/garbled degrades to
// null and nothing new renders — never a fabricated total.
function plKnownLegCountOf(b: ScalpBasket): number | null {
  const v = (b as { plKnownLegCount?: unknown }).plKnownLegCount;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function fmtSyncTime(iso: string): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "an unknown time";
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtSyncAge(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 2 * 60 * 60) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function BasketRow({ basket, name }: { basket: ScalpBasket; name: string }) {
  const combined = pl(basket.combinedFloatingPl);
  const sync = basketSyncOf(basket);
  const syncStale = sync?.stale === true;
  // Partial reporting: the total is withheld and at least one — but not every —
  // leg reported. Distinguish that from "no leg reported anything at all".
  const plKnownLegs = plKnownLegCountOf(basket);
  const plPartial =
    basket.combinedFloatingPl == null &&
    plKnownLegs != null &&
    plKnownLegs > 0 &&
    plKnownLegs < basket.entryCount;
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-basket-row"
      data-symbol={basket.symbol}
      data-direction={basket.direction}
      data-sync-stale={syncStale || undefined}
    >
      {/* Stale-sync banner — amber, distinct from the genuine empty state.
          Rendered FIRST so the P/L below can never be read as live. */}
      {syncStale && (
        <div
          className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning"
          data-testid="scalp-basket-stale"
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            {sync?.syncedAt
              ? `Position sync is stale — showing broker data as of ${fmtSyncTime(sync.syncedAt)}${
                  sync.ageSeconds != null ? ` (${fmtSyncAge(sync.ageSeconds)} ago)` : ""
                }, not live. Some of these positions may already be closed at the broker.`
              : "The broker feed hasn't reported a sync time — these positions and P/L may not be current, and some may already be closed at the broker."}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{basket.displayName}</span>
        <Badge variant="outline" className={directionTone(basket.direction)}>
          {basket.direction === "BUY" ? "Buy" : "Sell"}
        </Badge>
        <Badge
          variant="outline"
          className={FLAME_STAGE_TONE[basket.flame.flameStage]}
          data-testid="scalp-basket-flame"
          data-flame-stage={basket.flame.flameStage}
        >
          {FLAME_STAGE_LABEL[basket.flame.flameStage]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {basket.entryCount} {basket.entryCount === 1 ? "entry" : "entries"} · {basket.totalVolume.toFixed(2)} lots
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Avg entry</span>
          <div className="font-mono">{basket.averageEntry > 0 ? basket.averageEntry : "—"}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Break-even</span>
          <div className="font-mono">{basket.breakEvenPrice > 0 ? basket.breakEvenPrice : "—"}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Open P/L</span>
          <div className={`font-mono ${combined.tone}`}>{combined.text}</div>
          {plPartial && (
            <div className="text-[10px] text-warning" data-testid="scalp-basket-pl-partial">
              P/L incomplete — {plKnownLegs} of {basket.entryCount} legs reporting, so no basket
              total is shown.
            </div>
          )}
          {syncStale && (
            <div className="text-[10px] text-warning" data-testid="scalp-basket-pl-asof">
              as of {sync?.syncedAt ? fmtSyncTime(sync.syncedAt) : "an unknown time"} — not live
            </div>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Protection</span>
          <div className={basket.hasUnprotectedLeg ? "text-warning" : "text-success"}>
            {basket.hasUnprotectedLeg ? "Has unprotected leg" : "All have stops"}
          </div>
        </div>
      </div>

      {/* Exit urgency — ALERT_ONLY guidance */}
      <div
        className="rounded-md border border-border/40 p-2 space-y-1"
        data-testid="scalp-basket-exit"
        data-exit-urgency={basket.exit.urgency}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={EXIT_URGENCY_TONE[basket.exit.urgency]}>
            {EXIT_URGENCY_LABEL[basket.exit.urgency]}
          </Badge>
          <span className="text-sm font-medium">{basket.exit.headline}</span>
        </div>
        <p className="text-xs text-muted-foreground">{basket.exit.detail}</p>
        <p className="text-[11px] text-muted-foreground/70">
          {name} only advises — she never closes a position for you.
        </p>
      </div>

      {/* Add-on guidance */}
      <div
        className="rounded-md border border-border/40 p-2 space-y-1"
        data-testid="scalp-basket-addon"
        data-addon={basket.addOn.recommendation}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={ADD_ON_TONE[basket.addOn.recommendation]}>
            {ADD_ON_LABEL[basket.addOn.recommendation]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {basket.addOn.usedAddOns}/{basket.addOn.maxAddOns} adds used
            {basket.addOn.remainingAddOns > 0 ? ` · ${basket.addOn.remainingAddOns} left` : ""}
          </span>
          {basket.addOn.revengeGuardTriggered && (
            <span className="flex items-center gap-1 text-xs text-danger">
              <AlertTriangle className="h-3 w-3" /> Revenge guard
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{basket.addOn.reason}</p>
      </div>
    </div>
  );
}

export function RubyScalpBasketPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const { name } = useAssistantName();
  const baskets = useGetMeScalpBaskets({
    query: {
      queryKey: ["me-scalp-baskets"],
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  });
  const data = baskets.data;
  const list = data?.baskets ?? [];

  return (
    <Card data-testid="ruby-scalp-baskets" className="rounded-2xl border-ruby/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
              <Layers className="h-[18px] w-[18px]" />
            </span>
            {name} Position Manager
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => baskets.refetch()}
              disabled={baskets.isFetching}
              data-testid="ruby-scalp-baskets-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${baskets.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="ruby-scalp-baskets-collapse"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3">
          {baskets.isError && (
            <p className="text-sm text-danger">
              {name} couldn't read your open positions right now. Try Refresh in a moment.
            </p>
          )}
          {baskets.isPending && !data && (
            <p className="text-sm text-muted-foreground animate-pulse">
              {name} is reading your open positions…
            </p>
          )}
          {data && list.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No open scalp positions to manage. Once you're in a trade, {name} will
              watch the flame, exit urgency, and whether it's sane to add.
            </p>
          )}
          {list.map((b) => (
            <BasketRow key={`${b.symbol}:${b.direction}`} basket={b} name={name} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

export default RubyScalpBasketPanel;
