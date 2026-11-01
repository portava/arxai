# Smart Chart provider, Truth and assistant alignment — 1 November 2026

Application source: `38285b29b6978247f971d69c05100653674463c3`, branch `codex/chart-provider-alignment-20261101`, based on saved `dc5f6d18`. **Local bounded validation passed; not release-green, deployed, architecture-complete or competitor parity.** Documentation/checkpoint commits after this source do not change application code.

## Existing owners extended

- The chart assistant now supports explicit **Keep Fibonacci**, **hide selected Fibonacci**, **show selected Fibonacci** and **remove selected Fibonacci**. These use the same manual drawing owner, storage and undo history. A current preview is rechecked and consumed once; repeated Keep cannot duplicate it. Missing/stale previews, unsupported compound instructions and an absent/non-Fibonacci selection refuse without partial actions. Global drawing visibility remains authoritative. A failed storage write is disclosed as an open-view-only edit.
- The existing Twelve Data intraday request now explicitly requests UTC and descending observations. It validates identity, interval, exchange metadata, calendar-valid timestamps, order and prices. Daily intervals are refused because the provider ignores requested timezone conversion there. Exchange timezone is instrument metadata, not an output-timezone echo. This source receives no research price/clock authority.
- The existing Polygon/Massive FX custom-bars path can qualify **original UTC/BID historical evidence** for its audited supported request subset. Runtime-issued evidence is bound to the exact original bar, symbol and interval, retained through the existing memory cache and router, and checked by Truth. Copied, serialized, altered or wrong-context evidence does not qualify. Only the actual loaded closed window may be used; larger requested periods remain withheld. Quote counts are not traded volume.
- Exact Polygon and Twelve Data source mappings now preserve their original bar-open coordinates instead of subtracting an extra interval. Other source mappings are unchanged. Both historical candle adapters remain conservatively DELAYED: an aggregate response or recent bar-open time cannot establish real-time entitlement or an executable quote. Broker decision routing is unchanged.

No second chart, provider, research engine, execution path or assistant drawing registry was built. See `SMART_CHART_FIBONACCI_LANGUAGE_2026_11_01.md`, `TWELVE_DATA_INTRADAY_CLOCK_2026_11_01.md` and `POLYGON_FX_ORIGINAL_CANDLE_EVIDENCE_2026_11_01.md` for exact contracts and primary provider documentation.

## Reviews and source-specific validation

Isolated commits: Fibonacci `83fe91bc`, Twelve Data `98be323e` plus freshness correction `084f285c`, Polygon `941108fe`. Root and independent peer reviews preceded integration. The combined provider diff was reviewed again at `38285b29`; both test registrations survived without overlap loss. Review found and corrected the recent-candle/realtime overclaim, overly broad aggregation-grid assumption and contradictory zero quote counts. Before-fix failures and intermediate logs are retained.

All following combined results ran on application `38285b29`:

| Check | Actual result |
| --- | --- |
| Dashboard tests | 3,073 pass; 11 skipped; 0 fail; 194 files passed, 1 skipped |
| Targeted backend checks | 466 pass; 0 fail; 0 skipped: provider57, Truth47, research/mission150, candle shape108, fixture52, forming18, v2 evidence34 |
| Type checking | All four CI units pass |
| Builds | Dashboard and API builds pass; no runtime activated |
| Guards / bridge bindings | 87 guards and 7 binding assertions pass |
| Browser fixture | Frozen production Scanner build `9bbcc197ecc49882`, clean source `38285b29` |
| Actual Scanner controls | Desktop51/51; CPU4 after initial load51/51; 390×844 touch emulation51/51 |
| Clock withdrawal / historical research | 41/41; frozen result retained while current overlays/explanation and rerun authority are withdrawn |

The 194 browser assertions are repeated behavior checks across four cases, not 194 separate implemented features. Real manual and assistant controls were exercised; actual rendered study values and drawing strokes, persistence, selected edits, undo and source withdrawal were inspected. There were zero page exceptions. Each command case retained 88 unavailable fixture requests, 92 console errors and four blocked background write attempts; the research case retained 54, 57 and three respectively. All external traffic/API writes were blocked. No model-send, order or broker action was performed. These are synthetic fixtures and an offline actual provider/router/Truth/capture chain, not operational API coverage or real provider certification.

The root run initially omitted the scripts dependency overlay, so typecheck, guards and bindings could not load tsx. That local setup was repaired; only the affected checks were rerun and passed on the same source. Initial loopback startup was denied by the environment, then passed with approved local-only access. Logs were retained. Browser screenshots were inspected: the controls and geometry match, but the phone assistant still obscures most of the chart while open. This is an explicit usability gap.

Raw receipts, screenshots, test failures and browser programs: `/Users/areyouok/arx-tier1-release/chart-provider-alignment-20261101/`; authoritative summary `final-receipt.json`. Isolated before/after receipts are in the sibling Fibonacci-owned-actions, twelve-data-utc and polygon-fx-candle-evidence folders. The source-only import manifest is `docs/development-sync/SMART_CHART_PROVIDER_ALIGNMENT_2026_11_01.json`.

## Replit and remaining work

The prior Replit source-only update (`532ce696`, saved `dc5f6d18`) still returned busy at the last read-only check; the question was not queued. **This new source has not been imported or activated there.** Preserve concurrent Replit work and its existing setup/sign-out corrections. Inspect the earlier update's actual source/checkpoint and validation before sending a further source-only update. Local passing results do not prove preview acceptance.

Remaining requirements include compact chart/chat readability, complete natural-language controls for all requested tool families, editable automatic support/resistance and structure, qualified traded-volume VWAP/profile, broader historical coverage, capital/position sizing/currency/benchmarks, general strategy rules and paired competitor/performance acceptance. Current tick-count bars do not fulfill traded-volume requirements. Original MT5 historical clocks remain unqualified; the separately compiled price-basis EA changes have not been installed. First-click navigation and large-chart frame-budget gaps remain open. No timing, returns, completion percentage or parity is inferred from this increment.

No main merge, deployment, existing database change, API running-bundle replacement, operational worker, email, terminal installation, external model request, live/demo broker test or trade occurred.
