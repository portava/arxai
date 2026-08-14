import { TradePlanBuilderPanel } from "@/components/tradePlan";

export default function TradePlanBuilderPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">AI Trade Plan Builder</h1>
        <p className="text-sm text-slate-400">
          Compose a written plan, run the pre-trade checklist, and convert to a confirmation when ready.
          Final execution remains gated by the live-execution safety layer.
        </p>
      </header>
      <TradePlanBuilderPanel />
    </div>
  );
}
