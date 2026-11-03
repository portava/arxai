import type {
  ChartIntelligenceResponse,
  ChartMarketSentenceTone,
} from "@workspace/api-client-react";
import { Activity, AlertTriangle } from "lucide-react";
import { feedConfidence } from "@/lib/feed-confidence";
import { toneClasses } from "@/lib/chart-sentence-tone";
import { useAssistantName } from "@/lib/assistant-name";
import { formatInstrumentPrice } from "@/lib/instrumentPriceFormat";
import { useStatePricePrecision } from "./chartPricePrecisionStore";
import { chartReadVerification } from "./chartReadVerification";

// ChartPulse — Chart Brain v2 (Task 3) compact at-a-glance state panel.
//
// A small, mobile-friendly grid that summarises the live Chart Intelligence
// State: feed status, regime, bias, active level, last bar, risk, readiness,
// best action, setup age — plus the agent-court chip (from the state's agent
// consensus, withheld on an unverified read) and the Ruby chip. EVERYTHING is generated from the
// state object; nothing is hardcoded and no verdict is invented. PURE DISPLAY —
// it never places, modifies, or closes a trade.
//
// FEED BASIS: the feed chip grades `state.truthState`, which the server builds
// from CLOSED bars only (the forming tip is excluded). The chart header chip
// grades the display feed (closed bars + live forming tip), so the chip says
// "Closed bars · …" to make the different basis explicit.

type ChartState = ChartIntelligenceResponse["state"];

interface PulseItem {
  label: string;
  value: string;
  tone: ChartMarketSentenceTone;
  testid: string;
  /** Hover text saying exactly what the tile measures. */
  title?: string;
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

// Prices print at the precision the chart resolved for this symbol (shared
// rule, lib/instrumentPriceFormat), so a level never disagrees with the axis.
function buildItems(
  state: ChartState,
  pricePrecision: number | null,
  verified: boolean,
): PulseItem[] {
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
      ? `${nearest.kind === "support" ? "Sup" : "Res"} ${formatInstrumentPrice(nearest.price, pricePrecision)}`
      : "None",
    tone: nearest ? "info" : "neutral",
    testid: "pulse-level",
  });

  // Last closed bar. candleStats.direction is ONE close compared with the
  // previous close — not momentum — so the tile says exactly that. A momentum
  // burst (wide-range bar) is coloured by the burst bar's OWN body, never by
  // the close-to-close direction (a wide bearish bar can still close above the
  // prior close).
  const flags = state.fastFlags;
  const burst = flags.populated && flags.momentumBurst;
  const closeVsPrior =
    state.candleStats.direction === "unknown"
      ? "No prior close"
      : `${titleCase(state.candleStats.direction)} vs prior close`;
  const bar = state.latestClosedCandle;
  const barTone: ChartMarketSentenceTone =
    bar && bar.close > bar.open ? "bullish" : bar && bar.close < bar.open ? "bearish" : "neutral";
  const barBody =
    barTone === "bullish" ? "bullish" : barTone === "bearish" ? "bearish" : "no clear body";
  items.push({
    label: "Last bar",
    value: burst ? `Wide-range bar · ${barBody}` : closeVsPrior,
    tone: burst ? barTone : "neutral",
    testid: "pulse-momentum",
    title: !flags.populated
      ? "Last closed bar's close compared with the previous close. Not enough closed bars to check for a wide-range (burst) bar."
      : burst
        ? `The last closed bar's range is well above the recent average; coloured by that bar's own body (${barBody}). ${closeVsPrior}.`
        : "Last closed bar's close compared with the previous close — one bar, not a momentum measure.",
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

  // Readiness (quality + actionability). An unverified read is at most
  // "watch" (the server caps it too; an uncapped "ready"/"prepare" from an
  // older server is downgraded here, never the other way round).
  const d = state.decisionState;
  const actionability =
    !verified && (d.actionability === "ready" || d.actionability === "prepare")
      ? "watch"
      : d.actionability;
  items.push({
    label: "Readiness",
    value: d.populated
      ? `${d.quality} · ${titleCase(actionability)}`
      : "—",
    tone: d.vetoed
      ? "danger"
      : !verified && d.populated
        ? "caution"
        : actionability === "ready"
          ? "bullish"
          : actionability === "prepare"
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

function agentCourtChip(state: ChartState, verified: boolean): { text: string; title: string } {
  const c = (state as { agentConsensus?: ChartState["agentConsensus"] | null }).agentConsensus ?? null;
  if (!c) return { text: "Agent court: could not be loaded", title: "The agent consensus was not returned with this read." };
  if (!c.populated) return { text: "Agent court: no read", title: c.note };
  if (!verified) {
    return {
      text: "Agent court: withheld (read not verified)",
      title: "Chart data not verified — agent consensus withheld.",
    };
  }
  return {
    text: `Agent court: ${c.stance}${c.conflict ? " · conflict" : ""} (advisory)`,
    title: c.note,
  };
}

export function ChartPulse({ state }: { state: ChartState | null }) {
  const pricePrecision = useStatePricePrecision(state);
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
  const verification = chartReadVerification(state);
  const items = buildItems(state, pricePrecision, verification.verified);
  const court = agentCourtChip(state, verification.verified);
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
          data-basis="closed-bars"
          title="Server grade of the closed bars this Chart Intelligence read was built from (the live forming bar is excluded). The chart header grades the display feed, including the forming bar, so the two can differ."
        >
          Closed bars · {conf.statusLabel}
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

      {!dirty && !verification.verified && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-300"
          data-testid="chart-pulse-unverified"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Read not verified — {verification.reasons.join("; ")}. Readiness and
            best action are watch-only until the chart verifies.
          </span>
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
              title={it.title}
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

      {/* Agent court chip — read from state.agentConsensus, never hard-coded.
          An unverified read withholds the stance, exactly as Ruby and the
          consensus panel do. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
        <span
          className="rounded border border-zinc-800 px-1.5 py-0.5"
          data-testid="pulse-agent-court"
          title={court.title}
        >
          {court.text}
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
