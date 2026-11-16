# Development Scanner / cockpit selective update

## Saved source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Application-source checkpoint: `45abd502e75589d0e3e86a967cada02824053888`.
- Recovery checkpoint: `619f259db5f265a379190de42ff39fa5f876c768`.
- Recovery reference: `codex/backup-before-scanner-cockpit-20261031`.
- Verified open draft PR104 head:
  `861c56f913e6424cfc4e26eefaa8f09c7dc0aca1`.
- Candidate checked application source:
  `f09edbad73cd6fb1e3e44d8e500e95e22796ce84`.
- Selective delta base: `a6147137c9da303c33422d8895a42475889f6b8d`.
- The final report checkpoint is the commit containing this report; its exact
  full SHA is recorded in the delivery and ignored checkpoint receipt.

The workspace started clean at the authorized recovery checkpoint. No concurrent
integration/test process, staging changes or Git lock was observed. No unrelated
workspace changes appeared during this work. This is a point-in-time observation,
not a guarantee about other actors outside this workspace.

## Scope and preservation

Imported the draft's 38-path selective-source manifest, not the full PR or tree.
All 36 non-manifest files matched expected pre-change blobs/absence and now match
the candidate's exact final blobs. Both package manifests were reconciled:

- API manifest: added only `test:account-stream-scheduling`.
- Root manifest: appended only its invocation to the existing `ci` command.
- Existing Express dependency, API `test:execution-epistemology` and
  `test:mt5-terminal-results` command changes, all other manifest values,
  dependency versions and lockfiles were preserved.

Every tracked source path outside the selected set remains identical to the
recovery checkpoint. In particular, the locally different API `app.ts` and
`index.ts`, authentication routes, `useCurrentUser`, chart Truth evidence tests,
Truth evidence fixtures, preview launchers, sign-out behavior and startup safety
fixes were not replaced with upstream versions. The earlier chart/navigation
import outside these paths is unchanged. No schema, migration, order/risk gate,
one-click permission or execution-setting source was changed.

The machine-readable preservation audit contains exact blobs for every imported
path. A separate inventory records all recovery-source differences from the
upstream delta base, including unchanged local-only files, so preservation is
not limited to the examples above.

## Imported behavior

- Mobile native chart places the plot before secondary controls; notices remain
  above it. Scanner summaries/feed details are accessible disclosures, and
  fullscreen remains available. Desktop controls remain in their desktop order.
- Chart-reader reuse revalidates source, finality, window and freshness before
  reusing a bounded result; invalid evidence withdraws reuse.
- Initial/event/fallback account stream reads share a serialized scheduler.
  Subscriber exceptions are isolated so one viewer does not starve others.
- Shared read-transport pause/manual refresh/resume; retained evidence ages
  without needing another network update. Last-known/paused/stale wording does
  not upgrade evidence or change amounts.
- Plain-text chart library credit remains; no graphic logo was added.

These describe imported source and deterministic checks. Actual authenticated
served rendering and funds behavior remain BLOCKED, as detailed below.

## Actual validation on this combined workspace

All commands used a credential-free environment, unusable synthetic loopback
database target, disabled execution/settlement/public-provider test settings and
external-network guard. No application database fixture, native terminal or
broker/live/demo test was run.

| Check | Actual result |
|---|---|
| Full frontend suite | **2,472 passed / 11 skipped / 0 failed**, 2,483 total |
| Frontend files | **172 passed / 1 skipped**, 173 total |
| Server scheduler/route/listener suite | **13 passed / 0 skipped / 0 failed** |
| Strict Scanner navigation-tool tests | **9 passed / 0 failed** |
| Disclosure geometry/state tools | **6 passed / 0 failed** |
| Shared freshness-policy fixture command | PASS, including **8 negative display-policy fixtures** |
| Root typecheck (libraries, API, frontend, scripts) | PASS, exit 0 |
| API production build | PASS, exit 0 |
| Frontend production build | PASS, exit 0 |
| CI guards | **87/87 passed** |
| Master live-bridge syntax binding fixtures | **7 assertions passed** |
| Selective-source/preservation audit | PASS, 36 exact files + 2 reconciled manifests |
| Whitespace/diff check | PASS |

These are actual local counts, not the candidate report's quoted 2,477 frontend
passes or 84 tooling checks. This pass ran 15 selected navigation/disclosure
tooling tests; it does not claim the candidate's complete 84-check tooling run.
No automated check failed and none was rerun to erase an initial failure.
The 11 frontend skips comprise the 9 feed-badge skips and the 2 opt-in reader
performance benchmarks in one skipped file.

Warnings retained: frontend bundle chunks above 500 kB; API bundle-size advisory;
28 React act-warning occurrences, 4 chart zero-size warning occurrences, and
hydration/DOM-nesting warning text in the frontend suite. Passing tests do not
resolve those warnings. Full root CI, database integration, release/launch,
native-terminal and broker suites were not run.

## Development runtime

After source checks passed, restarted only the existing development frontend and
API workflows once each, without changing their commands/settings. The frontend
continues to serve Vite development source, not the production `dist` build.
Read-only served module checks found the mobile-layout/fullscreen code and
shared preference/evidence-aging hook in the actual served modules; this proves
served source availability, not successful authenticated rendering.

- Frontend and API workflows running.
- `/api/healthz`: HTTP 200, `status: ok`.
- `/api/health/ready`: HTTP 200.
- API startup explicitly reports preview safe start/background jobs paused,
  authentication available and no schema migration performed.
- Launchers retain settlement disabled, live broker execution disabled and
  broker credentials excluded; public chart data remains enabled as before.
- Startup still emits its pre-existing fresh-reconciliation-gate OFF warning.
  This default was not changed and is not a launch-readiness approval.
- Provider access/rate-limit warnings (including 403/429) remain in runtime logs.
  They were not treated as successful market-data evidence.

No migrations, forced schema pushes, direct existing-database operations,
credential/account changes, emails, orders, main merges or publishing were
performed. No worker/trading switch was enabled. Existing startup code/settings
were preserved rather than modified to satisfy this update.

## Actual served browser inspection: BLOCKED / incomplete

One bounded testing pass was attempted after the refresh. No authenticated
browser context was available: the previous QA session had been revoked and its
contexts closed. The owner's separate signed-in preview was not accessible to
the test browser. No login, credential access, session creation/revocation or
account change was attempted.

Before the anonymous context's first navigation, an all-origin route allowed
only GET/HEAD/OPTIONS and locally failed other methods with HTTP 451. No
mutations were attempted; blocked count **0**. No GETs were mocked or replaced.
No onboarding preferences, chart settings, templates or notes were saved.
The test-created anonymous context was closed.

- Four setup/read-only checks completed: route installed, login route reached,
  `/api/me` 401 observed, and context closed.
- Three authenticated desktop areas BLOCKED: Cockpit, funds/refresh, Scanner.
- One mobile Scanner check SKIPPED because authentication was unavailable.
- The anonymous route redirected to `/login`. Its immediate visibility check
  was false; accessibility later listed login controls, while screenshot
  `pwnjn2` showed a centered loading skeleton. This discrepancy is retained:
  login-form visual rendering was **not** certified.
- No authenticated desktop/mobile screenshot, initial mobile plot intersection,
  disclosure keyboard/fullscreen interaction, actual funds update, stream
  pause/manual/resume, or real evidence-expiry behavior was verified in-browser.
  Those outcomes are not inferred from unit tests or served-module markers.

Browser evidence:
`generated-artifacts/arx-scanner-cockpit-validation/browser-inspection.json`
and `browser-inspection.md`. The screenshot exists as tool artifact `pwnjn2`;
the browser tool did not expose it as a workspace image file.

## Timing, parity and earlier limitations

**Immediate-first-click acceptance remains FAILED/incomplete.** No new timing
acceptance run was performed. Earlier six warm observations and two invalid
corrections remain in `ARX_SCANNER_NAVIGATION_SPEED_UPDATE.md` and
`generated-artifacts/arx-scanner-navigation-validation/`; none were discarded.

The upstream combined offline synthetic desktop/mobile medians near 116 ms are
not this Replit preview. That upstream run itself recorded **0/10 meeting
100 ms**, a FAIL. Fixed synthetic response timing, DOM/render opportunities and
reader reuse do not prove hardware paint, a real provider's latency, completed
analysis or instant loading.

Preserved earlier caveats: M2 no-data/loading; inconclusive actual zoom/pan range;
mobile Study-panel overlap; onboarding hydration warnings; legacy `/live-manual`
404s; historical ordinary automatic alert POSTs and their unqueried possible
effects. The new mobile source does not clear an old browser limitation without
new authenticated evidence. New write blocking does not retroactively establish
zero writes in the earlier historical pass.

Candidate documentation also retains cockpit Truth gaps: denied-read tiles may
still say no-events/no-alerts/no-red-flags. This scoped update does not certify
those reads, fix those gaps or establish broker/cross-process funds latency.

**No parity verdict and no launch-ready approval.** Source integration and local
automated validation passed; authenticated served acceptance is still blocked.

## Retained evidence

All detailed evidence is ignored from Git/deployment under:
`generated-artifacts/arx-scanner-cockpit-validation/`.

- `import-manifest.json`, `upstream-development-source-manifest.json`
- `upstream-COMBINED_SCANNER_COCKPIT_2026_10_31.md`
- `preservation.json`, `preserved-local-differences.json`, `audit.py`
- `checkpoint-receipt.json`
- `combined-frontend-results.json`, `combined-frontend-0.log`
- `combined-compile-results.json`, `combined-compile-{0,1,2}.log`
- `combined-relevant-results.json`, `combined-relevant-{0,1,2,3}.log`
- `remaining-tooling-results.json`, `remaining-tooling-0.log`
- `run.py`, `offline.cjs`
- `browser-brief.md`, `browser-inspection.json`, `browser-inspection.md`
- `runtime-checks.json`, `evidence-manifest.json`
