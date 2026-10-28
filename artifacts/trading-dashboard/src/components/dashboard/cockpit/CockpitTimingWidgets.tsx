// Cockpit Timing Widgets — Phase 3 Best Markets / Avoid Right Now.
// Uses useGetTimingBrainMulti to pull timing reads for major pairs and
// classifies them into "best now" (GO + grade A/B) and "avoid now"
// (STAND_DOWN / NO_TRADE / grade D/F). Only reads measured from current candles
// are classified; unmeasured reads are named as such.
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

// Honest source/freshness footer (Task #611). A timing read is "measured" only
// when the server says it was computed from current candles; a read built from
// session constants alone (no candles, no quote) is never listed as a best or
// avoid market and never counted as live. The age comes from the reads' own
// generatedAt (when the server computed them), not from the browser fetch time.
type TimingRow = Record<string, unknown>;

export function isMeasuredTimingRead(row: TimingRow): boolean {
  const dq = row["dataQuality"];
  if (!dq || typeof dq !== "object") return false;
  const d = dq as Record<string, unknown>;
  return d["hasCandleData"] === true && (d["label"] === "real" || d["label"] === "partial");
}

function asRows(results: unknown[]): TimingRow[] {
  return results.filter((r): r is TimingRow => !!r && typeof r === "object");
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export function timingFooter(rows: TimingRow[], nowMs: number = Date.now()): string {
  if (rows.length === 0) return "No timing reads returned yet.";
  const measured = rows.filter(isMeasuredTimingRead);
  if (measured.length === 0) {
    return "No current candles for any scanned market — timing not measured.";
  }
  const times = measured
    .map((r) => Date.parse(String(r["generatedAt"] ?? "")))
    .filter((t) => Number.isFinite(t));
  const age = times.length === measured.length ? ` · computed ${formatAge(nowMs - Math.min(...times))}` : " · computation time unknown";
  return `Timing from current candles for ${measured.length} of ${rows.length} markets${age}`;
}

function UnmeasuredLine({ rows }: { rows: TimingRow[] }) {
  const unmeasured = rows.filter((r) => !isMeasuredTimingRead(r)).map((r) => String(r["symbol"] ?? "")).filter(Boolean);
  if (unmeasured.length === 0) return null;
  return (
    <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-unmeasured">
      Not measured (no current candles): {unmeasured.join(", ")}
    </p>
  );
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

  const rows = asRows((q.data as { results?: unknown[] })?.results ?? []);
  const measuredCount = rows.filter(isMeasuredTimingRead).length;

  const best = rows.filter((row) => {
    if (!isMeasuredTimingRead(row)) return false;
    return PERMISSION_PASS.has(String(row["entryPermission"] ?? ""))
      && GRADE_GOOD.has(String(row["timingGrade"] ?? ""));
  }).slice(0, 3);

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
          {rows.length > 0 && measuredCount === 0 ? (
            <p className="text-sm text-txt-secondary">Timing not measured — no current candles.</p>
          ) : (
            <>
              <p className="text-sm text-txt-secondary">No A-grade setups right now.</p>
              <p className="text-xs text-txt-muted">Check back when session conditions improve.</p>
            </>
          )}
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
      <UnmeasuredLine rows={rows} />
      <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-footer">{timingFooter(rows)}</p>
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

  const rows = asRows((q.data as { results?: unknown[] })?.results ?? []);
  const measuredCount = rows.filter(isMeasuredTimingRead).length;

  const avoid = rows.filter((row) => {
    if (!isMeasuredTimingRead(row)) return false;
    return PERMISSION_BLOCK.has(String(row["entryPermission"] ?? ""))
      || GRADE_BAD.has(String(row["timingGrade"] ?? ""))
      || Number(row["dangerScore"] ?? 0) >= 65;
  }).slice(0, 3);

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
          {rows.length > 0 && measuredCount === 0 ? (
            <p className="text-sm text-txt-secondary">Timing not measured — no current candles.</p>
          ) : (
            <>
              <p className="text-sm text-txt-secondary">No major red flags right now.</p>
              <p className="text-xs text-txt-muted">Market conditions look manageable.</p>
            </>
          )}
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
      <UnmeasuredLine rows={rows} />
      <p className="mt-2 text-[10px] text-txt-muted" data-testid="timing-footer">{timingFooter(rows)}</p>
      <div className="mt-3">
        <ActionButton href="/market-heat-map" subtle icon={<TrendingDown className="h-4 w-4" />} data-testid="avoid-markets-heat">
          Heat Map
        </ActionButton>
      </div>
    </CockpitCard>
  );
}
