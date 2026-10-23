import type {
  ChartIntelligenceResponse,
  ChartMarketSentence,
} from "@workspace/api-client-react";
import { MessageSquareText } from "lucide-react";
import { toneClasses } from "@/lib/chart-sentence-tone";

// ChartSentencesPanel — Chart Brain v2 (Task 3) natural-language reader.
//
// Renders the deterministic plain-language sentences produced by the backend
// Market Sentence Engine. PURE DISPLAY: it never places, modifies, or closes a
// trade and never invents text — every sentence comes straight from
// `state.marketSentences`. When the engines are not populated the backend
// already returns honest "not enough data" sentences, which we show verbatim.

type ChartState = ChartIntelligenceResponse["state"];

// Display order for the ten sentence outputs.
const ORDER: Array<keyof ChartState["marketSentences"]> = [
  "market",
  "proving",
  "failedToProve",
  "entryTiming",
  "bestNextAction",
  "scalp",
  "risk",
  "whatWouldChange",
  "whatInvalidates",
  "signalFreshness",
];

function isSentence(v: unknown): v is ChartMarketSentence {
  return (
    typeof v === "object" &&
    v != null &&
    "text" in v &&
    "tone" in v &&
    "label" in v
  );
}

export function ChartSentencesPanel({
  state,
}: {
  state: ChartState | null;
}) {
  if (!state) {
    return (
      <div
        className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-500"
        data-testid="chart-sentences-empty"
      >
        Waiting for chart intelligence…
      </div>
    );
  }

  const sentences = state.marketSentences;

  return (
    <div
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] leading-snug"
      data-testid="chart-sentences-panel"
    >
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-3.5 w-3.5 text-sky-400" />
        <span className="font-semibold text-zinc-200">What the chart is saying</span>
        {!sentences.populated && (
          <span className="ml-auto rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
            limited data
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1.5">
        {ORDER.map((k) => {
          const s = sentences[k];
          if (!isSentence(s)) return null;
          const tc = toneClasses(s.tone);
          return (
            <div
              key={s.key}
              className={`rounded border ${tc.border} ${tc.bg} px-2 py-1.5`}
              data-testid={`chart-sentence-${s.key}`}
            >
              <div className="flex items-baseline gap-1.5">
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                  {s.label}
                </span>
              </div>
              <div className={`mt-0.5 ${tc.text}`}>{s.text}</div>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[10px] text-zinc-600">{sentences.note}</p>
    </div>
  );
}

export default ChartSentencesPanel;
