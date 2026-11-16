import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMeChartDecisionReceipts,
  useGetMeChartDecisionReceipt,
  usePostMeChartDecisionReceiptOutcome,
  usePostMeChartSimilarSetups,
  useGetMeChartBehaviorProtection,
  getGetMeChartDecisionReceiptQueryKey,
  ChartSimilarSetupsRequestTimeframe,
  type ChartDecisionReceiptView,
  type ChartDecisionOutcomeCreateRequestOutcome,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Loader2, ChevronDown, ChevronRight, Search, HeartPulse } from "lucide-react";

// ChartDecisionReceiptsPanel — Smart Chart "Decision receipts" side panel.
//
// Shows the trader's OWN recorded chart decisions (every official chart read
// writes an immutable receipt), lets them record what actually happened (an
// append-only OUTCOME — this is what feeds the Chart Brain benchmark's outcome
// scores and the similar-setups history), finds structurally similar past
// setups for the chart on screen, and surfaces the advisory behavior-protection
// signals computed from their own recent trading.
//
// HONESTY / SAFETY: read + append-only. Recording an outcome never places,
// modifies or closes a trade. Every figure shown is what the server returned;
// a failed request says it failed instead of showing an empty history.

const OUTCOME_CHOICES: { value: ChartDecisionOutcomeCreateRequestOutcome; label: string }[] = [
  { value: "WIN", label: "Win" },
  { value: "LOSS", label: "Loss" },
  { value: "BREAKEVEN", label: "Breakeven" },
  { value: "NO_TRADE_CORRECT", label: "Skipped — right call" },
  { value: "NO_TRADE_MISSED", label: "Skipped — missed move" },
  { value: "EXPIRED", label: "Expired" },
];

const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(
  OUTCOME_CHOICES.map((c) => [c.value, c.label]),
);

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "No outcome";
  return OUTCOME_LABEL[outcome] ?? (outcome === "UNKNOWN" ? "Unknown" : "Other");
}

function timeLabel(iso: string | null | undefined): string {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return "time unknown";
  const d = new Date(t);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi} UTC`;
}

function ReceiptRow({ receipt }: { receipt: ChartDecisionReceiptView }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const detail = useGetMeChartDecisionReceipt(receipt.receiptId, {
    query: {
      enabled: open,
      queryKey: getGetMeChartDecisionReceiptQueryKey(receipt.receiptId),
    },
  });
  const record = usePostMeChartDecisionReceiptOutcome({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetMeChartDecisionReceiptQueryKey(receipt.receiptId),
        });
      },
    },
  });
  const outcomes = (detail.data?.outcomes ?? []).filter((o) => o.kind === "OUTCOME");
  // Server returns outcomes newest first; pick the newest by time regardless.
  const latest =
    outcomes.length > 0
      ? outcomes.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
      : null;

  return (
    <li className="rounded border border-zinc-800/80 px-2 py-1" data-testid="chart-receipt-row">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="chart-receipt-toggle"
      >
        {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
        <span className="text-zinc-500">{timeLabel(receipt.createdAt)}</span>
        <span className="text-zinc-300">{receipt.timeframe}</span>
        {receipt.direction && <Badge variant="outline" className="h-4 px-1 text-[9px]">{receipt.direction}</Badge>}
        {receipt.qualityLabel && <span className="truncate text-zinc-400">{receipt.qualityLabel}</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          {receipt.marketSentence && <div className="text-zinc-400">{receipt.marketSentence}</div>}
          {detail.isLoading ? (
            <div className="text-zinc-500">Loading recorded outcome…</div>
          ) : detail.isError ? (
            <div className="text-amber-400/90" data-testid="chart-receipt-detail-error">
              Couldn't load this receipt's outcome right now.
            </div>
          ) : latest ? (
            <div className="text-zinc-300" data-testid="chart-receipt-outcome">
              Recorded: <span className="font-semibold">{outcomeLabel(latest.outcome)}</span>
              <span className="text-zinc-500"> · {timeLabel(latest.createdAt)}</span>
            </div>
          ) : (
            <div className="text-zinc-500" data-testid="chart-receipt-no-outcome">No outcome recorded yet.</div>
          )}
          {!detail.isLoading && !detail.isError && (
            <div className="flex flex-wrap gap-1" data-testid="chart-receipt-outcome-actions">
              {OUTCOME_CHOICES.map((c) => (
                <Button
                  key={c.value}
                  size="sm"
                  variant="outline"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={record.isPending}
                  onClick={() =>
                    record.mutate({
                      receiptId: receipt.receiptId,
                      data: { kind: "OUTCOME", outcome: c.value, plQuality: "UNKNOWN" },
                    })
                  }
                  data-testid={`chart-receipt-record-${c.value}`}
                >
                  {c.label}
                </Button>
              ))}
            </div>
          )}
          {record.isError && (
            <div className="text-rose-400" data-testid="chart-receipt-record-error">
              Couldn't record that outcome — nothing was saved.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const SIMILAR_TIMEFRAMES = new Set<string>(Object.values(ChartSimilarSetupsRequestTimeframe));

export function ChartDecisionReceiptsPanel({
  symbol,
  timeframe,
}: {
  /** Canonical chart symbol (no provider prefix), e.g. "EURUSD". */
  symbol: string;
  timeframe: string;
}) {
  const receipts = useGetMeChartDecisionReceipts(
    { symbol, limit: 8 },
    { query: { enabled: !!symbol, queryKey: ["/api/me/chart/decision-receipts", { symbol, limit: 8 }] } },
  );
  const behavior = useGetMeChartBehaviorProtection();
  const similar = usePostMeChartSimilarSetups();
  const similarTf = SIMILAR_TIMEFRAMES.has(timeframe) ? (timeframe as ChartSimilarSetupsRequestTimeframe) : null;
  const list = receipts.data?.receipts ?? [];
  const protection = behavior.data?.protection;

  return (
    <div
      className="rounded-md border border-sky-500/20 bg-sky-950/10 p-3 text-[11px] leading-snug"
      data-testid="chart-decision-receipts-panel"
    >
      <div className="flex items-center gap-2">
        <ClipboardList className="h-3.5 w-3.5 text-sky-400" />
        <span className="font-semibold text-sky-300">Decision receipts</span>
        <span className="text-zinc-500">{symbol}</span>
      </div>

      {protection?.applicable && protection.hasSignals && (
        <div className="mt-2 space-y-0.5" data-testid="chart-behavior-protection">
          <div className="flex items-center gap-1.5 text-amber-300/90">
            <HeartPulse className="h-3.5 w-3.5" />
            <span>{protection.summary}</span>
          </div>
          {protection.signals.map((s) => (
            <div key={s.key} className="pl-5 text-zinc-400">
              <span className="text-zinc-300">{s.title}</span> — {s.detail}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2">
        {receipts.isLoading ? (
          <div className="text-zinc-500">Loading your chart decisions…</div>
        ) : receipts.isError ? (
          <div className="text-amber-400/90" data-testid="chart-receipts-error">
            Couldn't load your decision receipts right now.
          </div>
        ) : list.length === 0 ? (
          <div className="text-zinc-500" data-testid="chart-receipts-empty">
            No decision receipts for {symbol} yet — each chart read records one.
          </div>
        ) : (
          <ul className="space-y-1" data-testid="chart-receipts-list">
            {list.map((r) => <ReceiptRow key={r.receiptId} receipt={r} />)}
          </ul>
        )}
      </div>

      <div className="mt-2 border-t border-zinc-800/80 pt-2">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={!symbol || !similarTf || similar.isPending}
            onClick={() => similarTf && similar.mutate({ data: { symbol, timeframe: similarTf } })}
            data-testid="chart-similar-setups-find"
          >
            {similar.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Search className="mr-1 h-3 w-3" />}
            Find similar past setups
          </Button>
          {!similarTf && <span className="text-zinc-500">Not available on {timeframe}.</span>}
        </div>
        {similar.isError && (
          <div className="mt-1 text-amber-400/90" data-testid="chart-similar-error">
            Couldn't look up similar setups right now.
          </div>
        )}
        {similar.data && (
          <div className="mt-1 space-y-0.5" data-testid="chart-similar-result">
            <div className="text-zinc-400">{similar.data.result.summary}</div>
            {similar.data.result.matches.map((m) => (
              <div key={m.receiptId} className="flex flex-wrap gap-x-2 text-zinc-400">
                <span className="text-zinc-500">{timeLabel(m.createdAt)}</span>
                <span>{m.timeframe}</span>
                {m.direction && <span>{m.direction}</span>}
                <span>{Math.round(m.similarity * 100)}% similar</span>
                <span className="text-zinc-300">{outcomeLabel(m.outcome)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ChartDecisionReceiptsPanel;
