# Smart Chart volume, mobile and Truth alignment — 1 November 2026

Application source **`677241aa2933dc3c2dc519c5d35edd51fc59ee9e`**, branch `codex/chart-volume-mobile-integration-20261101`, based on saved `38703611`. The bounded local checks pass. **Positive Scanner VWAP acceptance remains blocked by a reachable-source gap. This is not release-green, architecture completion, deployment or competitor parity.** Documentation commits following this source do not change application code.

## Existing owners extended

- The existing mobile assistant has a compact chart mode, explicit conversation expansion and deliberate chart reveal when opening. The same input/history stay mounted; drafts and focus survive mode changes. Short viewports prioritize reachable controls. No second assistant or chart was built.
- The existing Twelve Data Common Stock path requests unadjusted regular-session intraday bars. Exact original positive whole trade quantities and UTC coordinates are bound to the returned listing/series and original bar. Missing, copied, fractional, contradictory or forming-bar evidence is withheld. Returned listing identity is not an independently verified venue or consolidated tape. FX/tick counts are never substituted for trade quantities; research price basis remains unqualified.
- The existing study catalogue/calculator/renderer and manual/assistant controls now contain anchored VWAP and Trade volume. VWAP defaults to original HLC3, starts at an exact observed visible bar and retains its source-bound anchor across pan/history changes. Missing or mismatched quantities hold the cumulative suffix. Reanchoring is explicit. Quantity-only corrections invalidate the calculation. Trade volume has its own synchronized histogram; tick counts remain separately labelled.
- Known delayed provider history now stays delayed through the real chart service and feed-status endpoint. A recent bar cannot make it Live or AI-usable. Worse integrity/stale states retain precedence. No execution or confidence policy was changed.
- Initial conversation hydration now preserves immediate local chart turns rather than replacing them with older server history. Cancellation/revision checks prevent late responses crossing an explicit conversation change. This extends the existing assistant state owner.
- The Replit correction that preserves a frozen historical result after a refused rerun is now ported locally. Invalid current-source markers and explanations stay withdrawn; successful reruns still replace/cancel previous generations.

## Material integration finding

The actual Scanner's approved Focus symbol bus does not include Common Stocks. Entering AAPL in its stored selection redirects to V75. Therefore the new qualified stock-volume path is **not currently reachable through the Scanner's primary chart**. The attempted positive browser test stopped; no AAPL data was relabelled as V75 and no registry/event bypass was used. Passing calculator/renderer tests do not close this gap.

The inspected additive next path is the existing **analysis-only comparison pane**, reusing the canonical market catalogue, existing picker/layout and ARXNativeChart. Its selection/restore boundaries need an explicit analysis scope; the Focus scanner/ticket universe must remain unchanged. Full owner-requested AI parity also requires explicit active-pane assistant routing with exact symbol/interval/source context. A manual-only comparison change would be incomplete. This is a design, not an implemented feature. See `chart-only-stock-integration-design.json` in the raw receipt folder.

Volume profile remains unimplemented. The other requested tools and research requirements remain tracked in `SMART_CHART_REQUIREMENTS_CENSUS_2026_11_01.md`.

## Exact-source validation

All combined results below ran on `677241aa2933dc3c2dc519c5d35edd51fc59ee9e`:

| Check | Actual result |
| --- | --- |
| Dashboard | 3,173 pass; 11 skipped; 0 fail; 197 files passed and 1 skipped |
| Targeted backend | 513 pass; 0 fail; 0 skipped: provider 57, Truth 47, research/mission 150, candle shape 155, fixture 52, forming 18, v2 evidence 34 |
| Type checks / builds | All four typecheck units, dashboard and isolated API builds pass |
| Guards / bridge bindings | 87/87 and 7/7 pass |
| Frozen actual Scanner production fixture | `fec6c0e42471671b`, clean source and unchanged build input |
| Mobile assistant browser | 29/29: real chart strip visible, actual RSI owner, same input/draft, explicit expansion, focus and short-viewport controls |
| Immediate local commands / volume eligibility | 30/30: actual RSI and refusal replies survive deliberately late history; tick-only VWAP is held and trade volume is not fabricated |
| Clock withdrawal / refused rerun browser | 45/45: actual markers/segments and current explanation withdrawn; frozen metrics and exact hash retained after refused rerun |

These browser counts repeat behavioral assertions; they are not feature counts. Mobile is viewport/touch emulation, not a physical keyboard/phone guarantee. Clock evidence is explicitly synthetic normalized fixture metadata, not an MT5 UTC assertion. All three final runs had zero page exceptions. Unavailable fixture requests were mobile 44, clock 54, immediate 46; blocked background write attempts were 3, 3 and 3 respectively. Raw console errors are retained; unavailable endpoints are not claimed covered. All external traffic and API writes were blocked. No model-send or broker/order operation occurred. No timing/paint/competitor benchmark is claimed.

Isolated VWAP checks: 714 targeted passes and four semantic mutations caught, with byte-identical source restoration. Stock evidence had 146 registered passes, later 155 after delayed-provenance tests. Delayed-status review also ran 14 adjacent cases. These overlap combined tests and are not added to the 513 total. The hydration suite passed 41 focused checks with deferred response and explicit conversation-replacement regressions; these also overlap the final frontend total. General pre-existing voice/remote-stream cancellation was not redesigned. Root and independent peer reviews covered source admission, arithmetic/renderer updates, mobile focus/lifecycle and the retained-result correction.

## Failures retained and corrected

- Initial mobile browser layout left zero chart pixels above the panel. Deliberate one-shot chart reveal fixed it; the later final run shows a visible strip. Resize-opening and focus regressions were separately tested.
- Original fractional string volume could round to an integer; validation now checks the original representation. Cross-listing evidence transplantation is held using original series context.
- Generating the real mocked stock service response exposed delayed history labelled Live. Original incorrect fixture is retained alongside corrected identical candle values.
- The Replit refused-rerun test reproduced one failure before the exact runtime correction. Valid-run/cancel/generation cases remain tested.
- An immediate first-click chart reply disappeared when the initial history GET resolved. Both actual-browser and deferred-response unit failures were retained; history ownership and pending conversation transitions were corrected and reviewed.
- Positive Scanner stock tests stopped before arithmetic acceptance because the approved market selector rejects stocks. This failure remains open, not converted to a pass.
- Initial local loopback permission, fixture precision and unavailable ancillary-symbol setup attempts are retained separately; no external provider was contacted.

Final desktop and phone screenshots were visually inspected by root; blank trade-volume and separately labelled tick-count panes match the source eligibility rules.

Raw receipts, browser programs/screenshots, failed attempts and exact hashes: `/Users/areyouok/arx-tier1-release/chart-volume-mobile-20261101/`. Summary: `final-receipt.json`. Source-only import manifest: `docs/development-sync/SMART_CHART_VOLUME_MOBILE_ALIGNMENT_2026_11_01.json`.

## Replit and remaining scope

Previous source `532ce696` / saved `dc5f6d18` finished at Replit application `5feede568fc47c1622300cd7a580f334ee628c69`, checkpoint `aec2c6f666c73757650f5153032c090c0ae898b8`. Its frontend 3,060 / 11 skipped and targeted backend 380 checks passed, but browser acceptance was partial (13 pass, 1 fail, 2 skipped, 5 unstarted before the local retained-result fix; that fix was not replayed there). Its API running bundle remained unchanged. Later local results do not backfill that environment's acceptance. Any new source-only import must preserve its setup, sign-out fixes, concurrent work and runtime bundle.

Remaining work includes reachable qualified volume with correctly routed AI, volume profile, editable automatic support/resistance/structure, broader natural-language controls, capital/sizing/currency/benchmarks and deep-history coverage, first-click navigation and large-chart frame budgets. No proven faster-than-TradingView/MT5, returns or completion percentage. No main merge, deployment, existing database change, API activation, worker/email, terminal installation, external model/provider request or live/demo broker test occurred.
