// T015 — owner/admin MANUAL live-testing status card.
//
// Read-only summary for the operator that makes the ongoing manual
// live-testing phase explicit and corrects the old "one trade spent"
// impression left by the single-shot T014 cycle. It shows:
//   - the active T015 phase (no per-trade limit),
//   - the current gate readiness (same dry-run the preflight uses),
//   - the unchanged $7 allocation envelope,
//   - the count of manual live trades placed in T015,
//   - completed T014 verification cycle(s) as history.
//
// Pure display: the backing GET endpoint never writes an arx_live_commands
// row. Hides itself entirely for non-admin sessions (403).

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CycleHistoryRow {
  cycleId: string;
  status: string;
  symbol: string;
  side: string;
  requestedVolume: number;
  createdAt: string | null;
}

interface T015Status {
  ok: boolean;
  phase: { tag: string; label: string; active: boolean; perTradeLimit: number | null; note: string };
  readiness: {
    decision: string;
    primaryReason: string | null;
    blockReasons: string[];
    bridgeKind: string;
    previewStopLoss: number;
  };
  allocation: {
    assignedAllocationUsd: number;
    reservedRiskUsd: number;
    availableAllocationUsd: number;
    bridgeAvailability: string;
    bridgeMessage: string;
  };
  manualLiveTradeCount: number;
  t014History: { note: string; cycles: CycleHistoryRow[] };
}

function fmtTs(t: string | null): string {
  if (!t) return "—";
  try { return new Date(t).toLocaleString(); } catch { return t; }
}

// Defensive currency formatter. The backing allocation figures come from a
// live balance source that can legitimately be null/absent (master account
// not yet synced, rate-limited, etc.). A raw `.toFixed()` on a null would
// throw during render and take the whole route into RouteErrorBoundary, so we
// coerce non-finite values to 0 here.
function fmtUsd(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(2)}`;
}

export function T015ManualLiveStatusCard() {
  const [data, setData] = useState<T015Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/admin/live-test-readiness/t015-status", {
          credentials: "same-origin",
        });
        if (r.status === 403) { if (!cancelled) setHidden(true); return; }
        if (!r.ok) { if (!cancelled) setErr(`HTTP ${r.status}`); return; }
        const j = await r.json() as T015Status;
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const tick = () => { if (!document.hidden) void load(); };
    const id = window.setInterval(tick, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (hidden) return null;

  const ready = data?.readiness?.decision === "PASS";
  const completedCycles = (data?.t014History?.cycles ?? []).filter(
    (c): c is CycleHistoryRow => !!c && typeof c === "object" && c.status === "COMPLETED",
  );

  return (
    <div className="container mx-auto px-3 md:px-6">
      <Card className="border-emerald-600/30 bg-emerald-950/10" data-testid="card-t015-status">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-emerald-300 flex items-center gap-2">
            Phase T015 — Manual Live Testing
            <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
              ACTIVE
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {err && <div className="text-red-400">Could not load T015 status: {err}</div>}
          {!data && !err && <div className="text-zinc-500">Loading…</div>}

          {data && (
            <>
              <div className="text-zinc-300" data-testid="t015-phase-note">
                {data.phase?.note ?? ""}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                <div>
                  <div className="text-zinc-500">Gate readiness</div>
                  <div
                    className={ready ? "font-semibold text-green-400" : "font-semibold text-amber-400"}
                    data-testid="t015-readiness"
                  >
                    {data.readiness?.decision ?? "—"}
                  </div>
                  {!ready && data.readiness?.primaryReason && (
                    <div className="text-[11px] text-amber-300/80">{data.readiness.primaryReason}</div>
                  )}
                </div>
                <div>
                  <div className="text-zinc-500">Allocation (available)</div>
                  <div className="font-semibold text-zinc-100" data-testid="t015-allocation">
                    {fmtUsd(data.allocation?.availableAllocationUsd)}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    of {fmtUsd(data.allocation?.assignedAllocationUsd)} assigned
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500">Manual live trades (T015)</div>
                  <div className="font-semibold text-zinc-100" data-testid="t015-trade-count">
                    {data.manualLiveTradeCount ?? 0}
                  </div>
                  <div className="text-[11px] text-zinc-500">no per-trade limit</div>
                </div>
                <div>
                  <div className="text-zinc-500">Bridge</div>
                  <div className="font-semibold text-zinc-100">
                    {data.allocation?.bridgeAvailability ?? "—"}
                  </div>
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-2">
                <div className="text-zinc-400 font-semibold">T014 verification cycle history</div>
                <div className="text-[11px] text-zinc-500">{data.t014History?.note ?? ""}</div>
                {completedCycles.length === 0 ? (
                  <div className="mt-1 text-zinc-500">No completed verification cycles yet.</div>
                ) : (
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                    {completedCycles.map((c) => (
                      <li key={c.cycleId} className="text-zinc-400">
                        <span className="text-emerald-400">COMPLETED</span>{" "}
                        {c.side} {c.symbol} {c.requestedVolume}{" · "}
                        <span className="text-zinc-500">{fmtTs(c.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default T015ManualLiveStatusCard;
