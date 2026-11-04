/**
 * Trading School — Practice Labs. Lists every lab; each card opens its
 * interactive lab at /school/labs/:labId (the Risk Calculator lab is the Risk
 * Simulator). Labs you've finished at least once show "Practised".
 * Renders inside AppLayout.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { buildPracticeLabs } from "../data/content";
import { SchoolPageHeader } from "../components/SchoolUI";
import { LAB_ICONS } from "../components/labs/labIcons";
import { useSchoolProgress } from "../lib/progress";
import { useAssistantName } from "@/lib/assistant-name";
import { FlaskConical, ArrowRight, CheckCircle2 } from "lucide-react";

export default function TradingSchoolLabs() {
  const { name } = useAssistantName();
  const labs = useMemo(() => buildPracticeLabs(name), [name]);
  const progress = useSchoolProgress();
  const practised = new Set(progress.labsAttempted);

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-labs">
      <SchoolPageHeader title="Practice Labs" subtitle="Hands-on practice to turn lessons into skills." icon={FlaskConical} />
      <p className="text-xs text-txt-muted">Every lab uses made-up practice scenarios — never live market data — so you can make mistakes safely.</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {labs.map((l) => {
          const Icon = LAB_ICONS[l.id] ?? FlaskConical;
          return (
            <Link key={l.id} href={`/school/labs/${l.id}`} data-testid={`lab-card-${l.id}`}
              className="group flex flex-col rounded-2xl border border-primary/30 bg-card p-4 transition-colors hover:border-primary/50">
              <Icon className="h-5 w-5 text-primary" />
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">{l.title}</div>
                <ArrowRight className="h-4 w-4 shrink-0 text-primary transition-transform group-hover:translate-x-1" />
              </div>
              <p className="text-xs text-txt-muted">{l.blurb}</p>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
                <span className="inline-flex rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">Available</span>
                {practised.has(l.id) && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    <CheckCircle2 className="h-3 w-3" /> Practised
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
