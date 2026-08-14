import { Sparkles } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";
import type {
  RubyReasoningBlockData,
  RubyReasoningEvidence,
} from "@/lib/rubyReasoningBlock";

// RubyReasoningBlock — the ONE standardized, ALWAYS-VISIBLE reasoning block shown
// on every Ruby decision surface. No collapse, no accordion, no "expand to see
// why": a trader sees Ruby's full reasoning immediately.
//
// DISPLAY ONLY. Rendering this block grants no execution permission and changes no
// safety gate. It renders exactly the (already honesty-gated) data its builder
// produced — it never fabricates direction, levels, or confidence.
//
// `dense` only tightens spacing/typography for narrow scanner cards; ALL labels
// always render in every variant.

const EVIDENCE_ORDER: ReadonlyArray<[keyof RubyReasoningEvidence, string]> = [
  ["structure", "Structure"],
  ["momentum", "Momentum"],
  ["pattern", "Pattern"],
  ["trendline", "Trendline"],
  ["supportResistance", "Support/Resistance"],
  ["feedData", "Feed/Data"],
  ["risk", "Risk"],
];

export function RubyReasoningBlock({
  data,
  dense = false,
  testid = "ruby-reasoning-block",
  title,
}: {
  data: RubyReasoningBlockData;
  dense?: boolean;
  testid?: string;
  title?: string;
}) {
  const { name } = useAssistantName();
  const resolvedTitle = title ?? `${name}'s Reasoning`;
  const text = dense ? "text-[11px]" : "text-xs";
  const labelCls =
    "shrink-0 font-semibold uppercase tracking-wide text-txt-muted";
  const labelW = dense ? "w-[78px]" : "w-[92px]";

  return (
    <div
      data-testid={testid}
      className={`rounded-xl border border-ruby/25 bg-background/40 ${dense ? "p-2.5" : "p-3"} ${text} leading-snug space-y-1.5`}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ruby">
        <Sparkles className={dense ? "h-3 w-3" : "h-3.5 w-3.5"} />
        {resolvedTitle}
      </div>

      <Line
        label="Decision"
        value={data.decision}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-decision`}
        strong
      />
      <Line
        label="Why"
        value={data.why}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-why`}
      />

      <div data-testid={`${testid}-evidence`}>
        <div className={`${labelCls} mb-0.5`}>Evidence</div>
        <div className="space-y-0.5 pl-2">
          {EVIDENCE_ORDER.map(([key, label]) => (
            <div key={key} className="flex gap-1.5">
              <span className="shrink-0 text-txt-muted">{label}:</span>
              <span
                className="text-txt-secondary"
                data-testid={`${testid}-evidence-${key}`}
              >
                {data.evidence[key]}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Line
        label="Confirmation"
        value={data.confirmation}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-confirmation`}
      />
      <Line
        label="Invalidation"
        value={data.invalidation}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-invalidation`}
      />
      <Line
        label="Trader Test"
        value={data.traderTest}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-trader-test`}
      />
      <Line
        label="Risk Note"
        value={data.riskNote}
        labelCls={labelCls}
        labelW={labelW}
        testid={`${testid}-risk-note`}
      />
    </div>
  );
}

function Line({
  label,
  value,
  labelCls,
  labelW,
  testid,
  strong = false,
}: {
  label: string;
  value: string;
  labelCls: string;
  labelW: string;
  testid?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex gap-1.5">
      <span className={`${labelCls} ${labelW}`}>{label}</span>
      <span
        className={strong ? "font-semibold text-foreground" : "text-txt-secondary"}
        data-testid={testid}
      >
        {value}
      </span>
    </div>
  );
}

export default RubyReasoningBlock;
