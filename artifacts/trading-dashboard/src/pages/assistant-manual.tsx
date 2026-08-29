import { useEffect, useMemo, useState } from "react";
import { compileKnowledge, auditKnowledge, type CompiledItem } from "@/knowledge/knowledgeCompiler";
import { GLOSSARY } from "@/knowledge/glossary";
import { WALKTHROUGHS } from "@/knowledge/walkthroughs";

type GateState = "loading" | "allowed" | "denied" | "error";

const SECTIONS: { type: CompiledItem["type"]; label: string }[] = [
  { type: "route", label: "Routes" },
  { type: "element", label: "UI elements" },
  { type: "badge", label: "Badges & statuses" },
  { type: "safety", label: "Safety locks & refusals" },
  { type: "workflow", label: "Walkthroughs" },
  { type: "troubleshooting", label: "Troubleshooting" },
  { type: "command", label: "Commands" },
];

export default function AssistantManualPage() {
  const [gate, setGate] = useState<GateState>("loading");
  const items = useMemo(() => compileKnowledge(), []);
  const audit = useMemo(() => auditKnowledge(), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/feedback", { credentials: "include" })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setGate("allowed");
        // Fail closed: any non-ok response (403, 401, 5xx, network) hides the manual.
        else setGate("denied");
      })
      .catch(() => !cancelled && setGate("denied"));
    return () => { cancelled = true; };
  }, []);

  if (gate === "loading") {
    return <div className="p-6 text-sm text-txt-secondary" data-testid="assistant-manual-loading">Loading…</div>;
  }
  if (gate === "denied" || gate === "error") {
    return (
      <div className="p-6 max-w-2xl" data-testid="assistant-manual-denied">
        <h1 className="text-xl font-semibold mb-2">Assistant App Manual</h1>
        <p className="text-sm text-txt-secondary">
          The full diagnostic manual is restricted to TESTER, ADMIN, and OWNER roles. Sign in with a higher-permission account to view it.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="assistant-manual">
      <header>
        <h1 className="text-2xl font-semibold">ARX Assistant Manual</h1>
        <p className="text-sm text-txt-secondary">
          Internal manual generated from the compiled knowledge index. Read-only diagnostics — never enables live trading or bypasses any safety lock.
        </p>
        <p className="text-xs text-txt-muted mt-1">
          {items.length} compiled items · audit score <span className="font-mono">{audit.score}/100</span> · {GLOSSARY.length} glossary terms · {WALKTHROUGHS.length} walkthroughs
        </p>
      </header>

      <section data-testid="manual-overview" className="rounded border border-border p-4">
        <h2 className="font-medium mb-2">What is ARX AI?</h2>
        <p className="text-sm text-txt-secondary">
          ARX AI is a demo-first trading command center built around three disciplines: Analyze, Risk, eXecute.
          Every screen reflects one of those three. The bot operates in demo mode by default and never sends
          real broker orders unless a separately-configured MT5 bridge is enabled — and even then, server-side locks
          (LIVE TRADING DISABLED, BROKER READ-ONLY, EMERGENCY STOP) must individually be cleared.
        </p>
      </section>

      {SECTIONS.map((sec) => {
        const subset = items.filter((i) => i.type === sec.type);
        if (!subset.length) return null;
        return (
          <section key={sec.type} data-testid={`manual-section-${sec.type}`} className="rounded border border-border p-4">
            <h2 className="font-medium mb-2">{sec.label} <span className="text-xs text-txt-muted">({subset.length})</span></h2>
            <ul className="space-y-2">
              {subset.map((it) => (
                <li key={it.id} className="text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-txt-muted">{it.id}</span>
                    <span className="font-medium">{it.title}</span>
                    {it.completeness < 0.5 && (
                      <span className="text-[10px] uppercase rounded bg-warning/40 text-warning px-1.5 py-0.5">draft</span>
                    )}
                  </div>
                  <p className="text-txt-secondary">{it.explanation}</p>
                  {it.safetyNote && <p className="text-xs text-warning mt-1">Safety: {it.safetyNote}</p>}
                  {it.relatedRoutes.length > 0 && (
                    <p className="text-xs text-txt-muted mt-1">Related: {it.relatedRoutes.join(", ")}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section data-testid="manual-glossary" className="rounded border border-border p-4">
        <h2 className="font-medium mb-2">Glossary <span className="text-xs text-txt-muted">({GLOSSARY.length})</span></h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {GLOSSARY.map((g) => (
            <div key={g.id}>
              <dt className="font-medium">{g.term}</dt>
              <dd className="text-txt-secondary">{g.definition}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section data-testid="manual-limits" className="rounded border border-border p-4">
        <h2 className="font-medium mb-2">Assistant limits</h2>
        <ul className="list-disc pl-5 text-sm text-txt-secondary space-y-1">
          <li>Cannot enable live trading or place real broker orders.</li>
          <li>Cannot reveal env vars, secrets, API keys, or broker credentials.</li>
          <li>Cannot change your role or bypass server-enforced permissions.</li>
          <li>Cannot disable Emergency Stop, the risk lock, or skip readiness gates.</li>
          <li>Will refuse trade-direction advice ("buy/sell now").</li>
          <li>Will say "I don't have that confirmed in the current ARX app state" rather than guess.</li>
        </ul>
      </section>
    </div>
  );
}
