import { useMemo, useState } from "react";
import {
  Flame,
  Loader2,
  ChevronDown,
  RefreshCw,
  AlertTriangle,
  Globe,
  Activity,
  Newspaper,
  CalendarClock,
  TrendingUp,
  Map as MapIcon,
  LayoutGrid,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { setChartSymbol } from "@/lib/use-chart-symbol";
import { useGetMarketHeat, getGetMarketHeatQueryKey } from "@workspace/api-client-react";
import type {
  MarketHeatVerdict,
  MarketHeatSource,
  MarketHeatProviderStatus,
  MarketHeatNewsRisk,
  MarketHeatNewsHeadline,
  MarketHeatEvent,
} from "@workspace/api-client-react";

// GlobalMarketHeatCard — honest, decision-support-only country/currency/synthetic
// heat (Task #611).
//
// SAFETY / HONESTY: reads ONLY the read-only `GET /api/market-heat` endpoint.
// It NEVER places, modifies, or closes a trade and never unlocks any gate. When
// a provider (news / calendar / price) is not connected, the backend returns an
// honest `unavailable` verdict — this component renders that absence faithfully
// and NEVER paints a missing provider as low-risk / calm. Every verdict carries
// `advisoryOnly: true`.

// ── Honesty-aware visual tone per intensity. `unavailable` is gray, NEVER green/
// calm, so a missing provider can never look like a safe/quiet market. ─────────
const INTENSITY_TONE: Record<string, { dot: string; text: string; label: string }> = {
  extreme: { dot: "bg-danger", text: "text-danger", label: "Extreme" },
  high: { dot: "bg-warning", text: "text-warning", label: "High" },
  moderate: { dot: "bg-warning/70", text: "text-warning", label: "Moderate" },
  low: { dot: "bg-success/70", text: "text-success", label: "Low" },
  calm: { dot: "bg-success", text: "text-success", label: "Calm" },
  unavailable: { dot: "bg-txt-muted/40", text: "text-txt-muted", label: "Unavailable" },
};

// Heat-map tile background per intensity. Gray for unavailable — a missing
// provider is never tinted as a safe/quiet (green) cell.
const INTENSITY_TILE: Record<string, string> = {
  extreme: "border-danger/40 bg-danger/15 text-danger",
  high: "border-warning/40 bg-warning/15 text-warning",
  moderate: "border-warning/30 bg-warning/10 text-warning",
  low: "border-success/30 bg-success/10 text-success",
  calm: "border-success/40 bg-success/15 text-success",
  unavailable: "border-txt-muted/25 bg-surface-2/40 text-txt-muted",
};

const DIRECTION_LABEL: Record<string, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
  unavailable: "Unavailable",
};

const SOURCE_STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  confirmed: { text: "Confirmed", tone: "text-success" },
  price_only: { text: "Price only", tone: "text-warning" },
  delayed: { text: "Delayed", tone: "text-warning" },
  stale: { text: "Stale", tone: "text-warning" },
  provider_missing: { text: "Provider missing", tone: "text-txt-muted" },
  unavailable: { text: "Unavailable", tone: "text-txt-muted" },
};

// News-risk tone. `unavailable` is gray — NEVER shown as a calm/low (green)
// reading when the provider is not connected.
const NEWS_RISK_TONE: Record<string, { text: string; label: string }> = {
  high: { text: "text-danger", label: "High" },
  elevated: { text: "text-warning", label: "Elevated" },
  moderate: { text: "text-warning", label: "Moderate" },
  low: { text: "text-success", label: "Low" },
  unavailable: { text: "text-txt-muted", label: "Unavailable" },
};

const EVENT_IMPACT_TONE: Record<string, string> = {
  high: "border-danger/40 text-danger",
  medium: "border-warning/40 text-warning",
  low: "border-txt-muted/40 text-txt-muted",
};

// Severity badge tone for a surfaced driving headline.
const HEADLINE_SEVERITY_TONE: Record<string, string> = {
  high: "border-danger/40 text-danger",
  medium: "border-warning/40 text-warning",
  low: "border-txt-muted/40 text-txt-muted",
};

function tone(intensity: string) {
  return INTENSITY_TONE[intensity] ?? INTENSITY_TONE.unavailable!;
}

function tileTone(intensity: string) {
  return INTENSITY_TILE[intensity] ?? INTENSITY_TILE.unavailable!;
}

// Honesty: a verdict whose data is not trustworthy must NEVER render in an
// intensity color (low/calm are green). Any degraded source status — stale,
// delayed, provider_missing, unavailable — or an `unavailable` intensity is
// forced to the gray "unavailable" tone, independent of the computed intensity.
const DEGRADED_SOURCE_STATUS = new Set([
  "stale",
  "delayed",
  "provider_missing",
  "unavailable",
]);

function isHonestyMuted(v: MarketHeatVerdict): boolean {
  return v.intensity === "unavailable" || DEGRADED_SOURCE_STATUS.has(v.sourceStatus);
}

// Map-node tone: gray + honest status label when muted, else the intensity tone.
function mapTone(v: MarketHeatVerdict): { text: string; dot: string; label: string } {
  if (isHonestyMuted(v)) {
    const gray = INTENSITY_TONE.unavailable!;
    const statusLabel = SOURCE_STATUS_LABEL[v.sourceStatus]?.text ?? gray.label;
    return { text: gray.text, dot: gray.dot, label: statusLabel };
  }
  return tone(v.intensity);
}

function freshness(updatedAt?: string | null): string {
  if (!updatedAt) return "never";
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function eventTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  // Provider event times are UTC (field name `timeUtc`). Label both the UTC
  // value and the viewer's local time so the chip is never an ambiguous
  // bare clock value.
  const utc = new Date(t).toLocaleString(undefined, { ...opts, timeZone: "UTC" });
  const local = new Date(t).toLocaleString(undefined, opts);
  return `${utc} UTC · ${local} local`;
}

function ProviderChip({ source }: { source: MarketHeatSource }) {
  const ok = source.connected;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
        ok ? "border-success/40 text-success" : "border-txt-muted/30 text-txt-muted"
      }`}
      title={source.note ?? undefined}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success" : "bg-txt-muted/50"}`} />
      {source.name}: {ok ? source.status : "not connected"}
    </span>
  );
}

function ProviderRow({ status }: { status: MarketHeatProviderStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ProviderChip source={status.price} />
      <ProviderChip source={status.news} />
      <ProviderChip source={status.calendar} />
    </div>
  );
}

// ── Today's news risk — distinct surfaced section. Honest `unavailable` is gray,
// never a fabricated "low risk" when the news provider is not connected. ───────
function HeadlineRow({ h }: { h: MarketHeatNewsHeadline }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/50 bg-surface-1/30 px-2 py-1.5">
      <span
        className={`mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase ${
          HEADLINE_SEVERITY_TONE[h.severity] ?? HEADLINE_SEVERITY_TONE.low!
        }`}
      >
        {h.severity}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-txt">{h.headline}</span>
        <span className="mt-0.5 block text-[10px] text-txt-muted">
          {h.source ?? "unknown source"} · {freshness(h.publishedAt)}
        </span>
      </span>
    </div>
  );
}

function NewsRiskSection({ risk }: { risk: MarketHeatNewsRisk }) {
  const t = NEWS_RISK_TONE[risk.level] ?? NEWS_RISK_TONE.unavailable!;
  // Surface driving headlines only when risk is elevated/high (and connected).
  const showHeadlines =
    risk.connected &&
    (risk.level === "elevated" || risk.level === "high") &&
    risk.topHeadlines.length > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-txt-muted">
        <Newspaper className="h-3 w-3" /> Today's news risk
      </div>
      <div className="rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-semibold ${t.text}`}>{t.label}</span>
          {risk.connected && (
            <span className="text-[11px] text-txt-muted">
              {risk.itemCount} item{risk.itemCount === 1 ? "" : "s"} · {risk.provider}
            </span>
          )}
          {risk.connected && risk.highImpactCount > 0 && (
            <span className="inline-flex items-center rounded-full border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger">
              {risk.highImpactCount} high-impact
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-txt-muted">{risk.summary}</p>
        {showHeadlines && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-txt-muted">
              Driving headlines
            </div>
            {risk.topHeadlines.map((h, i) => (
              <HeadlineRow key={`${h.headline}-${i}`} h={h} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Upcoming high-impact events — distinct surfaced section. Honest empty state
// when the economic-calendar provider is not connected (never fabricated). ─────
function UpcomingEventsSection({
  events,
  calendarConnected,
}: {
  events: MarketHeatEvent[];
  calendarConnected: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-txt-muted">
        <CalendarClock className="h-3 w-3" /> Upcoming high-impact events
      </div>
      {events.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2 text-xs text-txt-muted">
          {calendarConnected
            ? "No upcoming high-impact events on the connected calendar."
            : "Economic-calendar provider not connected — upcoming events are unavailable (not 'no events')."}
        </div>
      ) : (
        <div className="space-y-1">
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-1/40 px-3 py-1.5"
            >
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                  EVENT_IMPACT_TONE[e.impact] ?? EVENT_IMPACT_TONE.low!
                }`}
              >
                {e.impact}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-txt">
                <span className="font-medium">{e.currency}</span> · {e.title}
              </span>
              <span className="shrink-0 text-[10px] text-txt-muted">{eventTime(e.timeUtc)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VerdictDetail({
  verdict,
  onPickSymbol,
}: {
  verdict: MarketHeatVerdict;
  onPickSymbol: (symbol: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-surface-1/40 px-3 py-2 text-xs">
      <p className="text-txt-muted">{verdict.reason}</p>
      {verdict.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {verdict.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1 text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <span className="text-txt-muted">Price {freshness(verdict.priceUpdatedAt)}</span>
        <span className="text-txt-muted">· News {freshness(verdict.newsUpdatedAt)}</span>
        <span className="text-txt-muted">· Calendar {freshness(verdict.calendarUpdatedAt)}</span>
      </div>
      {verdict.affectedSymbols.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {verdict.affectedSymbols.map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => onPickSymbol(sym)}
              className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-txt hover:border-primary hover:text-primary"
            >
              {sym}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VerdictRow({
  verdict,
  onPickSymbol,
}: {
  verdict: MarketHeatVerdict;
  onPickSymbol: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = tone(verdict.intensity);
  const ss = SOURCE_STATUS_LABEL[verdict.sourceStatus] ?? SOURCE_STATUS_LABEL.unavailable!;
  const unavailable = verdict.intensity === "unavailable";

  return (
    <div className="rounded-lg border border-border/60 bg-surface-1/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt">
          {verdict.displayName}
        </span>
        <span className={`shrink-0 text-xs ${t.text}`}>{t.label}</span>
        {!unavailable && (
          <span className="shrink-0 text-xs text-txt-muted">
            {DIRECTION_LABEL[verdict.direction] ?? verdict.direction}
          </span>
        )}
        <span className={`shrink-0 text-[10px] ${ss.tone}`}>{ss.text}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-txt-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/50 p-2">
          <VerdictDetail verdict={verdict} onPickSymbol={onPickSymbol} />
        </div>
      )}
    </div>
  );
}

// ── Geographic placement for the world-heat map. Equirectangular projection on
// a 0..360 × 0..180 viewBox (x = lon+180, y = 90-lat), hand-nudged so the
// clustered European economies stay legible on a small card. Only macro regions
// we actually track get a coordinate; anything without one (e.g. "Global") is
// surfaced as a chip below the map so no verdict is ever silently dropped. ─────
const REGION_COORDS: Record<string, { x: number; y: number; short: string }> = {
  US: { x: 80, y: 52, short: "US" },
  Canada: { x: 72, y: 33, short: "CA" },
  UK: { x: 171, y: 31, short: "UK" },
  Eurozone: { x: 200, y: 45, short: "EZ" },
  Germany: { x: 189, y: 35, short: "DE" },
  Switzerland: { x: 181, y: 49, short: "CH" },
  China: { x: 288, y: 58, short: "CN" },
  Japan: { x: 323, y: 52, short: "JP" },
  Australia: { x: 311, y: 119, short: "AU" },
  "New Zealand": { x: 351, y: 133, short: "NZ" },
};

// Order used by the compact map legend.
const LEGEND_ORDER = ["extreme", "high", "moderate", "low", "calm", "unavailable"] as const;

function countryKeyFromId(id: string): string {
  return id.startsWith("country:") ? id.slice("country:".length) : id;
}

// Subtle, schematic continents backdrop (low-opacity blobs) so positioned heat
// nodes read as a world map. Decorative only — never a data claim.
function ContinentBackdrop() {
  return (
    <g className="text-txt-muted" fill="currentColor" opacity={0.08}>
      <ellipse cx={80} cy={46} rx={32} ry={24} />
      <ellipse cx={118} cy={120} rx={17} ry={30} />
      <ellipse cx={188} cy={40} rx={20} ry={15} />
      <ellipse cx={202} cy={98} rx={26} ry={34} />
      <ellipse cx={272} cy={50} rx={52} ry={30} />
      <ellipse cx={311} cy={120} rx={16} ry={11} />
      <ellipse cx={150} cy={18} rx={12} ry={8} />
    </g>
  );
}

// ── World market-heat map — countries shaded by their honest heat verdict.
// Honesty: `unavailable` regions render gray (never green/calm); only countries
// with a real reading carry an intensity color. Clicking a country selects it
// (parent renders its reasons + affected symbols). ────────────────────────────
function WorldHeatMap({
  countries,
  selectedKey,
  onSelect,
}: {
  countries: MarketHeatVerdict[];
  selectedKey: string | null;
  onSelect: (id: string | null) => void;
}) {
  const placed = countries
    .map((v) => ({ v, coord: REGION_COORDS[countryKeyFromId(v.id)] }))
    .filter((x): x is { v: MarketHeatVerdict; coord: (typeof REGION_COORDS)[string] } =>
      Boolean(x.coord),
    );
  const unplaced = countries.filter((v) => !REGION_COORDS[countryKeyFromId(v.id)]);

  return (
    <div className="space-y-1.5">
      {placed.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2 text-xs text-txt-muted">
          No country-level heat to map — country heat is unavailable while the news/calendar
          providers are not connected.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-surface-2/30">
          <svg
            viewBox="0 0 360 180"
            className="h-auto w-full"
            role="img"
            aria-label="World market-heat map"
          >
            {/* faint graticule */}
            <g className="text-border" stroke="currentColor" strokeWidth={0.3} opacity={0.4}>
              {[60, 120, 180, 240, 300].map((x) => (
                <line key={`v${x}`} x1={x} y1={0} x2={x} y2={180} />
              ))}
              {[45, 90, 135].map((y) => (
                <line key={`h${y}`} x1={0} y1={y} x2={360} y2={y} />
              ))}
            </g>
            <ContinentBackdrop />
            {placed.map(({ v, coord }) => {
              const t = mapTone(v);
              const active = v.id === selectedKey;
              const isUnavailable = isHonestyMuted(v);
              const r = isUnavailable ? 3.5 : 5;
              return (
                <g
                  key={v.id}
                  className={`cursor-pointer ${t.text}`}
                  onClick={() => onSelect(active ? null : v.id)}
                >
                  <title>{`${v.displayName} — ${t.label}`}</title>
                  {active && (
                    <circle
                      cx={coord.x}
                      cy={coord.y}
                      r={r + 3}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1}
                      opacity={0.7}
                    />
                  )}
                  <circle
                    cx={coord.x}
                    cy={coord.y}
                    r={r}
                    fill="currentColor"
                    opacity={isUnavailable ? 0.5 : 0.9}
                  />
                  <text
                    x={coord.x}
                    y={coord.y - r - 2}
                    textAnchor="middle"
                    fill="currentColor"
                    fontSize={8}
                    opacity={0.9}
                  >
                    {coord.short}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Compact legend so the shading is readable at a glance. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-txt-muted">
        {LEGEND_ORDER.map((k) => {
          const t = INTENSITY_TONE[k]!;
          return (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
              {t.label}
            </span>
          );
        })}
      </div>

      <p className="text-[10px] text-txt-muted">
        Tap a country for its drivers &amp; affected symbols. Currency tiles are in Grid view.
      </p>

      {/* Regions without a map location (e.g. Global) — never silently dropped. */}
      {unplaced.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unplaced.map((v) => {
            const t = mapTone(v);
            const active = v.id === selectedKey;
            const tileCls = isHonestyMuted(v)
              ? INTENSITY_TILE.unavailable!
              : tileTone(v.intensity);
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelect(active ? null : v.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${tileCls} ${active ? "ring-1 ring-primary" : ""}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                {v.displayName}
                <span className="opacity-70">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GlobalMarketHeatCard() {
  const { data, isLoading, isFetching, refetch, isError } = useGetMarketHeat(
    { timeframe: "M15" },
    {
      query: {
        queryKey: getGetMarketHeatQueryKey({ timeframe: "M15" }),
        staleTime: 60_000,
        refetchInterval: 120_000,
      },
    },
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [macroView, setMacroView] = useState<"map" | "grid">("map");
  const onPickSymbol = (symbol: string) => setChartSymbol(symbol);

  const anyProviderConnected = useMemo(() => {
    if (!data) return false;
    const p = data.providerStatus;
    return p.price.connected || p.news.connected || p.calendar.connected;
  }, [data]);

  // Macro heat cells (countries + currencies) for the heat-map grid.
  const macroCells = useMemo<MarketHeatVerdict[]>(
    () => (data ? [...data.countries, ...data.currencies] : []),
    [data],
  );

  // Top hot — distinct surfaced section. Only ranks cells that pass the same
  // honesty gate as the map view: an unavailable intensity OR any degraded
  // source status (stale/delayed/provider_missing/unavailable) is excluded, so
  // a disconnected OR stale/delayed provider can never appear "hot".
  const topHot = useMemo<MarketHeatVerdict[]>(() => {
    return macroCells
      .filter((v) => !isHonestyMuted(v))
      .sort((a, b) => Math.abs(b.heatScore) - Math.abs(a.heatScore))
      .slice(0, 6);
  }, [macroCells]);

  const selected = useMemo(
    () => macroCells.find((v) => v.id === selectedKey) ?? null,
    [macroCells, selectedKey],
  );

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Flame className="h-4 w-4 text-warning" />
        <h3 className="flex-1 text-sm font-semibold text-txt">Global Market Heat</h3>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-txt-muted">
          Decision-support only
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-txt-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading market heat…
        </div>
      ) : isError || !data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-txt-muted">
          <AlertTriangle className="h-4 w-4 text-warning" /> Market heat is unavailable right now.
        </div>
      ) : (
        <div className="space-y-3">
          <ProviderRow status={data.providerStatus} />

          {!anyProviderConnected && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                No live news, calendar, or price feed is connected — heat is reported as
                unavailable. This is honest absence, not a calm/low-risk reading.
              </span>
            </div>
          )}

          {/* Global aggregate */}
          <VerdictRow verdict={data.global} onPickSymbol={onPickSymbol} />

          {/* Top hot — distinct surfaced section */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-txt-muted">
              <TrendingUp className="h-3 w-3" /> Top hot countries &amp; currencies
            </div>
            {topHot.length === 0 ? (
              <div className="rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2 text-xs text-txt-muted">
                No live macro heat to rank — country/currency heat is unavailable while the
                news/calendar providers are not connected.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {topHot.map((v) => {
                  // Defense-in-depth: mapTone re-applies the honesty mute even
                  // though honesty-muted verdicts are already excluded above.
                  const t = mapTone(v);
                  const tileCls = isHonestyMuted(v)
                    ? INTENSITY_TILE.unavailable!
                    : tileTone(v.intensity);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedKey(v.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${tileCls}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                      {v.displayName}
                      <span className="opacity-70">{t.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Today's news risk — distinct surfaced section */}
          <NewsRiskSection risk={data.newsRisk} />

          {/* Upcoming high-impact events — distinct surfaced section */}
          <UpcomingEventsSection
            events={data.upcomingEvents}
            calendarConnected={data.providerStatus.calendar.connected}
          />

          {/* Country / currency heat — geographic map OR colored tile grid */}
          {macroCells.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Globe className="h-3 w-3 text-txt-muted" />
                <span className="flex-1 text-[11px] uppercase tracking-wide text-txt-muted">
                  Country &amp; currency heat
                </span>
                <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMacroView("map")}
                    aria-pressed={macroView === "map"}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                      macroView === "map" ? "bg-surface-2 text-txt" : "text-txt-muted"
                    }`}
                  >
                    <MapIcon className="h-3 w-3" /> Map
                  </button>
                  <button
                    type="button"
                    onClick={() => setMacroView("grid")}
                    aria-pressed={macroView === "grid"}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                      macroView === "grid" ? "bg-surface-2 text-txt" : "text-txt-muted"
                    }`}
                  >
                    <LayoutGrid className="h-3 w-3" /> Grid
                  </button>
                </div>
              </div>

              {macroView === "map" ? (
                <WorldHeatMap
                  countries={data.countries}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                />
              ) : (
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {macroCells.map((v) => {
                    // Same honesty mute as the map view: a stale/delayed/
                    // missing-source verdict renders gray with its status label,
                    // never in intensity color (low/calm are green).
                    const t = mapTone(v);
                    const tileCls = isHonestyMuted(v)
                      ? INTENSITY_TILE.unavailable!
                      : tileTone(v.intensity);
                    const active = v.id === selectedKey;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setSelectedKey(active ? null : v.id)}
                        className={`flex flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${tileCls} ${active ? "ring-1 ring-primary" : ""}`}
                      >
                        <span className="w-full truncate text-xs font-medium text-txt">
                          {v.displayName}
                        </span>
                        <span className="flex items-center gap-1 text-[10px]">
                          <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                          {t.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selected && <VerdictDetail verdict={selected} onPickSymbol={onPickSymbol} />}
            </div>
          )}

          {/* Synthetics rendered in their own panel — never mapped to a country */}
          {data.synthetics.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-txt-muted">
                <Activity className="h-3 w-3" /> Synthetic indices (no country)
              </div>
              {data.synthetics.map((v) => (
                <VerdictRow key={v.id} verdict={v} onPickSymbol={onPickSymbol} />
              ))}
            </div>
          )}

          {data.warnings.length > 0 && (
            <ul className="space-y-0.5 pt-1">
              {data.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1 text-[11px] text-txt-muted">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="pt-1 text-[10px] text-txt-muted">
            Updated {freshness(data.generatedAt)} · advisory only, never an execution gate.
          </p>
        </div>
      )}
    </div>
  );
}
