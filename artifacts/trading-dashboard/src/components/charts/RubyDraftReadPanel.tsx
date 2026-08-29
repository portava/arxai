import { useState } from "react";
import {
  usePostMeAssistantDraftRead,
  RubyDraftReadRequestIntent,
  type RubyDraftReadRequestIntent as RubyDraftReadIntentValue,
  type RubyDraftReadRequestTimeframe,
} from "@workspace/api-client-react";
import { Sparkles, AlertCircle, ShieldCheck } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

// RubyDraftReadPanel — Chart Brain v2 (Task 4) read-only Ruby reader.
//
// Lets the user ask Ruby a small set of fixed questions about the CURRENT
// symbol/timeframe. Ruby is strictly read-only: the endpoint never places,
// modifies, or closes a trade and the response always carries the
// paper_only / readOnlyMode / allowOrderExecution=false envelope, which we
// surface so the user can see Ruby cannot act. Honest by construction — on a
// dirty/insufficient feed the read says so rather than inventing a setup.

const INTENTS: { key: RubyDraftReadIntentValue; label: string }[] = [
  { key: RubyDraftReadRequestIntent.analyze, label: "Analyze" },
  { key: RubyDraftReadRequestIntent["is-this-a-buy"], label: "Is this a buy?" },
  { key: RubyDraftReadRequestIntent["is-this-a-scalp"], label: "Scalp?" },
  { key: RubyDraftReadRequestIntent["why-not-now"], label: "Why not now?" },
  {
    key: RubyDraftReadRequestIntent["what-changes-my-mind"],
    label: "What changes my mind?",
  },
  {
    key: RubyDraftReadRequestIntent["what-invalidates"],
    label: "What invalidates?",
  },
  { key: RubyDraftReadRequestIntent["hold-or-close"], label: "Hold or close?" },
  {
    key: RubyDraftReadRequestIntent["agent-consensus"],
    label: "Agent consensus",
  },
];

export function RubyDraftReadPanel({
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe: RubyDraftReadRequestTimeframe;
}) {
  const { name } = useAssistantName();
  const [active, setActive] = useState<RubyDraftReadIntentValue | null>(null);
  const mut = usePostMeAssistantDraftRead();
  const trimmed = (symbol ?? "").trim();

  function ask(intent: RubyDraftReadIntentValue) {
    if (!trimmed) return;
    setActive(intent);
    mut.mutate({
      data: {
        symbol: trimmed,
        timeframe,
        intent,
      },
    });
  }

  const resp = mut.data;
  const read = resp?.draftRead;

  return (
    <div
      className="rounded-md border border-border bg-background/40 p-3 text-[11px] leading-snug"
      data-testid="ruby-draft-read-panel"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
        <span className="font-semibold text-foreground">Ask {name} (read-only)</span>
        <span className="ml-auto flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
          <ShieldCheck className="h-3 w-3" /> read-only
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {INTENTS.map((it) => (
          <button
            key={it.key}
            type="button"
            disabled={!trimmed || mut.isPending}
            onClick={() => ask(it.key)}
            className={`rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${
              active === it.key
                ? "border-fuchsia-500/60 bg-fuchsia-500/10 text-fuchsia-200"
                : "border-border bg-card/40 text-txt-secondary hover:border-border"
            }`}
            data-testid={`ruby-draft-intent-${it.key}`}
          >
            {it.label}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-1.5">
        {mut.isPending && (
          <div className="text-txt-muted">Reading the chart…</div>
        )}

        {mut.isError && (
          <div className="flex items-start gap-1 text-warning">
            <AlertCircle className="mt-0.5 h-3 w-3" />
            <span>{name} couldn't read this right now. Try again shortly.</span>
          </div>
        )}

        {read && !mut.isPending && (
          <>
            {read.dataQuality === "insufficient" && (
              <div
                className="flex items-start gap-1.5 rounded border border-warning/25 bg-warning/10 px-2 py-1.5 text-warning"
                data-testid="ruby-draft-feed-not-confirmed"
              >
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Feed not confirmed for {read.displaySymbol || trimmed} ·{" "}
                  {read.timeframe} — {name} has limited visibility, so treat this
                  read as low-confidence.
                </span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-txt-muted">
                {read.bias} · {read.confidenceLabel}
                {(read.signalStrength ?? read.confidenceScore) != null
                  ? ` · ${read.signalStrength ?? read.confidenceScore}/100`
                  : ""}
              </span>
            </div>

            <div className="rounded border border-border bg-card/40 px-2 py-1.5 text-foreground">
              {read.headline}
            </div>

            {read.points.map((p, i) => (
              <div
                key={`pt-${i}`}
                className="rounded border border-border bg-card/40 px-2 py-1.5 text-txt-secondary"
              >
                {p}
              </div>
            ))}

            {read.cautions.map((c, i) => (
              <div
                key={`ca-${i}`}
                className="rounded border border-warning/25 bg-warning/5 px-2 py-1.5 text-warning"
              >
                {c}
              </div>
            ))}

            {read.bestNextAction && (
              <div className="rounded border border-border bg-card/40 px-2 py-1.5">
                <span className="mr-1.5 text-[10px] uppercase tracking-wide text-txt-muted">
                  Best next action
                </span>
                <span className="text-txt-secondary">{read.bestNextAction}</span>
              </div>
            )}

            <p className="text-[10px] text-txt-muted">{read.disclaimer}</p>
          </>
        )}

        {!read && !mut.isPending && !mut.isError && (
          <div className="text-txt-muted">
            Pick a question above to get {name}'s read on {trimmed || "this symbol"}.
          </div>
        )}
      </div>
    </div>
  );
}

export default RubyDraftReadPanel;
