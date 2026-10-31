# Chart volume evidence — 31 October 2026

Application commit `af9e3c9ab4414e0286dea151995ab7bca8250738` on `codex/chart-volume-evidence-20261031`, based on accepted chart source `8072ad7685d0e2f6167d542ae63f500a0df03488`. Development-only; not imported into Replit, merged to main or deployed. No release-green or competitive-parity claim.

## Correction

Normalization previously replaced omitted/non-finite volume with zero, then counted that fallback as a ZERO_VOLUME_GHOST. Preserve whether the input explicitly reported zero before normalization. Only that evidence supports the existing advisory on non-synthetic candles. The selected duplicate carries its own evidence. Existing numeric output compatibility, synthetic exemption, OHLC validation, source and trading gates remain unchanged. The internal marker is not serialized.

This does **not** establish real traded volume. The wire contract still represents absent volume as zero, and the broker candle mirror can map tick volume into the generic volume slot. Providers that themselves substitute zero remain indistinguishable. Volume studies, VWAP, footprint and volume profile must stay withheld until source-specific real/tick/unavailable semantics survive the complete pipeline. An explicit zero advisory is not proof of missing trading activity.

## Exact-source validation

- Baseline plus four added regression tests: 49 pass / 3 fail / 0 skipped. Three failures prove the omitted-volume, duplicate-selection and invalid-price cases; the explicit-zero preservation test already passed.
- Fixed candle fixtures: 52 pass / 0 fail / 0 skipped.
- Exact-commit pure chart contracts (fixtures, response schema and truth evidence): **77 pass / 0 fail / 0 skipped**.
- API typecheck, API build and domain declaration build: pass.
- Guards: **87/87 pass**.
- Self-review checked duplicate replacement, serialization, synthetic exemption, invalid price flags and downstream use of the count. No independent agent review is claimed.

A broader first contract command mistakenly included two DB-backed session suites: **77 pass / 2 fail** because the intentionally unreachable offline database refused their connections. No existing database was contacted or changed. Those failures remain archived; the subsequent pure run does not relabel them as passing. Database integration, full root CI and browser checks were not run for this narrow backend correction. No new speed result follows.

Raw logs and exact-source check receipt are gzip archived under `docs/validation/chart-volume-evidence-20261031`, with original SHA-256 hashes and sizes in `manifest.json`. Original logs: `/Users/areyouok/arx-tier1-release/chart-volume-evidence-20261031/`.

## Inventory reconciliation

Five stale competitive-scorecard descriptions were corrected from inspected accepted source 8072ad76. The chart has seven styles; nine drawing kinds including anchored text and channels; named display zones; nineteen fixed selectable intervals; and thirty named local settings templates with ARX JSON import/export. These are source capabilities, not newly measured competitor parity. W1/MN1, provider calendar/session boundaries, full drawing/study coverage, cloud profiles, physical-device coverage and matched competitor timing remain open.

Relevant prior receipt: `SMART_CHART_WORKSPACE_ACCEPTANCE_2026_10_31.md` — browser assertions on 1e879563, separate reload follow-ups on ca36fcc4 and406524df. Latest accepted f1fc3092 frontend suite is separate regression evidence, not a retrospective rerun of those browser checks.

## Next

The existing Replit accepted-follow-up update was still busy at this checkpoint; read-only status requests were not queued. Preserve that work and its exact source/result. Do not interrupt it or install held resize/toolbar/containment experiments. First-navigation latency remains failed or unproven in the saved local/remote measurements. Establish volume provenance before volume analytics, and verify current combined Replit source before any further selective development import.
