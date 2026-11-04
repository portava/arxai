/**
 * Trading School — single Practice Lab page (/school/labs/:labId). Resolves a
 * lab id from buildPracticeLabs and renders its interactive body. All labs use
 * made-up practice data; completion is recorded with markLabAttempted (the
 * existing labsAttempted progress field). Renders inside AppLayout.
 */
import { useEffect, useMemo } from "react";
import { Link, useRoute } from "wouter";
import { buildPracticeLabs } from "../data/content";
import { SCENARIO_LABS } from "../data/labs";
import { markLabAttempted } from "../lib/progress";
import { SchoolPageHeader, SchoolDisclaimer } from "../components/SchoolUI";
import { ScenarioQuizLab } from "../components/labs/ScenarioQuizLab";
import { EntryStopTargetLab } from "../components/labs/EntryStopTargetLab";
import { SupportResistanceLab } from "../components/labs/SupportResistanceLab";
import { TradePlanLab } from "../components/labs/TradePlanLab";
import { LAB_ICONS } from "../components/labs/labIcons";
import TradingSchoolRiskSimulator from "./TradingSchoolRiskSimulator";
import { useAssistantName } from "@/lib/assistant-name";
import { ArrowLeft, FlaskConical } from "lucide-react";

/** Renders the interactive body for a lab id, or null for an unknown id. */
export function LabBody({ labId }: { labId: string }) {
  const record = () => markLabAttempted(labId);
  const scenarioLab = SCENARIO_LABS[labId];
  if (scenarioLab) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-txt-secondary">{scenarioLab.intro}</p>
        <ScenarioQuizLab key={labId} lab={scenarioLab} onComplete={record} />
      </div>
    );
  }
  switch (labId) {
    case "lab-entry-sl-tp": return <EntryStopTargetLab onChecked={record} />;
    case "lab-support-resistance": return <SupportResistanceLab onChecked={record} />;
    case "lab-trade-plan": return <TradePlanLab onScored={record} />;
    default: return null;
  }
}

export default function TradingSchoolLab() {
  const { name } = useAssistantName();
  const labs = useMemo(() => buildPracticeLabs(name), [name]);
  const [, params] = useRoute("/school/labs/:labId");
  const labId = params?.labId ?? "";
  const lab = labs.find((l) => l.id === labId);

  useEffect(() => {
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try { window.scrollTo(0, 0); } catch { /* jsdom */ }
    }
  }, [labId]);

  const back = (
    <Link href="/school/labs" className="inline-flex items-center gap-1.5 text-xs font-medium text-txt-secondary hover:text-primary">
      <ArrowLeft className="h-3.5 w-3.5" /> All practice labs
    </Link>
  );

  // The risk calculator lab is the existing Risk Simulator page.
  if (labId === "lab-risk-calculator") {
    return (
      <div data-testid="page-school-lab" data-lab-id={labId}>
        <div className="mx-auto w-full max-w-[900px] px-4 pt-4 md:px-6 md:pt-6">{back}</div>
        <TradingSchoolRiskSimulator />
      </div>
    );
  }

  if (!lab) {
    return (
      <div className="mx-auto w-full max-w-[900px] space-y-4 p-4 md:p-6" data-testid="page-school-lab-missing">
        {back}
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <div className="text-sm font-semibold text-foreground">That lab doesn't exist</div>
          <p className="mt-1 text-xs text-txt-muted">Pick one from the Practice Labs list.</p>
        </div>
      </div>
    );
  }

  const Icon = LAB_ICONS[lab.id] ?? FlaskConical;
  return (
    <div className="mx-auto w-full max-w-[900px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-lab" data-lab-id={lab.id}>
      {back}
      <SchoolPageHeader title={lab.title} subtitle={lab.blurb} icon={Icon} />
      <div className="inline-flex rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
        Practice scenarios with made-up data — not live market data
      </div>
      <LabBody labId={lab.id} />
      <div className="rounded-2xl border border-border bg-background/40 p-4">
        <SchoolDisclaimer text="Practice Labs are for education only. Scenarios and charts are invented for learning, they do not place trades, and a good practice score does not predict real results. Trading involves risk." />
      </div>
    </div>
  );
}
