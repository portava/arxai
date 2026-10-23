import type {
  ChartIntelligenceResponse,
  ChartMarketSentenceTone,
} from "@workspace/api-client-react";
import { Activity, AlertTriangle } from "lucide-react";
import { feedConfidence } from "@/lib/feed-confidence";
import { toneClasses } from "@/lib/chart-sentence-tone";
import { useAssistantName } from "@/lib/assistant-name";

// ChartPulse — Chart Brain v2 (Task 3) compact at-a-glance state panel.
//
// A small, mobile-friendly grid that summarises the live Chart Intelligence
// State: feed status, regime, bias, active level, momentum, risk, readiness,
// best action, setup age — plus honest standby chips for the agent court and
// Ruby (those consumers land in a later task). EVERYTHING is generated from the
// state object; nothing is hardcoded and no verdict is invented. PURE DISPLAY —
// it never places, modifies, or closes a trade.

type ChartState = ChartIntelligenceResponse["state"];

interface PulseItem {
  label: string;
  value: string;
  tone: ChartMarketSentenceTone;
  testid: string;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const decimals = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return n.toFixed(decimals);
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function biasTone(b: string): ChartMarketSentenceTone {
  if (b === "bullish") return "bullish";
  if (b === "bearish") return "bearish";
  return "neutral";
}

function buildItems(state: ChartState): PulseItem[] {
  const mu = state.marketUnderstanding;
  const items: PulseItem[] = [];

  // Regime + direction.
  if (mu.trend.populated) {
    items.push({
      label: "Regime",
      value: `${titleCase(mu.trend.regime)} · ${titleCase(mu.trend.direction)}`,
      tone:
        mu.trend.direction === "bullish"
          ? "bullish"
          : mu.trend.direction === "bearish"
            ? "bearish"
            : "neutral",
      testid: "pulse-regime",
    });
  } else {
    items.push({
      label: "Regime",
      value: "No read",
      tone: "neutral",
      testid: "pulse-regime",
    });
  }

  // Bias (from the read-only decision summary).
  items.push({
    label: "Bias",
    value: state.decisionState.populated
      ? titleCase(state.decisionState.bias)
      : "Unknown",
    tone: state.decisionState.populated
      ? biasTone(state.decisionState.bias)
      : "neutral",
    testid: "pulse-bias",
  });

  // Active level — nearest support/resistance.
  const sup = mu.levels.nearestSupport;
  const res = mu.levels.nearestResistance;
  const sd = sup?.distancePct != null ? Math.abs(sup.distancePct) : Infinity;
  const rd = res?.distancePct != null ? Math.abs(res.distancePct) : Infinity;
  const nearest = sup && sd <= rd ? sup : (res ?? sup);
  items.push({
    label: "Active level",
    value: nearest
      ? `${nearest.kind === "support" ? "Sup" : "Res"} ${fmtPrice(nearest.price)}`
      : "None",
    tone: nearest ? "info" : "neutral",
    testid: "pulse-level",
  });

  // Momentum.
  const burst = state.fastFlags.momentumBurst;
  items.push({
    label: "Momentum",
    value: burst
      ? "Burst"
      : state.candleStats.direction === "flat"
        ? "Flat"
        : titleCase(state.candleStats.direction),
    tone: burst
      ? state.candleStats.direction === "down"
        ? "bearish"
        : "bullish"
      : "neutral",
    testid: "pulse-momentum",
  });

  // Risk — reuse the deterministic risk sentence tone.
  items.push({
    label: "Risk",
    value:
      state.marketSentences.risk.tone === "danger"
        ? "High"
        : state.marketSentences.risk.tone === "caution"
          ? "Elevated"
          : "Normal",
    tone: state.marketSentences.risk.tone,
    testid: "pulse-risk",
  });

  // Readiness (quality + actionability).
  const d = state.decisionState;
  items.push({
    label: "Readiness",
    value: d.populated
      ? `${d.quality} · ${titleCase(d.actionability)}`
      : "—",
    tone: d.vetoed
      ? "danger"
      : d.actionability === "ready"
        ? "bullish"
        : d.actionability === "prepare"
          ? "caution"
          : "neutral",
    testid: "pulse-readiness",
  });

  // Setup age.
  const setup = state.setupState;
  items.push({
    label: "Setup age",
    value:
      setup.populated && setup.ageBars != null
        ? `${setup.ageBars} bar${setup.ageBars === 1 ? "" : "s"} · ${titleCase(setup.stage)}`
        : "No setup",
    tone:
      setup.stage === "stale" || setup.stage === "invalid"
        ? "caution"
        : "neutral",
    testid: "pulse-setup-age",
  });

  return items;
}

export function ChartPulse({ state }: { state: ChartState | null }) {
  const { name } = useAssistantName();
  if (!state) {
    return (
      <div
        className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-500"
        data-testid="chart-pulse-empty"
      >
        Waiting for chart pulse…
      </div>
    );
  }

  const conf = feedConfidence(state.truthState);
  const dirty = state.stale || !state.aiUsable || conf.severity === "danger";
  const items = buildItems(state);
  const bestAction = state.marketSentences.bestNextAction;
  const baTone = toneClasses(bestAction.tone);

  return (
    <div
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3"
      data-testid="chart-pulse"
    >
      <div className="flex items-center gap-2 text-[11px]">
        <Activity className="h-3.5 w-3.5 text-primary" />
        <span className="font-semibold text-zinc-200">Chart Pulse</span>
        <span className="text-zinc-500">
          {state.displaySymbol} · {state.timeframe}
        </span>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
            conf.severity === "clean"
              ? "bg-emerald-500/10 text-emerald-400"
              : conf.severity === "caution"
                ? "bg-amber-500/10 text-amber-400"
                : conf.severity === "danger"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-zinc-800 text-zinc-400"
          }`}
          data-testid="pulse-feed"
        >
          {conf.statusLabel}
        </span>
      </div>

      {dirty && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300"
          data-testid="chart-pulse-dirty"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{conf.message} Read with caution — not for a live decision.</span>
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((it) => {
          const tc = toneClasses(it.tone);
          return (
            <div
              key={it.testid}
              className={`rounded border ${tc.border} ${tc.bg} px-2 py-1`}
              data-testid={it.testid}
            >
              <div className="text-[9px] uppercase tracking-wide text-zinc-500">
                {it.label}
              </div>
              <div className={`text-[11px] font-medium ${tc.text}`}>
                {it.value}
              </div>
            </div>
          );
        })}
      </div>

      {/* Best next action — the single headline call, straight from state. */}
      <div
        className={`mt-1.5 rounded border ${baTone.border} ${baTone.bg} px-2 py-1.5`}
        data-testid="pulse-best-action"
      >
        <div className="text-[9px] uppercase tracking-wide text-zinc-500">
          Best next action
        </div>
        <div className={`text-[11px] ${baTone.text}`}>{bestAction.text}</div>
      </div>

      {/* Honest standby chips: the agent court + Ruby consumers land in a later
          task, so we never fake a verdict here. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
        <span
          className="rounded border border-zinc-800 px-1.5 py-0.5"
          data-testid="pulse-agent-court"
        >
          Agent court: standby
        </span>
        <span
          className="rounded border border-zinc-800 px-1.5 py-0.5"
          data-testid="pulse-ruby"
        >
          {name}: read-only · on demand
        </span>
      </div>
    </div>
  );
}

export default ChartPulse;
