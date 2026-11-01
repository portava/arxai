// Exact local SPA entry points only. API calls and writes are rejected before
// this mapping; arbitrary paths must still resolve to a recorded build asset.
export const SHARED_CHART_PAGE_PATHS = Object.freeze([
  '/live-chart', '/live-manual', '/live-ai-assist', '/live-ai-auto-test',
]);
export function isOfflineChartPagePath(pathname) {
  return pathname === '/' || pathname === '/market-scanner' || SHARED_CHART_PAGE_PATHS.includes(pathname);
}
