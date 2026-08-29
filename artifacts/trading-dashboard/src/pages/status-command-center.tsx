/**
 * ARX Status Command Center
 *
 * Aggregates: runtime context, readiness score (10 sections), setup checklist
 * (12 items), blocker cards (15 kinds), fix-first (App Doctor priorities),
 * guided setup wizard (11 steps). Read-only and diagnostic.
 *
 * INVARIANTS (also enforced by tests):
 *  - Live trading is never enabled or hinted as enable-able by this page.
 *  - No mutations to MT5/broker/risk routes; we only read public diag endpoints.
 *  - Even with a perfect score, "Live trading remains unavailable" stays visible.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useRuntimeContext } from "@/assistant/useRuntimeContext";
import { useTradingMode } from "@/hooks/useTradingMode";
import { diagnose, fixFirst, explainAppStatus } from "@/assistant/appDoctor";
import { buildSafeReportContext } from "@/assistant/runtimeContext";
import { buildSetupChecklist, checklistProgress } from "@/knowledge/setupChecklist";
import { computeReadinessScore } from "@/statusCommand/readinessScore";
import type { ReadinessSection, SectionLevel } from "@/statusCommand/readinessScore";
import { buildBlockerCards } from "@/statusCommand/blockerCards";
import type { BlockerCard } from "@/statusCommand/blockerCards";
import { buildSetupWizard } from "@/statusCommand/setupWizard";
import type { WizardStep } from "@/statusCommand/setupWizard";
import { resolveRoute } from "@/knowledge/routeKnowledge";
import type { AskContext } from "@/knowledge/answerEngine";
import type { RuntimeContext } from "@/assistant/runtimeContextTypes";

function levelToTone(level: SectionLevel | "blocker" | "attention" | "info"): {
  bg: string; border: string; text: string; chip: string; label: string; icon: string;
} {
  switch (level) {
    case "ready":
      return { bg: "bg-success/40", border: "border-success/40", text: "text-success", chip: "bg-success/15 text-success", label: "Ready", icon: "✓" };
    case "attention":
      return { bg: "bg-warning/40", border: "border-warning/40", text: "text-warning", chip: "bg-warning/15 text-warning", label: "Attention", icon: "!" };
    case "blocked":
    case "blocker":
      return { bg: "bg-danger/40", border: "border-danger/40", text: "text-danger", chip: "bg-danger/15 text-danger", label: "Blocked", icon: "■" };
    case "unavailable":
      return { bg: "bg-muted/60", border: "border-border", text: "text-txt-secondary", chip: "bg-secondary text-foreground", label: "Unavailable", icon: "·" };
    case "info":
    default:
      return { bg: "bg-primary/40", border: "border-primary/40", text: "text-primary", chip: "bg-primary/15 text-primary", label: "Info", icon: "i" };
  }
}

function toAskContext(ctx: RuntimeContext): AskContext {
  return {
    route: ctx.route,
    selectedSymbol: ctx.selectedSymbol ?? undefined,
    safetyStatuses: ctx.activeSafetyLocks,
    mt5Hint: ctx.mt5BridgeConnected ? "connected" : ctx.mt5Deferred ? "deferred" : "disconnected",
    tradingModeHint: ctx.paperOnly ? "paper" : ctx.simulatorMode ? "simulator" : ctx.tradingMode === "broker-readonly" ? "broker-readonly" : "unknown",
  } as AskContext;
}

export default function StatusCommandCenter() {
  const ctx = useRuntimeContext();
  const tradingMode = useTradingMode();
  const askCtx = useMemo(() => toAskContext(ctx), [ctx]);
  const checklist = useMemo(() => buildSetupChecklist(askCtx), [askCtx]);
  const progress = useMemo(() => checklistProgress(checklist), [checklist]);
  const score = useMemo(() => computeReadinessScore(ctx, checklist), [ctx, checklist]);
  const blockers = useMemo(() => buildBlockerCards(ctx, checklist), [ctx, checklist]);
  const wizard = useMemo(() => buildSetupWizard(ctx), [ctx]);
  const diagnoses = useMemo(() => diagnose(ctx), [ctx]);
  const ff = useMemo(() => fixFirst(ctx), [ctx]);
  const status = useMemo(() => explainAppStatus(ctx), [ctx]);
  const reportContext = useMemo(() => buildSafeReportContext(ctx, "status-command-center"), [ctx]);

  return (
    <div
      data-arx-id="status-command-center"
      data-testid="status-command-center"
      className="space-y-6 pb-24 md:pb-8"
    >
      <SummaryHeader
        score={score.total}
        mode={tradingMode.envelope ? tradingMode.cleanModeLabel : status.mode}
        progress={progress}
      />

      {tradingMode.isLoading || !tradingMode.envelope ? (
        <LiveModeLoadingBanner />
      ) : tradingMode.isLiveShared ? (
        <LiveSharedReadinessBanner
          cleanBlockedReason={tradingMode.cleanBlockedReason}
          cleanUserMessage={tradingMode.cleanUserMessage}
        />
      ) : (
        <LiveUnavailableBanner reason={score.liveUnavailableReason} />
      )}

      {/* Fix-first */}
      <FixFirstBlock primary={ff.primary} alternates={ff.alternates} />

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-4 space-y-4" data-testid="scc-left-col">
          <ReadinessScoreCard score={score} />
          <ChecklistCard items={checklist} progress={progress} />
        </section>

        <section className="lg:col-span-5 space-y-4" data-testid="scc-mid-col">
          <BlockersCard cards={blockers} />
          <RuntimeSummaryCard ctx={ctx} status={status} />
        </section>

        <section className="lg:col-span-3 space-y-4" data-testid="scc-right-col">
          <SafestNextCard primaryStep={status.safestNextStep} nextRoute={status.nextRoute} />
          <WizardCard steps={wizard} />
          <DiagnosticsCard diagnoses={diagnoses.length} reportContext={reportContext} />
        </section>
      </div>
    </div>
  );
}

function SummaryHeader({ score, mode, progress }: { score: number; mode: string; progress: { complete: number; total: number; percent: number } }) {
  return (
    <div
      className="sticky top-0 z-10 -mx-2 px-2 py-3 rounded-md bg-background/80 backdrop-blur border border-border"
      data-arx-id="scc-summary"
      data-testid="scc-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-foreground">ARX Status Command Center</h1>
          <p className="text-xs md:text-sm text-txt-secondary">Real app state — readiness, blockers, safest next step.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="px-2 py-1 rounded bg-primary/15 text-primary" data-arx-status={`MODE: ${mode}`}>MODE: {mode}</span>
          <span
            className="px-2 py-1 rounded bg-secondary text-foreground"
            data-testid="scc-readiness-total"
          >
            Readiness: {score} / 100
          </span>
          <span className="px-2 py-1 rounded bg-secondary text-foreground" data-testid="scc-checklist-progress">
            Checklist: {progress.complete}/{progress.total} ({progress.percent}%)
          </span>
        </div>
      </div>
    </div>
  );
}

function LiveUnavailableBanner({ reason }: { reason: string }) {
  // Shown only when the unified mode resolver does NOT report LIVE_SHARED.
  return (
    <div
      className="rounded-md border border-danger/40 bg-danger/40 text-danger px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE TRADING UNAVAILABLE"
      data-testid="scc-live-unavailable"
    >
      <div className="font-semibold">Live trading remains unavailable.</div>
      <div className="text-danger/90">{reason} A high readiness score does not unlock live trading — execution stays server-gated.</div>
    </div>
  );
}

function LiveModeLoadingBanner() {
  return (
    <div
      className="rounded-md border border-border bg-muted/60 text-txt-secondary px-4 py-3 text-sm"
      role="status"
      data-arx-status="MODE_LOADING"
      data-testid="scc-mode-loading"
    >
      <div className="font-semibold">Checking account mode…</div>
      <div className="text-txt-secondary">Status will update once the mode resolver responds.</div>
    </div>
  );
}

function LiveSharedReadinessBanner({
  cleanBlockedReason,
  cleanUserMessage,
}: { cleanBlockedReason: string | null; cleanUserMessage: string }) {
  const checksPassed = !cleanBlockedReason;
  return checksPassed ? (
    <div
      className="rounded-md border border-success/40 bg-success/30 text-success px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE_SHARED_PROFILE_DETECTED"
      data-testid="scc-live-shared-ready"
    >
      <div className="font-semibold">Live Shared profile detected. Readiness checks passed.</div>
      <div className="text-success/80">
        {cleanUserMessage} Execution remains server-gated — every order still goes through the
        full 16-gate evaluator and may still be blocked. This banner does not authorize live trading.
      </div>
    </div>
  ) : (
    <div
      className="rounded-md border border-warning/40 bg-warning/40 text-warning px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE_SHARED_PENDING"
      data-testid="scc-live-shared-pending"
    >
      <div className="font-semibold">Live Shared profile detected. A readiness item is still pending.</div>
      <div className="text-warning/90">
        {cleanUserMessage} Live execution stays server-gated until every gate passes.
      </div>
    </div>
  );
}

function FixFirstBlock({ primary, alternates }: { primary: ReturnType<typeof fixFirst>["primary"]; alternates: ReturnType<typeof fixFirst>["alternates"] }) {
  if (!primary) {
    return (
      <div className="rounded-md border border-success/40 bg-success/40 px-4 py-3 text-sm text-success" data-testid="scc-fix-first-empty">
        <div className="font-semibold">What to fix first</div>
        <div>No diagnoses to address right now. Stay in simulator/paper while server gates remain in place.</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-warning/40 bg-warning/40 p-4 text-sm" data-testid="scc-fix-first">
      <div className="text-warning font-semibold">What to fix first</div>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <div className="text-warning font-medium">{primary.explanation}</div>
          <ul className="mt-1 text-warning/90 list-disc pl-5 space-y-0.5">
            <li><span className="text-warning">Why it matters:</span> {primary.likelyCause}</li>
            <li><span className="text-warning">Safe next:</span> {primary.safeNextStep}</li>
            <li><span className="text-warning">Don't:</span> {primary.doNotDo}</li>
          </ul>
          {primary.relatedRoute && (
            <Link href={primary.relatedRoute}>
              <a className="inline-block mt-2 px-3 py-1.5 rounded bg-warning/15 hover:bg-warning/15 text-warning" data-testid="scc-fix-first-route">
                Open {resolveRoute(primary.relatedRoute)?.title ?? primary.relatedRoute}
              </a>
            </Link>
          )}
        </div>
        <div>
          <div className="text-warning text-xs uppercase">Then check</div>
          <ul className="mt-1 space-y-1 text-warning/90">
            {alternates.map((d) => <li key={d.id} data-testid={`scc-fix-first-alt-${d.id}`}>• {d.explanation}</li>)}
            {alternates.length === 0 && <li className="text-warning/70">No further issues.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ReadinessScoreCard({ score }: { score: ReturnType<typeof computeReadinessScore> }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-readiness-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Readiness Score</h2>
        <span className="text-sm text-txt-secondary">{score.total} / 100</span>
      </div>
      <ul className="mt-3 space-y-2">
        {score.sections.map((s) => <ScoreRow key={s.id} section={s} />)}
      </ul>
    </div>
  );
}

function ScoreRow({ section }: { section: ReadinessSection }) {
  const tone = levelToTone(section.level);
  return (
    <li
      className={`rounded border ${tone.border} ${tone.bg} p-2`}
      data-testid={`scc-readiness-section-${section.id}`}
      data-arx-id={`scc-readiness-${section.id}`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${tone.text}`}>{section.title}</span>
        <span className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone.chip}`} aria-label={tone.label}>{tone.icon} {tone.label}</span>
          <span className="text-xs text-txt-secondary">{section.score}/{section.max}</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-txt-secondary">{section.summary}</p>
    </li>
  );
}

function ChecklistCard({ items, progress }: { items: ReturnType<typeof buildSetupChecklist>; progress: { complete: number; total: number; percent: number } }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-checklist-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Setup Checklist</h2>
        <span className="text-xs text-txt-secondary">{progress.complete}/{progress.total}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((item) => {
          const tone = levelToTone(item.status === "complete" ? "ready" : item.status === "blocked" ? "blocked" : item.status === "unavailable" ? "unavailable" : "attention");
          return (
            <li key={item.id} className={`rounded border ${tone.border} ${tone.bg} p-2`} data-testid={`scc-checklist-${item.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm text-foreground">{item.title}</div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
              </div>
              <div className="mt-1 text-xs text-txt-secondary">{item.explanation}</div>
              <div className="mt-1 text-xs text-txt-secondary"><span className="text-txt-muted">Why:</span> {item.safeNextAction}</div>
              {item.blockerReason && <div className="text-xs text-danger">Blocker: {item.blockerReason}</div>}
              {item.related && (
                <Link href={item.related.route}>
                  <a className="inline-block mt-1 text-xs px-2 py-1 rounded bg-secondary hover:bg-muted text-foreground" data-testid={`scc-checklist-route-${item.id}`}>
                    Open {item.related.label}
                  </a>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BlockersCard({ cards }: { cards: BlockerCard[] }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-blockers-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Active Blockers</h2>
        <span className="text-xs text-txt-secondary">{cards.length}</span>
      </div>
      {cards.length === 0 ? (
        <p className="mt-3 text-sm text-success" data-testid="scc-blockers-empty">No active blockers right now.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {cards.map((b) => {
            const tone = levelToTone(b.severity);
            return (
              <li key={b.kind} className={`rounded border ${tone.border} ${tone.bg} p-3`} data-testid={`scc-blocker-${b.kind}`}>
                <div className="flex items-center justify-between">
                  <div className="font-medium text-foreground">{b.title}</div>
                  <span className="flex items-center gap-1 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
                    <span className="px-1.5 py-0.5 rounded bg-secondary text-foreground">{b.nature}</span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-txt-secondary"><span className="text-txt-muted">Blocks:</span> {b.blocks}</div>
                <div className="text-xs text-txt-secondary"><span className="text-txt-muted">Why:</span> {b.why}</div>
                <div className="text-xs text-txt-secondary"><span className="text-txt-muted">How to check:</span> {b.howToCheck}</div>
                <div className="text-xs text-success"><span className="text-txt-muted">Safe next:</span> {b.safeNextStep}</div>
                <div className="text-xs text-danger"><span className="text-txt-muted">Don't:</span> {b.doNotDo}</div>
                {b.relatedRoute && (
                  <Link href={b.relatedRoute.route}>
                    <a className="inline-block mt-2 text-xs px-2 py-1 rounded bg-secondary hover:bg-muted text-foreground" data-testid={`scc-blocker-route-${b.kind}`}>
                      {b.relatedRoute.label}
                    </a>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RuntimeSummaryCard({ ctx, status }: { ctx: RuntimeContext; status: ReturnType<typeof explainAppStatus> }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-runtime-card">
      <h2 className="font-semibold text-foreground">Runtime Status</h2>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-txt-secondary">
        <dt className="text-txt-muted">Mode</dt><dd>{status.mode}</dd>
        <dt className="text-txt-muted">Demo-only</dt><dd>{String(ctx.paperOnly)}</dd>
        <dt className="text-txt-muted">Simulator</dt><dd>{String(ctx.simulatorMode)}</dd>
        <dt className="text-txt-muted">Live trading disabled</dt><dd>{String(ctx.liveTradingDisabled)}</dd>
        <dt className="text-txt-muted">Broker exec disabled</dt><dd>{String(ctx.brokerExecutionDisabled)}</dd>
        <dt className="text-txt-muted">Bridge mode</dt><dd>{ctx.bridge?.bridgeMode ?? "unknown"}</dd>
        <dt className="text-txt-muted">Heartbeat</dt><dd>{ctx.heartbeatPresent ? `present (${ctx.heartbeatAgeSeconds ?? "?"}s)` : "absent"}</dd>
        <dt className="text-txt-muted">Broker read-only</dt><dd>{String(ctx.brokerReadOnly)}</dd>
        <dt className="text-txt-muted">Readiness</dt><dd>{ctx.readiness}</dd>
        <dt className="text-txt-muted">Emergency Stop</dt><dd>{ctx.emergencyStopActive ? "ENGAGED" : "off"}</dd>
        <dt className="text-txt-muted">Selected symbol</dt><dd>{ctx.selectedSymbol ?? "—"}</dd>
        <dt className="text-txt-muted">Route</dt><dd className="truncate">{ctx.route}</dd>
        <dt className="text-txt-muted">Recent failed APIs</dt><dd>{ctx.recentFailedEndpoints.length}</dd>
        <dt className="text-txt-muted">Recent errors</dt><dd>{ctx.recentErrors.length}</dd>
      </dl>
      <div className="mt-3 text-xs">
        <div className="text-txt-muted">Cannot do right now:</div>
        <ul className="list-disc pl-5 text-txt-secondary">{status.cannotDo.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
    </div>
  );
}

function SafestNextCard({ primaryStep, nextRoute }: { primaryStep: string; nextRoute?: string }) {
  return (
    <div className="rounded-md border border-success/40 bg-success/40 p-4" data-testid="scc-safest-next">
      <h2 className="font-semibold text-success">Safest next step</h2>
      <p className="mt-2 text-sm text-success/90">{primaryStep}</p>
      {nextRoute && (
        <Link href={nextRoute}>
          <a className="inline-block mt-2 text-sm px-3 py-1.5 rounded bg-success/15 hover:bg-success/15 text-success" data-testid="scc-safest-next-route">
            Open {resolveRoute(nextRoute)?.title ?? nextRoute}
          </a>
        </Link>
      )}
      <p className="mt-2 text-xs text-success/80">Live trading is never the next step.</p>
    </div>
  );
}

function WizardCard({ steps }: { steps: WizardStep[] }) {
  const [openId, setOpenId] = useState<string | null>(steps[0]?.id ?? null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-wizard">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Start Safe Setup</h2>
        <span className="text-xs text-txt-secondary">{acked.size}/{steps.length}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {steps.map((step, i) => {
          const tone = levelToTone(step.currentStatus === "complete" ? "ready" : step.currentStatus === "blocked" ? "blocked" : step.currentStatus === "info" ? "info" : "attention");
          const open = openId === step.id;
          const isAcked = acked.has(step.id);
          return (
            <li key={step.id} className={`rounded border ${tone.border} ${tone.bg}`} data-testid={`scc-wizard-step-${step.id}`}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : step.id)}
                className="w-full text-left px-3 py-2 flex items-center justify-between"
                aria-expanded={open}
                data-testid={`scc-wizard-toggle-${step.id}`}
              >
                <span className="text-sm text-foreground">{i + 1}. {step.title}</span>
                <span className="flex items-center gap-1 text-[10px]">
                  {isAcked && <span className="px-1.5 py-0.5 rounded bg-success/15 text-success">acknowledged</span>}
                  <span className={`px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
                </span>
              </button>
              {open && (
                <div className="px-3 pb-3 text-xs text-txt-secondary space-y-1">
                  <p>{step.shortExplanation}</p>
                  <p><span className="text-txt-muted">Status:</span> {step.statusText}</p>
                  <p><span className="text-txt-muted">Done when:</span> {step.completionCondition}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {step.pageRoute && (
                      <Link href={step.pageRoute}>
                        <a className="text-xs px-2 py-1 rounded bg-secondary hover:bg-muted" data-testid={`scc-wizard-route-${step.id}`}>
                          Open {step.pageLabel}
                        </a>
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setAcked((prev) => {
                          const next = new Set(prev);
                          if (next.has(step.id)) next.delete(step.id);
                          else next.add(step.id);
                          return next;
                        });
                      }}
                      className="text-xs px-2 py-1 rounded bg-success/15 hover:bg-success/15 text-success"
                      data-testid={`scc-wizard-ack-${step.id}`}
                    >
                      {isAcked ? "Unacknowledge" : "I understand"}
                    </button>
                    <a
                      href={`/help?ask=${encodeURIComponent(step.assistantQuestion)}`}
                      className="text-xs px-2 py-1 rounded bg-primary/15 hover:bg-primary/15 text-primary"
                      data-testid={`scc-wizard-ask-${step.id}`}
                    >
                      Ask ARX
                    </a>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-txt-muted">This wizard is read-only. It does not enable live trading or change broker/MT5/risk state.</p>
    </div>
  );
}

function DiagnosticsCard({ diagnoses, reportContext }: { diagnoses: number; reportContext: Record<string, unknown> }) {
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-md border border-border bg-background/40 p-4" data-testid="scc-diagnostics-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Diagnostics</h2>
        <span className="text-xs text-txt-secondary">{diagnoses} active</span>
      </div>
      <p className="mt-2 text-xs text-txt-secondary">
        The App Doctor returned {diagnoses} diagnosis{diagnoses === 1 ? "" : "es"}. Open the floating help widget for the full report,
        or attach this safe context when you submit feedback.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href="/feedback-center">
          <a className="text-xs px-2 py-1 rounded bg-secondary hover:bg-muted text-foreground" data-testid="scc-diagnostics-report">
            Open Feedback Center
          </a>
        </Link>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="text-xs px-2 py-1 rounded bg-secondary hover:bg-muted text-foreground"
          data-testid="scc-diagnostics-toggle"
        >
          {show ? "Hide" : "Show"} safe context
        </button>
      </div>
      {show && (
        <pre
          className="mt-2 p-2 text-[10px] overflow-auto rounded bg-background border border-border text-txt-secondary max-h-48"
          data-testid="scc-diagnostics-context"
        >
{JSON.stringify(reportContext, null, 2)}
        </pre>
      )}
    </div>
  );
}
