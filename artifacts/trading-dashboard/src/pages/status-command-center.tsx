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
      return { bg: "bg-emerald-950/40", border: "border-emerald-700", text: "text-emerald-200", chip: "bg-emerald-900 text-emerald-100", label: "Ready", icon: "✓" };
    case "attention":
      return { bg: "bg-amber-950/40", border: "border-amber-700", text: "text-amber-200", chip: "bg-amber-900 text-amber-100", label: "Attention", icon: "!" };
    case "blocked":
    case "blocker":
      return { bg: "bg-rose-950/40", border: "border-rose-700", text: "text-rose-200", chip: "bg-rose-900 text-rose-100", label: "Blocked", icon: "■" };
    case "unavailable":
      return { bg: "bg-zinc-900/60", border: "border-zinc-700", text: "text-zinc-300", chip: "bg-zinc-800 text-zinc-200", label: "Unavailable", icon: "·" };
    case "info":
    default:
      return { bg: "bg-indigo-950/40", border: "border-indigo-700", text: "text-indigo-200", chip: "bg-indigo-900 text-indigo-100", label: "Info", icon: "i" };
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
      className="sticky top-0 z-10 -mx-2 px-2 py-3 rounded-md bg-zinc-950/80 backdrop-blur border border-zinc-800"
      data-arx-id="scc-summary"
      data-testid="scc-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-zinc-100">ARX Status Command Center</h1>
          <p className="text-xs md:text-sm text-zinc-400">Real app state — readiness, blockers, safest next step.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="px-2 py-1 rounded bg-indigo-900 text-indigo-100" data-arx-status={`MODE: ${mode}`}>MODE: {mode}</span>
          <span
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-100"
            data-testid="scc-readiness-total"
          >
            Readiness: {score} / 100
          </span>
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-100" data-testid="scc-checklist-progress">
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
      className="rounded-md border border-rose-700 bg-rose-950/40 text-rose-100 px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE TRADING UNAVAILABLE"
      data-testid="scc-live-unavailable"
    >
      <div className="font-semibold">Live trading remains unavailable.</div>
      <div className="text-rose-200/90">{reason} A high readiness score does not unlock live trading — execution stays server-gated.</div>
    </div>
  );
}

function LiveModeLoadingBanner() {
  return (
    <div
      className="rounded-md border border-zinc-700 bg-zinc-900/60 text-zinc-300 px-4 py-3 text-sm"
      role="status"
      data-arx-status="MODE_LOADING"
      data-testid="scc-mode-loading"
    >
      <div className="font-semibold">Checking account mode…</div>
      <div className="text-zinc-400">Status will update once the mode resolver responds.</div>
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
      className="rounded-md border border-emerald-800 bg-emerald-950/30 text-emerald-100 px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE_SHARED_PROFILE_DETECTED"
      data-testid="scc-live-shared-ready"
    >
      <div className="font-semibold">Live Shared profile detected. Readiness checks passed.</div>
      <div className="text-emerald-200/80">
        {cleanUserMessage} Execution remains server-gated — every order still goes through the
        full 16-gate evaluator and may still be blocked. This banner does not authorize live trading.
      </div>
    </div>
  ) : (
    <div
      className="rounded-md border border-amber-700 bg-amber-950/40 text-amber-100 px-4 py-3 text-sm"
      role="status"
      data-arx-status="LIVE_SHARED_PENDING"
      data-testid="scc-live-shared-pending"
    >
      <div className="font-semibold">Live Shared profile detected. A readiness item is still pending.</div>
      <div className="text-amber-200/90">
        {cleanUserMessage} Live execution stays server-gated until every gate passes.
      </div>
    </div>
  );
}

function FixFirstBlock({ primary, alternates }: { primary: ReturnType<typeof fixFirst>["primary"]; alternates: ReturnType<typeof fixFirst>["alternates"] }) {
  if (!primary) {
    return (
      <div className="rounded-md border border-emerald-700 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-100" data-testid="scc-fix-first-empty">
        <div className="font-semibold">What to fix first</div>
        <div>No diagnoses to address right now. Stay in simulator/paper while server gates remain in place.</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-amber-700 bg-amber-950/40 p-4 text-sm" data-testid="scc-fix-first">
      <div className="text-amber-100 font-semibold">What to fix first</div>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <div className="text-amber-50 font-medium">{primary.explanation}</div>
          <ul className="mt-1 text-amber-200/90 list-disc pl-5 space-y-0.5">
            <li><span className="text-amber-300">Why it matters:</span> {primary.likelyCause}</li>
            <li><span className="text-amber-300">Safe next:</span> {primary.safeNextStep}</li>
            <li><span className="text-amber-300">Don't:</span> {primary.doNotDo}</li>
          </ul>
          {primary.relatedRoute && (
            <Link href={primary.relatedRoute}>
              <a className="inline-block mt-2 px-3 py-1.5 rounded bg-amber-800 hover:bg-amber-700 text-amber-50" data-testid="scc-fix-first-route">
                Open {resolveRoute(primary.relatedRoute)?.title ?? primary.relatedRoute}
              </a>
            </Link>
          )}
        </div>
        <div>
          <div className="text-amber-300 text-xs uppercase">Then check</div>
          <ul className="mt-1 space-y-1 text-amber-200/90">
            {alternates.map((d) => <li key={d.id} data-testid={`scc-fix-first-alt-${d.id}`}>• {d.explanation}</li>)}
            {alternates.length === 0 && <li className="text-amber-300/70">No further issues.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ReadinessScoreCard({ score }: { score: ReturnType<typeof computeReadinessScore> }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-readiness-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-zinc-100">Readiness Score</h2>
        <span className="text-sm text-zinc-300">{score.total} / 100</span>
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
          <span className="text-xs text-zinc-300">{section.score}/{section.max}</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">{section.summary}</p>
    </li>
  );
}

function ChecklistCard({ items, progress }: { items: ReturnType<typeof buildSetupChecklist>; progress: { complete: number; total: number; percent: number } }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-checklist-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-zinc-100">Setup Checklist</h2>
        <span className="text-xs text-zinc-400">{progress.complete}/{progress.total}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((item) => {
          const tone = levelToTone(item.status === "complete" ? "ready" : item.status === "blocked" ? "blocked" : item.status === "unavailable" ? "unavailable" : "attention");
          return (
            <li key={item.id} className={`rounded border ${tone.border} ${tone.bg} p-2`} data-testid={`scc-checklist-${item.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm text-zinc-100">{item.title}</div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-400">{item.explanation}</div>
              <div className="mt-1 text-xs text-zinc-300"><span className="text-zinc-500">Why:</span> {item.safeNextAction}</div>
              {item.blockerReason && <div className="text-xs text-rose-300">Blocker: {item.blockerReason}</div>}
              {item.related && (
                <Link href={item.related.route}>
                  <a className="inline-block mt-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100" data-testid={`scc-checklist-route-${item.id}`}>
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
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-blockers-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-zinc-100">Active Blockers</h2>
        <span className="text-xs text-zinc-400">{cards.length}</span>
      </div>
      {cards.length === 0 ? (
        <p className="mt-3 text-sm text-emerald-200" data-testid="scc-blockers-empty">No active blockers right now.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {cards.map((b) => {
            const tone = levelToTone(b.severity);
            return (
              <li key={b.kind} className={`rounded border ${tone.border} ${tone.bg} p-3`} data-testid={`scc-blocker-${b.kind}`}>
                <div className="flex items-center justify-between">
                  <div className="font-medium text-zinc-100">{b.title}</div>
                  <span className="flex items-center gap-1 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">{b.nature}</span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-300"><span className="text-zinc-500">Blocks:</span> {b.blocks}</div>
                <div className="text-xs text-zinc-300"><span className="text-zinc-500">Why:</span> {b.why}</div>
                <div className="text-xs text-zinc-300"><span className="text-zinc-500">How to check:</span> {b.howToCheck}</div>
                <div className="text-xs text-emerald-300"><span className="text-zinc-500">Safe next:</span> {b.safeNextStep}</div>
                <div className="text-xs text-rose-300"><span className="text-zinc-500">Don't:</span> {b.doNotDo}</div>
                {b.relatedRoute && (
                  <Link href={b.relatedRoute.route}>
                    <a className="inline-block mt-2 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100" data-testid={`scc-blocker-route-${b.kind}`}>
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
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-runtime-card">
      <h2 className="font-semibold text-zinc-100">Runtime Status</h2>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-300">
        <dt className="text-zinc-500">Mode</dt><dd>{status.mode}</dd>
        <dt className="text-zinc-500">Demo-only</dt><dd>{String(ctx.paperOnly)}</dd>
        <dt className="text-zinc-500">Simulator</dt><dd>{String(ctx.simulatorMode)}</dd>
        <dt className="text-zinc-500">Live trading disabled</dt><dd>{String(ctx.liveTradingDisabled)}</dd>
        <dt className="text-zinc-500">Broker exec disabled</dt><dd>{String(ctx.brokerExecutionDisabled)}</dd>
        <dt className="text-zinc-500">Bridge mode</dt><dd>{ctx.bridge?.bridgeMode ?? "unknown"}</dd>
        <dt className="text-zinc-500">Heartbeat</dt><dd>{ctx.heartbeatPresent ? `present (${ctx.heartbeatAgeSeconds ?? "?"}s)` : "absent"}</dd>
        <dt className="text-zinc-500">Broker read-only</dt><dd>{String(ctx.brokerReadOnly)}</dd>
        <dt className="text-zinc-500">Readiness</dt><dd>{ctx.readiness}</dd>
        <dt className="text-zinc-500">Emergency Stop</dt><dd>{ctx.emergencyStopActive ? "ENGAGED" : "off"}</dd>
        <dt className="text-zinc-500">Selected symbol</dt><dd>{ctx.selectedSymbol ?? "—"}</dd>
        <dt className="text-zinc-500">Route</dt><dd className="truncate">{ctx.route}</dd>
        <dt className="text-zinc-500">Recent failed APIs</dt><dd>{ctx.recentFailedEndpoints.length}</dd>
        <dt className="text-zinc-500">Recent errors</dt><dd>{ctx.recentErrors.length}</dd>
      </dl>
      <div className="mt-3 text-xs">
        <div className="text-zinc-500">Cannot do right now:</div>
        <ul className="list-disc pl-5 text-zinc-300">{status.cannotDo.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
    </div>
  );
}

function SafestNextCard({ primaryStep, nextRoute }: { primaryStep: string; nextRoute?: string }) {
  return (
    <div className="rounded-md border border-emerald-700 bg-emerald-950/40 p-4" data-testid="scc-safest-next">
      <h2 className="font-semibold text-emerald-100">Safest next step</h2>
      <p className="mt-2 text-sm text-emerald-100/90">{primaryStep}</p>
      {nextRoute && (
        <Link href={nextRoute}>
          <a className="inline-block mt-2 text-sm px-3 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-50" data-testid="scc-safest-next-route">
            Open {resolveRoute(nextRoute)?.title ?? nextRoute}
          </a>
        </Link>
      )}
      <p className="mt-2 text-xs text-emerald-200/80">Live trading is never the next step.</p>
    </div>
  );
}

function WizardCard({ steps }: { steps: WizardStep[] }) {
  const [openId, setOpenId] = useState<string | null>(steps[0]?.id ?? null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-wizard">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-zinc-100">Start Safe Setup</h2>
        <span className="text-xs text-zinc-400">{acked.size}/{steps.length}</span>
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
                <span className="text-sm text-zinc-100">{i + 1}. {step.title}</span>
                <span className="flex items-center gap-1 text-[10px]">
                  {isAcked && <span className="px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-100">acknowledged</span>}
                  <span className={`px-1.5 py-0.5 rounded ${tone.chip}`}>{tone.icon} {tone.label}</span>
                </span>
              </button>
              {open && (
                <div className="px-3 pb-3 text-xs text-zinc-300 space-y-1">
                  <p>{step.shortExplanation}</p>
                  <p><span className="text-zinc-500">Status:</span> {step.statusText}</p>
                  <p><span className="text-zinc-500">Done when:</span> {step.completionCondition}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {step.pageRoute && (
                      <Link href={step.pageRoute}>
                        <a className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700" data-testid={`scc-wizard-route-${step.id}`}>
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
                      className="text-xs px-2 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-50"
                      data-testid={`scc-wizard-ack-${step.id}`}
                    >
                      {isAcked ? "Unacknowledge" : "I understand"}
                    </button>
                    <a
                      href={`/help?ask=${encodeURIComponent(step.assistantQuestion)}`}
                      className="text-xs px-2 py-1 rounded bg-indigo-800 hover:bg-indigo-700 text-indigo-50"
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
      <p className="mt-3 text-[11px] text-zinc-500">This wizard is read-only. It does not enable live trading or change broker/MT5/risk state.</p>
    </div>
  );
}

function DiagnosticsCard({ diagnoses, reportContext }: { diagnoses: number; reportContext: Record<string, unknown> }) {
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4" data-testid="scc-diagnostics-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-zinc-100">Diagnostics</h2>
        <span className="text-xs text-zinc-400">{diagnoses} active</span>
      </div>
      <p className="mt-2 text-xs text-zinc-300">
        The App Doctor returned {diagnoses} diagnosis{diagnoses === 1 ? "" : "es"}. Open the floating help widget for the full report,
        or attach this safe context when you submit feedback.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href="/feedback-center">
          <a className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100" data-testid="scc-diagnostics-report">
            Open Feedback Center
          </a>
        </Link>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
          data-testid="scc-diagnostics-toggle"
        >
          {show ? "Hide" : "Show"} safe context
        </button>
      </div>
      {show && (
        <pre
          className="mt-2 p-2 text-[10px] overflow-auto rounded bg-zinc-950 border border-zinc-800 text-zinc-300 max-h-48"
          data-testid="scc-diagnostics-context"
        >
{JSON.stringify(reportContext, null, 2)}
        </pre>
      )}
    </div>
  );
}
