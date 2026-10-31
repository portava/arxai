# Cockpit account and position evidence

Checked application: **acc7d85bb436d01893c2664183a5ae199fda3c54**, isolated development branch `codex/cockpit-unavailable-states-20261031`. Not installed in Replit or integrated into PR104 yet.

Unavailable account figures now show dashes, not fabricated zero balances. Missing account status is unknown, not automatically Active. Live account scope is checked before consuming live data. Stale figures remain labelled last-known. Genuine reported zero values remain zero.

Missing position reads no longer claim no open trades. A funds-only poll is explicitly incomplete position evidence; unknown counts remain unknown on these cockpit cards. Complete empty snapshots are described as the latest or last-reported snapshot, according to freshness. No exposure reservations, order gates or broker actions changed.

Validation on acc7d85b:

- Initial component regressions: 9 failed /3 passed before the fix. Expanded focused suite: 52/52 pass. An intermediate test-helper mistake is retained in expanded.log, corrected in expanded-corrected.log.
- Full frontend: 2,525 pass /11 skip /0 fail; 174 passing files and one skipped opt-in benchmark file. Dashboard typecheck/build, 87 guards and 7 binding assertions pass. Full root CI, DB integration and broker testing not run.
- Production fixture 78eedd150db69bc4 matches the clean checked source. Offline browser account truth, funds pause/manual refresh/resume/expiry checks PASS. Desktop and mobile screenshots inspected. Unknown overview has no false zero/Active; missing position evidence is explicit; stale empty positions use last-reported wording.
- Five synthetic event-to-DOM samples: 9.9, 0.9, 0.7, 0.8, 0.9ms. Two-frame observations: 41.1, 32.2, 32.5, 32.5, 32.4ms. Retained first-sample outlier; no competitive or broker latency claim. Six normal background write attempts denied across two page lifecycles; all other unmocked reads unavailable. No page exceptions. Owned browser/server closed.

Receipts: docs/validation/cockpit-account-truth-20261031/manifest.json. Mobile full-page capture includes the fixed bottom navigation and offline-fixture banner crossing content; this is not acceptance of every viewport interaction or production layout.

Remaining: fallback financial fields can still retain old figures on explicit null, and other consumers need a partial/count metadata audit. Current account panels are improved, not globally certified. Currency/account-mode labels and other permission-card assertions also need review. Real authenticated Replit acceptance, actual provider freshness, native-terminal checks, scanner sub-100ms target and matched TradingView/MT5 comparisons remain open.

Replit completed its earlier selective import of frozen 861c56f913e6424cfc4e26eefaa8f09c7dc0aca1: application 45abd502e75589d0e3e86a967cada02824053888, final checkpoint a8a7fedc7afcb140997c885570b0efdc107c1b44. Its own frontend run had 2,472 pass /11 skip, both builds/types and 87 guards pass. Local unrelated changes were preserved. Authenticated UI acceptance was blocked by the absent signed-in testing session. These results are not attributed to acc7d85b or the newer follow-up branch. No deployment or main merge.
