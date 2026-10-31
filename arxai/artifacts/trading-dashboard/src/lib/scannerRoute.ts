// Share the exact import between idle/intent warming and the route. A failed
// speculative import must not remain in our cache for a later visit.
let pending: Promise<typeof import("@/pages/market-scanner")> | undefined;
let loaded: typeof import("@/pages/market-scanner") | undefined;
export function getLoadedMarketScannerPage() { return loaded; }
export function loadMarketScannerPage() {
  if (!pending) {
    pending = import("@/pages/market-scanner").then(module => {
      loaded = module;
      return module;
    }).catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}

export function preloadMarketScannerPage() {
  void loadMarketScannerPage().catch(() => { /* Navigation owns visible errors. */ });
}
