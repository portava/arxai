# Smart Chart historical-rule drafts

This addition configures the existing versioned research engine. It does not create a chatbot, strategy engine, simulator, data fetch, order path or storage service.

Supported example:

> Test buying when the 20 EMA crosses above the 50 EMA, with an ATR-based stop, over the last two years.

The full phrase must match. An upward crossover can request buying; a downward crossover can request selling. Periods and positive historical durations are parsed; durations support days, weeks, UTC calendar months and years. The selected chart asset and fixed-duration interval are reused. Additional assets, intervals, execution instructions, reversal exits, discretionary rules, capital/currency amounts, lots, leverage and percentage sizing are not silently dropped. Other strategies and free-form planning remain unsupported.

The parser creates an editable draft only. The same `defaultChartResearchSettings` and `createChartResearchDraft` functions serve the manual panel. Defaults are EMA 20/50, Wilder ATR 14 × 2, target 2R, maximum hold 100 bars, long-only (short-only for a selling request), one synthetic unit, a contiguous next-open entry requirement and 60/20/20 chronological development/validation/holdout shares. EMA uses SMA seeds and original source closes. ATR distance is frozen at the signal and anchored to the modeled entry fill. Opposite crosses are not exits. These are disclosed strategy assumptions, not inferred user trading policy.

Spread, adverse slippage and fee equivalents default to an explicitly labelled **zero-cost exploratory baseline**, each in source price units. This excludes those costs until edited; it is not historical broker pricing or a claim of cost-free execution. No capital, monetary account return, contract multiplier, buying power or live confidence policy is invented.

`closedThroughMs` must be supplied by the source-bound closed-history capture, not by a wall-clock fallback. Calendar subtraction retains UTC time and clamps invalid month days (for example a leap day to the prior year's February 28). Any forward interval alignment is disclosed. The requested exact window remains in the draft: a two-year request cannot become a latest-200-bar request.

Before running, the workbench must pass that window to `captureChartResearchWindow`. Source identity, price basis, finality, matching current chart values and exact boundary coverage belong to that shared evidence authority. Exploratory internal gaps must be disclosed; an explicit complete-history requirement holds gaps. `finalizeChartResearchConfig(draft, verifiedBarCount)` alone does not establish coverage: it converts partition shares to engine indices, holds insufficient EMA/ATR warmup or empty partitions and delegates to the same authoritative V2 configuration validator used by the engine. The worker and actual assistant/UI binding are separate integration work.

The public pure helper exports are in `artifacts/trading-dashboard/src/lib/chart-engine/chartResearchDraft.ts`:

- `defaultChartResearchSettings(window)` returns fresh editable assumptions.
- `createChartResearchDraft(context, settings)` validates a manual draft and produces disclosures.
- `parseChartResearchRequest(text, context)` returns the same draft shape, a clear unsupported result, or null for ordinary non-research conversation.
- `finalizeChartResearchConfig(draft, verifiedBarCount)` returns the canonical engine configuration or a refusal.
- `describeChartResearchDraft(draft)` explains the executable rules and assumptions.

Validation: 29 focused checks pass against the actual V2 engine, including complete manual-versus-language result and SHA-256 equality for the same generated historical input with completed trades. Other checks cover calendar boundaries, no clock access, unknown intervals without fallback, unsupported modifiers, manual extra-key refusal, copied settings, warmup and engine-size limits. Local domain/API declarations and dashboard typecheck pass. Test receipts are under `/Users/areyouok/arx-tier1-release/chart-research-language-20261101/`. The Truth agent independently reviewed the helper and found no blocking issue.

No broker, network model request, existing database, worker or API was activated by this helper. Real browser acceptance and combined source validation belong to the parent integration. No release-readiness, profitability or competitive-parity claim follows from these tests.
