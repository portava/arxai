import { Button } from "@/components/ui/button";

export function ReviewedOrderCallout({ symbol, onOpen }: { symbol: string; onOpen: () => void }) {
  return <div className="arx-order-entry-content">
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-sm font-semibold text-slate-100">{symbol}</span>
      <span className="text-[10px] text-slate-400">Review only · no order sent</span>
    </div>
    <Button type="button" onClick={onOpen} aria-label={`Open reviewed order flow for ${symbol}`} className="mt-2 h-9 w-full bg-cyan-300 text-slate-950 hover:bg-cyan-200">Review order</Button>
  </div>;
}
