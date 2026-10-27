# Study calculation allocation reduction

The calculator retains the same recursive seeds, arithmetic order, checkpoints and outputs. It creates its averaging helper once per calculation instead of once per bar, normalizes each newly owned channel array in place, and avoids a discarded initial channel array. The renderer opts out of collecting a second array of changed points because it already reads the calculator's canonical points. Default callers still receive the complete changed-point list.

There is no future-state cache, hidden calculation or worker. A rewind truncates calculated state; a full forward seek still calculates its supplied prefix. Exact comparisons against the frozen prior source cover all 17 studies, two applied-price modes, rewinds, appends, middle corrections, shifted windows and empty histories: 680 comparisons pass. The focused renderer/reader/calculator suites pass 105 tests.

## Paired browser evidence

The final larger local trial uses 5,000 constructed closed bars, 12 studies, the existing 37-name reader and CPU4 throttling, with 40 samples for each direction of steps and seeks. All 160 installed-series and reader-DOM witnesses per version match; page errors are zero. Screenshots were inspected for geometry and controls.

Full forward-seek applied-series median/p95/p99 changes from 89.6/97/110.3 ms to 79.55/91/101.4 ms. Reader DOM observation changes from 102.15/109.7/123.3 ms to 91.95/103.3/113.9 ms. Reader-following rAF opportunity changes from 131.75/146/164.8 ms to 121.4/139.8/158.8 ms. Separate second-rAF timing changes from 138.55/154.8/172.2 ms to 127.9/147.4/166.5 ms. The overall 100 ms target therefore **fails**. Step directions remain below 54 ms at p95 in this trial.

This trial starts directly at CPU4. Earlier smaller trials ran CPU1 first; their absolute timings must not be compared as a speedup. Every valid trial and outlier remains in the external `arx-tier1-release/chart-study-allocation-20261026` receipt folder. No repeat was used to replace the clear failed larger trial. A future pass requires at least 40 samples per direction and a repeat. rAF opportunity is distinct from actual physical display, and these results do not establish 60 fps or competitor parity. The later expanded catalogue and descriptive reader require their own integration measurement.
