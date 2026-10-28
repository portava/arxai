async page => {
  // The same script runs against the isolated development or production fixture.
  // It verifies behavior, not latency: selectOption is not a trusted human click.
  const base = typeof CHART_QA_BASE_URL === 'string' ? CHART_QA_BASE_URL : 'http://127.0.0.1:4178';
  const errors = [], external = [];
  const onError = error => errors.push(error.message);
  const blockExternal = route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin) return route.continue();
    external.push(url.origin); return route.abort();
  };
  const check = (ok, message) => { if (!ok) throw Error(message); };
  page.on('pageerror', onError);
  await page.route('**/*', blockExternal);
  try {
    await page.goto(base);
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.setViewportSize({ width: 1600, height: 1100 });
    const chart = page.getByTestId('arx-native-canvas');
    await chart.waitFor();
    await chart.hover({ position: { x: 300, y: 120 } });
    const legend = page.getByTestId('chart-candle-inspector');
    await page.waitForFunction(() => document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent.includes('UTC'));
    const canonical = await legend.textContent();
    const ohlc = canonical.match(/  ·  O -?\d+\.\d+  H -?\d+\.\d+  L -?\d+\.\d+  C -?\d+\.\d+$/);
    check(ohlc, `No complete canonical OHLC in legend: ${canonical}`);
    const stamp = canonical.slice(0, 16), prices = ohlc[0];
    const millis = Date.parse(stamp.replace(' ', 'T') + ':00Z');
    check(Number.isFinite(millis), 'No original candle timestamp');
    const canvas = await chart.locator('canvas').first().elementHandle();
    const canvasCount = await chart.locator('canvas').count();
    const style = page.getByLabel('Chart style', { exact: true });
    for (const value of ['heikinAshi', 'baseline', 'hollow']) {
      await style.selectOption(value);
      const note = page.getByTestId('chart-style-note');
      check(await note.isVisible(), `${value}: explanation hidden`);
      check(await style.getAttribute('aria-describedby') === await note.getAttribute('id'), `${value}: description not associated`);
      check(!(await note.evaluate(el => !!el.closest('details'))), `${value}: explanation requires expansion`);
    }
    await style.selectOption('candles');
    check(await page.getByTestId('chart-style-note').count() === 0, 'Obsolete style explanation');
    const zone = page.getByLabel('Display time zone', { exact: true });
    await page.getByLabel('Go to UTC date and time', { exact: true }).fill(stamp.replace(' ', 'T'));
    const zones = ['Asia/Tokyo', 'America/New_York', 'Europe/London', 'UTC'];
    for (const value of zones) {
      await zone.selectOption(value);
      // Independent expectation from the original UTC instant; never parse an
      // already-relabelled timestamp or call the application's formatting code.
      const expected = new Intl.DateTimeFormat('sv-SE', {
        timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(millis));
      await page.waitForFunction(([time, ohlc]) => {
        const text = document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? '';
        return text.startsWith(time) && text.endsWith(ohlc);
      }, [expected, prices]);
      const input = page.getByLabel(`Go to ${value} date and time`, { exact: true });
      check(await input.inputValue() === expected.replace(' ', 'T'), `${value}: go-to changed the instant`);
      check(await canvas.evaluate(el => el.isConnected), `${value}: replaced chart canvas`);
      check(await chart.locator('canvas').count() === canvasCount, `${value}: leaked canvas`);
    }
    // The wall-clock conversion rejects a spring-forward time that never existed.
    await zone.selectOption('America/New_York');
    await page.getByLabel('Go to America/New_York date and time', { exact: true }).fill('2026-03-08T02:30');
    await page.getByRole('button', { name: 'Go to America/New_York', exact: true }).click();
    await page.getByText('That time does not exist in America/New_York (clock change). Choose another time.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'D1 timeframe', exact: true }).click();
    await page.getByTestId('chart-daily-zone-note').waitFor();
    await page.getByLabel('Go to UTC date and time', { exact: true }).waitFor();
    check(await zone.inputValue() === 'America/New_York', 'Daily view discarded the chosen zone');
    await chart.hover({ position: { x: 300, y: 120 } });
    await page.waitForFunction(() => /^\d{4}-\d{2}-\d{2} 00:00 UTC  ·  O /.test(document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? ''));
    await page.getByRole('button', { name: 'M15 timeframe', exact: true }).click();
    await page.getByLabel('Go to America/New_York date and time', { exact: true }).waitFor();
    await chart.hover({ position: { x: 300, y: 120 } });
    await page.waitForFunction(() => / (EDT|EST)  ·  O /.test(document.querySelector('[data-testid="chart-candle-inspector"]')?.textContent ?? ''));
    await style.selectOption('heikinAshi');
    await page.reload();
    check(await zone.inputValue() === 'America/New_York' && await style.inputValue() === 'heikinAshi', 'Style or zone did not persist');
    await page.getByTestId('chart-style-note').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const value of ['heikinAshi', 'baseline', 'hollow']) {
      await style.selectOption(value);
      check(await page.getByTestId('chart-style-note').isVisible(), `${value}: mobile explanation hidden`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${value}: mobile overflow`);
    }
    check(errors.length === 0, `Browser exceptions: ${errors}`);
    check(external.length === 0, `Unexpected external requests (blocked): ${external}`);
    return { base, fixture: 'synthetic offline, no broker', transformedStyleNotes: 3,
      canonicalPricesAcrossZones: zones, goToInstantPreserved: true, dstGapRejected: true,
      dailyUtcAndIntradayRestore: true, persistedStyleAndZone: true, canvasRetained: true,
      mobileNoOverflow: true, errors, externalRequests: external,
      scope: 'functional acceptance only; no latency, feed or competitor parity claim' };
  } finally {
    page.off('pageerror', onError); await page.unroute('**/*', blockExternal);
  }
}
