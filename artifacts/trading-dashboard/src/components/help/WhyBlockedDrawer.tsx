import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Link } from "wouter";
import { ShieldAlert, AlertTriangle } from "lucide-react";
import { isHumanTraderAllowedPath } from "@/lib/routeAccess";
import { useTraderTier } from "@/hooks/useTraderTier";
import { useViewMode } from "@/hooks/useViewMode";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type BlockedAction = "START_PAPER_SESSION" | "START_AUTOPILOT" | "OPEN_PAPER_TRADE" | "ENABLE_LIVE_TRADING" | "USE_BROKER_EXECUTION";

interface Explanation {
  explanation_id: string;
  blockedAction: BlockedAction;
  blockingSystems: string[];
  highestSeverity: "INFO" | "WARN" | "BLOCK" | "CRITICAL";
  plainEnglishReasons: string[];
  technicalReasons: string[];
  recommendedFixes: string[];
  safeNextStep: string;
  links: { label: string; href: string }[];
  // RANK 4: this was the literal type "DISABLED" — the shape could not express
  // any other answer, on a build that dispatches real broker orders. The server
  // now reports the user's real state, including UNKNOWN when a read failed.
  liveTradingStatus: "ALLOWED" | "BLOCKED" | "UNKNOWN";
  generatedAt: string;
}

const LIVE_STATUS_COPY: Record<Explanation["liveTradingStatus"], string> = {
  ALLOWED: "Live trading: every account-level prerequisite is met on your account. Individual orders are still gated.",
  BLOCKED: "Live trading: at least one prerequisite is not met — the reasons are listed below.",
  UNKNOWN: "Live trading: your status could not be read. Treat this as unknown, not as safe.",
};

export function WhyBlockedDrawer({ defaultAction = "START_PAPER_SESSION" as BlockedAction, trigger }: { defaultAction?: BlockedAction; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<BlockedAction>(defaultAction);
  const [exp, setExp] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isApprovedTrader } = useTraderTier();
  const visibleLinks = (exp?.links ?? []).filter(
    (l) => isAdmin || isHumanTraderAllowedPath(l.href, { isApprovedTrader }),
  );

  /** CONFIDENT_ABSENT fix: this ignored `r.ok` and had no catch, so a failed
   *  read set `exp` to null and — once "Loading…" cleared — rendered an empty
   *  drawer body with no explanation and no reason why. A drawer whose whole
   *  job is to say what is blocking you must say "I couldn't find out" out
   *  loud, never go blank. */
  async function load(a: BlockedAction) {
    setLoading(true); setAction(a); setError(null);
    try {
      const r = await fetch(`${BASE}/api/help/why-blocked`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockedAction: a }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d?.explanation) throw new Error("the server returned no explanation");
      setExp(d.explanation as Explanation);
    } catch (e) {
      setExp(null);
      setError(e instanceof Error ? e.message : "the read failed");
    } finally {
      setLoading(false);
    }
  }

  function openWith(a: BlockedAction) { setOpen(true); load(a); }

  return (
    <>
      <span onClick={() => openWith(defaultAction)}>
        {trigger ?? <Button variant="outline" size="sm"><ShieldAlert className="h-4 w-4 mr-1" />Why am I blocked?</Button>}
      </span>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" />Why am I blocked?</SheetTitle>
            {/* RANK 4: this line read "Live trading remains DISABLED." on every
                open, regardless of the user's actual mode. */}
            <SheetDescription>Plain-English explanation of what is stopping this action, and what would change it.</SheetDescription>
          </SheetHeader>
          <div className="mt-3 flex flex-wrap gap-1">
            {(["START_PAPER_SESSION","START_AUTOPILOT","OPEN_PAPER_TRADE","ENABLE_LIVE_TRADING","USE_BROKER_EXECUTION"] as BlockedAction[]).map(a => {
              const label = a === "START_PAPER_SESSION" ? "START_DEMO_SESSION" : a === "OPEN_PAPER_TRADE" ? "OPEN_DEMO_TRADE" : a;
              return (
                <Button key={a} size="sm" variant={action === a ? "default" : "outline"} onClick={() => load(a)} className="text-[11px] h-7">{label}</Button>
              );
            })}
          </div>
          <div className="mt-4 space-y-3">
            {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {!loading && error && (
              <Alert variant="destructive" data-testid="why-blocked-error">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Couldn't load the explanation</AlertTitle>
                <AlertDescription className="text-xs space-y-2">
                  <p>Nothing is known about what is blocking <span className="font-mono">{action}</span> right now — treat that as unknown, not as allowed.</p>
                  <p className="font-mono text-[10px]">{error}</p>
                  <Button size="sm" variant="outline" onClick={() => load(action)}>Retry</Button>
                </AlertDescription>
              </Alert>
            )}
            {!loading && !error && exp && (
              <>
                <Alert variant={exp.highestSeverity === "CRITICAL" || exp.highestSeverity === "BLOCK" ? "destructive" : "default"}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{exp.blockedAction} — {exp.highestSeverity}</AlertTitle>
                  <AlertDescription className="text-xs">
                    Blocking systems: {exp.blockingSystems.join(", ") || "none"}
                  </AlertDescription>
                </Alert>
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Why</div>
                  <ul className="text-sm list-disc pl-5 space-y-1">{exp.plainEnglishReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Recommended fixes</div>
                  <ul className="text-sm list-disc pl-5 space-y-1">{exp.recommendedFixes.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
                <div className="text-xs"><span className="font-semibold">Safest next step: </span>{exp.safeNextStep}</div>
                {/* RANK 51: these were plain <a href> full page loads, and the
                    old link set pointed at /trading-cockpit, /risk-settings and
                    /paper-testing-launch — routes that either do not exist or
                    are not on any trader allowlist, so the click silently
                    bounced the user home. wouter <Link> now, and only rendered
                    when the destination is reachable for THIS viewer's tier. */}
                {visibleLinks.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {visibleLinks.map((l, i) => <Link key={i} className="text-xs underline" href={l.href}>{l.label} →</Link>)}
                  </div>
                )}
                <details className="text-[10px] text-muted-foreground">
                  <summary className="cursor-pointer">Technical detail</summary>
                  <ul className="pl-4 mt-1 space-y-0.5 font-mono">{exp.technicalReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </details>
                <p className="text-xs text-muted-foreground">{LIVE_STATUS_COPY[exp.liveTradingStatus]}</p>
                <p className="text-[10px] italic text-muted-foreground">explanation_id {exp.explanation_id} · {new Date(exp.generatedAt).toLocaleString()}</p>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
