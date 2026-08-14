import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert, AlertTriangle } from "lucide-react";

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
  liveTradingStatus: "DISABLED";
  generatedAt: string;
}

export function WhyBlockedDrawer({ defaultAction = "START_PAPER_SESSION" as BlockedAction, trigger }: { defaultAction?: BlockedAction; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<BlockedAction>(defaultAction);
  const [exp, setExp] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(a: BlockedAction) {
    setLoading(true); setAction(a);
    const r = await fetch(`${BASE}/api/help/why-blocked`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockedAction: a }) });
    const d = await r.json();
    setExp(d.explanation ?? null);
    setLoading(false);
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
            <SheetDescription>Plain-English safety explanation. Live trading remains DISABLED.</SheetDescription>
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
            {!loading && exp && (
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
                {exp.links.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {exp.links.map((l, i) => <a key={i} className="text-xs underline" href={`${BASE}${l.href}`}>{l.label} →</a>)}
                  </div>
                )}
                <details className="text-[10px] text-muted-foreground">
                  <summary className="cursor-pointer">Technical detail</summary>
                  <ul className="pl-4 mt-1 space-y-0.5 font-mono">{exp.technicalReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </details>
                <p className="text-[10px] italic text-muted-foreground">explanation_id {exp.explanation_id} · {new Date(exp.generatedAt).toLocaleString()} · liveTradingStatus=DISABLED</p>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
