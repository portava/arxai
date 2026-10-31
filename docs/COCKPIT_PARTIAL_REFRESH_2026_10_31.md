# Partial funds refresh and Open Trades count

Checked application **256aff05cfeda351927c8485044210ef59c90d47**. Branch `codex/cockpit-unavailable-states-20261031`, based on frozen PR104 candidate861c56f9. Not merged to main; development preview integration pending.

A successful funds response previously reused older financial values when a field was null or missing. Explicitly unknown/missing/malformed amounts now remain null. Valid zeroes and negative profit/loss remain intact. Allocation and bridge flags require boolean true. Leaving live-shared mode clears its amounts and canonical block. Explicit null canonical funds clear the previous block; an older endpoint omitting the block may retain only same-mode last-known canonical evidence, marked stale. Failed requests retain the previous snapshot with its age, rather than creating zeroes.

Unknown or malformed position counts carry explicit unknown metadata. The cockpit already observes it; Open Trades now does too, displaying a dash instead of the legacy numeric placeholder. Missing/failed initial trade-list reads likewise do not present a zero count. The other Open Trades totals, exposure text and empty-list guidance still need a separate audit; this is not full-page truth acceptance. No reservation, audit, order-release or execution behavior changed.

Evidence:

- 13 new hook cases; 12 failed before correction. Focused hook + account-card suite65/65 pass. Intermediate after.log retains one failure for undefined canonical-block handling; corrected omission handling restored the existing stale-evidence contract.
- Full exact256aff05 frontend: **2,538 pass /11 skip /0 fail**,174 passing files /1 skipped opt-in benchmark file. Dashboard typecheck/build,87 guards and7 binding assertions PASS. Earlier c4af43e4 run is retained separately; only256aff05 includes the Open Trades display correction. No root CI, database integration or broker tests.
- Clean immutable production fixture **388989412301b36e** matches256aff05. Unknown/stale account and position states, pause/manual refresh/resume/expiry, then explicit-null response clearing previous funds all PASS. Open Trades unknown-count rendering PASS after client-side routing. Two cropped evidence screenshots inspected; prior desktop/mobile checks also rerun.
- First browser attempt reached the null-funds check but failed because the offline fixture server does not serve /my-trades directly. Raw failure retained. Corrected fresh-browser run uses the fixture root and app client routing. This is rendering acceptance, not a real user navigation latency benchmark.
- Five synthetic update-to-DOM observations:11.4,0.8,0.7,0.7,1.2ms; two-frame observations42.8,32.3,32.1,32.4,32.3ms. First outlier retained; no speedup, physical paint, broker or competitor claim. All external traffic and API mutations denied by the offline harness; no page exceptions. Owned browser/server closed.

Receipts: docs/validation/cockpit-partial-refresh-20261031/manifest.json. Selective import manifest records seven frontend source/test paths relative861c56f9. No dependency, manifest, backend, authentication, schema, worker or trading-gate changes are required by this follow-up. Preserve all concurrent development-workspace changes and validate the resulting combined source independently.

Still open: authenticated Replit acceptance, actual provider/terminal evidence, scanner sub-100ms goal, matched competitor benchmarks, whole-page unknown-data audits and complete runtime schema validation of SSE/canonical blocks. The fixed hook is display transport only and does not prove immediate broker execution or free funds before confirmation. Architecture remains incomplete; no release-green claim.
