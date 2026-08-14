import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import {
  useGetMeTradeHealth,
  getGetMeTradeHealthQueryKey,
} from "@workspace/api-client-react";
import type {
  TradeHealthAssessment,
  TradeHealthAssessmentState,
} from "@workspace/api-client-react";

// Live Trade Health & Management (Task #198) — per-user, READ-ONLY post-entry
// health for the caller's own open positions. GUIDANCE ONLY: this panel never
// places, modifies, or closes a trade. Every number is broker-derived or an
// honest "unknown"; the endpoint returns an honest empty when there are no open
// positions (never fabricated). No internal enum tokens are shown — all copy is
// the server's already-humanised strings.

const STATE_LABEL: Record<TradeHealthAssessmentState, string> = {
  healthy: "Healthy",
  weakening: "Weakening",
  danger: "Danger",
  invalidated: "Invalidated",
};

function stateBadgeClass(state: TradeHealthAssessmentState): string {
  switch (state) {
    case "healthy":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "weakening":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "danger":
      return "bg-orange-500/15 text-orange-300 border-orange-500/30";
    case "invalidated":
      return "bg-red-500/15 text-red-300 border-red-500/30";
  }
}

function AssessmentCard({ a }: { a: TradeHealthAssessment }) {
  // Defensive complete-payload gate (Task #609): a truthy-but-partial assessment
  // row — any nested block (tpProgress / slDistance / breakEven / partialClose /
  // styleMatch) or list (reasons / alternatives) missing from a half-streamed or
  // older-cached response — must NOT throw the whole panel into the route error
  // boundary. Every nested hop below is read defensively so a half-formed row
  // degrades to its honest "—" / hidden state. Well-formed rows are unchanged.
  const tpProgress = a.tpProgress ?? null;
  const slDistance = a.slDistance ?? null;
  const breakEven = a.breakEven ?? null;
  const partialClose = a.partialClose ?? null;
  const styleMatch = a.styleMatch ?? null;
  const reasons = Array.isArray(a.reasons) ? a.reasons : [];
  const alternatives = Array.isArray(a.alternatives) ? a.alternatives : [];

  const tpPct =
    tpProgress?.known && tpProgress.progressPct != null
      ? Math.max(0, Math.min(100, tpProgress.progressPct))
      : null;

  return (
    <div
      className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 space-y-2"
      data-testid={`trade-health-card-${a.ticket}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-zinc-200 truncate">{a.symbol}</span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {a.side}
          </Badge>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {a.accountMode}
          </Badge>
        </div>
        <Badge
          variant="outline"
          className={`text-[10px] shrink-0 ${stateBadgeClass(a.state)}`}
        >
          {STATE_LABEL[a.state]}
        </Badge>
      </div>

      <p className="text-xs text-zinc-300">{a.headline}</p>

      {reasons.length > 0 && (
        <ul className="space-y-0.5">
          {reasons.map((r, i) => (
            <li key={i} className="text-[11px] text-zinc-500">
              • {r}
            </li>
          ))}
        </ul>
      )}

      {/* Take-profit progress — honest unknown when no TP is set. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <span>Target progress</span>
          <span>{tpPct != null ? `${Math.round(tpPct)}%` : "—"}</span>
        </div>
        {tpPct != null ? (
          <Progress value={tpPct} className="h-1.5" />
        ) : (
          <p className="text-[10px] text-zinc-600">{tpProgress?.note ?? "—"}</p>
        )}
      </div>

      {/* Stop-loss buffer — honest unknown when no SL is set. */}
      <p className="text-[11px] text-zinc-400">
        <span className="text-zinc-500">Stop buffer: </span>
        {slDistance?.known && slDistance.bufferRemainingPct != null
          ? `${Math.round(slDistance.bufferRemainingPct)}% remaining`
          : (slDistance?.note ?? "—")}
      </p>

      {(breakEven?.suggested || partialClose?.suggested) && (
        <div className="space-y-1">
          {breakEven?.suggested && (
            <p className="text-[11px] text-sky-300">{breakEven.note}</p>
          )}
          {partialClose?.suggested && (
            <p className="text-[11px] text-sky-300">{partialClose.note}</p>
          )}
        </div>
      )}

      {styleMatch?.note && (
        <p className="text-[11px] text-zinc-500">{styleMatch.note}</p>
      )}

      {alternatives.length > 0 && (
        <div className="space-y-0.5">
          {alternatives.map((alt, i) => (
            <p key={i} className="text-[10px] text-zinc-500">
              <span className="text-zinc-400">{alt.label}: </span>
              {alt.note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeHealthPanel({
  chartSymbol,
  compact = false,
}: {
  chartSymbol?: string | null;
  compact?: boolean;
}) {
  const params = useMemo(
    () => (chartSymbol ? { chartSymbol } : undefined),
    [chartSymbol],
  );
  const query = useGetMeTradeHealth(params, {
    query: {
      queryKey: getGetMeTradeHealthQueryKey(params),
      refetchInterval: 20_000,
    },
  });

  const data = query.data ?? null;
  // Defensive complete-payload gate (Task #609): a truthy-but-partial response
  // (a non-array list field, or an array carrying a null/non-object entry) must
  // not throw the panel into the route error boundary. Coerce every list to a
  // real array and drop null assessment rows before they reach AssessmentCard.
  const assessments = (
    Array.isArray(data?.assessments) ? data.assessments : []
  ).filter((a): a is TradeHealthAssessment => a != null);
  const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
  const correlations = Array.isArray(data?.correlations) ? data.correlations : [];
  const overtrading = Array.isArray(data?.overtrading) ? data.overtrading : [];

  // Symbol-split (Task #600). The server is the single source of truth for which
  // positions belong to the selected symbol (`matchesChartSymbol`, the same
  // normalization the symbolMatch handshake uses), so the panel never
  // re-derives symbol matching. The label comes from the SAME response as the
  // flags, so "This symbol" and the split can never disagree.
  const selectedSymbolLabel =
    (data?.chartSymbol ?? chartSymbol ?? "").trim() || null;
  const thisSymbolAssessments = assessments.filter((a) => a.matchesChartSymbol);
  const accountAssessments = assessments.filter((a) => !a.matchesChartSymbol);

  // Context-aware count copy. A bare "{n} open" hides whether those positions
  // are on the selected symbol or elsewhere; the badge now names the split using
  // the SAME server-derived `matchesChartSymbol` flag the sections below use, so
  // the header can never disagree with the this-symbol / account-wide split.
  const totalOpen = assessments.length;
  const thisCount = thisSymbolAssessments.length;
  const openBadgeLabel = !selectedSymbolLabel
    ? `${totalOpen} open`
    : thisCount === totalOpen
      ? `${thisCount} on ${selectedSymbolLabel}`
      : thisCount === 0
        ? `${totalOpen} open · none on ${selectedSymbolLabel}`
        : `${thisCount} on ${selectedSymbolLabel} · ${totalOpen} account-wide`;

  return (
    <Card data-testid="trade-health-panel">
      <CardHeader className={compact ? "pb-2" : ""}>
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-sky-400" />
          Trade Health
          {totalOpen > 0 && (
            <Badge variant="outline" className="text-[10px]" data-testid="trade-health-open-count">
              {openBadgeLabel}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {query.isLoading ? (
          <div className="flex items-center gap-2 text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking your open positions…
          </div>
        ) : query.isError ? (
          <p className="text-amber-400/80" data-testid="trade-health-error">
            Trade health is momentarily unavailable — your positions and trading
            are unaffected.
          </p>
        ) : assessments.length === 0 ? (
          <p className="text-zinc-500" data-testid="trade-health-empty">
            No open positions to monitor right now. Health guidance appears once
            you have a live or demo trade running.
          </p>
        ) : (
          <>
            {data?.summary && (
              <p className="text-zinc-300" data-testid="trade-health-summary">
                {data.summary}
              </p>
            )}

            {selectedSymbolLabel ? (
              <>
                {/* This symbol — only positions on the selected symbol. */}
                <div className="space-y-2" data-testid="trade-health-this-symbol">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                      This symbol
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {selectedSymbolLabel}
                    </Badge>
                  </div>
                  {thisSymbolAssessments.length > 0 ? (
                    <div className="space-y-2">
                      {thisSymbolAssessments.map((a) => (
                        <AssessmentCard key={a.ticket} a={a} />
                      ))}
                    </div>
                  ) : (
                    <p
                      className="text-zinc-500"
                      data-testid="trade-health-this-symbol-empty"
                    >
                      No open positions on {selectedSymbolLabel}.
                    </p>
                  )}
                </div>

                {/* Account exposure — positions on OTHER symbols, explicitly
                    labeled account-wide so they never read as this-symbol health. */}
                {accountAssessments.length > 0 && (
                  <>
                    <Separator className="bg-zinc-800" />
                    <div
                      className="space-y-2"
                      data-testid="trade-health-account-exposure"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                          Account exposure
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {accountAssessments.length} on other symbol
                          {accountAssessments.length === 1 ? "" : "s"}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-zinc-500">
                        Open positions elsewhere in your account — not on{" "}
                        {selectedSymbolLabel}.
                      </p>
                      <div className="space-y-2">
                        {accountAssessments.map((a) => (
                          <AssessmentCard key={a.ticket} a={a} />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              /* No selected symbol — render all open positions plainly. */
              <div className="space-y-2">
                {assessments.map((a) => (
                  <AssessmentCard key={a.ticket} a={a} />
                ))}
              </div>
            )}

            {(conflicts.length > 0 ||
              correlations.length > 0 ||
              overtrading.length > 0) && (
              <>
                <Separator className="bg-zinc-800" />
                <div className="space-y-1.5">
                  {conflicts.map((c, i) => (
                    <div
                      key={`cf-${i}`}
                      className="flex items-start gap-2 text-[11px] text-amber-300"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{c.note}</span>
                    </div>
                  ))}
                  {correlations.map((c, i) => (
                    <div
                      key={`co-${i}`}
                      className="flex items-start gap-2 text-[11px] text-amber-300"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{c.note}</span>
                    </div>
                  ))}
                  {overtrading.map((o, i) => (
                    <div
                      key={`ot-${i}`}
                      className="flex items-start gap-2 text-[11px] text-amber-300"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{o.note}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <p className="text-[10px] text-zinc-600">
              Guidance only — ARX never opens, closes, or changes a trade for
              you.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
