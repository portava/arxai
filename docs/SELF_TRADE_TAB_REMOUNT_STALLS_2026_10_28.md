# Self-trade admin page: tab-remount stalls — October 28, 2026

**Status:** investigated; no fix implemented. This is a documented issue, separate from the scanner measurements.

## Report

Release validation measured long tasks of up to about 185 ms on the admin self-trade page (`artifacts/trading-dashboard/src/pages/admin/self-trade-ai.tsx`). They appeared when switching back to the **Autonomous Execution** tab, at 4× CPU throttle, in a production build. Every long task in that run came after a switch back to that tab (validation harness results `prod-4x.json`, `d25e3c1-prod-4x.json`). At 1× there were none.

## Method

The real `AutonomousExecutionTab` and `OverviewTab` are mounted inside the real `PageTabs`, with the real generated query hooks. Only `window.fetch` is stubbed: one execution row, no kill switches.

The harness is not the full page, and differs from it in these ways:

- There is no app shell or layout (sidebar, header, route wrapper). The tabs render alone in a `<main>`.
- The stubbed data is one execution row and no kill switches, so the table and the kill-switch list are near their smallest.
- The harness's `QueryClient` was created with `retry: false` only. The real app's global `QueryClient` (`App.tsx`) sets `retry: 1`, `staleTime: 30_000`, `gcTime: 5 min`, `refetchOnWindowFocus: false`, `refetchOnReconnect: "always"` and `refetchIntervalInBackground: false`. Item 4 below and the re-profile under it account for this difference. The harness is built with `vite build` in production mode. Chromium runs at 4× CPU throttle, and the harness switches Overview → Autonomous Execution 8–12 times per run. Three instruments:

1. **Long tasks:** a `PerformanceObserver` records them for each switch.
2. **Trace and CPU profile:** a Chrome devtools timeline trace and a CDP CPU profile (100 µs sampling) are taken on an unminified build. Each switch window is delimited by a named marker function and `performance.mark`.
3. **Per-component render time:** a React profiling build (`react-dom/profiling`) reports each commit's self render time through the DevTools global hook, by component and by tab section.

Scratch harness (not part of the repository): `/home/claude/val/r3-scanner/tabs/`. It contains `profile.cjs`, `trace.py`, `longtask.py`, `fibers.cjs` and `build.mjs`. `build.mjs --app-query-defaults` builds it with the app's `QueryClient` defaults; `profile2.cjs` also records the reads made in each switch window (results `qd-*.json`).

The container was shared with other jobs, with a 1-minute load average of 1.4–3 on 4 CPUs. The absolute numbers below are noisy. The breakdown is consistent across runs.

## Findings

Each switch back takes 73–232 ms of long tasks at 4× (median per-switch maximum 96–116 ms). Switching away takes about 50–120 ms. The cause is a full remount of the tab's subtree inside one input task.

1. **The tab remounts on every switch.** Radix `TabsContent`, used by `PageTabs`, wraps the content in `Presence` and unmounts inactive tabs. Each return mounts about 244 new fibers in one commit, plus about 96 more in a follow-up commit, and unmounts the previous tab.
2. **The work starts at mousedown, synchronously.** Radix tab triggers activate on `mousedown`. React flushes this discrete update in a microtask inside the same task. In the longest task traced (139 ms at 4×):
   - about 74 ms of JavaScript: React render and commit of the new tab;
   - a forced style recalculation of 124 elements (6–17 ms) and another of 5 elements, from inside JavaScript (`Presence`'s `getAnimationName` → `getComputedStyle`);
   - layout of 18–24 ms and pre-paint of about 4 ms, from the browser's mousedown default action (focus);
   - focus, focusin and focusout handlers.

   Native style and layout average about 27 ms and 15 ms per long task.
3. **The kill-switch scope picker is the largest render cost.** The React profiling build reports the render self-time of the mount commit by section (one 4× run):

   | Section | Render self-time |
   | --- | --- |
   | `KillSwitchesSection` | 38 ms |
   | Execution feed `Card` (the table) | 23.5 ms |
   | `AutonomousExecutionTab` itself | 11.5 ms |
   | `RunAutonomousCycleCard` | 8.2 ms |
   | `StatCard`s | 4.9 ms |
   | `Alert` | 3.7 ms |

   Two more commits follow, both in `KillSwitchesSection`: 23.6 ms (96 new fibers: `SelectCollectionItemSlot`, `PopperProvider`, `<style>`) and 9.5 ms (`SelectItem`, `SelectItemText`). They come from the single Radix `Select` in `KillSwitchesSection`. When closed, it still renders its items into a detached fragment, and it does so in follow-up commits. Averaged over 6 switches, that section is 35 of about 55 ms of render self-time per switch.
4. **Refetch on remount came from the harness, not the app.** In the first profiles, each switch back started two reads (executions and kill switches), and their `isFetching` transitions caused further commits. That happened because the harness's `QueryClient` lacked the app's defaults. Neither query overrides the app's global `staleTime: 30_000`, and the executions query polls every 8 s while mounted. So in the real app, a return within 30 s of the last read does not refetch on mount.

   A re-profile with the app's `QueryClient` defaults in the harness confirms this. Everything else was unchanged: production build, 4× CPU, 12 switches per run, the two variants alternated, 1-minute load about 1–1.6.

   | Harness `QueryClient` | Reads per switch back | Median of per-switch max long task (switch back), run 1 / run 2 | Largest |
   | --- | --- | --- | --- |
   | `retry: false` only (first profiles) | 2 | 121.5 / 112 ms | 168 ms |
   | App defaults (`App.tsx`) | 0 | 125 / 111 ms | 249 ms |

   The stall does not change. It comes from the remount (items 1–3), not from the reads.

### Variant experiments

These were built from the same sources with a Vite alias swapped in the scratch harness. Nothing in the repository was changed. Each variant ran 2 × 12 switches at 4×. They used the first harness, with the `retry: false` `QueryClient`. The re-profile under item 4 shows that this difference does not change the stall.

| Variant | Median of per-switch max long task (switch back) |
| --- | --- |
| Baseline | 96 / 116 ms |
| Inactive tabs kept mounted (`forceMount`, hidden by `data-state`) | 53 / 66 ms |
| `Select` replaced by a probe that renders nothing while closed | 136 / 108 ms |

Keeping tabs mounted roughly halves the stall. Its remainder is the style, layout and paint of re-showing about 300 nodes. The `Select` probe showed no reduction at this noise level, despite the profiler's attribution, so its benefit is unproven.

## Options (not implemented)

None of these is both small and clearly free of behaviour change, so no fix is included.

- **A. Keep visited tabs mounted** (an opt-in `PageTabs` prop using `forceMount`, hiding inactive content). This has the largest measured effect. But hidden tabs keep their 8-second polling (executions, live decisions, volatility matrix), timers and memory, and form state persists across switches. That includes a typed kill-switch reason, which the owner would have to accept.
- **B. Make tab activation a transition** (`startTransition` or `useDeferredValue` for the content). The trigger highlight stays immediate while the mount is time-sliced. Commit, style and layout of the new subtree remain synchronous, so this needs `PageTabs` to decouple the trigger and content values. It is medium-sized and affects every page that uses `PageTabs`.
- **C. A lighter kill-switch scope picker** (for example, a native `<select>`, or a Radix `Select` whose items render only when open). The profiler attributes about 35 ms of throttled render per switch to it, but the probe did not show a measurable improvement. It also changes UI and accessibility behaviour, so it needs its own tests and review.
- ~~**D. `staleTime` for the executions query.**~~ Withdrawn. The app's global `staleTime: 30_000` already applies to both queries, so a remount within 30 s does not refetch. The re-profile under item 4 shows no reads on return and no change in the stall.

## Next step

Use the quiet-machine run, not these noisy numbers, to decide. If A or B is chosen, measure it with the same harness at 1× and 4× in a production build, and keep the remount-free behaviour covered by a component test.
