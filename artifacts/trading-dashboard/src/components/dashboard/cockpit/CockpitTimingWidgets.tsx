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

// The multi-read endpoint omits failed markets. An empty/partial response is
// not an all-clear, and HTTP receipt time is not provider data time.
function timingRows(data: unknown): Array<Record<string, unknown>> {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of results) {
    const symbol = r && typeof r === "object" ? (r as Record<string, unknown>).symbol : null;
    if (typeof symbol === "string") { if (seen.has(symbol)) duplicates.add(symbol); seen.add(symbol); }
  }
  return results.filter((r): r is Record<string, unknown> => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    const quality = row.dataQuality as Record<string, unknown> | null;
    return typeof row.symbol === "string" && SCAN_SYMBOLS.includes(row.symbol) && !duplicates.has(row.symbol)
      && quality?.label === "real" && quality.hasCandleData === true && quality.hasQuoteData === true
      && ["A+", "A", "B", "C", "D", "F"].includes(String(row.timingGrade))
      && ["GO", "WAIT_FOR_ENTRY", "WAIT_NEWS", "NO_TRADE", "STAND_DOWN"].includes(String(row.entryPermission))
      && [row.heatScore, row.tradeabilityScore, row.dangerScore].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100)
      && typeof row.generatedAt === "string" && Number.isFinite(Date.parse(row.generatedAt)) && Date.parse(row.generatedAt) <= Date.now();
  });
}

function responseFooter(updatedAt: number | undefined, count: number): string {
  const received = typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= Date.now()
    ? ` · response received ${new Date(updatedAt).toLocaleString()}` : "";
  return `Provider-backed timing reads: ${count}/${SCAN_SYMBOLS.length}${received}. Advisory only; not a trading approval.`;
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

  const results = q.isError ? [] : timingRows(q.data);

  const best = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    return PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
      && GRADE_GOOD.has(String(row["timingGrade"] ?? ""));
  }).slice(0, 3) as Array<Record<string, unknown>>;

  return (
    <CockpitCard
      title="Timing Candidates"
      icon={<TrendingUp className="h-[18px] w-[18px]" />}
      accent="success"
      loading={q.isLoading}
      data-testid="cockpit-best-markets"
    >
      {results.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary">Timing data unavailable. Market opportunities have not been assessed.</p>
      ) : best.length === 0 ? (
        <div className="py-4 text-center">
          <Flame className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">No A/B candidates in the returned timing reads.</p>
          <p className="text-xs text-txt-muted">These reads do not cover every market or every risk.</p>
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
                className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">{grade}</span>
                  </div>
                  <div className="text-[10px] text-txt-muted">Read generated {new Date(String(r["generatedAt"])).toLocaleString()}</div>
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
      {results.length > 0 && results.length < SCAN_SYMBOLS.length && <p className="mt-2 text-xs text-warning">Partial coverage. Missing or estimated market reads are excluded.</p>}
      <p className="mt-2 text-[10px] text-txt-muted">{responseFooter(q.dataUpdatedAt, results.length)}</p>
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

  const results = q.isError ? [] : timingRows(q.data);

  const avoid = results.filter((r: unknown) => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65;
  }).slice(0, 3) as Array<Record<string, unknown>>;

  return (
    <CockpitCard
      title="Timing Cautions"
      icon={<ShieldAlert className="h-[18px] w-[18px]" />}
      accent="danger"
      loading={q.isLoading}
      data-testid="cockpit-avoid-markets"
    >
      {results.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary">Timing data unavailable. Market cautions have not been assessed.</p>
      ) : avoid.length === 0 ? (
        <div className="py-4 text-center">
          <ShieldAlert className="mx-auto mb-1 h-5 w-5 text-txt-muted" />
          <p className="text-sm text-txt-secondary">No listed cautions in the returned timing reads.</p>
          <p className="text-xs text-txt-muted">This is not an all-clear for trading.</p>
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
                className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{sym}</span>
                    <span className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-bold",
                      GRADE_BAD.has(grade)
                        ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
                        : "border-amber-500/40 bg-amber-500/15 text-amber-400",
                    )}>{grade}</span>
                  </div>
                  <div className="text-[10px] text-txt-muted">Read generated {new Date(String(r["generatedAt"])).toLocaleString()}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-txt-muted capitalize">{state}</span>
                    <span className="text-[10px] text-txt-muted">·</span>
                    <span className="text-[10px] text-txt-muted capitalize">{perm}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={cn("text-[10px] font-mono", danger >= 65 ? "text-rose-400" : "text-amber-400")}>
                    D:{danger}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {results.length > 0 && results.length < SCAN_SYMBOLS.length && <p className="mt-2 text-xs text-warning">Partial coverage. Missing or estimated market reads are excluded.</p>}
      <p className="mt-2 text-[10px] text-txt-muted">{responseFooter(q.dataUpdatedAt, results.length)}</p>
      <div className="mt-3">
        <ActionButton href="/market-heat-map" subtle icon={<TrendingDown className="h-4 w-4" />} data-testid="avoid-markets-heat">
          Heat Map
        </ActionButton>
      </div>
    </CockpitCard>
  );
}
