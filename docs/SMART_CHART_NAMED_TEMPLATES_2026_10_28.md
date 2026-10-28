# Smart Chart named templates — 28 October 2026

Development implementation for the shared Smart Chart, including the actual
Scanner page. Not deployed; no platform-parity or performance verdict follows.

## Scope and reference behavior

TradingView documents reusable groups of configured indicators, created from the
chart toolbar. ARX's template also carries chart style, scale and inversion.
[TradingView indicator templates](https://www.tradingview.com/support/solutions/43000543048-what-are-indicator-templates/).

MT5 templates can include chart settings, indicators, objects and Expert Advisor
parameters, while profiles organize multiple charts. ARX implements a smaller,
settings-only browser library: it does not import MT5 TPL files or save execution
configuration. [MT5 templates and profiles](https://www.metatrader5.com/en/terminal/help/charts_advanced/templates_profiles).

## Implemented behavior

- One compact Templates dialog replaces the single-slot Save/Load buttons. Native
  charts keep its trigger in stable view controls, outside source-keyed drawings.
- Up to 30 named templates; explicit Save new, Update selected, Rename, Apply,
  Export and confirmed Delete actions. Names are bounded to 64 characters.
- Templates contain only style, price scale, inversion and up to 12 study
  instances/settings. Applying preserves the current time zone. Instrument,
  timeframe, drawings, candle data, positions, account and trade controls are
  excluded. Applying a template is a local chart-settings operation.
- Versioned ARX JSON export/import, bounded to 64 KiB. An import is validated,
  then staged for naming before Save imported. Saving does not apply it.
  Duplicate names are refused; the staged name can be changed without editing
  the file. Invalid studies, extra fields and unknown versions are rejected,
  rather than silently importing a partial setup.
- The old saved template is offered as “Saved template” without writing during
  render. A subsequent explicit mutation materializes the new library, keeping
  the old storage slot untouched. Unreadable or newer library data blocks writes.
- Browser Web Locks coordinate mutations; the callback reads and writes
  synchronously with no waiting/network work. An occupied lock reports retry;
  browsers without the lock API keep apply/export but refuse writes. Selected
  record revisions prevent stale updates/deletes. Browser storage failure never
  produces a success message.
- Both same-document chart events and storage events refresh the list. An old
  selection is cleared when its record changes. Closing/unmounting invalidates
  an unfinished file read; asynchronous saves/imports never apply to a chart.
- Modal keyboard focus returns to the visible Templates trigger on Native.
  Replay retains the parent Tools/Pan fallback if its compact toolbar hides it. Escape closes the top dialog before
  exiting chart fullscreen. The latter regression failed before its fix.
- Source binding does not close an open Native template dialog, erase a typed
  name or cancel its file read. The library is keyed to actual symbol/timeframe;
  intentional selection changes still close it and cancel pending file reads.
  Drawing gestures retain the full symbol/timeframe/source/evidence reset key.
  Two lifecycle regressions failed before this separate ownership fix.

## Evidence and explicit gaps

Focused model/component checks include all 17 existing study definitions,
settings-only export/roundtrip, bounds, old-slot migration, unknown/corrupt
storage preservation, quota/lock failures, stale edits, import staging/collision,
no apply before request, file-read cancellation, literal names and modal layering.
Independent persistence and UI reviews found two issues (empty native selection
mismatch and nested fullscreen Escape); both were corrected before integration.

Exact combined source, final counts and actual Scanner browser receipts are
recorded with the integration checkpoint, not inferred from earlier commits.
The focused tests use a LockManager shim; native lock/focus behavior needs the
separate real-browser receipt. No latency target is established by these tests.

Still open: account/cloud sync and recovery, named multi-chart workspace
profiles, sharing permissions, study-on-study chains, TV/Pine or MT5 TPL imports,
object/style preset libraries, automatic layout backups, broader mobile/browser
coverage, and matched competitor timings. Browser-local settings are shared by
users of that browser profile and are not an account-private cloud vault.
