# Smart Chart browser acceptance

This isolated fixture mounts the real `ARXNativeChart` and real Lightweight Charts
renderer. Only data hooks, history loading and EventSource are replaced. All bars
are explicitly synthetic. It opens no broker/API connection and contains no order
entry surface. It is outside the production dashboard entry and build output.

From the repository root, with dashboard dependencies installed:

```sh
node scripts/chart-qa/server.mjs
playwright-cli -s=arx-chart open http://127.0.0.1:4178 --browser=chrome
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/acceptance.js
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/workbench-acceptance.js
playwright-cli -s=arx-chart run-code --filename=scripts/chart-qa/interaction-latency.js
```

The server binds only to 127.0.0.1. Stop it when finished. If the local workspace
uses an external native esbuild binary, supply its matching ESBUILD_BINARY_PATH.

Acceptance exercises latest/history/log-scale controls, fullscreen and Escape,
crosshair OHLC, instrument/timeframe switching, mobile page overflow, canvas
lifecycle and a 5,000-bar rendering benchmark. It fails on browser exceptions,
lost history anchors or unexpected full-series replacements. Timings are measured
processing cost, not provider/network latency or complete rendered-frame latency.

The benchmark runs 100 tail-changing snapshot refreshes and 1,000 forming-bar
updates, followed by a 100-bar history prepend. It measures synchronous adapter
work using performance.now. Every test starts with 5,000 synthetic candles.
Only the initial load and history prepend should replace the entire series.

Workbench acceptance covers styles, configurable studies and pane cleanup,
three drawing tools, editable objects, undo/redo, symbol/timeframe persistence,
templates, an annotated PNG, two-chart layouts and mobile touch placement. It
also repeats the benchmark with all five studies enabled. Both scripts clear
only this isolated fixture origin's browser storage before running. Exported
images and browser screenshots are written under `/private/tmp/` for inspection.

The fixture mounts the real `SmartChartLayout` and primary `ARXNativeChart`.
The comparison chart uses the same synthetic data hooks. No order ticket or
authenticated application shell is present, so these browser checks are not
end-to-end deployment or broker tests.

For a same-machine comparison, the benchmark optionally accepts a module URL
exporting the baseline LightweightChartsAdapter. The recorded baseline was copied
from main commit 76cdbdc9 into a temporary sibling module and removed afterwards.
Do not ship an old adapter or expose this harness through production routes.

## Interaction latency

`interaction-latency.js` measures Smart Chart local controls by adapting the method
of `scripts/scanner-qa/responsiveness.js` (document capture, second rAF): a trusted
Playwright click or key press is captured in the window capture phase (the drawing
editor stops `pointerup` in its own window capture listener) and timed to the second
`requestAnimationFrame` after it (acknowledgement). A separate completion witness
is checked from that frame onwards: `aria-pressed` for timeframes, Invert scale
and Pan; `select.value` for Price scale and Chart style; a change in the rendered
time-axis pixels for Latest, Fit history, Reset, range presets, Go to UTC,
pan/zoom buttons and ArrowLeft/ArrowRight/+/- on the focused chart; the
Fullscreen/Exit fullscreen button; `Studies (12)` for the twelfth Add study; the
stored study period/colour; the stored drawing after a drag; and the
`arx-native-chart` count for One/Two/Four charts. Median, p95, p99 and maximum
(nearest-rank percentiles) are reported per control with overlapping
PerformanceObserver long tasks.

Before timing, the script writes 11 studies (including 1000-period Bollinger and
CCI) and 39 Fibonacci drawings through `arx.chart.preferences.v1` and
`arx.chart.drawings.v1:EURUSD:M15`, reloads, and adds one horizontal line through
the UI (40 drawings, the UI ceiling). Eleven studies keep Add study enabled
below the 12-study ceiling. It runs the same sequence at 1x and with
`Emulation.setCPUThrottlingRate` 4, at 1,600 × 1,100, with two warm-up
repetitions and 40 recorded repetitions per control in each of two passes.
It runs in its own page of the caller's context, so its init script and capture
listeners do not persist into a shared `arx-chart` session, and it always resets
the CPU throttle on exit. A full run takes about an hour in the shared 4-vCPU
development container (measured duration is in each result's `seconds`).

Results are labelled `offline synthetic fixture, Chromium, 4x CPU throttle, rAF
opportunity not paint, Vite dev server / React development build, shared
container, not reference hardware`. The fixture runs unbundled development code,
CPU throttling is not a physical-device benchmark, and a shared container is not
reference hardware. Chart style and Price scale are driven by trusted ArrowUp /
ArrowDown on a focused closed `<select>`, which changes the value in Chromium on
Linux and Windows; on macOS Chromium opens the popup instead, so those two
witnesses are verified on Linux only. The time-axis witness is any change in the
axis pixels, so it proves a repaint, not the exact intended range. With 80
samples per control the nearest-rank p99 equals the maximum.
The colour sample is the only untrusted one: a native colour picker has no
trusted automation path, so it times the input event that Playwright `fill`
dispatches and reports it as untrusted. The fixture does not mount
`ChartReplayBoundary`, so replay step/seek is not measured here.

The script always fails on a page error, a missing control or sample (the exact
41-control set is asserted), or a completion witness that does not appear within
5 s. `ENFORCE_P95_GATE` adds the scanner rule of failing when any control's
second-rAF p95 exceeds 100 ms. It is **off (report-only)** while recorded controls
miss the target, so every miss is reported in `targetMisses` and in
[the baseline](../../docs/SMART_CHART_ACCEPTANCE.md#local-control-interaction-latency)
as a FAIL finding instead of failing the run; turn it on once the controls meet
100 ms p95.

### Production-build column

The acceptance metric above is measured on the Vite dev server with React's
development build, which includes development-only work (React `jsxDEV` and the
lightweight-charts development checks) that does not ship. To report a
production-build column next to it, run the same scenario against a production
bundle of this fixture:

```sh
node scripts/chart-qa/prod-server.mjs            # vite build, then serve on 127.0.0.1:4179
```

Then evaluate `interaction-latency.js` with the target set, for example from a Node
Playwright launcher:

```js
const run = vm.runInNewContext(`(${source})`, { CHART_QA_BASE_URL: 'http://127.0.0.1:4179' });
const result = await run(page);
```

`prod-server.mjs` builds with the Vite 7 build defaults as used by the dashboard
(esbuild minify, no sourcemap); fixture aliases and entry as `server.mjs`. It does not
reproduce the dashboard's `vite.config.ts` (no `base`, no runtime error overlay plugin). It forces
`NODE_ENV=production`, so a launcher that sets `NODE_ENV=test` still gets production
React and lightweight-charts. `--unminified` keeps names and adds sourcemaps for CPU
profiles, `--build-only` builds and exits, `--no-build` serves an existing bundle, and
`--check` verifies an existing bundle and exits without serving.

Bundle guard. After every build, before `--no-build` serves, and on `--check`, every
JavaScript file of the bundle is scanned for string literals, which survive
minification. It fails if any development-only literal is present: React's
`react-stack-bottom-frame`, or the lightweight-charts development-build messages
`data must be asc ordered by time`, `series item data value must be` and
`should not be changed once the chart has been created` (in
`lightweight-charts.development.mjs`, absent from `lightweight-charts.production.mjs`).
It also fails if a production literal is missing: React DOM's `Minified React error #`
formatter (production build only) or lightweight-charts' `tv-lightweight-charts`
class (both builds, so with the development literals absent it shows the production
build), or if `index.html` loads a script that is not in the scanned bundle. The guard
recognises these two libraries' development builds only; it does not prove that the
rest of the bundle matches the dashboard's build.

Build info. Each build writes `arx-chart-qa-build-info.json` into the output directory:
a build id, the build start and end times, the minified and sourcemap flags, the label,
the Vite version, and the git state: HEAD, a dirty flag and a hash of the uncommitted
changes (tracked diff plus untracked, non-ignored files). The git state is read before
the build, so it describes the tree that was bundled, and read again after it:
`git.treeChangedDuringBuild` is `true` when the two differ (the later state is then in
`git.after`, and the build prints a warning), since other work can edit the checkout
during a build. If any git call fails (for example git's "dubious ownership" check when
another user runs the script), `dirty` and `treeChangedDuringBuild` are `"unknown"`,
`dirtyHash` is null and `git.error` says why; an unreadable tree is never recorded as
clean. The server labels the page from that file, not
from its own flags: it adds `<meta name="arx-chart-qa-build">` (for example
`Vite production build (minified) / React production build`) and
`<meta name="arx-chart-qa-build-id">`. `--no-build` and `--check` refuse a bundle without
this file. When the server is ready it prints
`Production chart fixture ready pid=<pid> build=<id>: http://127.0.0.1:4179 ...`; a
launcher should wait for that line, check that the served page carries the same build
id, and fail if the server process exits before or during the scenario.

Output directory. The bundle goes to the gitignored
`scripts/node_modules/.chart-qa-prod`; `--out=<dir>` overrides it and is resolved
against the repository root, not the current directory. Every build empties the
directory, so the directory must be inside `scripts/node_modules` or a git-ignored path
of this repository, and must be absent, empty, or carry the
`.arx-chart-qa-prod-server` sentinel that an earlier build wrote (symlinks are
resolved first; lock files do not count). The repository, its ancestors, tracked
directories, and paths outside
the repository are refused. A bundle from before the sentinel existed must be removed by
hand once.

Lock. Every run that builds or serves (the default, `--build-only` and `--no-build`)
holds `.arx-chart-qa-prod-server.lock` in the output directory from before it empties,
builds or serves until it exits, so two runs can never empty or rebuild a directory
under each other, on any port. The lock is created whole (written to a temporary file,
then hard-linked into place, which fails if a lock exists) and records the holder's pid,
mode, phase (`building` or `serving`) and a token. A second run on the same directory
exits at once, naming the holder, and changes nothing. A lock whose pid is no longer
running, or now belongs to a process whose command line does not mention `prod-server`
(Linux), is stale: the next run removes it and says so. The holder re-checks its token
just before it empties the directory, and removes the lock on exit, including after
SIGINT, SIGTERM or SIGHUP; only SIGKILL leaves a stale lock. `--check` changes nothing
and takes no lock, but refuses while a live holder is still `building`.

Port. A serving run takes the lock, then binds 127.0.0.1:4179 before it builds
(answering 503 until the bundle is ready) and exits at once, without building, if the
port is in use, so it cannot rebuild a bundle that an older server is still serving.
`--no-build` checks the bundle first and then binds. `--build-only` serves nothing, but
besides the lock it also refuses to build while anything listens on 4179. The server
binds only to 127.0.0.1. It builds the
working tree as it is, so dev and prod runs compare only when they are taken at the same
checkout; the build info's git fields show which.

`interaction-latency.js` targets `http://127.0.0.1:4178` unless a
`CHART_QA_BASE_URL` global is defined where the function is evaluated (for example
the context object of `vm.runInNewContext`) or, when the runner exposes `process`,
the `CHART_QA_BASE_URL` environment variable is set (`playwright-cli run-code` was not
checked for `process`; use the global if the variable is ignored). Targets are compared
after normalising: a trailing slash, `localhost` or `[::1]` for `127.0.0.1`, and the
letter case of scheme and host do not count. When the target is the dev server under
any such spelling, the output is unchanged: no `baseUrl` field, no meta read, and the
dev label. With any other target, the output gains a `baseUrl` field (the target as
given), and the build part of each run's `label` is read from the `arx-chart-qa-build`
meta tag (for example
`Vite production build (minified) / React production build at http://127.0.0.1:4179`);
a page without that tag is labelled `unlabelled build at <url>`. The browser context
must allow that
origin. Screenshots use the same `/private/tmp/` paths as dev runs, so keep them in a
separate output directory.

The production column is a second, labelled metric. It does not replace the dev
column, which stays the acceptance metric. Use the same protocol for both: the full
2 warm-up and 40 × 2 recorded repetitions at 1x and 4x, with production and dev runs
interleaved on the same container at the same commit. Report a dev-to-prod delta per
control only where repeated runs agree, and count a control as passing in production
only if every production run's 1x p95 is at or below 100 ms. A dev-only share of a
few tens of milliseconds cannot change the 4x verdicts.
