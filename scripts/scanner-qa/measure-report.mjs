// Statistics and Markdown summary for measure.mjs (kept separate so they are unit-tested:
// measure-report.test.mjs). Pure functions over the runner's results.json data.
import { writeFileSync } from "node:fs";
import path from "node:path";

// The scanner click-feedback target. Not configurable.
export const TARGET_MS = 100;

// ---- Statistics ----------------------------------------------------------------------------
// Nearest-rank percentiles, the definition both scenarios use for their p95.
export const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(s.length * p) - 1)] : null; };
export const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
export const round1 = x => x == null ? null : Math.round(x * 10) / 10;
// Outlier: further than 3 scaled MADs (3 × 1.4826 × MAD, about 3 standard deviations for
// normal data) from the median. With MAD = 0 nothing is flagged. Outliers are listed, never dropped.
export const outlierRule = "|x − median| > 3 × 1.4826 × MAD";
export const outliers = (values) => {
  if (values.length < 3) return { median: median(values), mad: null, threshold: null, indices: [] };
  const m = median(values), mad = median(values.map(v => Math.abs(v - m)));
  const threshold = 3 * 1.4826 * mad;
  return { median: m, mad, threshold, indices: mad > 0 ? values.map((v, i) => Math.abs(v - m) > threshold ? i : -1).filter(i => i >= 0) : [] };
};
export const describe = values => values.length ? { n: values.length, p50: round1(percentile(values, .5)), p95: round1(percentile(values, .95)),
  p99: round1(percentile(values, .99)), max: round1(Math.max(...values)), mean: round1(values.reduce((a, b) => a + b, 0) / values.length) } : { n: 0 };

// ---- Bundle provenance -------------------------------------------------------------------
// Why a production bundle's build info does not belong to the checkout it is reported
// under (null when it does): another source directory, another commit or dirty state,
// different uncommitted changes (dirtyHash, when both sides recorded one), a tree that
// changed during the build, or git state that could not be read on either side.
export const buildMismatch = (buildInfo, checkout) => {
  if (!buildInfo) return "the bundle has no readable build info";
  if (buildInfo.source && buildInfo.source !== checkout.path) return `built from ${buildInfo.source}, not ${checkout.path}`;
  const b = buildInfo.git ?? {}, c = checkout.git ?? {};
  if (b.dirty === "unknown" || c.dirty === "unknown" || !b.head || !c.head) return "git state unknown for the bundle or the checkout";
  if (b.head !== c.head || b.dirty !== c.dirty) return `built from ${b.head}${b.dirty ? " (dirty)" : ""}, checkout is at ${c.head}${c.dirty ? " (dirty)" : ""}`;
  if (b.dirty && typeof b.dirtyHash === "string" && typeof c.dirtyHash === "string" && b.dirtyHash !== c.dirtyHash) return `uncommitted changes differ between the bundle (${b.dirtyHash.slice(0, 12)}) and the checkout (${c.dirtyHash.slice(0, 12)})`;
  if (b.treeChangedDuringBuild === true) return "the working tree changed during the build";
  if (b.treeChangedDuringBuild === "unknown") return "whether the tree changed during the build is unknown";
  return null;
};

// ---- Summary (also used by --summarize) ------------------------------------------------
export const SURFACES = { fixture: "Scanner fixture (isolated Opportunity Map, scripts/scanner-qa)", app: "Integrated scanner page (dashboard /market-scanner, Broad Scan tab)" };
export const MODES = { prod: "Production build", dev: "Development server" };
export const summarize = data => {
  const recorded = data.iterations.filter(it => !it.warmup);
  const groups = [];
  for (const mode of data.config.modes) for (const surface of data.config.surfaces) for (const checkout of data.checkouts) {
    const its = recorded.filter(it => it.mode === mode && it.surface === surface && it.checkout === checkout.label);
    const errors = its.filter(it => it.error);
    const rates = [...new Set(its.flatMap(it => (it.runs ?? []).map(r => r.cpuRate)))].sort((a, b) => a - b);
    const perRate = rates.map(cpuRate => {
      const runs = its.flatMap(it => (it.runs ?? []).filter(r => r.cpuRate === cpuRate).map(r => ({ ...r, iteration: it.index, round: it.round })));
      const samples = runs.flatMap(r => r.samples.map((ms, click) => ({ ms, click, iteration: r.iteration, round: r.round })));
      const sampleOut = outliers(samples.map(s => s.ms));
      const p95s = runs.map(r => r.p95);
      const runOut = outliers(p95s);
      return { cpuRate, runs: runs.length, breaches: runs.filter(r => r.breach).map(r => ({ iteration: r.iteration, round: r.round, p95: r.p95, max: r.max })),
        perRunP95: { median: round1(median(p95s)), min: round1(Math.min(...p95s)), max: round1(Math.max(...p95s)), values: p95s.map(round1) },
        samples: describe(samples.map(s => s.ms)),
        sampleOutliers: { rule: outlierRule, median: round1(sampleOut.median), threshold: round1(sampleOut.threshold), items: sampleOut.indices.map(i => ({ ...samples[i], ms: round1(samples[i].ms) })) },
        runP95Outliers: { rule: outlierRule, threshold: round1(runOut.threshold), items: runOut.indices.map(i => ({ iteration: runs[i].iteration, round: runs[i].round, p95: round1(runs[i].p95) })) },
        longTasks: runs.some(r => r.longTasks) ? describe(runs.flatMap(r => (r.longTasks ?? []).map(t => t.duration))) : undefined };
    });
    const loads = its.map(it => it.load.before[0]);
    const serverErrors = (data.serverErrors ?? []).filter(e => e.mode === mode && e.surface === surface && e.checkout === checkout.label);
    // Production bundles served for this group, with any provenance mismatch.
    const bundles = mode === "prod" ? (data.servers ?? []).filter(s => s.mode === mode && s.surface === surface && s.checkout === checkout.label)
      .map(s => ({ round: s.round, buildId: s.buildId, builtAt: s.buildInfo?.builtAt ?? null, git: s.buildInfo?.git ?? null, source: s.buildInfo?.source ?? null,
        mismatch: "buildMismatch" in s ? s.buildMismatch : buildMismatch(s.buildInfo, checkout) })) : [];
    // What the integrated-page fixture did not model: endpoints answered 503, requests it
    // refused, and clicks whose reads had not settled. Only scenarios that report them.
    const gapIts = its.filter(it => it.unknownEndpoints || it.blocked);
    const gapRuns = its.flatMap(it => (it.runs ?? []).filter(r => r.unsettledAfterClicks !== undefined || r.settledBeforeClicks !== undefined));
    let fixtureGaps;
    if (gapIts.length || gapRuns.length) {
      const blocked = gapIts.flatMap(it => it.blocked ?? []), mutations = {};
      for (const b of blocked.filter(b => b.kind === "mutation")) mutations[`${b.method} ${b.path}`] = (mutations[`${b.method} ${b.path}`] ?? 0) + 1;
      fixtureGaps = { unknownEndpoints: [...new Set(gapIts.flatMap(it => it.unknownEndpoints ?? []))].sort(), partialModels: [...new Set(gapIts.flatMap(it => it.partialModels ?? []))].sort(),
        mutations: Object.entries(mutations).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), mutationCount: blocked.filter(b => b.kind === "mutation").length,
        websockets: blocked.filter(b => b.kind === "websocket").length, external: blocked.filter(b => b.kind === "external").length,
        unsettledClicks: gapRuns.reduce((n, r) => n + (r.unsettledAfterClicks?.length ?? 0), 0), unsettledBefore: gapRuns.filter(r => r.settledBeforeClicks === false).length };
    }
    groups.push({ mode, surface, checkout: checkout.label, iterations: its.length,
      errors: errors.map(it => ({ iteration: it.index, round: it.round, error: it.error, ...(it.partialRuns?.length && { partialRuns: it.partialRuns }) })), serverErrors, bundles, fixtureGaps,
      passed: its.length > 0 && !errors.length && !serverErrors.length && !bundles.some(b => b.mismatch) && perRate.every(r => !r.breaches.length), perRate,
      load1: loads.length ? { min: round1(Math.min(...loads)), max: round1(Math.max(...loads)) } : null });
  }
  return groups;
};
export const markdown = (data, groups) => {
  const L = [];
  const env = data.environment;
  L.push(`# Scanner responsiveness measurement`, "");
  L.push(`Generated ${data.finishedAt ?? "(incomplete run)"} by \`scripts/scanner-qa/measure.mjs\`.`, "");
  L.push(`Command: \`${data.command}\``, "");
  L.push(`Target (unchanged): each run's p95 from a trusted row click to the second requestAnimationFrame is at most ${TARGET_MS} ms, at 1× and at 4× CPU throttle (20 clicks per run). The second animation frame is a render-opportunity proxy, not a hardware presentation timestamp; CPU throttling is not a physical-device benchmark.`, "");
  L.push(`Host: ${env.cpus} CPUs (${env.cpuModel}), ${env.platform}, Node ${env.node}, Playwright ${env.playwright}, Chromium ${env.browser}. 1-minute load average ${env.loadBefore.map(round1).join(" / ")} (1/5/15) at start${data.environment.loadAfter ? `, ${data.environment.loadAfter.map(round1).join(" / ")} at end` : ""}.`, "");
  const busy = data.iterations.filter(it => it.load.before[0] > env.cpus * .5);
  if (busy.length) L.push(`**Load warning:** ${busy.length} of ${data.iterations.length} iterations started with a 1-minute load average above half the CPU count; treat timings as noisy.`, "");
  L.push(`| Checkout | Path | Commit | Dirty |`, `| --- | --- | --- | --- |`);
  for (const c of data.checkouts) L.push(`| ${c.label} | \`${c.path}\` | \`${c.git.head ?? "unknown"}\`${c.git.branch ? ` (${c.git.branch})` : ""} | ${c.git.dirty} |`);
  L.push("");
  if (data.checkouts.length === 2) {
    const [a, b] = data.checkouts, differ = Object.keys(a.fixtureSha256).filter(f => a.fixtureSha256[f] !== b.fixtureSha256[f]);
    L.push(differ.length ? `Fixture files that differ between the checkouts: ${differ.map(f => `\`${f}\``).join(", ")}.` : `The scanner-qa fixture files (\`${Object.keys(a.fixtureSha256).join("`, `")}\`) are identical in both checkouts.`, "");
  }
  const fails = groups.filter(g => !g.passed);
  L.push(`**Overall: ${fails.length ? `FAIL — ${fails.length} of ${groups.length} measured groups breached the target or had errors` : `PASS — all ${groups.length} measured groups within the target`}.** Every breach, error and outlier is listed below.`, "");
  for (const mode of data.config.modes) {
    L.push(`## ${MODES[mode]}`, "");
    if (mode === "dev") L.push(`Vite dev server with React's development build: includes development-only work that does not ship. Reported separately; it does not replace or offset the production result.`, "");
    else L.push(`\`vite build\` in production mode (minified), React production build, served statically by \`prod-server.mjs\`; the bundle guard rejects development React.`, "");
    for (const surface of data.config.surfaces) {
      L.push(`### ${SURFACES[surface]}`, "");
      L.push(`| Checkout | CPU | Runs | Breaches > ${TARGET_MS} ms | Errors | Per-run p95 median (min–max) | All clicks p50 / p95 / p99 / max | Click outliers | Verdict |`);
      L.push(`| --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- |`);
      for (const g of groups.filter(x => x.mode === mode && x.surface === surface)) {
        // A verdict on a page whose fixture left endpoints unanswered says so in the cell.
        const gap = g.fixtureGaps?.unknownEndpoints.length ? ` (${g.fixtureGaps.unknownEndpoints.length} endpoints unavailable)` : "";
        if (!g.perRate.length) L.push(`| ${g.checkout} | — | 0 | — | ${g.errors.length} / ${g.iterations} | — | — | — | **FAIL** (no measurements) |`);
        for (const r of g.perRate)
          L.push(`| ${g.checkout} | ${r.cpuRate}× | ${r.runs} | ${r.breaches.length} | ${g.errors.length} / ${g.iterations} | ${r.perRunP95.median} ms (${r.perRunP95.min}–${r.perRunP95.max}) | ${r.samples.p50} / ${r.samples.p95} / ${r.samples.p99} / ${r.samples.max} ms | ${r.sampleOutliers.items.length} / ${r.samples.n} | ${r.breaches.length || g.errors.length || g.serverErrors.length || g.bundles.some(b => b.mismatch) ? "**FAIL**" : "pass"}${gap} |`);
      }
      L.push("");
      for (const g of groups.filter(x => x.mode === mode && x.surface === surface)) {
        for (const r of g.perRate) {
          L.push(`- ${g.checkout} ${r.cpuRate}×: per-run p95 values ${r.perRunP95.values.join(", ")} ms${r.longTasks ? `; long tasks n=${r.longTasks.n}, p50 ${r.longTasks.p50} ms, max ${r.longTasks.max} ms` : ""}.`);
          for (const b of r.breaches) L.push(`  - **Breach:** round ${b.round} iteration ${b.iteration}: p95 ${round1(b.p95)} ms (max ${round1(b.max)} ms).`);
          if (r.runP95Outliers.items.length) L.push(`  - Run-level p95 outliers (${r.runP95Outliers.rule}, threshold ${r.runP95Outliers.threshold} ms): ${r.runP95Outliers.items.map(o => `round ${o.round} iteration ${o.iteration} ${o.p95} ms`).join("; ")}.`);
          if (r.sampleOutliers.items.length) L.push(`  - Click outliers (${r.sampleOutliers.rule}; median ${r.sampleOutliers.median} ms, threshold ±${r.sampleOutliers.threshold} ms): ${r.sampleOutliers.items.map(o => `r${o.round}/i${o.iteration}/click ${o.click + 1} ${o.ms} ms`).join("; ")}.`);
        }
        for (const e of g.errors) L.push(`- **Error** ${g.checkout} round ${e.round} iteration ${e.iteration}: ${e.error}${e.partialRuns ? ` (samples kept in results.json: ${e.partialRuns.map(r =>
          `${r.cpuRate}× ${r.samples.length} clicks${r.inProgress ? " (run interrupted)" : ""}, p95 ${round1(percentile(r.samples, .95)) ?? "—"} ms`).join("; ")})` : ""}`);
        for (const e of g.serverErrors) L.push(`- **Server failure** ${g.checkout} round ${e.round}: ${e.error}`);
        for (const b of g.bundles) {
          L.push(`- ${g.checkout} Bundle round ${b.round}: build ${b.buildId}, built ${b.builtAt ?? "unknown"} from \`${b.git?.head ?? "unknown"}\` (dirty: ${b.git?.dirty ?? "unknown"})${b.git?.dirtyHash ? `, uncommitted-changes hash ${b.git.dirtyHash.slice(0, 12)}` : ""}, source \`${b.source ?? "unknown"}\`.`);
          if (b.mismatch) L.push(`  - **Bundle/checkout mismatch** ${g.checkout} round ${b.round}: ${b.mismatch}. These results are not attributed to the checkout's commit.`);
        }
        const fg = g.fixtureGaps;
        if (fg) {
          L.push(`- ${g.checkout}: measured with the fixture's gaps. Endpoints answered 503 (not modelled by the fixture): ${fg.unknownEndpoints.length ? fg.unknownEndpoints.map(e => `\`${e}\``).join(", ") : "none"}.`);
          if (fg.partialModels.length) L.push(`  Modelled with a minimal shape: ${fg.partialModels.join("; ")}.`);
          L.push(`  Blocked requests: ${fg.mutationCount} mutations${fg.mutations.length ? ` (${fg.mutations.map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}, ${fg.websockets} WebSocket, ${fg.external} other-origin.`
            + ` ${fg.unsettledClicks} clicks did not settle within 15 s; ${fg.unsettledBefore} run${fg.unsettledBefore === 1 ? "" : "s"} started ${fg.unsettledBefore === 1 ? "its" : "their"} clicks before the page settled.`);
        }
        if (g.load1) L.push(`- ${g.checkout}: 1-minute load average at iteration start ${g.load1.min}–${g.load1.max}.`);
      }
      L.push("");
    }
  }
  // Warm-ups do not decide the verdict, but each one's p95 values, breaches and errors are shown.
  const warm = data.iterations.filter(it => it.warmup);
  if (warm.length) {
    const breached = warm.flatMap(w => (w.runs ?? []).filter(r => r.breach)).length;
    L.push(`Warm-up iterations (${warm.length}, one per server start by default) are kept in \`results.json\` with \`"warmup": true\` and excluded from the tables and the verdict.${breached ? ` **${breached} warm-up run${breached === 1 ? "" : "s"} breached the target** (reported here, not counted).` : ""}`, "");
    for (const w of warm) L.push(`- ${MODES[w.mode]} / ${w.surface} / ${w.checkout} round ${w.round}: ${w.error ? `**error** ${w.error.split("\n")[0]}` : (w.runs ?? []).map(r => `${r.cpuRate}× p95 ${round1(r.p95)} ms${r.breach ? " **breach**" : ""}`).join(", ")}`);
    L.push("");
  }
  L.push(`Raw data: \`results.json\` (every click sample in click order, per-run p50/p95/p99/max, the scenario's own p95, breach flags, errors, load averages, server logs under \`logs/\`).`);
  return `${L.join("\n")}\n`;
};
export const writeReport = (dir, data) => {
  const groups = summarize(data);
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(groups, null, 2)}\n`);
  writeFileSync(path.join(dir, "summary.md"), markdown(data, groups));
  return groups;
};
