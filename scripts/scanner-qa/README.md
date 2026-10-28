# Scanner browser QA

Offline Playwright fixtures and scenarios for the scanner UI. Nothing here contacts a
broker, a market-data provider or the API server: the fixture replaces the data hooks,
and the integrated-page scenario answers every `/api` call in the browser with invented
JSON. None of it is part of the dashboard's production entry or build output.

## Fixtures and scenarios

| File | What it is |
| --- | --- |
| `server.mjs` | Vite **dev** server of the isolated Opportunity Map fixture (`main.tsx`, `api.ts`, `hooks.ts`), 127.0.0.1:4181 (`SCANNER_QA_PORT` overrides). |
| `prod-server.mjs` | **Production** build server. `--target=fixture` (default): the same fixture, `vite build`, 127.0.0.1:4182. `--target=app`: the whole dashboard built with its own `vite.config.ts`, 127.0.0.1:4187. |
| `app-dev-server.mjs` | Vite **dev** server of the whole dashboard with its own `vite.config.ts`, 127.0.0.1:4188. |
| `responsiveness.js` | Fixture scenario: 20 row clicks at 1× and 4× CPU throttle, p95 from click to the second animation frame, 100 ms target. |
| `app-responsiveness.js` | The same method and target on the real `/market-scanner` page (Broad Scan tab, real Opportunity Map rows), with all API calls intercepted. |
| `measure.mjs` | Runner: starts the servers, runs the scenarios repeatedly, keeps every sample, writes raw JSON and a Markdown summary. |
| `measure-report.mjs` | Statistics and summary rules of the runner; unit-tested by `measure-report.test.mjs` (`pnpm run test:scanner-qa-measure`, part of root CI). |
| `acceptance.js`, `rapid-interactions.js`, `saved-screens-acceptance.js`, `full-page-*.js` | Other acceptance scenarios (see `docs/SCANNER_*.md`). |

## Reproducible responsiveness measurement

From the repository root, with dependencies installed. Playwright is not a repository
dependency: set `PLAYWRIGHT_MODULE` to a Playwright package directory unless one
resolves from the repository or the global npm root.

```sh
# Production and development, fixture and integrated page, 5 recorded runs each:
node scripts/scanner-qa/measure.mjs --out=/tmp/scanner-measure

# Production fixture only, 15 runs:
node scripts/scanner-qa/measure.mjs --surface=fixture --mode=prod --iterations=15

# Alternate two checkouts (ABBA across rounds), e.g. two PR heads:
node scripts/scanner-qa/measure.mjs --compare=../other-checkout --label=pr100 --compare-label=pr99 --rounds=3 --iterations=5

# Rebuild the Markdown summary from saved raw data:
node scripts/scanner-qa/measure.mjs --summarize=/tmp/scanner-measure
```

Options: `--surface=fixture,app`, `--mode=prod,dev`, `--iterations=N` (recorded runs per
server start, default 5), `--rounds=N` (default 1), `--warmup=N` (unrecorded runs per
server start, default 1), `--no-build` (serve the bundles from an earlier run),
`--report-only` (exit 0 even when the target is missed). The default output directory is
`scripts/node_modules/.scanner-qa-measure/<UTC time>/`; an existing `results.json` is never
overwritten.

What it records, in `results.json`:

- every click sample in click order for every run (not only the p95), with the selected
  row state at the measured frame; per-run p50/p95/p99/max (nearest rank, as the
  scenarios compute p95) and the scenario's own p95;
- breaches of the unchanged 100 ms p95 target, per run;
- errors: any other scenario rule that failed (missing selection highlight, blanked
  rows, page errors), timeouts, and servers that failed to start or exited;
- for the integrated page, long tasks, request counts and the endpoints the fixture did
  not model (answered 503);
- 1-minute load average before and after each run, CPU count and model, Node,
  Playwright and Chromium versions, each checkout's commit, branch and dirty flag, the
  scenario hashes, and each production build's build info (id, git state, label);
- warm-up runs, flagged `"warmup": true` and excluded from the summary.

`summary.md` reports **production and development separately**, and the isolated fixture
separately from the integrated page. It lists every breach, every error and every
outlier. An outlier is a value further than 3 × 1.4826 × MAD from the median of its group
(about 3 standard deviations for normal data); outliers are listed, never removed, both
for single clicks and for per-run p95 values. Iterations that started with a load
average above half the CPU count are counted in a load warning.

The runner exits 1 if any run breaches the target, any iteration fails or any server
fails (0 with `--report-only`), and 2 on bad arguments. It refuses to run if a scenario's
final p95 rule no longer matches the text it expects: that rule is the only part of a
scenario it changes (from a throw into a recorded breach, so a breaching run keeps its
samples).

Each server can also be run alone, for example to profile by hand:

```sh
node scripts/scanner-qa/prod-server.mjs --target=app --unminified   # names and sourcemaps for CPU profiles
node scripts/scanner-qa/prod-server.mjs --target=fixture --check     # verify an existing bundle
```

`prod-server.mjs` follows `scripts/chart-qa/prod-server.mjs`: the bundle goes to a
git-ignored directory under `scripts/node_modules` that carries a sentinel, an exclusive
lock file guards every build and serve, `--no-build`, `--build-only` and `--check` behave
the same, and a bundle guard rejects development React (`react-stack-bottom-frame`,
`jsxDEV`) and, for the dashboard, development lightweight-charts. The page carries
`<meta name="arx-scanner-qa-build-id">`, which the runner checks against the build info.
`--source=<checkout>` builds another checkout with this script.

With `--compare`, both checkouts are measured with this checkout's scenarios. The
production bundles (fixture and dashboard) and the dashboard dev server come from this
checkout's `prod-server.mjs` and `app-dev-server.mjs` with `--source`. The fixture dev
server is the compared checkout's own `server.mjs` (an older checkout may not have this
tooling), which writes its Vite dependency cache inside that checkout. The summary records
hashes of each checkout's fixture files, so it shows whether the measured fixtures differ.

Limits. The second animation frame is a render-opportunity proxy, not a hardware
presentation timestamp. CPU throttling is not a physical device. The fixture measures
the Opportunity Map component alone; the integrated page includes the rest of the
scanner page (chart panel, header, other cards) with invented data, but not network,
provider or server latency. Timings depend on the host and its load: compare runs taken
on the same machine at the same time, alternating heads with `--compare`.
