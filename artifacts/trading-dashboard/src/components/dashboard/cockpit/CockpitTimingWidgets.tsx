// Cockpit Timing Widgets — Phase 3 Best Markets / Avoid Right Now.
// Uses useGetTimingBrainMulti to pull timing reads for major pairs and
// classifies them into "best now" (GO + grade A/B) and "avoid now"
// (STAND_DOWN / NO_TRADE / grade D/F).
// Honest empty when timing data is unavailable — never fabricated.

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  useGetTimingBrainMulti,
  getGetTimingBrainMultiQueryKey,
} from "@workspace/api-client-react";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { useActiveSymbol } from "@/lib/symbol-context";
import { Flame, ShieldAlert, TrendingUp, TrendingDown } from "lucide-react";
import { CockpitCard, ActionButton } from "./primitives";

// Focus-Lock (Task #570): only scan markets that are in the approved ARX Focus
// universe. Any symbol outside the registry is dropped so the cockpit never
// requests timing for an unapproved market.
//
// SCOPE HONESTY: this is a handful of symbols out of the 43 approved markets,
// yet these two cards render whole-market verdicts. A synthetics trader was
// being told "Market conditions look manageable" when the system had never
// looked at a single synthetic — the app's own default chart symbol (V75) is
// not in the default list. The user's active symbol is now always scanned,
// and BOTH cards name the exact markets they looked at.
const DEFAULT_SCAN_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"];
const GRADE_GOOD = new Set(["A+", "A", "B"]);
const GRADE_BAD = new Set(["D", "F"]);

const PERMISSION_PASS = new Set(["GO"]);
const PERMISSION_BLOCK = new Set(["STAND_DOWN", "NO_TRADE"]);

// types.ts: consumers "must check dataQuality.label before treating scores as
// actionable". Neither filter did, so a symbol whose candle AND quote feeds
// were both dead could be promoted into "Best Markets Now" with a green A.
function qualityLabel(row: Record<string, unknown>): string {
  const dq = row["dataQuality"];
  if (dq && typeof dq === "object") return String((dq as Record<string, unknown>)["label"] ?? "unavailable");
  return "unavailable";
}
function isRealQuality(row: Record<string, unknown>): boolean {
  return qualityLabel(row) === "real";
}

/** Scan set = the user's active market (when approved) + the default majors. */
function useScanSymbols(): string[] {
  const { active } = useActiveSymbol();
  return useMemo(() => {
    const wanted = [active, ...DEFAULT_SCAN_SYMBOLS].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return [...new Set(wanted)].filter(isApprovedArxMarket);
  }, [active]);
}

function scopeSubtitle(symbols: string[]): string {
  if (symbols.length === 0) return "No approved market in scope — nothing scanned.";
  return `Scanned ${symbols.length} market${symbols.length === 1 ? "" : "s"}: ${symbols.join(", ")}. Other markets were not looked at.`;
}

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
  const scanSymbols = useScanSymbols();
  const symbolsParam = scanSymbols.join(",");
  const q = useGetTimingBrainMulti(
    { symbols: symbolsParam },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: symbolsParam }),
        refetchInterval: 90_000,
        retry: false,
        enabled: scanSymbols.length > 0,
      },
    },
  );

  const results = (q.data as { results?: unknown[] })?.results ?? [];

  const qualified = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    return PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
      && GRADE_GOOD.has(String(row["timingGrade"] ?? ""));
  }) as Array<Record<string, unknown>>;

  // Only reads backed by a real feed are promoted. A read on a dead candle or
  // quote feed is shown separately and labelled, never with a green grade.
  const best = qualified.filter(isRealQuality).slice(0, 3);
  const estimates = qualified.filter((r) => !isRealQuality(r)).slice(0, 3);

  return (
    <CockpitCard
      title="Best Markets Now"
      subtitle={scopeSubtitle(scanSymbols)}
      icon={<TrendingUp className="h-[18px] w-[18px]" />}
      accent="success"
      loading={q.isLoading}
      data-testid="cockpit-best-markets"
    >
      {!q.isLoading && best.length === 0 ? (
        <div className="py-4 text-center">
          <Flame className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">
            No A-grade setup on a confirmed feed in {scanSymbols.length === 1 ? "the market" : `the ${scanSymbols.length} markets`} scanned.
          </p>
          <p className="text-xs text-txt-muted">This says nothing about markets outside that list.</p>
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
      {estimates.length > 0 && (
        <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-warning">Estimate only — feed incomplete</p>
          <ul className="mt-1 space-y-0.5">
            {estimates.map((r) => (
              <li key={String(r["symbol"] ?? "")} className="flex items-center justify-between text-[11px]">
                <span className="font-mono">{String(r["symbol"] ?? "")}</span>
                <span className="text-txt-muted">{qualityLabel(r).replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-txt-muted">Not scored as a setup — treat as unconfirmed.</p>
        </div>
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
  const scanSymbols = useScanSymbols();
  const symbolsParam = scanSymbols.join(",");
  const q = useGetTimingBrainMulti(
    { symbols: symbolsParam },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: symbolsParam }),
        refetchInterval: 90_000,
        retry: false,
        enabled: scanSymbols.length > 0,
      },
    },
  );

  const results = (q.data as { results?: unknown[] })?.results ?? [];

  const avoid = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    // A read on a degraded feed is itself a reason to stand back, so a
    // non-real dataQuality is a WARN here rather than a silent pass — the
    // conservative direction. Only the reassuring "nothing to avoid" verdict
    // needs a confirmed feed behind it.
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65
      || !isRealQuality(row);
  }).slice(0, 3) as Array<Record<string, unknown>>;

  const degraded = (results as Array<Record<string, unknown>>).filter(
    (r) => r && typeof r === "object" && !isRealQuality(r),
  ).length;

  return (
    <CockpitCard
      title="Avoid Right Now"
      subtitle={scopeSubtitle(scanSymbols)}
      icon={<ShieldAlert className="h-[18px] w-[18px]" />}
      accent="danger"
      loading={q.isLoading}
      data-testid="cockpit-avoid-markets"
    >
      {!q.isLoading && avoid.length === 0 ? (
        <div className="py-4 text-center">
          <ShieldAlert className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">
            No red flags in the {scanSymbols.length} market{scanSymbols.length === 1 ? "" : "s"} scanned.
          </p>
          <p className="text-xs text-txt-muted">
            {results.length === 0
              ? "No timing read was returned — this is not an all-clear."
              : "Markets outside that list were not checked."}
          </p>
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
                    {!isRealQuality(r) && (
                      <>
                        <span className="text-[10px] text-txt-muted">·</span>
                        <span className="text-[10px] font-medium text-warning">feed {qualityLabel(r).replace(/_/g, " ")}</span>
                      </>
                    )}
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
      {degraded > 0 && (
        <p className="mt-2 text-[10px] text-warning">
          {degraded} of {results.length} scanned market{results.length === 1 ? "" : "s"} returned an incomplete feed.
        </p>
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
