---
name: ScannerChartPanel pure-helper extraction
description: Why ScannerChartPanel's pure constants/helpers live in scannerChartFormat.ts, not the component file
---

Keep pure display constants/helpers (timeframe lists, coercion, countdown
formatting) for the Scanner chart in a sibling module
(`components/scanner/scannerChartFormat.ts`), NOT exported from
`ScannerChartPanel.tsx`. Same as the `scannerCandleAdapter.ts` split.

**Why:**
1. Testability — pure helpers can be unit-tested under vitest/jsdom without
   importing the heavy component (which pulls in lightweight-charts + the whole
   chart tree).
2. Vite React fast-refresh breaks when a component file ALSO exports
   non-component values. Exporting `PRIMARY_TIMEFRAMES`/`coerceVisibleTimeframe`
   from `ScannerChartPanel.tsx` produced HMR "export is incompatible" /
   "Could not Fast Refresh (new export)" invalidations that fall back to a full
   page reload on every edit.

**How to apply:** when you need a pure helper near a heavy component, put it in
a sibling `*.ts` module and import it back. The component file should export
only the component(s).
