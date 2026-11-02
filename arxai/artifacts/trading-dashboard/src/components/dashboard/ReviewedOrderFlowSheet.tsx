import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function ReviewedOrderFlowSheet({
  open, onOpenChange, symbol,
}: { open: boolean; onOpenChange: (open: boolean) => void; symbol: string }) {
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="flex h-[94dvh] w-full flex-col border-slate-700 bg-[#07111a] p-0 text-slate-100 sm:max-w-5xl">
      <SheetHeader className="shrink-0 border-b border-slate-700 px-4 py-3">
        <SheetTitle className="text-slate-100">Reviewed order · {symbol}</SheetTitle>
      </SheetHeader>
      <iframe title={`Trade Command Room for ${symbol}`} src="/trade-command-room" className="min-h-0 w-full flex-1 border-0 bg-background" data-testid="trade-command-room-frame"/>
      <div className="shrink-0 border-t border-slate-700 px-4 py-2 text-xs text-slate-400">
        Existing permission-gated flow, using the shared market {symbol}. <a href="/trade-command-room" target="_blank" rel="noopener noreferrer" className="ml-1 text-cyan-300 underline">Open in a new tab</a>
      </div>
    </SheetContent>
  </Sheet>;
}
