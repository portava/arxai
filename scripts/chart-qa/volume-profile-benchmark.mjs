/** Playwright page workload for the isolated --volume-profile frozen build.
 * Deliberately excludes API, React navigation and physical paint claims. */
export async function measureVolumeProfile(page, { samples = 30, warmups = 5 } = {}) {
  if (!Number.isInteger(samples) || samples < 20 || samples > 100 || warmups !== 5) throw Error('Unsupported measurement plan');
  const errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4209' || request.method() !== 'GET' || url.pathname.startsWith('/api/')) {
      blocked.push({ url: request.url(), method: request.method() }); return route.abort();
    }
    return route.continue();
  });
  await page.context().routeWebSocket('**/*', socket => { blocked.push({ url: socket.url(), kind: 'websocket' }); socket.close(); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:4209/market-scanner');
  await page.waitForFunction(() => !!window.__arxVolumeProfileProbe);
  const build = await page.evaluate(async () => (await fetch('/arx-scanner-qa-build-info.json')).json());
  if (build.buildId !== await page.evaluate(() => window.__arxScannerQaBuildId) || !build.volumeProfileProbe || !build.productionRuntimeChecked || !build.sourceUnchanged || build.source.status) throw Error('Unclean or wrong frozen build');
  const cdp = await page.context().newCDPSession(page), results = [];
  let outerFailure = null;
  const cleanupErrors = [];
  try {
    for (const cpu of [1, 4]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      for (const [count, rows] of [[200, 32], [1000, 32], [5000, 32], [5000, 128]]) {
        const result = await page.evaluate(async ({ count, rows, samples, warmups }) => {
          const probe = window.__arxVolumeProfileProbe, qa = window.__arxChartQa;
          const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const groups = [];
          // Existing studies remain present in every baseline and candidate run.
          probe.configure(count, rows, true); probe.view('full'); await frame();
          const initial = qa.snapshot();
          let failure = null;
          for (const operation of ['show', 'hide', 'pan-without-profile', 'pan-with-profile', 'quantity-correction', 'rows-edit']) {
           const timings = [], group = { operation, timings }; groups.push(group);
           try {
            probe.show(operation !== 'pan-without-profile'); await frame();
            const before = qa.volumeProfiles(), retained = operation === 'pan-with-profile' ? before.profiles[0].resultId : null;
            const initialRange = qa.snapshot().range;
            const companionIds = qa.configuration().studies.filter(s => s.config.kind !== 'volume_profile').map(s => ({id:s.config.id,lines:s.lineIds,calculator:s.calculatorId}));
            let moved = false;
            for (let i = 0; i < samples + warmups; i++) {
              if (operation === 'show') { probe.show(false); await frame(); }
              if (operation === 'hide') { probe.hide(false); await frame(); }
              const start = performance.now();
              if (operation === 'show') probe.show(true);
              else if (operation === 'hide') probe.hide(true);
              else if (operation.startsWith('pan-')) probe.pan(i % 2 ? 1 : -1);
              else if (operation === 'quantity-correction') probe.correctQuantity();
              else probe.changeRows(i % 2 ? rows : rows === 32 ? 128 : 32);
              const syncMs = performance.now() - start;
              await frame();
              timings.push({ warmup: i < warmups, syncMs, secondRafMs: performance.now() - start });
              if (operation.startsWith('pan-') && JSON.stringify(qa.snapshot().range) !== JSON.stringify(initialRange)) moved = true;
            }
            const after = qa.volumeProfiles(), finalRange = qa.snapshot().range;
            if (operation === 'pan-with-profile' && (after.profiles[0].resultId !== retained || !moved)) throw Error('Pan recomputed aggregate or did not move');
            if (operation === 'quantity-correction' && (after.profiles[0].resultId === before.profiles[0].resultId || after.profiles[0].result.totalTradeUnits - before.profiles[0].result.totalTradeUnits !== samples + warmups)) throw Error('Quantity correction not installed');
            if (!['pan-without-profile', 'hide'].includes(operation) && (after.profiles[0]?.result.status !== 'ready' || !after.profiles[0].geometry.length || after.profiles[0].dirty)) throw Error('Missing real calculated/rendered profile');
            if (operation === 'hide' && after.profiles[0].geometry.length) throw Error('Hidden geometry retained');
            const afterCompanions = qa.configuration().studies.filter(s => s.config.kind !== 'volume_profile').map(s => ({id:s.config.id,lines:s.lineIds,calculator:s.calculatorId}));
            if (companionIds.length !== 4 || (['show','hide','rows-edit'].includes(operation) && JSON.stringify(companionIds) !== JSON.stringify(afterCompanions))) throw Error('Existing indicator identities changed');
            Object.assign(group,{ beforeIds: before.profiles.map(p => p.resultId), afterIds: after.profiles.map(p => p.resultId), finalRange, geometryRows: after.profiles[0]?.geometry.length ?? 0, companionIds, afterCompanions });
           } catch(error) { failure={operation,error:String(error?.stack??error)};break; }
          }
          return { count, rows, companions: 4, view: 'full-history', initial, groups, failure };
        }, { count, rows, samples, warmups });
        for (const group of result.groups) {
          const summarize = key => {
            const sorted = group.timings.filter(t => !t.warmup).map(t => t[key]).sort((a, b) => a - b);
            return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)]??null, p95: sorted[Math.ceil(sorted.length * .95) - 1]??null, max: sorted.at(-1)??null, above100ms: sorted.filter(v => v > 100).length };
          };
          group.summary = { syncMs: summarize('syncMs'), secondRafMs: summarize('secondRafMs') };
        }
        results.push({ cpu, ...result });
      }
    }
  } catch (error) { outerFailure = String(error?.stack ?? error); }
  finally {
    try { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch(error) { cleanupErrors.push(String(error)); }
    try { await cdp.detach(); } catch(error) { cleanupErrors.push(String(error)); }
  }
  const correctnessPass = !outerFailure&&!cleanupErrors.length&&!errors.length&&!blocked.length&&results.length===8&&results.every(r=>!r.failure);
  const performanceTargetPass = correctnessPass && results.every(r=>r.groups.every(g=>g.summary.secondRafMs.p95<=100));
  return { build, samples, warmups, results, errors, blocked, outerFailure, cleanupErrors, pass:correctnessPass, correctnessPass, performanceTargetPass, limitations: [
    'Constructed candles and evidence through the actual adapter; no provider qualification, real Scanner navigation or network measurement.',
    'Feature-off and feature-on workloads on the same candidate source, with four existing studies. No before/after release or competitor comparison.',
    'Second requestAnimationFrame is a completion proxy, not a physical paint measurement. Full-history view explicitly includes all configured candles.',
    'All warmups, failures, tails and outliers must be retained. Local 100 ms goal is not a production guarantee.',
  ] };
}
