import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { GraduationCap, Check, SkipForward, RotateCcw, ShieldOff, Lock, BookOpen } from "lucide-react";
import { useCanOpenRoute } from "@/lib/useCanOpenRoute";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

/** `page_route` mirrors the server catalogue (lib/onboarding/steps.ts): a real
 *  trader-reachable route, or null = no page. Each link is additionally
 *  re-checked against THIS viewer's tier before rendering (useCanOpenRoute) —
 *  the same RANK 51 second line of defence the Help Center uses, so a pending
 *  trader is never offered a link RouteAccessGuard would silently bounce. */
interface Step { step_id: string; title: string; description: string; page_route: string | null; action_type: string; required: boolean; help_text: string; safety_note: string }

interface Status {
  onboardingId: string; status: string; currentStep: string | null;
  completedSteps: string[]; skippedSteps: string[];
  paperOnlyAcknowledged: boolean; liveDisabledAcknowledged: boolean; riskDisclaimerAcknowledged: boolean;
  replaySimulationAcknowledged: boolean; brokerReadonlyAcknowledged: boolean; walkthroughCompleted: boolean;
  totalSteps: number; nextStep: string | null;
}

/** Real per-user account-level live status from the server; UNKNOWN = read failed. */
interface LiveTradingInfo { status: "ALLOWED" | "BLOCKED" | "UNKNOWN"; reasons: string[] }

const ACK_LABELS: { key: keyof Status; text: string }[] = [
  { key: "paperOnlyAcknowledged", text: "I understand my trading mode (Trading Off / Demo Trading Active / Live Trading Active) is set by my admin." },
  { key: "liveDisabledAcknowledged", text: "I understand live trading is only enabled by admin approval, and I cannot unlock it myself." },
  { key: "riskDisclaimerAcknowledged", text: "I understand demo results do not guarantee live results." },
  { key: "replaySimulationAcknowledged", text: "I understand replay results are simulation only." },
  { key: "brokerReadonlyAcknowledged", text: "I understand the broker connection is read-only." },
];

/** CONFIDENT_ABSENT fix: this used to `return r.json()` regardless of r.ok, so
 *  an error envelope (or a 500 HTML body) resolved to an object with no
 *  `status`, `setStatus(undefined)` left the page on "Loading onboarding…"
 *  forever, and a failed acknowledgement looked exactly like a successful one.
 *  A failed read must be an error, never a silent empty answer. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { "content-type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${path} — HTTP ${r.status}`);
  return r.json();
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the read failed");

export default function OnboardingPage() {
  const canOpen = useCanOpenRoute();
  const [status, setStatus] = useState<Status | null>(null);
  const [liveTrading, setLiveTrading] = useState<LiveTradingInfo | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [s, sd] = await Promise.all([
        api<{ status: Status; liveTrading?: LiveTradingInfo }>("/api/onboarding/status"),
        api<{ steps: Step[] }>("/api/onboarding/steps"),
      ]);
      if (!s?.status) throw new Error("/api/onboarding/status returned no status");
      setStatus(s.status); setLiveTrading(s.liveTrading ?? null); setSteps(Array.isArray(sd?.steps) ? sd.steps : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    }
  }
  useEffect(() => { refresh(); document.title = "Onboarding — ARX AI"; }, []);

  if (!status) {
    // A failed read is reported as a failed read. It is NOT "still loading",
    // and it is NOT a fresh/zeroed onboarding.
    if (loadError) {
      return (
        <Alert variant="destructive" data-testid="onboarding-load-error">
          <AlertTitle>Couldn't load onboarding</AlertTitle>
          <AlertDescription className="text-xs space-y-2">
            <p>Your onboarding status could not be read, so none of it is known — this is a failed read, not a reset or completed onboarding. Your trading mode is unchanged either way.</p>
            <p className="font-mono text-[10px]">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => { setLoadError(null); refresh(); }}>Retry</Button>
          </AlertDescription>
        </Alert>
      );
    }
    return <div className="text-sm text-muted-foreground">Loading onboarding…</div>;
  }

  const completed = new Set(status.completedSteps);
  const skipped = new Set(status.skippedSteps);
  const completedCount = completed.size + skipped.size;
  const pct = Math.round((completedCount / Math.max(1, status.totalSteps)) * 100);

  /** Every mutation reports its own failure and always clears `busy`, so a
   *  rejected write can never leave the page silently stuck mid-action or
   *  looking as though it succeeded. */
  async function run(key: string, path: string, body: unknown) {
    setBusy(key); setActionError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      setActionError(errText(e));
    } finally {
      await refresh();
      setBusy(null);
    }
  }
  const start = () => run("start", "/api/onboarding/start", {});
  const complete = (step_id: string) => run(step_id, "/api/onboarding/complete-step", { stepId: step_id });
  const skip = (step_id: string) => run(step_id, "/api/onboarding/skip-step", { stepId: step_id });
  const reset = () => run("reset", "/api/onboarding/reset", {});
  const ack = (key: string) => run(key, "/api/onboarding/acknowledge", { key });

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="bg-primary/15 text-primary border-primary/30"><Lock className="h-3 w-3 mr-1" />ADMIN-CONTROLLED MODE</Badge>
        {/* Real per-user live status, read server-side — three honest states. */}
        {liveTrading?.status === "ALLOWED" && (
          <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/30" data-testid="badge-live-allowed"><ShieldOff className="h-3 w-3 mr-1" />LIVE TRADING AVAILABLE — real money risk</Badge>
        )}
        {liveTrading?.status === "BLOCKED" && (
          <Badge variant="outline" data-testid="badge-live-blocked">Live trading blocked for your account</Badge>
        )}
        {(!liveTrading || liveTrading.status === "UNKNOWN") && (
          <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30" data-testid="badge-live-unknown">Live status unknown — couldn't read it</Badge>
        )}
      </div>
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><GraduationCap className="h-5 w-5" />Guided Onboarding</h1>
        <p className="text-xs text-muted-foreground">Learn how to safely operate the ARX AI trading workflow. Acknowledgements never bypass admin-set trading mode.</p>
      </div>

      {/* A refresh that failed AFTER the first successful read leaves stale
          numbers on screen — say so rather than presenting them as current. */}
      {loadError && (
        <Alert variant="destructive" data-testid="onboarding-refresh-error">
          <AlertTitle>Onboarding couldn't be re-read — showing the last known state</AlertTitle>
          <AlertDescription className="text-xs space-y-2">
            <p className="font-mono text-[10px]">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => { setLoadError(null); refresh(); }}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive" data-testid="onboarding-action-error">
          <AlertTitle>That didn't go through</AlertTitle>
          <AlertDescription className="text-xs"><span className="font-mono text-[10px]">{actionError}</span> — nothing was recorded. Your trading mode is unchanged.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Progress
            <span className="text-xs font-mono">{completedCount} / {status.totalSteps} ({pct}%) — {status.status}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Progress value={pct} />
          <div className="flex flex-wrap gap-2">
            {status.status === "NOT_STARTED" && <Button onClick={start} disabled={busy !== null}>Start Onboarding</Button>}
            {status.status !== "NOT_STARTED" && <Button variant="outline" onClick={reset} disabled={busy !== null}><RotateCcw className="h-3 w-3 mr-1" />Reset</Button>}
          </div>
          {/* "Use the Trading Cockpit as your home base" named a page removed in
              Phase 3 — the real home base is the cockpit home page at "/". */}
          {status.walkthroughCompleted && (
            <Alert><AlertTitle>Onboarding complete</AlertTitle><AlertDescription className="text-xs">Onboarding never changes your trading mode — check the mode chip for your current mode. Your home base is the cockpit — the app home page.</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Safety acknowledgements</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {ACK_LABELS.map(({ key, text }) => {
            const checked = !!status[key];
            return (
              <label key={key as string} className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox checked={checked} disabled={checked || busy !== null} onCheckedChange={() => !checked && ack(key as string)} />
                <span>{text}</span>
              </label>
            );
          })}
          <p className="text-[10px] italic text-muted-foreground">These acknowledgements are stored. They never enable live trading.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BookOpen className="h-4 w-4" />Steps</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {steps.map((s, i) => {
            const isCompleted = completed.has(s.step_id);
            const isSkipped = skipped.has(s.step_id);
            const isCurrent = status.currentStep === s.step_id;
            return (
              <div key={s.step_id} className={`border rounded-md p-3 ${isCurrent ? "border-primary/50 bg-primary/5" : ""}`}>
                <div className="flex items-start gap-2">
                  <div className="text-xs font-mono text-muted-foreground w-6">{i + 1}.</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-sm">{s.title}</h4>
                      {s.required && <Badge variant="outline" className="text-[10px]">REQUIRED</Badge>}
                      {isCompleted && <Badge variant="outline" className="text-[10px] bg-success/15 text-success border-success/30"><Check className="h-3 w-3 mr-0.5" />Done</Badge>}
                      {isSkipped && <Badge variant="outline" className="text-[10px]">Skipped</Badge>}
                      {isCurrent && !isCompleted && <Badge variant="outline" className="text-[10px] bg-primary/15">Current</Badge>}
                    </div>
                    <p className="text-xs mt-1">{s.description}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">{s.help_text}</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {!isCompleted && <Button size="sm" variant="outline" onClick={() => complete(s.step_id)} disabled={busy !== null}><Check className="h-3 w-3 mr-1" />Mark complete</Button>}
                      {!isCompleted && !isSkipped && !s.required && <Button size="sm" variant="ghost" onClick={() => skip(s.step_id)} disabled={busy !== null}><SkipForward className="h-3 w-3 mr-1" />Skip</Button>}
                      {/* Link only when the route exists AND this viewer's tier can
                          actually open it — a link RouteAccessGuard would silently
                          bounce home must render NO link, never a dead one. */}
                      {s.page_route && s.page_route !== "/onboarding" && canOpen(s.page_route) && (
                        <Link className="text-xs underline self-center" href={s.page_route}>Open {s.page_route} →</Link>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* The old footer stamped "DEMO_ONLY · LIVE TRADING DISABLED" unconditionally —
          a fabricated claim on a build where live mode is admin-settable. */}
      <p className="text-[10px] text-muted-foreground text-center">onboarding_id {status.onboardingId} · onboarding never changes your trading mode</p>
    </div>
  );
}
