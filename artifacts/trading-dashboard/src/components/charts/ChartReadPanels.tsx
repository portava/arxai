import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import {
  ShieldAlert,
  Zap,
  LogIn,
  LogOut,
  Users,
  AlertTriangle,
} from "lucide-react";
import { toneClasses } from "@/lib/chart-sentence-tone";

// ChartReadPanels — Chart Brain v2 (Task 4) decision panels.
//
// Compact, mobile-friendly panels that READ the captured Chart Intelligence
// State (Risk, Scalp, Entry timing, Exit/TP) plus the advisory agent-consensus
// summary. PURE DISPLAY: no panel places, modifies, or closes a trade, and none
// invents data — every value comes straight from the state the chart already
// produced. When a layer is unpopulated the backend returns honest empty copy,
// which we surface verbatim.

type ChartState = ChartIntelligenceResponse["state"];

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return n.toFixed(d);
}

function PanelShell({
  icon: Icon,
  title,
  accent,
  badge,
  testid,
  children,
}: {
  icon: typeof ShieldAlert;
  title: string;
  accent: string;
  badge?: string | null;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md border border-border bg-background/40 p-3 text-[11px] leading-snug"
      data-testid={testid}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 ${accent}`} />
        <span className="font-semibold text-foreground">{title}</span>
        {badge && (
          <span className="ml-auto rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

function Line({
  label,
  children,
  tone,
}: {
  label?: string;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded border border-border bg-card/40 px-2 py-1.5">
      {label && (
        <span className="mr-1.5 text-[10px] uppercase tracking-wide text-txt-muted">
          {label}
        </span>
      )}
      <span className={tone ?? "text-txt-secondary"}>{children}</span>
    </div>
  );
}

function Waiting({ testid }: { testid: string }) {
  return (
    <div
      className="rounded-md border border-border bg-background/40 p-3 text-[11px] text-txt-muted"
      data-testid={testid}
    >
      Waiting for chart intelligence…
    </div>
  );
}

// ── Risk ──────────────────────────────────────────────────────────────────
export function ChartRiskPanel({ state }: { state: ChartState | null }) {
  if (!state) return <Waiting testid="chart-risk-empty" />;
  const risk = state.marketSentences.risk;
  const inval = state.marketSentences.whatInvalidates;
  const readiness = state.marketUnderstanding.readiness;
  const ds = state.decisionState;
  const rt = toneClasses(risk.tone);
  return (
    <PanelShell
      icon={ShieldAlert}
      title="Risk read"
      accent="text-danger"
      badge={ds.vetoed ? "veto active" : null}
      testid="chart-risk-panel"
    >
      <Line tone={rt.text}>{risk.text}</Line>
      <Line label="Readiness">
        {readiness.quality}
        {readiness.score != null ? ` · ${readiness.score}/100` : ""} ·{" "}
        {ds.actionability.replace("_", " ")}
      </Line>
      {ds.vetoed && readiness.vetoReason && (
        <Line label="Veto" tone="text-danger">
          {readiness.vetoReason}
        </Line>
      )}
      <Line label="Invalidates" tone="text-muted-foreground">
        {inval.text}
      </Line>
    </PanelShell>
  );
}

// ── Scalp ─────────────────────────────────────────────────────────────────
export function ChartScalpPanel({ state }: { state: ChartState | null }) {
  if (!state) return <Waiting testid="chart-scalp-empty" />;
  const scalp = state.marketSentences.scalp;
  const fresh = state.marketSentences.signalFreshness;
  const ff = state.fastFlags;
  const st = toneClasses(scalp.tone);
  return (
    <PanelShell
      icon={Zap}
      title="Scalp read"
      accent="text-warning"
      testid="chart-scalp-panel"
    >
      <Line tone={st.text}>{scalp.text}</Line>
      <Line label="Freshness" tone="text-muted-foreground">
        {fresh.text}
      </Line>
      <div className="flex flex-wrap gap-1">
        {ff.momentumBurst && (
          <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
            momentum burst
          </span>
        )}
        {ff.nearRecentHigh && (
          <span className="rounded bg-ruby/10 px-1.5 py-0.5 text-[10px] text-ruby">
            near recent high
          </span>
        )}
        {ff.nearRecentLow && (
          <span className="rounded bg-ruby/10 px-1.5 py-0.5 text-[10px] text-ruby">
            near recent low
          </span>
        )}
        {!ff.momentumBurst && !ff.nearRecentHigh && !ff.nearRecentLow && (
          <span className="text-[10px] text-txt-muted">
            no fast-flag triggers
          </span>
        )}
      </div>
    </PanelShell>
  );
}

// ── Entry timing ────────────────────────────────────────────────────────────
export function ChartEntryPanel({ state }: { state: ChartState | null }) {
  if (!state) return <Waiting testid="chart-entry-empty" />;
  const entry = state.marketSentences.entryTiming;
  const next = state.marketSentences.bestNextAction;
  const fork = state.decisionFork;
  const reasoning = state.decisionReasoning;
  const et = toneClasses(entry.tone);
  const triggers = fork.populated
    ? fork.branches.filter((b) => b.kind === "break" || b.kind === "hold")
    : [];
  return (
    <PanelShell
      icon={LogIn}
      title="Entry timing"
      accent="text-success"
      badge={fork.downgrade ? "downgraded" : null}
      testid="chart-entry-panel"
    >
      <Line tone={et.text}>{entry.text}</Line>
      <Line label="Next" tone="text-txt-secondary">
        {next.text}
      </Line>
      {triggers.map((b, i) => (
        <Line key={`trig-${i}`} label={b.kind} tone="text-txt-secondary">
          {b.text}
          {b.price != null ? ` (${fmt(b.price)})` : ""} ·{" "}
          <span className="text-txt-muted">{b.likelihood} likelihood</span>
        </Line>
      ))}
      {reasoning.populated &&
        reasoning.improve.slice(0, 2).map((c, i) => (
          <Line key={`imp-${i}`} label="Strengthens" tone="text-success">
            {c.text}
            {c.price != null ? ` (${fmt(c.price)})` : ""}
          </Line>
        ))}
    </PanelShell>
  );
}

// ── Exit / TP ───────────────────────────────────────────────────────────────
export function ChartExitPanel({ state }: { state: ChartState | null }) {
  if (!state) return <Waiting testid="chart-exit-empty" />;
  const inval = state.marketSentences.whatInvalidates;
  const reasoning = state.decisionReasoning;
  const fork = state.decisionFork;
  const levels = state.marketUnderstanding.levels;
  const it = toneClasses(inval.tone);
  return (
    <PanelShell
      icon={LogOut}
      title="Exit / targets"
      accent="text-ruby"
      testid="chart-exit-panel"
    >
      <Line label="Stop idea" tone={it.text}>
        {inval.text}
      </Line>
      {reasoning.populated &&
        reasoning.invalidate.slice(0, 2).map((c, i) => (
          <Line key={`inv-${i}`} label="Invalidates" tone="text-danger">
            {c.text}
            {c.price != null ? ` (${fmt(c.price)})` : ""}
          </Line>
        ))}
      {levels.nearestResistance && (
        <Line label="Resistance" tone="text-txt-secondary">
          {fmt(levels.nearestResistance.price)} ·{" "}
          <span className="text-txt-muted">
            {levels.nearestResistance.personality}
          </span>
        </Line>
      )}
      {levels.nearestSupport && (
        <Line label="Support" tone="text-txt-secondary">
          {fmt(levels.nearestSupport.price)} ·{" "}
          <span className="text-txt-muted">
            {levels.nearestSupport.personality}
          </span>
        </Line>
      )}
      {fork.populated &&
        fork.expectations.slice(0, 2).map((e, i) => (
          <Line
            key={`exp-${i}`}
            label={e.horizon === 1 ? "Next candle" : `Next ${e.horizon}`}
            tone="text-muted-foreground"
          >
            {e.text}
          </Line>
        ))}
    </PanelShell>
  );
}

// ── Agent consensus (advisory / shadow only) ────────────────────────────────
export function ChartAgentConsensusPanel({
  state,
}: {
  state: ChartState | null;
}) {
  if (!state) return <Waiting testid="chart-consensus-empty" />;
  const c = state.agentConsensus;
  if (!c.populated) {
    return (
      <PanelShell
        icon={Users}
        title="Agent consensus"
        accent="text-premium"
        badge="advisory"
        testid="chart-consensus-panel"
      >
        <Line tone="text-muted-foreground">{c.note}</Line>
      </PanelShell>
    );
  }
  return (
    <PanelShell
      icon={Users}
      title="Agent consensus"
      accent="text-premium"
      badge={c.conflict ? "conflict" : "advisory"}
      testid="chart-consensus-panel"
    >
      <Line tone="text-foreground">{c.headline}</Line>
      {c.detail && (
        <Line tone="text-muted-foreground" label="Why">
          {c.detail}
        </Line>
      )}
      {c.agents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {c.agents.map((a, i) => (
            <span
              key={`ag-${i}`}
              className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] text-txt-secondary"
            >
              {a.name}: {a.stance.toLowerCase()}
            </span>
          ))}
        </div>
      )}
      {c.protective && (
        <div className="flex items-center gap-1 text-[10px] text-warning">
          <AlertTriangle className="h-3 w-3" /> Governance lowered this read
          protectively.
        </div>
      )}
      {c.cautions.map((ct, i) => (
        <Line key={`ct-${i}`} tone="text-warning">
          {ct}
        </Line>
      ))}
      <p className="text-[10px] text-txt-muted">{c.note}</p>
    </PanelShell>
  );
}
