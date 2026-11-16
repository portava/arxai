import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function ReviewedOrderFlowSheet({
  open, onOpenChange, symbol,
}: { open: boolean; onOpenChange: (open: boolean) => void; symbol: string }) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    if (!open) setFrameLoaded(false);
  }, [open]);

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="flex h-[94dvh] w-full flex-col border-slate-700 bg-[#07111a] p-0 text-slate-100 sm:max-w-5xl">
      <SheetHeader className="shrink-0 border-b border-slate-700 px-4 py-3">
        <SheetTitle className="text-slate-100">Reviewed order · {symbol}</SheetTitle>
      </SheetHeader>
      <div className="relative flex min-h-0 w-full flex-1">
        <iframe
          title={`Trade Command Room for ${symbol}`}
          src="/trade-command-room"
          onLoad={() => setFrameLoaded(true)}
          aria-busy={!frameLoaded}
          className="min-h-0 w-full flex-1 border-0 bg-background"
          data-testid="trade-command-room-frame"
        />
        {!frameLoaded && (
          <div
            className="absolute inset-0 z-10 grid place-items-center bg-[#07111a] px-5 text-center"
            role="status"
            aria-live="polite"
            data-testid="reviewed-order-loading"
          >
            <div className="space-y-3">
              <Loader2 size={22} className="mx-auto animate-spin text-cyan-300" aria-hidden="true"/>
              <p className="text-sm font-medium text-slate-100">Loading the existing reviewed-order flow…</p>
              <p className="text-xs text-slate-400">The first load can take a few seconds. Trading permissions and review gates remain in effect.</p>
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-slate-700 px-4 py-2 text-xs text-slate-400">
        Existing permission-gated flow, using the shared market {symbol}. <a href="/trade-command-room" target="_blank" rel="noopener noreferrer" className="ml-1 text-cyan-300 underline">Open in a new tab</a>
      </div>
    </SheetContent>
  </Sheet>;
}
