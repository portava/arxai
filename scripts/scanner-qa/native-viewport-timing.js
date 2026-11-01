// Playwright CLI run-code --filename. Serve the bundled native-viewport-entry
// at localhost:4199. Offline synthetic data only. Keep every sample/outlier.
async page => {
  const cdp = await page.context().newCDPSession(page);
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort());
  await page.setViewportSize({ width: 1280, height: 1000 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const runs = [];
  try {
    for (const cpuRate of [1, 4, 4, 1]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
      await page.goto('http://127.0.0.1:4199');
      await page.waitForFunction(() => window.__arxNativeViewportQa?.viewport.getState().paintCount > 0);
      const initial = await page.evaluate(() => window.__arxNativeViewportQa.viewport.getState());
      if (initial.width < 1000 || initial.pixelRatio !== 1) throw Error('Timing viewport mismatch');
      const interaction = await page.evaluate(() => window.__arxNativeViewportQa.benchmark());
      // Data construction excluded. Full sanitization/snapshot replacement is
      // measured separately and must not be hidden by the RAF-only benchmark.
      const refresh = await page.evaluate(async () => {
        const q = window.__arxNativeViewportQa, samples = [];
        for (let i = 0; i < 35; i++) {
          const data = q.data.map(b => ({ ...b })); data[data.length - 1].close += .001;
          const start = performance.now(); q.replace(data); const elapsed = performance.now() - start;
          await q.waitPaint(q.viewport.getState().paintCount);
          if (i >= 5) samples.push(elapsed);
        }
        return { samples, warmup: 5, loadedBars: q.data.length };
      });
      runs.push({ cpuRate, initial, interaction, refresh });
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  return { metric: 'Logical range request to completed RAF Canvas submission; not physical presentation, app click, feed or competitor timing', refreshMetric: 'Full setCandles synchronous preparation; excludes fixture construction and paint', runs };
}
