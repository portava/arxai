import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Sparkles, ExternalLink, Bell, Search, Shield, Zap, Wifi, UserCheck, ShieldCheck, Flag, Pause } from "lucide-react";
import { ARXLogoMark, ARXWordmark } from "@/components/brand/ARXLogo";
import { useTradingMode } from "@/hooks/useTradingMode";
import { cn } from "@/lib/utils";

type ChipTone = "success" | "warning" | "danger" | "primary" | "muted";
function ChipRow({ icon, label, chip }: { icon: ReactNode; label: string; chip: { label: string; tone: ChipTone } }) {
  const toneCls =
    chip.tone === "success" ? "border-success/40 bg-success/10 text-success"
    : chip.tone === "warning" ? "border-warning/40 bg-warning/10 text-warning"
    : chip.tone === "danger" ? "border-danger/40 bg-danger/10 text-danger"
    : chip.tone === "primary" ? "border-primary/40 bg-primary/10 text-primary"
    : "border-border bg-secondary/40 text-txt-secondary";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-xs text-txt-secondary">{icon}{label}</span>
      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", toneCls)}>{chip.label}</span>
    </div>
  );
}

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const STORAGE_DISMISSED = "highroll.onboarding.firstrun.dismissed.v1";

interface OnboardingStatus {
  status: string;
  walkthroughCompleted: boolean;
  totalSteps: number;
  completedSteps: string[];
  skippedSteps: string[];
  nextStep: string | null;
}
interface Announcement {
  id: number;
  featureKey: string;
  version: string;
  title: string;
  body: string;
  route: string | null;
  severity: string;
  acknowledged: boolean;
  dismissed: boolean;
  remindLaterUntil: string | null;
  shouldShow: boolean;
}

interface OnboardingContextValue {
  showTour: () => void;
  showWhatsNew: () => Promise<void>;
}
const Ctx = createContext<OnboardingContextValue>({ showTour: () => {}, showWhatsNew: async () => {} });
export const useOnboarding = () => useContext(Ctx);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { "content-type": "application/json" }, ...init });
  return r.json();
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  const tradingMode = useTradingMode();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [tourOpen, setTourOpen] = useState(false);
  const [activeAnn, setActiveAnn] = useState<Announcement | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const handoffPendingRef = useRef(false);

  const fetchAnnouncements = useCallback(async (): Promise<Announcement[]> => {
    try {
      const r = await api<{ announcements: Announcement[] }>("/api/feature-announcements");
      const next = r.announcements ?? [];
      setAnnouncements(next);
      return next;
    } catch {
      return [];
    }
  }, []);

  const showFirstUnack = useCallback((list?: Announcement[]) => {
    const source = list ?? announcements;
    const next = source.find(a => a.shouldShow);
    setActiveAnn(next ?? null);
  }, [announcements]);

  // Bootstrap on first mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, a] = await Promise.all([
          api<{ status: OnboardingStatus }>("/api/onboarding/status"),
          api<{ announcements: Announcement[] }>("/api/feature-announcements"),
        ]);
        if (cancelled) return;
        setStatus(s.status);
        const list = a.announcements ?? [];
        setAnnouncements(list);
        const dismissed = typeof window !== "undefined" && window.localStorage.getItem(STORAGE_DISMISSED) === "1";
        const shouldAutoTour = !dismissed && s.status && !s.status.walkthroughCompleted && s.status.status !== "COMPLETED";
        if (shouldAutoTour) {
          setTourOpen(true);
          handoffPendingRef.current = true; // queue announcements after tour closes
        } else {
          const next = list.find(x => x.shouldShow);
          if (next) setActiveAnn(next);
        }
      } catch { /* non-fatal */ }
      finally { if (!cancelled) setBootstrapped(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Watch for tour close to perform announcement handoff
  useEffect(() => {
    if (tourOpen) return;
    if (!handoffPendingRef.current) return;
    handoffPendingRef.current = false;
    (async () => {
      const list = await fetchAnnouncements();
      const next = list.find(a => a.shouldShow);
      if (next) setActiveAnn(next);
    })();
  }, [tourOpen, fetchAnnouncements]);

  const showTour = useCallback(() => setTourOpen(true), []);
  const showWhatsNew = useCallback(async () => {
    const list = await fetchAnnouncements();
    const next = list.find(a => a.shouldShow);
    setActiveAnn(next ?? null);
  }, [fetchAnnouncements]);

  const ctx = useMemo<OnboardingContextValue>(() => ({ showTour, showWhatsNew }), [showTour, showWhatsNew]);

  // ── Onboarding modal handlers ─────────────────────────────────────────────
  async function startTour() {
    try { await api("/api/onboarding/start", { method: "POST", body: "{}" }); } catch { /* */ }
    setTourOpen(false);
    navigate("/onboarding");
  }
  function skipForNow() { setTourOpen(false); }
  function dontShowAgain() {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_DISMISSED, "1");
    setTourOpen(false);
  }

  // ── Announcement modal handlers ───────────────────────────────────────────
  async function advanceAnn() {
    const remaining = announcements.filter(a => a.shouldShow && a.featureKey !== activeAnn?.featureKey);
    setActiveAnn(remaining[0] ?? null);
  }
  async function gotIt(a: Announcement) {
    try {
      await api(`/api/feature-announcements/${encodeURIComponent(a.featureKey)}/acknowledge`, {
        method: "POST", body: JSON.stringify({ version: a.version }),
      });
    } catch { /* */ }
    setAnnouncements(prev => prev.map(x => x.featureKey === a.featureKey ? { ...x, acknowledged: true, shouldShow: false } : x));
    advanceAnn();
  }
  async function viewFeature(a: Announcement) {
    await gotIt(a);
    if (a.route) navigate(a.route);
  }
  async function remindLater(a: Announcement) {
    try {
      await api(`/api/feature-announcements/${encodeURIComponent(a.featureKey)}/remind-later`, {
        method: "POST", body: JSON.stringify({ version: a.version, hours: 24 }),
      });
    } catch { /* */ }
    setAnnouncements(prev => prev.map(x => x.featureKey === a.featureKey ? { ...x, shouldShow: false } : x));
    advanceAnn();
  }
  async function dontShowAnn(a: Announcement) {
    try {
      await api(`/api/feature-announcements/${encodeURIComponent(a.featureKey)}/dismiss`, {
        method: "POST", body: JSON.stringify({ version: a.version }),
      });
    } catch { /* */ }
    setAnnouncements(prev => prev.map(x => x.featureKey === a.featureKey ? { ...x, dismissed: true, shouldShow: false } : x));
    advanceAnn();
  }

  // ── State-driven Trading Platform Status (no hardcoded "paused") ───────────
  // Derives a single user-facing status + supporting line from the real
  // trading-mode envelope. Falls back to "Checking" when state isn't known.
  const env = tradingMode.envelope;
  const approvalRaw = (env?.userApprovalStatus ?? env?.accountShellStatus?.approvalStatus ?? "").toUpperCase();
  const platform = (() => {
    if (!env) return { tone: "muted" as const, title: "Checking trading status", note: "ARX AI is verifying your bridge, permissions, and safety controls." };
    if (tradingMode.isFrozen) return { tone: "danger" as const, title: "Risk lock active", note: "Trading is paused by your account safety controls." };
    if (tradingMode.isDemo) return { tone: "primary" as const, title: "Demo mode active", note: "You can explore ARX AI without placing live broker orders." };
    if (approvalRaw && approvalRaw !== "APPROVED" && approvalRaw !== "ACTIVE") return { tone: "warning" as const, title: "Waiting for approval", note: "Your trading access must be approved before live trades can be placed." };
    if (tradingMode.cleanBlockedReason) return { tone: "warning" as const, title: "Bridge connection unavailable", note: "Market analysis may still work, but trading requires a connected MT5 bridge." };
    if (tradingMode.isLiveShared && tradingMode.canManualTrade) return { tone: "success" as const, title: "Live trading available", note: "Your account is approved and connected through the active trading route." };
    return { tone: "muted" as const, title: "Checking trading status", note: "ARX AI is verifying your bridge, permissions, and safety controls." };
  })();

  // Readiness chips — only truthful state; MT5 bridge has no direct field on
  // this envelope, so it reflects blocked-reason / live state / "Checking".
  const approvalChip = !env
    ? { label: "Checking", tone: "muted" as const }
    : (approvalRaw === "APPROVED" || approvalRaw === "ACTIVE")
      ? { label: "Approved", tone: "success" as const }
      : approvalRaw
        ? { label: "Pending", tone: "warning" as const }
        : { label: "Checking", tone: "muted" as const };
  const bridgeChip = !env
    ? { label: "Checking", tone: "muted" as const }
    : tradingMode.cleanBlockedReason
      ? { label: "Unavailable", tone: "danger" as const }
      : tradingMode.isLiveShared
        ? { label: "Connected", tone: "success" as const }
        : { label: "Checking", tone: "muted" as const };
  const riskChip = tradingMode.isFrozen
    ? { label: "Lock active", tone: "danger" as const }
    : { label: "Active", tone: "success" as const };
  const tourStatusLabel = (() => {
    const s = (status?.status ?? "").toUpperCase();
    if (s === "COMPLETED") return { label: "Completed", tone: "success" as const };
    if (s === "IN_PROGRESS") return { label: "In progress", tone: "primary" as const };
    if (s === "SKIPPED") return { label: "Skipped", tone: "muted" as const };
    return { label: "Not started", tone: "muted" as const };
  })();
  const stepNum = status ? Math.min(status.completedSteps.length + status.skippedSteps.length + 1, status.totalSteps || 1) : 1;
  const totalSteps = status?.totalSteps ?? 0;

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {/* App Shell 3.0: removed pinned bottom-left "Help / Tour" pill — it
          was overlapping the sidebar/risk-notice. Tour is now reachable from
          the FloatingHelpWidget ("Start app tour" row) via useOnboarding(). */}
      {bootstrapped ? null : null}

      {/* First-time onboarding modal */}
      <Dialog open={tourOpen} onOpenChange={setTourOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border-border bg-card p-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-5 pt-5">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <DialogTitle className="text-lg font-bold leading-tight">Welcome to ARX AI</DialogTitle>
                <DialogDescription className="text-sm text-txt-secondary">Your intelligent trading command center</DialogDescription>
              </div>
            </div>
          </div>

          {/* Brand hero */}
          <div className="flex items-center justify-center gap-3 px-5 pt-4">
            <ARXLogoMark size="lg" mode="dark" />
            <ARXWordmark mode="dark" size="lg" />
          </div>
          <div className="text-center text-sm font-semibold tracking-wide px-5">
            <span className="text-ruby-cyan">ANALYZE.</span>{" "}
            <span className="text-ruby">RISK.</span>{" "}
            <span className="text-foreground">e<span className="text-primary">X</span>ECUTE.</span>
          </div>

          {/* Feature cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 px-5 pt-4">
            <div className="rounded-xl border border-border bg-background/40 p-3 text-center">
              <span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-ruby-cyan/15 text-ruby-cyan ring-1 ring-ruby-cyan/25"><Search className="h-5 w-5" /></span>
              <div className="text-sm font-semibold"><span className="text-ruby-cyan">A</span> — Analyze</div>
              <div className="text-xs text-txt-secondary mt-0.5">Market scans, chart reads, trade ideas</div>
            </div>
            <div className="rounded-xl border border-border bg-background/40 p-3 text-center">
              <span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-ruby/15 text-ruby ring-1 ring-ruby/25"><Shield className="h-5 w-5" /></span>
              <div className="text-sm font-semibold"><span className="text-ruby">R</span> — Risk</div>
              <div className="text-xs text-txt-secondary mt-0.5">Risk Governor, limits, protection</div>
            </div>
            <div className="rounded-xl border border-border bg-background/40 p-3 text-center">
              <span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/25"><Zap className="h-5 w-5" /></span>
              <div className="text-sm font-semibold"><span className="text-primary">X</span> — Execute</div>
              <div className="text-xs text-txt-secondary mt-0.5">Guarded routing, trade prep, live execution</div>
            </div>
          </div>

          {/* Intro */}
          <div className="flex items-start gap-2.5 px-5 pt-4">
            <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">ARX AI helps you scan the market, protect your account, and execute disciplined trades.</p>
              <p className="text-xs text-txt-secondary mt-1">Live execution only works when your MT5 bridge, permissions, and account safety checks are ready.</p>
            </div>
          </div>

          {/* Trading Platform Status */}
          <div className="mx-5 mt-4 rounded-2xl border border-border bg-background/40 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Trading Platform Status</div>
                <div className="mt-2 flex items-start gap-2.5">
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full ring-1",
                    platform.tone === "success" ? "bg-success/15 text-success ring-success/30"
                    : platform.tone === "danger" ? "bg-danger/15 text-danger ring-danger/30"
                    : platform.tone === "warning" ? "bg-warning/15 text-warning ring-warning/30"
                    : platform.tone === "primary" ? "bg-primary/15 text-primary ring-primary/30"
                    : "bg-secondary text-txt-secondary ring-border")}>
                    <Pause className="h-4 w-4" />
                  </span>
                  <div>
                    <div className={cn("text-sm font-semibold",
                      platform.tone === "success" ? "text-success"
                      : platform.tone === "danger" ? "text-danger"
                      : platform.tone === "warning" ? "text-warning"
                      : platform.tone === "primary" ? "text-primary"
                      : "text-txt-secondary")}>{platform.title}</div>
                    <div className="text-xs text-txt-secondary mt-0.5">{platform.note}</div>
                  </div>
                </div>
              </div>
              <div className="space-y-1.5 sm:border-l sm:border-border sm:pl-4">
                <ChipRow icon={<Wifi className="h-3.5 w-3.5" />} label="MT5 Bridge" chip={bridgeChip} />
                <ChipRow icon={<UserCheck className="h-3.5 w-3.5" />} label="Account Approval" chip={approvalChip} />
                <ChipRow icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Risk Controls" chip={riskChip} />
                <ChipRow icon={<Flag className="h-3.5 w-3.5" />} label="Tour Progress" chip={tourStatusLabel} />
              </div>
            </div>
          </div>

          {/* Guided setup progress */}
          <div className="mx-5 mt-3 rounded-2xl border border-border bg-background/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ruby">Guided Setup</div>
                <div className="text-lg font-bold leading-tight">Step {stepNum}{totalSteps ? <> of {totalSteps}</> : null}</div>
              </div>
              {totalSteps > 0 && (
                <div className="flex flex-1 items-center gap-1.5 justify-end overflow-hidden">
                  {Array.from({ length: Math.min(totalSteps, 12) }).map((_, i) => (
                    <span key={i} className={cn("h-2 w-2 rounded-full", i < stepNum ? "bg-ruby" : "bg-secondary")} />
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-txt-secondary mt-1.5">We’ll walk you through ARX AI in a few quick steps.</p>
          </div>

          {/* Footer actions */}
          <div className="flex flex-col sm:flex-row gap-2 px-5 pt-4">
            <Button onClick={startTour} data-testid="button-onboarding-start" className="sm:flex-1 bg-primary text-white hover:bg-primary/90">
              <GraduationCap className="h-4 w-4 mr-2" />
              Start tour
            </Button>
            <Button variant="outline" onClick={skipForNow} data-testid="button-onboarding-skip" className="sm:flex-1">Skip for now</Button>
            <Button variant="ghost" onClick={dontShowAgain} data-testid="button-onboarding-never" className="sm:flex-1 text-txt-secondary">Don’t show again</Button>
          </div>

          {/* Safety note */}
          <div className="flex items-center gap-2 px-5 py-4 text-xs text-txt-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-success shrink-0" />
            Your safety settings stay active whether you start the tour or skip it. ARX AI never places trades without your confirmation.
          </div>
        </DialogContent>
      </Dialog>

      {/* Feature announcement popup */}
      <Dialog open={activeAnn !== null} onOpenChange={(open) => { if (!open) setActiveAnn(null); }}>
        <DialogContent className="max-w-lg">
          {activeAnn && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5 text-primary" />
                  {activeAnn.title}
                </DialogTitle>
                <DialogDescription>
                  <Badge variant={activeAnn.severity === "critical" ? "destructive" : activeAnn.severity === "warning" ? "outline" : "secondary"} className="mr-2">
                    {activeAnn.severity}
                  </Badge>
                  v{activeAnn.version}
                </DialogDescription>
              </DialogHeader>
              <div className="text-sm leading-relaxed whitespace-pre-line">{activeAnn.body}</div>
              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button variant="ghost" onClick={() => dontShowAnn(activeAnn)} data-testid="button-ann-dismiss">Don't show again</Button>
                <Button variant="outline" onClick={() => remindLater(activeAnn)} data-testid="button-ann-remind">Remind me later</Button>
                {activeAnn.route && (
                  <Button variant="outline" onClick={() => viewFeature(activeAnn)} data-testid="button-ann-view">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    View feature
                  </Button>
                )}
                <Button onClick={() => gotIt(activeAnn)} data-testid="button-ann-ack">Got it</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
