import { TradePlanBuilderPanel } from "@/components/tradePlan";

export default function TradePlanBuilderPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">AI Trade Plan Builder</h1>
        <p className="text-sm text-txt-secondary">
          Compose a written plan, run the pre-trade checklist, and convert it into a recorded execution
          confirmation when ready. This page never places an order — live orders are placed from the Live
          Trading ticket, where the server-side dispatch gate runs on every press.
        </p>
      </header>
      <TradePlanBuilderPanel />
    </div>
  );
}
