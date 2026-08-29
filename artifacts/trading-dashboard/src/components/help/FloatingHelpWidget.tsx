import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  HelpCircle, X, Bug, BookOpen, Sparkles, Send, Loader2, GraduationCap,
  ShieldAlert, Compass, ArrowRight, Search, Activity, Eye, ChevronDown, ChevronUp,
  CheckCircle2, Map, ListChecks, Circle, MinusCircle, Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useOnboarding } from "@/components/onboarding/OnboardingProvider";
import { cn } from "@/lib/utils";
import {
  ask, chipsForRoute, explainBadges, whatAmILookingAt, whatsNext, whyBlocked,
  type Answer, type AskContext,
} from "@/knowledge/answerEngine";
import { resolveRoute } from "@/knowledge/routeKnowledge";
import { useAssistantIconState, usePrefersReducedMotion } from "./AnimatedArxAssistantIcon";
import { RubyAvatar } from "@/components/ruby/RubyAvatar";
import { useAssistantName } from "@/lib/assistant-name";
import { sourceLabelFor } from "@/knowledge/knowledgeCompiler";
import { useAssistantContext, type AssistantLiveContext } from "@/hooks/use-assistant-context";
import { WALKTHROUGHS, type Walkthrough } from "@/knowledge/walkthroughs";
import { classifyAction } from "@/knowledge/actionRouter";
import { safestNextStep } from "@/knowledge/safestNextStep";
import { buildSetupChecklist, checklistProgress, type ChecklistItem } from "@/knowledge/setupChecklist";
import { activeStatuses } from "@/knowledge/statusRegistry";
import { useRuntimeContext } from "@/assistant/useRuntimeContext";
import { diagnose, fixFirst, explainAppStatus } from "@/assistant/appDoctor";
import { buildSafeReportContext } from "@/assistant/runtimeContext";
import type { DoctorDiagnosis } from "@/assistant/runtimeContextTypes";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const CATEGORIES = ["BUG", "FEATURE", "UI", "TRADING", "CHART", "AI", "RISK", "JOURNAL", "MOBILE", "MT5", "OTHER"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const OPEN_KEY = "arx.assistant.open.v1";
const MEMORY_LIMIT = 4;
const MENU_CHIP_LIMIT = 4;
const ASK_CHIP_LIMIT = 4;

type View = "menu" | "ask" | "report" | "walkthroughs" | "walkthrough" | "guide" | "doctor";
interface ChatItem { q: string; a: Answer }

/** Topic guess used for follow-up pronoun resolution. */
function guessTopic(q: string, a: Answer): string {
  const m = a.sourceId.replace(/^(kb|route|look|blockers|refusal):/, "").replace(/[-_]/g, " ");
  return m || q.split(/\s+/).slice(0, 5).join(" ");
}

export function FloatingHelpWidget() {
  const { name } = useAssistantName();
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(OPEN_KEY) === "1";
  });
  // `closing` lets the panel play its exit animation before unmounting.
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // Smooth close: trigger exit animation, then unmount after 200ms.
  // Idempotent — extra calls during the animation are ignored.
  const requestClose = useCallback(() => {
    setClosing((wasClosing) => {
      if (wasClosing) return wasClosing;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
      closeTimerRef.current = window.setTimeout(() => {
        setOpen(false);
        setClosing(false);
        closeTimerRef.current = null;
      }, 200);
      return true;
    });
  }, []);

  // Cancel any in-flight close timer on unmount.
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const [view, setView] = useState<View>("menu");
  const [activeWalkthroughId, setActiveWalkthroughId] = useState<string | null>(null);
  const [memory, setMemory] = useState<{ q: string; topic?: string }[]>([]);
  // Free-text question composed on the menu view; auto-submitted by AskView.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const liveCtx = useAssistantContext();
  const runtimeCtx = useRuntimeContext();
  const location = liveCtx.route;

  // Assistant activity signals — drive the icon's motion state.
  const [thinking, setThinking] = useState(false);
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [iconError, setIconError] = useState(false);

  // Active app blockers (drives the amber status ring on the icon).
  // App-status only — never used to suggest live-trading readiness.
  const blockerCount = useMemo(() => {
    try { return diagnose(runtimeCtx).length; }
    catch { return 0; }
  }, [runtimeCtx]);

  // Persist open state across in-session navigations (cleared on tab close).
  useEffect(() => {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
    }
  }, [open]);
  useEffect(() => { if (open) setView("menu"); }, [location]);
  useEffect(() => {
    if (!open || closing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closing, requestClose]);

  // Click/tap outside the panel closes the assistant. We also exempt the
  // floating trigger button so re-clicking the icon does not double-fire.
  useEffect(() => {
    if (!open || closing) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current && panelRef.current.contains(target)) return;
      const trigger = document.querySelector('[data-testid="floating-help-trigger"]');
      if (trigger && trigger.contains(target)) return;
      requestClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, closing, requestClose]);

  // Session memory passed into every ask() — short-lived, in-memory only.
  const ctxWithMemory: AskContext = useMemo(
    () => ({ ...liveCtx, recentExchanges: memory }),
    [liveCtx, memory],
  );

  function rememberExchange(q: string, a: Answer) {
    setMemory((prev) => {
      const next = [...prev, { q, topic: guessTopic(q, a) }];
      return next.slice(-MEMORY_LIMIT);
    });
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed z-40 right-4 md:right-6",
        "bottom-[calc(env(safe-area-inset-bottom)+140px)] md:bottom-24",
      )}
      aria-live="polite"
    >
      {open ? (
        <div
          ref={panelRef}
          className={cn(
            "pointer-events-auto rounded-2xl border border-white/10",
            "bg-background/85 backdrop-blur-xl shadow-2xl shadow-black/40",
            "ring-1 ring-white/5 overflow-hidden flex flex-col",
            "w-[min(24rem,calc(100vw-24px))]",
            "max-h-[min(78vh,calc(100vh-env(safe-area-inset-bottom)-160px))]",
            "duration-200",
            closing
              ? "animate-out fade-out slide-out-to-bottom-2 zoom-out-95 ease-in fill-mode-forwards"
              : "animate-in fade-in slide-in-from-bottom-2 zoom-in-95 ease-out",
          )}
          role="dialog"
          aria-modal="false"
          aria-label={`${name} — ARX Assistant`}
          data-testid="floating-help-panel"
          data-state={closing ? "closing" : "open"}
        >
          <Header
            route={location}
            onClose={requestClose}
            thinking={thinking}
            readyAt={readyAt}
            error={iconError}
            blockerCount={blockerCount}
          />
          <div className="p-3 text-sm overflow-y-auto">
            {view === "menu" && (
              <MenuView
                ctx={ctxWithMemory}
                rememberExchange={rememberExchange}
                onAsk={() => setView("ask")}
                onAskWithQuestion={(q) => { setPendingQuestion(q); setView("ask"); }}
                onReport={() => setView("report")}
                onWalkthroughs={() => setView("walkthroughs")}
                onGuide={() => setView("guide")}
                onDoctor={() => setView("doctor")}
                onNavigate={(r) => { navigate(r); requestClose(); }}
                showDiag={liveCtx.diagnosticsRequested}
              />
            )}
            {view === "guide" && (
              <GuideView
                ctx={ctxWithMemory}
                onBack={() => setView("menu")}
                onNavigate={(r) => { navigate(r); requestClose(); }}
                onWalkthrough={(id) => { setActiveWalkthroughId(id); setView("walkthrough"); }}
                onReport={() => setView("report")}
              />
            )}
            {view === "ask" && (
              <AskView
                ctx={ctxWithMemory}
                rememberExchange={rememberExchange}
                initialQuestion={pendingQuestion}
                onConsumedInitialQuestion={() => setPendingQuestion(null)}
                onBack={() => setView("menu")}
                onNavigate={(r) => { navigate(r); requestClose(); }}
                onWalkthrough={(id) => { setActiveWalkthroughId(id); setView("walkthrough"); }}
                onReport={() => setView("report")}
                onGuide={() => setView("guide")}
                showDiag={liveCtx.diagnosticsRequested}
                onActivity={(ev) => {
                  if (ev.kind === "thinking") setThinking(ev.value);
                  else if (ev.kind === "ready") { setThinking(false); setReadyAt(Date.now()); setIconError(false); }
                  else if (ev.kind === "error") { setThinking(false); setIconError(true); }
                }}
              />
            )}
            {view === "walkthroughs" && (
              <WalkthroughsList
                onPick={(id) => { setActiveWalkthroughId(id); setView("walkthrough"); }}
                onBack={() => setView("menu")}
              />
            )}
            {view === "walkthrough" && activeWalkthroughId && (
              <WalkthroughView
                walkthrough={WALKTHROUGHS.find((w) => w.id === activeWalkthroughId)!}
                onBack={() => setView("walkthroughs")}
                onNavigate={(r) => { navigate(r); requestClose(); }}
              />
            )}
            {view === "report" && (
              <ReportView
                route={location}
                runtimeCtx={runtimeCtx}
                onDone={() => { requestClose(); setView("menu"); }}
                toast={toast}
              />
            )}
            {view === "doctor" && (
              <DoctorView
                runtimeCtx={runtimeCtx}
                onBack={() => setView("menu")}
                onNavigate={(r) => { navigate(r); requestClose(); }}
              />
            )}
            {liveCtx.diagnosticsRequested && view === "menu" && (
              <DiagnosticsPanel ctx={liveCtx} memory={memory} />
            )}
          </div>
        </div>
      ) : (
        <AssistantTrigger
          onOpen={() => setOpen(true)}
          thinking={thinking}
          readyAt={readyAt}
          error={iconError}
          blockerCount={blockerCount}
        />
      )}
    </div>
  );
}

// ─── Animated trigger ──────────────────────────────────────────────────────
function AssistantTrigger({
  onOpen, thinking, readyAt, error, blockerCount,
}: {
  onOpen: () => void;
  thinking: boolean;
  readyAt: number | null;
  error: boolean;
  blockerCount: number;
}) {
  const { name } = useAssistantName();
  const [hover, setHover] = useState(false);
  const [opening, setOpening] = useState(false);
  const reduced = usePrefersReducedMotion();
  const { state, status, ariaLabel, tooltip } = useAssistantIconState({
    open: false, hover, opening, thinking, readyAt, error, blockerCount,
  });

  function handleClick() {
    if (reduced) { onOpen(); return; }
    // Brief morph (~220ms) before mounting the panel.
    setOpening(true);
    window.setTimeout(() => onOpen(), 220);
  }

  return (
    <AssistantIconErrorBoundary fallback={<StaticTriggerFallback onClick={onOpen} />}>
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-label={ariaLabel}
        title={tooltip}
        data-testid="floating-help-trigger"
        data-arx-id="floating-help-trigger"
        data-icon-state={state}
        data-icon-status={status}
        className={cn(
          "pointer-events-auto group flex items-center gap-2 h-12 px-3 md:px-4 rounded-full",
          "border border-white/15 bg-background/85 backdrop-blur-xl",
          "shadow-2xl shadow-black/50 ring-1 ring-white/5",
          "text-foreground/90 hover:text-foreground transition-all duration-200",
          "hover:scale-[1.04] hover:-translate-y-0.5",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
        )}
      >
        <span className="grid place-items-center h-8 w-8 rounded-full">
          <RubyAvatar
            state={
              status === "error" ? "disconnected"
              : status === "warning" ? "alert"
              : state === "thinking" ? "thinking"
              : state === "typing" ? "speaking"
              : state === "ready" ? "success"
              : "idle"
            }
            size="sm"
            ariaHidden
            testId="ruby-avatar-trigger"
          />
        </span>
        <span className="hidden md:inline text-xs font-semibold tracking-wide">Ask {name}</span>
      </button>
    </AssistantIconErrorBoundary>
  );
}

function StaticTriggerFallback({ onClick }: { onClick: () => void }) {
  const { name } = useAssistantName();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${name} — ARX Assistant`}
      data-testid="floating-help-trigger"
      className={cn(
        "pointer-events-auto group flex items-center gap-2 h-12 px-3 md:px-4 rounded-full",
        "border border-white/15 bg-background/85 backdrop-blur-xl",
        "shadow-2xl shadow-black/50 ring-1 ring-white/5",
        "text-foreground/90 hover:text-foreground transition-all duration-200",
      )}
    >
      <span className="grid place-items-center h-7 w-7 rounded-full bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground shadow-inner">
        <HelpCircle size={15} />
      </span>
      <span className="hidden md:inline text-xs font-semibold tracking-wide">AI Help</span>
    </button>
  );
}

class AssistantIconErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { /* swallow — icon is decorative */ if (typeof console !== "undefined") console.warn("[arx-aicon] fallback engaged:", err); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ─── Header ─────────────────────────────────────────────────────────────────
function Header({
  route, onClose, thinking, readyAt, error, blockerCount,
}: {
  route: string;
  onClose: () => void;
  thinking?: boolean;
  readyAt?: number | null;
  error?: boolean;
  blockerCount?: number;
}) {
  const { name } = useAssistantName();
  const r = resolveRoute(route);
  const { state, status } = useAssistantIconState({
    open: true, thinking, readyAt, error, blockerCount,
  });
  return (
    <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 bg-gradient-to-r from-primary/15 to-transparent shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <RubyAvatar
          state={
            status === "error" ? "disconnected"
            : status === "warning" ? "alert"
            : state === "thinking" ? "thinking"
            : state === "typing" ? "speaking"
            : "idle"
          }
          size="xs"
          ariaHidden
          testId="ruby-avatar-header"
        />
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-wide leading-tight">{name}</div>
          <div className="text-[10px] text-muted-foreground truncate">
            {r ? r.title : "Page"} · <code className="text-[10px]">{route}</code>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close assistant"
        className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-white/5 shrink-0"
        data-testid="floating-help-close"
      >
        <X size={14} />
      </button>
    </header>
  );
}

// ─── Menu view ──────────────────────────────────────────────────────────────
function MenuView({
  ctx, rememberExchange, onAsk, onAskWithQuestion, onReport, onWalkthroughs, onGuide, onDoctor, onNavigate, showDiag,
}: {
  ctx: AskContext;
  rememberExchange: (q: string, a: Answer) => void;
  onAsk: () => void;
  onAskWithQuestion: (q: string) => void;
  onReport: () => void;
  onWalkthroughs: () => void;
  onGuide: () => void;
  onDoctor: () => void;
  onNavigate: (r: string) => void;
  showDiag: boolean;
}) {
  const { name } = useAssistantName();
  const { showTour } = useOnboarding();
  const route = ctx.route;
  const chips = useMemo(() => chipsForRoute(route).slice(0, MENU_CHIP_LIMIT), [route]);
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [pendingA, setPendingA] = useState<Answer | null>(null);
  const [composerQ, setComposerQ] = useState("");

  function quick(q: string, fn: () => Answer) {
    const a = fn();
    setPendingQ(q);
    setPendingA(a);
    rememberExchange(q, a);
  }

  function submitComposer(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = composerQ.trim();
    if (!trimmed) return;
    setComposerQ("");
    onAskWithQuestion(trimmed);
  }

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-1.5"
        onSubmit={submitComposer}
        data-testid="help-menu-composer"
      >
        <input
          type="text"
          value={composerQ}
          onChange={(e) => setComposerQ(e.target.value)}
          placeholder="Type your question…"
          aria-label={`Ask ${name}`}
          className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/60"
          data-testid="help-menu-composer-input"
        />
        <Button
          type="submit"
          size="sm"
          className="h-8 px-2 text-xs"
          disabled={!composerQ.trim()}
          data-testid="help-menu-composer-submit"
          aria-label="Send question"
        >
          <Send size={12} />
        </Button>
      </form>

      <div className="grid grid-cols-2 gap-1.5">
        <ShortcutTile icon={Eye} label="What am I looking at?" testId="help-shortcut-look"
          onClick={() => quick("What am I looking at?", () => whatAmILookingAt(ctx))} />
        <ShortcutTile icon={ShieldAlert} label="Why am I blocked?" testId="help-shortcut-blocked"
          onClick={() => quick("Why am I blocked?", () => whyBlocked(ctx))} />
        <ShortcutTile icon={Compass} label="What next?" testId="help-shortcut-next"
          onClick={() => quick("What should I do next?", () => whatsNext(ctx))} />
        <ShortcutTile icon={Sparkles} label="Explain badges" testId="help-shortcut-badges"
          onClick={() => quick("Explain current status badges", () => explainBadges(ctx))} />
      </div>

      {pendingA && pendingQ && (
        <AnswerCard q={pendingQ} a={pendingA} onNavigate={onNavigate} compact showDiag={showDiag} />
      )}

      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Suggested</div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => quick(c, () => ask(c, ctx))}
              className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-foreground/80"
              data-testid={`help-chip-${c.slice(0, 16).replace(/\s+/g, "-").toLowerCase()}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-1.5">
        <RowButton icon={Activity} label="Diagnose this page" hint="What is happening right now, what's blocked, safest next step" onClick={onDoctor} testId="help-action-doctor" />
        <RowButton icon={Map} label="Open Status Command Center" hint="Readiness, blockers, fix-first, safe setup" href={`${BASE}/status-command-center`} testId="help-action-status-center" />
        <RowButton icon={Map} label="What should I fix first?" hint="Top priority diagnosis from App Doctor" onClick={onDoctor} testId="help-action-fix-first" />
        <RowButton icon={Map} label="Start Safe Setup" hint="11-step guided wizard, no live trading" href={`${BASE}/status-command-center`} testId="help-action-safe-setup" />
        <RowButton icon={Map} label="Explain readiness score" hint="10 sections, 0–100" href={`${BASE}/status-command-center`} testId="help-action-readiness-score" />
        <RowButton icon={Map} label="Explain active blockers" hint="What's blocking you right now" href={`${BASE}/status-command-center`} testId="help-action-active-blockers" />
        <RowButton icon={Map} label="ARX Guide" hint="Page, statuses, safest next step, checklist" onClick={onGuide} testId="help-action-guide" />
        <RowButton icon={Search} label="Ask anything about ARX AI…" hint="Type your own question" onClick={onAsk} testId="help-action-ask" />
        <RowButton icon={GraduationCap} label="Guided walkthroughs" hint={`${WALKTHROUGHS.length} step-by-step flows`} onClick={onWalkthroughs} testId="help-action-walkthroughs" />
        <RowButton icon={GraduationCap} label="Start app tour" hint="Walk through ARX AI" onClick={showTour} testId="help-action-tour" />
        <RowButton icon={BookOpen} label="Open Help Center" hint="Full guides & playbook" href={`${BASE}/help`} testId="help-action-center" />
        <RowButton icon={Bug} label="Report an issue" hint="Send feedback or a bug" onClick={onReport} testId="help-action-report" />
      </div>

    </div>
  );
}

// ─── Ask view (free-text + chat history) ────────────────────────────────────
export type AskActivityEvent =
  | { kind: "thinking"; value: boolean }
  | { kind: "ready" }
  | { kind: "error" };

function AskView({
  ctx, rememberExchange, initialQuestion, onConsumedInitialQuestion,
  onBack, onNavigate, onWalkthrough, onReport, onGuide, showDiag, onActivity,
}: {
  ctx: AskContext;
  rememberExchange: (q: string, a: Answer) => void;
  initialQuestion?: string | null;
  onConsumedInitialQuestion?: () => void;
  onBack: () => void;
  onNavigate: (r: string) => void;
  onWalkthrough: (id: string) => void;
  onReport: () => void;
  onGuide: () => void;
  showDiag: boolean;
  onActivity?: (ev: AskActivityEvent) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ChatItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const chips = useMemo(() => chipsForRoute(ctx.route).slice(0, ASK_CHIP_LIMIT), [ctx.route]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Auto-submit a question handed off from the menu composer (one-shot).
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    if (!initialQuestion) return;
    consumedRef.current = true;
    submit(initialQuestion);
    onConsumedInitialQuestion?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    // Action router runs first — safe non-answer actions short-circuit ask().
    const action = classifyAction(trimmed, ctx);
    if (action.kind === "navigate" && action.route) {
      onNavigate(action.route);
      setQ("");
      return;
    }
    if (action.kind === "start-walkthrough" && action.walkthroughId) {
      onWalkthrough(action.walkthroughId);
      setQ("");
      return;
    }
    if (action.kind === "open-report-issue") { onReport(); setQ(""); return; }
    if (action.kind === "show-checklist" || action.kind === "show-safest-next") { onGuide(); setQ(""); return; }
    // Default: knowledge answer (also handles refusal because ask() pre-filters).
    // ask() is synchronous; emit a brief "thinking" pulse so the icon's
    // thinking animation is perceptible, then fire "ready" (or "error").
    onActivity?.({ kind: "thinking", value: true });
    setQ("");
    window.setTimeout(() => {
      try {
        const a = ask(trimmed, ctx);
        setItems((prev) => [...prev, { q: trimmed, a }]);
        rememberExchange(trimmed, a);
        onActivity?.({ kind: "ready" });
      } catch {
        onActivity?.({ kind: "error" });
      }
    }, 220);
  }

  return (
    <div className="space-y-2">
      <button onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground" data-testid="help-ask-back">← Back</button>

      {items.length === 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c}
                onClick={() => submit(c)}
                className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.08]"
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="space-y-1">
            <div className="text-[11px] text-muted-foreground"><span className="text-foreground/70 font-medium">You:</span> {it.q}</div>
            <AnswerCard q={it.q} a={it.a} onNavigate={onNavigate} showDiag={showDiag} />
          </div>
        ))}
      </div>

      <form
        className="flex items-center gap-1.5 pt-1 sticky bottom-0 bg-background/80 pb-1"
        onSubmit={(e) => { e.preventDefault(); submit(q); }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything about ARX AI, this screen, your status, blockers, MT5, risk, or setup…"
          className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs"
          data-testid="help-ask-input"
        />
        <Button type="submit" size="sm" className="h-8 px-2 text-xs" disabled={!q.trim()} data-testid="help-ask-submit">
          <Send size={12} />
        </Button>
      </form>
    </div>
  );
}

// ─── Walkthroughs list ──────────────────────────────────────────────────────
function WalkthroughsList({ onPick, onBack }: { onPick: (id: string) => void; onBack: () => void }) {
  return (
    <div className="space-y-2" data-testid="help-walkthroughs-list">
      <button onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground">← Back</button>
      <p className="text-[11px] text-muted-foreground">Step-by-step flows for the {WALKTHROUGHS.length} most common ARX tasks.</p>
      <div className="grid gap-1.5">
        {WALKTHROUGHS.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onPick(w.id)}
            className="text-left px-2.5 py-2 rounded-md border border-white/10 bg-white/[0.02] hover:bg-white/[0.06]"
            data-testid={`help-walkthrough-${w.id}`}
          >
            <div className="text-xs font-semibold">{w.title}</div>
            <div className="text-[10px] text-muted-foreground line-clamp-2">{w.intro}</div>
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">{w.steps.length} steps</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Walkthrough view ──────────────────────────────────────────────────────
function WalkthroughView({
  walkthrough, onBack, onNavigate,
}: { walkthrough: Walkthrough; onBack: () => void; onNavigate: (r: string) => void }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const allDone = done.size === walkthrough.steps.length;
  return (
    <div className="space-y-2" data-testid={`help-walkthrough-view-${walkthrough.id}`}>
      <button onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground">← All walkthroughs</button>
      <div>
        <div className="text-sm font-semibold">{walkthrough.title}</div>
        <div className="text-[11px] text-muted-foreground">{walkthrough.intro}</div>
      </div>
      <ol className="space-y-1.5">
        {walkthrough.steps.map((s, i) => {
          const isDone = done.has(i);
          return (
            <li key={i} className={cn("rounded-md border border-white/10 p-2", isDone && "bg-success/5 border-success/30")}>
              <div className="flex items-start gap-2">
                <button
                  onClick={() => setDone((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                  className={cn("h-4 w-4 mt-0.5 rounded border border-white/20 grid place-items-center text-[9px] shrink-0", isDone && "bg-success/40 border-success")}
                  aria-label={isDone ? "Mark step incomplete" : "Mark step complete"}
                >
                  {isDone ? <CheckCircle2 size={10} /> : i + 1}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">{s.title}</div>
                  <div className="text-[11px] text-muted-foreground">{s.body}</div>
                  {s.warning && (
                    <div className="text-[10px] text-warning/90 italic mt-0.5 flex gap-1">
                      <ShieldAlert size={10} className="shrink-0 mt-0.5" /> {s.warning}
                    </div>
                  )}
                  {s.route && (
                    <button
                      onClick={() => onNavigate(s.route!)}
                      className="mt-1 text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1]"
                    >
                      <ArrowRight size={9} /> Open {s.route}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className={cn("text-[11px] p-2 rounded-md", allDone ? "bg-success/10 text-success border border-success/30" : "bg-white/5 text-muted-foreground")}>
        <strong>Done when:</strong> {walkthrough.completion}
      </div>
    </div>
  );
}

// ─── Guide view ───────────────────────────────────────────────────────────
function GuideView({
  ctx, onBack, onNavigate, onWalkthrough, onReport,
}: {
  ctx: AskContext;
  onBack: () => void;
  onNavigate: (r: string) => void;
  onWalkthrough: (id: string) => void;
  onReport: () => void;
}) {
  const route = resolveRoute(ctx.route);
  const statuses = useMemo(() => activeStatuses(ctx), [ctx]);
  const safest = useMemo(() => safestNextStep(ctx), [ctx]);
  const checklist = useMemo(() => buildSetupChecklist(ctx), [ctx]);
  const progress = useMemo(() => checklistProgress(checklist), [checklist]);
  const suggestedWt = WALKTHROUGHS.find((w) => w.id === "wt-first-time") ?? WALKTHROUGHS[0];

  return (
    <div className="space-y-3" data-testid="help-guide">
      <button onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground">← Back</button>

      <section className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Current page</div>
        <div className="text-xs font-semibold">{route?.title ?? "Page"}</div>
        <div className="text-[11px] text-muted-foreground">{route?.purpose ?? ctx.route}</div>
      </section>

      <section className="rounded-md border border-success/30 bg-success/5 p-2.5" data-testid="help-guide-safest">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-success/80">
          <Compass size={10} /> Safest next step
        </div>
        <div className="text-xs font-semibold mt-0.5">{safest.step}</div>
        <div className="text-[11px] text-muted-foreground">{safest.why}</div>
        <div className="text-[10px] text-warning/90 italic mt-1 flex gap-1">
          <ShieldAlert size={10} className="shrink-0 mt-0.5" /> {safest.doNot}
        </div>
        <button
          onClick={() => onNavigate(safest.openRoute.route)}
          className="mt-1.5 text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-success/30 bg-success/10 hover:bg-success/20"
          data-testid="help-guide-safest-open"
        >
          <ArrowRight size={10} /> Open {safest.openRoute.label}
        </button>
        <div className="text-[10px] text-muted-foreground/70 mt-1">Live trading remains unavailable.</div>
      </section>

      {statuses.length > 0 && (
        <section className="rounded-md border border-white/10 bg-white/[0.03] p-2.5" data-testid="help-guide-statuses">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Active safety statuses</div>
          <ul className="mt-1 space-y-1">
            {statuses.slice(0, 6).map((s) => (
              <li key={s.id} className="text-[11px]">
                <span className={cn(
                  "inline-block px-1.5 py-0.5 rounded text-[9px] font-bold mr-1 align-middle",
                  s.severity === "good" && "bg-success/20 text-success",
                  s.severity === "warn" && "bg-warning/20 text-warning",
                  s.severity === "critical" && "bg-danger/20 text-danger",
                  s.severity === "info" && "bg-ruby/20 text-ruby",
                )}>{s.label}</span>
                <span className="text-muted-foreground">{s.meaning}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-md border border-white/10 bg-white/[0.03] p-2.5" data-testid="help-guide-checklist">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
            <ListChecks size={10} /> Setup checklist
          </div>
          <div className="text-[10px] text-muted-foreground">{progress.complete} / {progress.total} ({progress.percent}%)</div>
        </div>
        <ul className="mt-1.5 space-y-1">
          {checklist.map((it) => (
            <ChecklistRow key={it.id} item={it} onNavigate={onNavigate} />
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Quick actions</div>
        <div className="flex flex-wrap gap-1.5 mt-1">
          <QuickAction label="Open Risk" route="/risk-governor" onNavigate={onNavigate} />
          <QuickAction label="Open Trade" route="/manual-trade-ticket" onNavigate={onNavigate} />
          <QuickAction label="Open AI" route="/ai-coach" onNavigate={onNavigate} />
          <QuickAction label="Open MT5 Bridge" route="/mt5-bridge" onNavigate={onNavigate} />
          <QuickAction label="Open Readiness" route="/readiness-checklist" onNavigate={onNavigate} />
          <QuickAction label="Open Replay" route="/replay-simulator" onNavigate={onNavigate} />
          <QuickAction label="Open Data" route="/data-import" onNavigate={onNavigate} />
          <QuickAction label="Open Help" route="/help" onNavigate={onNavigate} />
        </div>
      </section>

      <section className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Suggested walkthrough</div>
        <div className="text-xs font-semibold mt-0.5">{suggestedWt.title}</div>
        <div className="text-[11px] text-muted-foreground line-clamp-2">{suggestedWt.intro}</div>
        <button
          onClick={() => onWalkthrough(suggestedWt.id)}
          className="mt-1.5 text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1]"
          data-testid="help-guide-walkthrough"
        >
          <GraduationCap size={10} /> Start walkthrough
        </button>
      </section>

      <button
        onClick={onReport}
        className="w-full text-[11px] inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1]"
        data-testid="help-guide-report"
      >
        <Bug size={10} /> Report an issue with this page
      </button>
    </div>
  );
}

function ChecklistRow({ item, onNavigate }: { item: ChecklistItem; onNavigate: (r: string) => void }) {
  const Icon = item.status === "complete" ? CheckCircle2
    : item.status === "blocked" ? Ban
    : item.status === "unavailable" ? MinusCircle
    : Circle;
  const tint = item.status === "complete" ? "text-success"
    : item.status === "blocked" ? "text-danger"
    : item.status === "unavailable" ? "text-muted-foreground"
    : "text-muted-foreground/70";
  return (
    <li className="text-[11px]" data-testid={`help-checklist-${item.id}`}>
      <div className="flex items-start gap-1.5">
        <Icon size={11} className={cn("shrink-0 mt-0.5", tint)} />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{item.title}</div>
          <div className="text-muted-foreground text-[10px]">{item.explanation}</div>
          {item.blockerReason && (
            <div className="text-warning/80 text-[10px] italic">Blocker: {item.blockerReason}</div>
          )}
          <div className="text-[10px] text-muted-foreground/80 mt-0.5">Next: {item.safeNextAction}</div>
          {item.related && (
            <button
              onClick={() => onNavigate(item.related!.route)}
              className="mt-0.5 text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1]"
            >
              <ArrowRight size={9} /> Open {item.related.label}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function QuickAction({ label, route, onNavigate }: { label: string; route: string; onNavigate: (r: string) => void }) {
  const resolved = resolveRoute(route);
  if (!resolved) return null; // never invent routes
  // Prefer registry title to keep labels in sync with route renames.
  const finalLabel = resolved.title ? `Open ${resolved.title}` : label;
  return (
    <button
      onClick={() => onNavigate(route)}
      className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1]"
      data-testid={`help-quick-${route.replace(/\//g, "_")}`}
    >
      <ArrowRight size={9} /> {finalLabel}
    </button>
  );
}

// ─── Answer card ───────────────────────────────────────────────────────────
function AnswerCard({
  a, onNavigate, compact,
}: { q: string; a: Answer; onNavigate: (r: string) => void; compact?: boolean; showDiag?: boolean }) {
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className={cn(
      "rounded-md border border-white/10 bg-white/[0.03] p-2.5 space-y-1.5",
      compact && "p-2",
    )}>
      <p className="text-xs text-foreground/90 whitespace-pre-line">{a.answer}</p>
      {a.detail && <p className="text-[11px] text-muted-foreground whitespace-pre-line">{a.detail}</p>}
      {a.safety && (
        <p className="text-[10px] text-warning/90 italic flex gap-1">
          <ShieldAlert size={11} className="shrink-0 mt-0.5" />
          <span>{a.safety}</span>
        </p>
      )}
      {a.related && a.related.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {a.related.slice(0, 4).map((r) => (
            <button
              key={r.route}
              onClick={() => onNavigate(r.route)}
              className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1] text-foreground/80"
              data-testid={`help-related-${r.route.replace(/\//g, "_")}`}
            >
              <ArrowRight size={9} /> {r.label}
            </button>
          ))}
        </div>
      )}
      <p className="text-[9px] text-muted-foreground/60">
        {sourceLabelFor(a.sourceId)}
        {" · "}id: <code>{a.sourceId}</code>
      </p>
      <div className="pt-1 border-t border-white/5">
        <button
          onClick={() => setShowWhy((v) => !v)}
          className="text-[10px] text-ruby/80 hover:text-ruby inline-flex items-center gap-1"
          data-testid="help-why-this-answer"
        >
          {showWhy ? <ChevronUp size={9} /> : <ChevronDown size={9} />} Why this answer?
        </button>
        {showWhy && (
          <div className="mt-1 text-[10px] text-muted-foreground space-y-0.5">
            <div>match: <code>{a.matchType}</code></div>
            <div>source: <code>{a.sourceId}</code></div>
            <div>confidence: <code>{a.confidence.toFixed(2)}</code></div>
            <div>related routes: <code>{(a.related ?? []).length}</code></div>
            <div>mode: <code>local-deterministic</code></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Report view (auto-attaches safe runtime context) ──────────────────────
function ReportView({
  route, runtimeCtx, onDone, toast,
}: {
  route: string;
  runtimeCtx: import("@/assistant/runtimeContextTypes").RuntimeContext;
  onDone: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [busy, setBusy] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [form, setForm] = useState({
    title: "", category: "BUG" as typeof CATEGORIES[number], severity: "medium" as typeof SEVERITIES[number], whatHappened: "",
  });
  const primary = useMemo(() => fixFirst(runtimeCtx).primary, [runtimeCtx]);
  const safeCtx = useMemo(
    () => buildSafeReportContext(runtimeCtx, primary?.category),
    [runtimeCtx, primary],
  );

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title || `Issue on ${route}`,
          category: form.category,
          severity: form.severity,
          route,
          whatHappened: form.whatHappened,
          currentMode: "BETA_TESTER",
          mt5Status: runtimeCtx.bridge?.bridgeMode ?? "deferred",
          context: {
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            viewport: typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
            ts: new Date().toISOString(),
            arxDoctor: safeCtx,
            arxStatusSummary: {
              route: runtimeCtx.route,
              tradingMode: runtimeCtx.tradingMode,
              activeSafetyLocks: runtimeCtx.activeSafetyLocks,
              bridgeMode: runtimeCtx.bridge?.bridgeMode ?? "unknown",
              heartbeatPresent: runtimeCtx.heartbeatPresent,
              brokerReadOnly: runtimeCtx.brokerReadOnly,
              liveTradingDisabled: runtimeCtx.liveTradingDisabled,
              recentFailedEndpointCount: runtimeCtx.recentFailedEndpoints.length,
              recentErrorCount: runtimeCtx.recentErrors.length,
              liveTradingStillUnavailable: true,
            },
          },
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? "submit failed");
      toast({ title: "Issue reported", description: j.feedbackId });
      onDone();
    } catch (e) {
      toast({ title: "Failed to report", description: String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">Route: <code className="rounded bg-white/5 px-1">{route}</code></p>
      <div className="rounded-md border border-success/20 bg-success/5 p-2 text-[11px]" data-testid="report-safe-context">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-success">Safe diagnostic context will be attached</span>
          <button type="button" onClick={() => setShowCtx((v) => !v)} className="text-[10px] underline text-success/80">
            {showCtx ? "Hide" : "Review"}
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Includes route, viewport, visible statuses, blocker IDs, recent failed endpoints, and the doctor's diagnosis category.
          Excludes tokens, secrets, broker credentials, account passwords, and raw request bodies.
        </p>
        {showCtx && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/40 p-2 text-[10px] text-success/90" data-testid="report-safe-context-json">
            {JSON.stringify(safeCtx, null, 2)}
          </pre>
        )}
      </div>
      <input
        className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs"
        placeholder="Short title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        data-testid="floating-help-report-title"
      />
      <div className="grid grid-cols-2 gap-2">
        <select className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as typeof CATEGORIES[number] })}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as typeof SEVERITIES[number] })}>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <textarea
        className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs"
        rows={3}
        placeholder="What happened?"
        value={form.whatHappened}
        onChange={(e) => setForm({ ...form, whatHappened: e.target.value })}
        data-testid="floating-help-report-what"
      />
      <Button
        size="sm"
        className="w-full h-8 text-xs"
        disabled={busy || form.whatHappened.trim().length < 2}
        onClick={submit}
        data-testid="floating-help-report-submit"
      >
        {busy ? <Loader2 size={12} className="animate-spin mr-1" /> : <Send size={12} className="mr-1" />}
        {busy ? "Submitting…" : "Submit"}
      </Button>
    </div>
  );
}

// ─── Doctor view ───────────────────────────────────────────────────────────
function DoctorView({
  runtimeCtx, onBack, onNavigate,
}: {
  runtimeCtx: import("@/assistant/runtimeContextTypes").RuntimeContext;
  onBack: () => void;
  onNavigate: (r: string) => void;
}) {
  const status = useMemo(() => explainAppStatus(runtimeCtx), [runtimeCtx]);
  const all = useMemo(() => diagnose(runtimeCtx), [runtimeCtx]);
  const primary = all[0];
  const alts = all.slice(1, 4);
  return (
    <div className="space-y-3" data-testid="doctor-view">
      <button onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground" data-testid="doctor-back">← Back</button>
      <section className="rounded-md border border-ruby/30 bg-ruby/5 p-2.5">
        <div className="text-[10px] uppercase tracking-wider text-ruby/80">Current app status</div>
        <div className="text-xs mt-1" data-testid="doctor-mode">Mode: <span className="font-semibold">{status.mode}</span></div>
        <div className="text-[11px] mt-2"><span className="text-success">Can do:</span> {status.canDo.join(" · ")}</div>
        {status.cannotDo.length > 0 && (
          <div className="text-[11px] mt-1"><span className="text-warning">Cannot do:</span> {status.cannotDo.join(" · ")}</div>
        )}
        <div className="text-[11px] mt-1"><span className="text-warning">Why live trading is unavailable:</span> {status.whyLiveUnavailable}</div>
      </section>

      <section className="rounded-md border border-success/30 bg-success/5 p-2.5" data-testid="doctor-fix-first">
        <div className="text-[10px] uppercase tracking-wider text-success/80">What to fix first</div>
        {primary ? (
          <DiagnosisRow d={primary} onNavigate={onNavigate} testId="doctor-primary" />
        ) : (
          <div className="text-xs text-muted-foreground">No issues detected — everything is operating in the expected safe mode.</div>
        )}
      </section>

      {alts.length > 0 && (
        <section className="space-y-1.5" data-testid="doctor-alternates">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Other things I noticed</div>
          {alts.map((d) => <DiagnosisRow key={d.id} d={d} onNavigate={onNavigate} />)}
        </section>
      )}
    </div>
  );
}

function DiagnosisRow({ d, onNavigate, testId }: { d: DoctorDiagnosis; onNavigate: (r: string) => void; testId?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2 mt-2" data-testid={testId ?? `doctor-row-${d.id}`}>
      <div className="text-xs font-semibold">{d.explanation}</div>
      {d.evidence.length > 0 && (
        <div className="text-[10px] text-muted-foreground mt-1">Evidence: {d.evidence.join(" · ")}</div>
      )}
      <div className="text-[11px] mt-1"><span className="text-success">Safest next step:</span> {d.safeNextStep}</div>
      <div className="text-[10px] text-warning/90 mt-0.5">Don't: {d.doNotDo}</div>
      {d.relatedRoute && (
        <button
          type="button"
          onClick={() => onNavigate(d.relatedRoute!)}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
          data-testid={`doctor-open-${d.id}`}
        >
          Open {d.relatedRoute} <ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

// ─── Atoms ─────────────────────────────────────────────────────────────────
function RowButton({
  icon: Icon, label, hint, onClick, href, testId,
}: { icon: ComponentType<{ size?: number; className?: string }>; label: string; hint?: string; onClick?: () => void; href?: string; testId?: string }) {
  const inner = (
    <div className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] transition-colors text-left">
      <span className="grid place-items-center h-7 w-7 rounded-md bg-primary/15 text-primary"><Icon size={14} /></span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-semibold">{label}</span>
        {hint && <span className="block text-[10px] text-muted-foreground truncate">{hint}</span>}
      </span>
    </div>
  );
  if (href) return <a href={href} data-testid={testId}>{inner}</a>;
  return <button type="button" onClick={onClick} className="block w-full" data-testid={testId}>{inner}</button>;
}

// ─── Diagnostics panel (?assistant-diag=1) ────────────────────────────────
function DiagnosticsPanel({ ctx, memory }: { ctx: AssistantLiveContext; memory: { q: string; topic?: string }[] }) {
  return (
    <div className="mt-3 rounded-md border border-ruby/30 bg-ruby/5 p-2 text-[10px] space-y-1" data-testid="assistant-diagnostics">
      <div className="flex items-center gap-1 text-ruby font-semibold">
        <Activity size={10} /> ASSISTANT DIAGNOSTICS
      </div>
      <div><span className="text-muted-foreground">mode:</span> local-deterministic</div>
      <div><span className="text-muted-foreground">route:</span> {ctx.route}</div>
      <div><span className="text-muted-foreground">page:</span> {ctx.pageTitle ?? "(none)"}</div>
      <div><span className="text-muted-foreground">mt5:</span> {ctx.mt5Hint}</div>
      <div><span className="text-muted-foreground">mode-hint:</span> {ctx.tradingModeHint}</div>
      <div><span className="text-muted-foreground">symbol:</span> {ctx.raw.chartSymbol}</div>
      <div><span className="text-muted-foreground">intents:</span> {ctx.raw.intentCount ?? "n/a"}</div>
      <div><span className="text-muted-foreground">sim-engine:</span> {String(ctx.raw.simRunning)}</div>
      <div><span className="text-muted-foreground">badges:</span> {ctx.safetyStatuses?.length ?? 0} visible</div>
      <div><span className="text-muted-foreground">memory:</span> {memory.length}/{MEMORY_LIMIT} exchanges</div>
    </div>
  );
}

function ShortcutTile({
  icon: Icon, label, onClick, testId,
}: { icon: ComponentType<{ size?: number; className?: string }>; label: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-1 h-14 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] transition-colors px-1"
    >
      <Icon size={14} className="text-primary" />
      <span className="text-[10px] font-semibold leading-tight text-center">{label}</span>
    </button>
  );
}
