import { Button } from "@/components/ui/button";

export function ReviewedOrderCallout({ symbol, onOpen }: { symbol: string; onOpen: () => void }) {
  return <div className="arx-order-entry-content">
    <div className="mb-2 flex items-center justify-between gap-2"><div><span className="mr-2 text-[9px] uppercase tracking-wide text-slate-500">Market</span><span className="text-xs font-semibold text-slate-200">{symbol}</span></div><span className="text-[10px] text-slate-400">No order sent</span></div>
    <p className="text-xs leading-relaxed text-slate-300">Open the existing, permission-gated Trade Command Room in this workspace. The selected market is shared through the chart symbol bus.</p>
    <Button type="button" onClick={onOpen} aria-label={`Open reviewed order flow for ${symbol}`} className="mt-3 h-9 w-full bg-cyan-300 text-slate-950 hover:bg-cyan-200">Review {symbol} setup</Button>
  </div>;
}
