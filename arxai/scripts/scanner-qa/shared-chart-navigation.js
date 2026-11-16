async page => {
  const hoverMs = typeof SCANNER_QA_HOVER_MS === 'number' ? SCANNER_QA_HOVER_MS : 0;
  if (![0, 200].includes(hoverMs)) throw Error('Use an immediate click or a 200ms hover');
  const report = { passed: false, samples: [], failure: null,
    scenario: 'Full document reload to home, first visible Scanner link click to correct 200-bar series plus two rendering frames', hoverMs,
    limitations: ['Offline synthetic candles with an 80ms response delay; no provider or published-app latency measurement.', 'Five samples; no hardware paint, physical-device, or competitor claim. Idle import may finish before hover.'] };
  const expectedHead = typeof SCANNER_QA_EXPECTED_COMMIT === 'string' ? SCANNER_QA_EXPECTED_COMMIT : null;
  try {
    await page.addInitScript(() => {
      window.__scannerNavigation = null;
      document.addEventListener('click', e => {
        if (!e.target.closest?.('a[href="/market-scanner"]')) return;
        const result = window.__scannerNavigation = { click: performance.now(), canvas: null, candles: null, rendered: null };
        const watch = () => {
          if (performance.now() - result.click > 15000) return;
          const canvas = document.querySelector('[data-testid="arx-native-canvas"]');
          if (canvas && result.canvas === null) result.canvas = performance.now() - result.click;
          const state = window.__arxChartQa?.snapshot();
          if (state?.symbol === 'EURUSD' && state?.intervalSeconds === 900 && state?.barCount === 200 && state.bounds.width > 0 && state.bounds.height > 0) {
            result.candles = performance.now() - result.click;
            requestAnimationFrame(() => requestAnimationFrame(() => { result.rendered = performance.now() - result.click; }));
          } else requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      }, true);
    });
    for (let i = 0; i < 5; i++) {
      await page.goto('http://127.0.0.1:4199/');
      const link = page.locator('a[href="/market-scanner"]').filter({visible:true}).first();
      await link.waitFor({state:'visible', timeout:15000});
      const metadata = await page.evaluate(async () => (await fetch('/arx-scanner-qa-build-info.json')).json());
      const runtime = await page.evaluate(() => window.__arxScannerQaBuildId);
      if (runtime !== metadata.buildId || !metadata.sourceUnchanged || metadata.source.status || (expectedHead && metadata.source.head !== expectedHead)) throw Error('Unverified/dirty fixture source');
      report.build = metadata;
      if (hoverMs) { await link.hover(); await page.waitForTimeout(hoverMs); }
      const before = await page.evaluate(() => performance.now());
      await link.click();
      await page.waitForFunction(() => window.__scannerNavigation?.rendered !== null && window.__scannerNavigation?.rendered !== undefined, null, {timeout:15000});
      const actual = await page.evaluate(() => ({ timing: window.__scannerNavigation, state: window.__arxChartQa.snapshot(), data: window.__arxChartQa.data(), timeOrigin: performance.timeOrigin }));
      const log = await page.evaluate(() => window.__readFixtureLog());
      const requests = log.requests.filter(r => r.started >= actual.timeOrigin && r.path === '/api/chart/candles');
      const expected = log.candleResponses.filter(r => r.symbol === 'EURUSD' && r.timeframe === 'M15').at(-1);
      const bar = p => ({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
      if (!expected || JSON.stringify(actual.data.canonical) !== JSON.stringify(expected.canonical) || JSON.stringify(actual.data.display.map(bar)) !== JSON.stringify(expected.canonical)) throw Error('Rendered OHLC differs from response');
      const expectedBlocked = ['/api/me/activity-ping', '/api/me/chart/ai-alerts/scan', '/api/me/scalp/focus'];
      if (log.errors.length || log.blocked.some(r => r.kind !== 'mutation' || r.method !== 'POST' || r.status !== 503 || !expectedBlocked.includes(r.path))) throw Error('Page error, external request, or unexpected write');
      report.samples.push({ index:i, ...actual.timing, timeOrigin:actual.timeOrigin, beforeClickCommand:before,
        candleRequests:requests.map(r => ({...r, relativeToClick:r.started - actual.timeOrigin - actual.timing.click})),
        source:actual.state.feed, bars:actual.state.barCount, seriesMatchesResponse:true });
    }
    const times = report.samples.map(s => s.rendered).sort((a,b)=>a-b);
    report.summary = { samples:times.length, medianMs:times[2], minMs:times[0], maxMs:times.at(-1), under100ms:times.filter(t=>t<100).length };
    report.network = await page.evaluate(() => window.__readFixtureLog());
    report.passed = true;
  } catch (error) { report.failure = String(error?.stack ?? error); }
  return report;
}
