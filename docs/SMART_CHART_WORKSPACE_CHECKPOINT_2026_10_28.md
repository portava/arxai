# Smart Chart workspace checkpoint — 28 October 2026

Saved at the owner's request before usage runs out. **Development checkpoint,
not release-green or architecture complete.** Draft PR103 remains unmerged.

Application source: `1a4fa6d7286d25a84d14e365ca9ebb420cb0d76a`.
Branch: `codex/chart-round3-acceptance-20261028`, stacked on `claude/pr99-round3`.
Any following checkpoint commit changes documentation/evidence only.

## Saved implementation

- Named browser templates: up to30 settings-only records, explicit save/update/
  rename/apply/delete, versioned bounded JSON export/import and editable staged
  import names. Unknown/corrupt storage is not overwritten; Web Locks and record
  revisions protect concurrent edits. Time zone, market, interval, drawings,
  feed, accounts and trading controls are not imported.
- Candle/price-anchored manual text notes: literal bounded text, labelled **Your
  note**, card/handle movement, locking, editing, undo/redo and existing local
  symbol/interval persistence. Tall notes keep full text in Objects and show a
  continuation cue. This is manual annotation, not automated analysis.
- Review fixes: an initially misleading native template selection; nested
  fullscreen Escape; source rebinding that closed an early template interaction;
  tall note clipping; and persistent warning banners covering note headings.
- Native template state now lives outside source-keyed drawing state, but still
  closes on intentional symbol/interval changes. Drawing resets remain bound to
  full source/evidence identity. Persistent warnings now flow above the canvas;
  the canvas and position overlays retain their shared coordinate origin.
- The prior logo removal and widget replacement remain intact. Required plain
  text library credit remains; Lightweight Charts is still the rendering library.

## Evidence, tied to its source

| Source | Result | Limit |
|---|---|---|
| `1a4fa6d7` |43 chart test files,1129 passed,0 failed/skipped; dashboard typecheck;69 tooling tests passed | Final targeted checkpoint checks; no final browser/build claim |
| `18e7e654` |167 frontend files,2400 passed/9 skipped; typecheck,production build,87 guards,7 binding assertions passed | Earlier source, before final interaction/banner fixes; bundle warning retained |
| `0d0c5c4e`, fixture `bd6e0545a258349e` | Notes script recorded44 assertions and a real PNG download | **VISUALLY INCOMPLETE:** mobile screenshot showed warning covering heading/top lines. Fixed in later code; needs fresh visual run |
| Same fixture | Template attempts reached8,24,24 and26 checks respectively | All retained as failed/incomplete; never a final PASS |

The template attempts exposed, in order: a test assuming whitespace warm-up rows
were returned by `series.data()`; a hidden-role locator timeout; bounds checked
during the opening animation; and a real toolbar remount during delayed source
binding. The first three tooling expectations were corrected. The last required
the separate template-state ownership fix. The next template script withholds an
M5 response, opens/edits Templates, releases it and verifies that input survives.

Source reviews were independent; their author-reported checks are distinguished
from parent runs. The notes screenshot and exported PNG were inspected: desktop
and PNG showed the note, while the mobile image established the real occlusion.
All captured runs used synthetic historical data, unavailable AI truth, no
broker, and every API mutation blocked. No trade/unknown write or external
request was accepted. Expected blocked/unmocked HTTP errors remain in raw logs.

Receipts, failed attempts, screenshots, review records and checksums:
`docs/validation/scanner-smart-chart-20261028/workspace-tools/`.
The local uncompressed copies remain at
`/Users/areyouok/arx-tier1-release/chart-workspace-tools-20261028/`.

## Resume without restarting

1. Start from this draft branch's latest GitHub head. Check concurrent worktrees
   and preserve separate calendar WIP and held performance branches.
2. Run the full frontend/build/guards on the final application source. The
   targeted checkpoint results above do not replace that combined run.
3. Build a clean immutable `scripts/scanner-qa/shared-chart-fixture/build.mjs`
   fixture. Use fresh synthetic USER sessions with `shared-chart-setup.js`.
4. Run `shared-chart-templates-acceptance.js` and
   `shared-chart-notes-acceptance.js`, supplying the exact expected source commit
   and receipt prefix. Inspect returned `passed`, network barriers and every
   screenshot/PNG. Confirm warning rectangles do not cover the canvas/note title,
   and early template interaction survives delayed data binding. Keep failures.
5. Rerun standard Scanner acceptance where the changed toolbar/banner layout
   matters, then update comparison/evidence and the existing draft PR.

Remaining competitive gaps include touch-device coverage, full-reload note
persistence acceptance, named account/cloud workspaces, broader text styling,
active-reader acceptance with attested source data, calendar intervals, heavy
stream/history performance, and matched TradingView/MT5 comparisons. Native
style-input timing still has0/80 completed samples; the standalone runner
reproduction does not turn that failure into a pass. No new speed or60fps claim.

All owned test browsers and the local static preview were stopped. No merge,
deployment, existing database change, broker test or trading enablement occurred.
