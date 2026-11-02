# Pattern producer continuity — 2 November 2026

Application: `9952afb01ba5168e96b7ba6e25f08503dbb275fd`.
Base: `92ed56e9c162101127a524f7d09d1db7d5363501`.
Branch: `codex/pattern-producer-continuity-20261102`.

Verdict: scoped cross-engine evidence repair verified offline. Not release-green; no claim that all engines are accurate, that feeds are synchronized, or that ARX matches TradingView/MT5.

## Problem and behavior

The server's pattern-library producer discarded timestamps and completion flags before calling its detector. An unfinished candle or a candle after a gap could therefore supply confirmation. Other pattern/trendline producers could use normalized observations after duplicate, ordering or invalid-price repairs without exposing that evidence conflict.

The existing chart analysis and server producers now share a continuity partition utility. The three server entry points (`buildPatternTruthVerdict`, `buildPatternLibraryRead`, `buildTrendlineTruthVerdict`) use one closed-window boundary. It rejects invalid/nonpositive prices, duplicate or reordered observations, overlapping intervals and raw timestamps without a valid calendar date and explicit timezone. It assesses only closed bars in the latest uninterrupted segment. One adjacent unfinished tail may be excluded; an unfinished interior observation is refused.

Continuity is partitioned **before** removing the unfinished tail. When the newest segment contains only an unfinished candle, earlier confirmed geometry cannot become current. Frontend capture also refuses an unfinished tail separated from the closed history by a gap or overlap. Existing chart findings before a gap remain explicitly historical rather than being used for current confirmation.

All 19 fixed intervals retain a positive detection case without mutating their input. Weekly/monthly periods remain withheld because their calendar boundaries are not qualified. No missing candle or scheduled market closure is invented.

## Verification and retained failures

- Corrected base reproduction: 5 pass / 29 fail; first repair: 34 pass. The initial test draft used an incorrect library pattern identifier in three assertions; those logs are retained and are not counted as product defects.
- Independent review found two additional problems: dropping a forming tail before partitioning, and permissive timestamp parsing. Both were repaired. The final reviewer independently passed 62 producer tests and 82 frontend capture/analysis tests; all ten reviewed source hashes match the application commit.
- Final backend producer/regression group: **174 pass / 0 fail / 0 skipped**. Separate actual-consumer group: **54 pass / 0 fail / 0 skipped** (market intelligence, Scanner trendline integration, no-unlock rules and assistant readers).
- Final full frontend: **4,730 pass / 0 fail / 12 skipped**, 268 passed test files and two skipped files. The existing DOM environment navigation warning remains in the log.
- Shared-library and API typechecks pass. Broad recursive typecheck then stops at `mockup-sandbox`, which lacks `node` and `vite/client` type dependencies in this worktree. The dashboard typecheck was run separately and passes. No full recursive typecheck pass is claimed.
- API and dashboard production builds pass. The dashboard retains its large-chunk warning; this is not performance acceptance.
- Source guards: **85/87**. The two existing wording guards have identical finding output to the preceding checkpoint after normalizing source line numbers and scanned-file count. The three supplemental guard fixtures pass separately. Full root CI was not run.
- One early backend test invocation omitted the repository lane's `--test-force-exit`; an imported in-memory simulator timer kept that test process alive. The exact owned child was stopped, that incomplete run retained, and the final invocation used the configured force-exit behavior. No runtime worker was enabled.
- No browser, real feed, broker, latency or physical-frame measurement was performed on this application commit. Prior browser acceptance belongs to its earlier exact commit, not this one.

## Limits and next work

These producers return `null` when they cannot supply qualified pattern evidence. That means no pattern contribution; it does not introduce a new execution blocker or replace the base Scanner verdict. Existing feed, sufficiency and execution gates remain separate.

Valid ISO syntax is not proof of the source clock or account identity. Candle completion still follows the existing normalizer's observation convention/clock; callers retain responsibility for source qualification. Some intelligence callers omit source information, which remains a provenance limitation. Other detectors and consumers still need independent review.

Cross-page observation identity, account/currency isolation, stale monetary displays, broker-to-display latency, AI calibration, calendar boundaries, trusted-input speed and competitor feature gaps remain open. Tests establish bounded behavior, not a blanket accuracy percentage.

Raw logs, initial failures, exact source hashes, independent review and guard comparison are retained at `/Users/areyouok/arx-tier1-release/pattern-producer-continuity-20261102/`.

No main merge, deployment, Replit sync, existing database mutation/migration, trading enablement or live/demo broker tests were performed.
