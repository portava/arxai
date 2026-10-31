# Trusted native style selection: local diagnostic, 28 October 2026

The missing style samples remain **0/80, FAIL** in the earlier Scanner latency receipts. No source gate, trusted-input requirement, or failed record was relaxed. No new ARX latency run was performed in this diagnosis.

With Playwright CLI 0.1.22 on this Mac, the same unsuccessful input occurs on an isolated `about:blank` page containing only native HTML controls, with no ARX code. Both the default headless session (HeadlessChrome 156.0.0.0) and documented `open --headed` session (Chrome 156.0.0.0) produced these results:

| Native control and input | Headless | Headed |
| --- | --- | --- |
| Dropdown: ArrowDown, Enter | No change event; still Candles | Same |
| Dropdown: Space, ArrowDown, Enter | No change event; still Candles | Same |
| Dropdown: Alt+ArrowDown, ArrowDown, Enter | No change event; still Candles | Same |
| Dropdown: pointer click, ArrowDown, Enter | No change event; still Candles | Same |
| Separate native `size=3` listbox: ArrowDown | Bars; trusted input and change | Same |
| Checkbox: pointer click | Checked; trusted input and change | Same |

All recorded keyboard events were trusted and not default-prevented. Each record preserves the event timestamp and capture time. The listbox and checkbox are positive controls on the diagnostic page only; ARX's dropdown was not modified to behave like either. Headed mode alone did not resolve selection.

This isolates the failed tested input sequences from ARX's handlers. It supports a local native-dropdown automation limitation; it does not prove that every browser/input route is unsupported, that ARX style behavior is defective, or that a native menu has rendered correctly. A native-app lookup could not safely identify the isolated diagnostic browser window, so no OS-level input was sent. Both diagnostic sessions were closed afterward.

## Reproduce

Run from a receipt directory, using a fresh, explicitly named session. The script replaces the contents of its page, so never run it in a user browser session.

```sh
playwright-cli -s=arx-select-diagnostic open about:blank
playwright-cli -s=arx-select-diagnostic run-code --filename=/absolute/path/to/scripts/scanner-qa/native-select-diagnostic.js
playwright-cli -s=arx-select-diagnostic close

playwright-cli -s=arx-select-diagnostic-headed open about:blank --headed
playwright-cli -s=arx-select-diagnostic-headed run-code --filename=/absolute/path/to/scripts/scanner-qa/native-select-diagnostic.js
playwright-cli -s=arx-select-diagnostic-headed close
```

`selectOption('candles')` resets each case before its event log is cleared. It is setup only and never accepted as a trusted selection. Fixed 80 ms waits separate diagnostic keys; these are not performance measurements.

## Receipts and next experiment

The raw logs and close receipts are retained in `/Users/areyouok/arx-tier1-release/scanner-performance-20261028/`. `native-select-diagnostic-results.json` records their hashes and exact environments. The executable reproduction is checked in beside this document. It was run before being copied here without logic changes; comments were added for safe reproduction.

Reference checkout: `0f12247640a589b655a6d8e74ba521a899a06cf4`. No application build, server, API, or database was used by this diagnostic. Earlier actual-Scanner logs (`style-input-diagnostic.log`, `style-input-variants.log`, `style-key-detail.log`, `style-input-delayed.log`) retain the corresponding unsuccessful native input attempts against the baseline. Their evidence and the later failed baseline/candidate style counts remain unchanged.

Before rerunning the full Scanner timing suite, establish a trusted native `change` event in this reproduction using a supported browser and input route. Then repeat that route on the immutable final Scanner fixture, bind the executed build ID, verify the actual new series and complete displayed/canonical data, and obtain a quiet timing window. A browser/environment change requires a newly matched baseline and candidate; do not compare it as if it were the old Chrome run. Programmatic style-change acceptance remains separate from trusted-input latency. No physical-paint or competitor-performance claim is supported here.
