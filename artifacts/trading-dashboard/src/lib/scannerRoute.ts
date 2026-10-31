// Share the exact import with React.lazy: intent and navigation must not start
// competing loads. A failed speculative import must not poison a later visit.
let pending: Promise<typeof import("@/pages/market-scanner")> | undefined;
export function loadMarketScannerPage() {
  if (!pending) {
    pending = import("@/pages/market-scanner").catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}

export function preloadMarketScannerPage() {
  void loadMarketScannerPage().catch(() => { /* Navigation owns visible errors. */ });
}
