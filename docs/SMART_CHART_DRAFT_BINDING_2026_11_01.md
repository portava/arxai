# Smart Chart assessment and plan binding — 1 November 2026

Status: development correctness increment validated; not deployed, not release-green, no platform parity claim.

Application: `27a4605fbec043125e934acb77e11a58b9b13aca`, based on `b4e2ef04ecc095dff57712d54a4277b6095da1b3`. The original regression was reproduced on `660394f6`; the intervening admin monetary display change is preserved.

## Behavior

The page-level assessment store previously keyed only market and interval. Editing a plan's side, entry, stop or target—or clearing it—could leave commentary for the old plan visible. Chart and scalp panels with different plans could also share that commentary.

The existing store now keys draft assessments by exact side and finite price values, alongside canonical market/interval identity. No price rounding or invalid-number-to-null coercion occurs. Chart-only legacy keys retain their existing namespace and behavior; tagged plan keys cannot collide with them.

- Identical plans share pending work and completed reads, including equivalent interval aliases.
- Different plans retain independent assessments. The generic header/chart summary cannot describe either as a shared full read.
- A changed, invalid or unassessed plan restricts the shared summary. The old commentary is withdrawn before paint through layout registration.
- Orphaned nonnull plans are cancelled and tombstoned on edits, unmount and market change. Late success, failure and cleanup cannot restore them. Another exact-plan consumer keeps its shared request intact.
- A submitted draft is copied before the request. Existing request deadlines, failure withholding and canonical response-market validation remain.

This binds local results to the actual frontend request. It does not prove a server-echoed draft, broker account, candle source/window, observation age, expiry or forecast accuracy. Legacy chart-only market navigation remains available; it is not a claim of source or freshness validity. No AI confidence or execution gate policy changed.

## Validation on the committed source

- Initial regressions: 18 fail, one pass on the original implementation. Subsequent independent review found orphan unmount/market-switch resurrection; root also found key ambiguity and an unread-plan summary gap. All were fixed before final validation.
- Final focused six-file lane: 132 passed. Includes changed/cleared prices and direction, late replies, competing plans, identical consumers, discarded plans, invalid values, market/unmount transitions, StrictMode registration and key collision.
- Complete dashboard suite: 3,904 passed, zero failed, 11 skipped.
- All four CI typecheck groups passed: libraries, API, scripts and dashboard. Ordinary dashboard production build passed with the existing large-chunk warning.
- Architecture guards: 85/87. Failure blocks are identical to the preceding monetary-display source: 38 risky-wording findings and three internal-name findings. No guard was weakened.
- Independent review pinned all three application file hashes to this commit.

The actual Scanner page was exercised in a separately launched browser against the ordinary local production bundle, with synthetic historical candles, an invented plan-capable UI envelope and blocked APIs/WebSockets/external requests. The local server has no API proxy. Only the assessment POST received locally fabricated, explicitly restricted replies. No order confirmation was clicked; all other attempted writes were blocked.

Seven browser scenarios passed: completed BUY plan, changed stop, exact edited-stop reread, clearing, late SELL response after target edit, new response after old cancellation, and clearing at a 390px viewport. No page runtime errors occurred. Expected HTTP errors from unimplemented fixture endpoints were retained. Submitted draft bodies and all source/bundle hashes are archived. Screenshot inspection confirmed the restricted cleared state; it also confirmed the still-visible TradingView library credit.

This browser fixture does not establish affirmative live analysis, pointer-drag acceptance, physical mobile touch, hardware paint timing or matched competitor speed. Unit checks cover full-read summary restrictions separately. Full root CI, database integration, terminal/broker execution and new performance measurements were not run.

## Receipts and remaining work

Raw receipts: `/Users/areyouok/arx-tier1-release/chart-draft-binding-20261101/`. Verified archive: `docs/validation/chart-draft-binding-20261101/receipts.tar.gz`. Initial environment errors are recorded: local server/browser process restrictions required authorized escalation; one package-script edit used an incorrect working directory and was corrected before mutation.

Next correctness work must extend coherent identity to account/source/window/time changes without inventing freshness or confidence policy. Previous slower-device first-navigation failures, larger-history work, broad analysis/candle catalogue gaps, strategy testing, cross-surface Truth and monetary delivery gaps remain open. The user's requirement to remove TradingView from the chart is not met by the remaining library credit; replacing embedded pages and removing a logo did not eliminate the rendering-library dependency. Do not conceal that gap or treat this increment as architecture completion.

No main merge, deployment, Replit update, existing database change, trading/worker activation or live/demo broker test occurred.
