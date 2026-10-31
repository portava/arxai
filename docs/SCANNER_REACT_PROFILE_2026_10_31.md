# Scanner initial-render diagnosis — 31 October 2026

Status: diagnostic tooling and evidence only. Application source remains b107f1db
through the accepted development base 4944c950. The held toolbar experiment was
not included. No claimed latency fix, parity, release completion or percentage.
No deployment, main merge, application database, worker or broker activity.

## What the measurements establish

A first-click Chrome timeline was captured on the ordinary production fixture
231a719410806a0e, source 643899a0, at controlled4× CPU slowdown. Its first desktop
sample finished in446.4ms with tracing overhead. This is a diagnostic sample,
not a replacement for the earlier untraced benchmark. The trace includes a
206.35ms click dispatch, a29.4ms style update and5.07ms layout at the toolbar's
synchronous measurement stack. Other React work remains substantial. The full
trace and all ten runner samples remain in the receipts, explicitly diagnostic.

A separate React profiling build identifies the initial component subtrees:

| First Scanner commit observation | Desktop | Emulated mobile |
|---|---:|---:|
| Root rendering |42.0ms|39.0ms|
| Root effects |35.7ms|33.1ms|
| MarketScanner subtree |31.0ms|25.7ms|
| PageTabs subtree below the chart |14.3ms|11.7ms|
| ScannerChartPanel subtree |13.8ms|10.7ms|
| Native chart subtree (inside chart panel) |9.8ms|8.0ms|
| Toolbar subtree (inside native chart) |4.9ms|3.4ms|

These durations overlap through nesting; **do not add them**. They are from two
instrumented visits, not a statistical benchmark. The first commits were observed
114.8ms/84.5ms after the click, but that is not source-correct chart completion.
The observer itself took0.9ms/0.7ms on those commits. It recorded35/33 commits over
the whole document visits, with no dropped commits; this is not a count of chart
rerenders. Later bailed-out fibers can retain old duration values. They cannot be
counted again as fresh work. Review renamed the raw `mount` observation to
`alternateAbsent` to make clear that an absent alternate does not prove a mount or
participation in the current commit. The original captured payload retains its
old field name for fidelity; use only the first new Scanner subtree commit for
the table above. Original payloads are never rewritten to newer schema/source.

The next candidate should target the initial below-chart panel work and unrelated
parent updates around the chart, with direct regression and ordinary-runtime
browser evidence. This evidence does not establish the cause of the remote
Replit delays, nor justify hiding unfinished panels behind an early success flag.
Any deferred/offscreen treatment must verify scrolling, keyboard reachability,
layout stability, actual analysis availability and whole-page readiness separately.

## Tooling and isolation

Profiling build4bbf6b701890d745de49c16b3c7fedb05884aa57,
fixture88ae9c0ead31deb1, uses the installed React19.1.0 profiling renderer and
preserves component function names. It imports the actual Scanner, App, providers
and styles. It runs only on127.0.0.1:4299 and is explicitly diagnostic-only.
The normal first-navigation runner rejects profiling/unverified runtime metadata.
The observer stores bounded names/timings/tags, not component props or state.
It refuses any non-diagnostic origin or existing DevTools hook.

The ordinary build atc28122b9320873fbcb432c0409ab1c159c7b6f9f,
fixturec158d9634a95fd80, runs on4199. Browser inspection verified200 chart bars
and no `__arxReactProfile` observer. Asset inspection also found no diagnostic
observer code; metadata records diagnosticOnly=false and regular runtime checked.
The last code changefc6291cd only renames/clarifies the fiber-alternate observation;
its96 tooling tests pass. The captured browser results above retain their own
exact commits and are not represented as runs on that later revision.

96 tooling tests pass,0 fail/skip, including profile acceptance rejection, private
props/state avoidance, bounded/cyclic tree handling and origin isolation. The first
test invocation used the repository root, where tsx is not installed, and failed
at import. The corrected invocation ran from scripts; both logs are retained.
Both clean fixture builds and syntax/whitespace checks passed. Existing sourcemap
and chunk-size build warnings remain. Application suites/root CI were not rerun
for these fixture-only changes. Review was self-review, not an independent agent.

The profiling visits used Headless Chrome156.0.8078.79, desktop1440×1100 and
mobile390×844, controlled4× CPU slowdown restored afterward. Synthetic historical
200-bar candles, inactive reader, blocked APIs.132 requests,88 unknown reads,
8 blocked POSTs,94 HTTP-denial console errors,0 page exceptions. Counts describe
an isolated mock session, not a healthy live provider. All owned browsers/servers
were closed after the check.

## Reference research and boundaries

React documents that profiling adds overhead and requires a special production
build: [React Profiler](https://react.dev/reference/react/Profiler). The installed
renderer source and captured version, not the latest documentation version, govern
these private fiber observations. This fixture does not claim the public Profiler
API guarantees every private field it observes.

Browser-native offscreen rendering is a candidate, not an implemented improvement.
Chrome calls out keyboard-reachability verification and layout-jump risks:
[defer heavy content](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/defer-rendering-heavy-content).
MDN explains the interaction of content visibility and remembered intrinsic sizes:
[contain-intrinsic-size](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-size).
No accessibility or scrolling success is inferred from those sources.

Replit's separate previously authorized recorder update was confirmed busy by
read-only queries. It was never restarted or superseded. Retrieve its result
before attributing remote latency. Preserve the earlier failed timing evidence,
held experiments, unfinished competitive gaps and all no-deployment/trading bounds.

Receipts: docs/validation/scanner-react-profile-20261031/manifest.json.
Raw: /Users/areyouok/arx-tier1-release/scanner-render-trace-20261031.
