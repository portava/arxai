# ARX tabbed workspace handoff

This branch implements the futuristic tabbed workspace in the actual ARX monorepo. It is based on GitHub main `cac505d` (merged V6.7 / PR #150), with no backend migrations or broker credential changes.

## Import into Replit

The preferred path is the GitHub branch `codex/arx-tabbed-workspace-20261113` in `portava/arxai`. In an existing checkout, save or commit any Replit-local changes first, then:

```sh
git fetch origin codex/arx-tabbed-workspace-20261113
git switch --track origin/codex/arx-tabbed-workspace-20261113
pnpm install --frozen-lockfile
```

If this branch already exists locally, use `git switch codex/arx-tabbed-workspace-20261113`. Do not force-reset a checkout with local changes.

Alternatively, extract `arx-tabbed-workspace-source.zip` into a fresh Replit project. The archive is the complete tracked monorepo, with no node_modules, .git directory, installed build outputs, or local secrets. Keep the existing Replit Secrets and runtime configuration. Use the repository's existing release/start workflow; do not use the visual preview server as the production server.

Publishing remains separate. This handoff does not merge the draft PR or republish Replit.

## What changed

- Persistent Scanner, Chart, Calendar, Journal, and Positions & Orders navigation; related tools in secondary navigation; the full existing tool catalog in a searchable drawer.
- Existing investor, pending trader, approved trader and administrator navigation rules remain enforced. The approved user's own journal route now matches its existing menu link and authenticated server endpoint.
- Scanner opens on Broad Scan. Scalps contains the existing ranking and goal-based builder. Market detail and Markets retain the previous chart, diagnostics and symbol explorer. Selected symbols/timeframes carry into Chart.
- Dark graphite/cyan styling, short page/tab transitions, a scan progress animation, and reduced-motion support. Mobile puts the order panel before the chart.
- Visible Buy and Sell controls with SL/TP fields; size and order type stay in the existing gated confirmation ticket. Switching markets clears the draft protective levels. Chart-originated shared tickets always require explicit review.
- First-party ARX Canvas chart renderer for the main chart, scanner chart, position previews, manual/AI-assist pages and operator test page. No TradingView widget, renderer selector, logo, script, or lightweight-charts dependency remains in the shipped frontend bundle.
- Renderer supports observed OHLC bars, pointer/keyboard pan and zoom, pinch, crosshair readout, price lines, markers, structural lines and illustrative scenario overlays. Existing data quality, AI eligibility and execution gates remain in their original controllers.

## Validation

151 targeted tests across 17 suites pass. Type checking and production Vite build pass. Existing large-chunk advisory remains (largest chunk approximately 806 kB before gzip).

The browser preview uses a separate localhost-only read-only fixture server: `tools/workspace-preview/server.mjs`. It serves the built real application; sample data is labeled and all non-GET API requests are rejected. It does not proxy to production or ship as the production application entrypoint. Calendar/journal/positions use empty fixtures; scanner discovery APIs are not connected in the preview.

Browser checks cover all five primary routes, Broad Scan/Scalps navigation, the tools drawer, chart rendering, protective-level handoff into the disabled review ticket, and desktop/mobile layouts. Live broker execution, real scanner service results, account authentication on Replit, and deployment are not validated by these local fixture checks.

## Reproduce local checks

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b lib/api-client-react lib/domain lib/integrations-openai-ai-react
pnpm --filter @workspace/trading-dashboard run typecheck
PORT=4190 BASE_PATH=/ pnpm --filter @workspace/trading-dashboard run build
node tools/workspace-preview/server.mjs
```

Open http://127.0.0.1:4190/live-chart for the labeled visual preview. Production continues to use the existing ARX backend and authentication.
