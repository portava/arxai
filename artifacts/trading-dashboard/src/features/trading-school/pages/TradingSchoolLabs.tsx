/**
 * Trading School — Practice Labs. Lists labs; the Risk Calculator lab links to
 * the working Risk Simulator, the rest show clean "Coming next" states (no dead
 * buttons). Renders inside AppLayout.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { buildPracticeLabs } from "../data/content";
import { SchoolPageHeader, ComingNextState } from "../components/SchoolUI";
import { useAssistantName } from "@/lib/assistant-name";
import { FlaskConical, Calculator, ArrowRight } from "lucide-react";

export default function TradingSchoolLabs() {
  const { name } = useAssistantName();
  const PRACTICE_LABS = useMemo(() => buildPracticeLabs(name), [name]);
  const available = PRACTICE_LABS.filter((l) => l.status === "available");
  const coming = PRACTICE_LABS.filter((l) => l.status === "coming-next");

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-labs">
      <SchoolPageHeader title="Practice Labs" subtitle="Hands-on practice to turn lessons into skills." icon={FlaskConical} />

      {available.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((l) => (
            <Link key={l.id} href="/school/risk-simulator" className="group rounded-2xl border border-primary/30 bg-card p-4 transition-colors hover:border-primary/50">
              <Calculator className="h-5 w-5 text-primary" />
              <div className="mt-2 flex items-center justify-between">
                <div className="text-sm font-semibold">{l.title}</div>
                <ArrowRight className="h-4 w-4 text-primary transition-transform group-hover:translate-x-1" />
              </div>
              <p className="text-xs text-txt-muted">{l.blurb}</p>
              <span className="mt-2 inline-flex rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">Available</span>
            </Link>
          ))}
        </div>
      )}

      <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">More labs on the way</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {coming.map((l) => (
          <ComingNextState key={l.id} title={l.title} blurb={l.blurb} />
        ))}
      </div>
    </div>
  );
}
