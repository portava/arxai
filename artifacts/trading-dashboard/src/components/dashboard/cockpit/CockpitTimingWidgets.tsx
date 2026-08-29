// Cockpit Timing Widgets — Phase 3 Best Markets / Avoid Right Now.
// Uses useGetTimingBrainMulti to pull timing reads for major pairs and
// classifies them into "best now" (GO + grade A/B) and "avoid now"
// (STAND_DOWN / NO_TRADE / grade D/F).
// Honest empty when timing data is unavailable — never fabricated.

import { cn } from "@/lib/utils";
import {
  useGetTimingBrainMulti,
  getGetTimingBrainMultiQueryKey,
} from "@workspace/api-client-react";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { Flame, ShieldAlert, TrendingUp, TrendingDown } from "lucide-react";
import { CockpitCard, ActionButton } from "./primitives";

// Focus-Lock (Task #570): only scan markets that are in the approved ARX Focus
// universe. Any symbol outside the registry is dropped so the cockpit never
// requests timing for an unapproved market.
const SCAN_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"].filter(
  isApprovedArxMarket,
);
const GRADE_GOOD = new Set(["A+", "A", "B"]);
const GRADE_BAD = new Set(["D", "F"]);

const PERMISSION_PASS = new Set(["GO"]);
const PERMISSION_BLOCK = new Set(["STAND_DOWN", "NO_TRADE"]);

// Honest source/freshness footer (Task #611). Timing reads are real-or-empty —
// this label never claims live data when the feed is stale or absent.
function freshnessFooter(updatedAt: number | undefined, count: number): string {
  if (!updatedAt || count === 0) return "Source: live market provider when connected";
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  const age = s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  return `Source: live market provider · updated ${age}`;
}

const HEAT_STATE_SHORT: Record<string, string> = {
  CLEAN_MOMENTUM:  "Clean",
  DIRTY_HEAT:      "Dirty heat",
  TRAP_HEAT:       "Trap risk",
  NEWS_HEAT:       "News-driven",
  EXHAUSTION_HEAT: "Exhausted",
  FALSE_HEAT:      "False heat",
  COMPRESSION:     "Coiling",
  WAKE_UP:         "Breaking out",
  COOL:            "Quiet",
};

export function BestMarketsCard() {
  const q = useGetTimingBrainMulti(
    { symbols: SCAN_SYMBOLS.join(",") },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: SCAN_SYMBOLS.join(",") }),
        refetchInterval: 90_000,
        retry: false,
      },
    },
  );

  const results = (q.data as { results?: unknown[] })?.results ?? [];

  const best = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    return PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
      && GRADE_GOOD.has(String(row["timingGrade"] ?? ""));
  }).slice(0, 3) as Array<Record<string, unknown>>;

  return (
    <CockpitCard
      title="Best Markets Now"
      icon={<TrendingUp className="h-[18px] w-[18px]" />}
      accent="success"
      loading={q.isLoading}
      data-testid="cockpit-best-markets"
    >
      {!q.isLoading && best.length === 0 ? (
        <div className="py-4 text-center">
          <Flame className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">No A-grade setups right now.</p>
          <p className="text-xs text-txt-muted">Check back when session conditions improve.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {best.map((r) => {
            const sym = String(r["symbol"] ?? "");
            const grade = String(r["timingGrade"] ?? "");
            const action = String(r["bestAction"] ?? "").replace(/_/g, " ");
            const state = HEAT_STATE_SHORT[String(r["heatState"] ?? "")] ?? String(r["heatState"] ?? "");
            const heat = Number(r["heatScore"] ?? 0);
            const trade = Number(r["tradeabilityScore"] ?? 0);
            return (
              <li
                key={sym}
                className="flex items-center justify-between gap-3 rounded-lg border border-success/20 bg-success/5 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className="rounded border border-success/25 bg-success/10 px-1.5 py-0.5 text-[10px] font-bold text-success">{grade}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-txt-muted capitalize">{state}</span>
                    <span className="text-[10px] text-txt-muted">·</span>
                    <span className="text-[10px] text-txt-muted capitalize">{action.toLowerCase()}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[10px] text-txt-muted">H:{heat} T:{trade}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-txt-muted">{freshnessFooter(q.dataUpdatedAt, results.length)}</p>
      <div className="mt-3">
        <ActionButton href="/market-scanner" subtle icon={<Flame className="h-4 w-4" />} data-testid="best-markets-scanner">
          Open Scanner
        </ActionButton>
      </div>
    </CockpitCard>
  );
}

export function AvoidMarketsCard() {
  const q = useGetTimingBrainMulti(
    { symbols: SCAN_SYMBOLS.join(",") },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: SCAN_SYMBOLS.join(",") }),
        refetchInterval: 90_000,
        retry: false,
      },
    },
  );

  const results = (q.data as { results?: unknown[] })?.results ?? [];

  const avoid = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65;
  }).slice(0, 3) as Array<Record<string, unknown>>;

  return (
    <CockpitCard
      title="Avoid Right Now"
      icon={<ShieldAlert className="h-[18px] w-[18px]" />}
      accent="danger"
      loading={q.isLoading}
      data-testid="cockpit-avoid-markets"
    >
      {!q.isLoading && avoid.length === 0 ? (
        <div className="py-4 text-center">
          <ShieldAlert className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">No major red flags right now.</p>
          <p className="text-xs text-txt-muted">Market conditions look manageable.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {avoid.map((r) => {
            const sym = String(r["symbol"] ?? "");
            const grade = String(r["timingGrade"] ?? "");
            const perm = String(r["entryPermission"] ?? "").replace(/_/g, " ").toLowerCase();
            const danger = Number(r["dangerScore"] ?? 0);
            const state = HEAT_STATE_SHORT[String(r["heatState"] ?? "")] ?? String(r["heatState"] ?? "");
            return (
              <li
                key={sym}
                className="flex items-center justify-between gap-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-bold",
                      GRADE_BAD.has(grade)
                        ? "border-danger/25 bg-danger/10 text-danger"
                        : "border-warning/25 bg-warning/10 text-warning",
                    )}>{grade}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-txt-muted capitalize">{state}</span>
                    <span className="text-[10px] text-txt-muted">·</span>
                    <span className="text-[10px] text-txt-muted capitalize">{perm}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={cn("text-[10px] font-mono", danger >= 65 ? "text-danger" : "text-warning")}>
                    D:{danger}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-txt-muted">{freshnessFooter(q.dataUpdatedAt, results.length)}</p>
      <div className="mt-3">
        <ActionButton href="/market-heat-map" subtle icon={<TrendingDown className="h-4 w-4" />} data-testid="avoid-markets-heat">
          Heat Map
        </ActionButton>
      </div>
    </CockpitCard>
  );
}
