// Offline laboratory only. Bundle with esbuild and serve on loopback; no app,
// broker, model, account, network or execution action is available in this page.
import { prepareNativePriceSeries, createNativePriceFrame, paintNativePriceLayer } from "../../artifacts/trading-dashboard/src/lib/chart-engine/nativePriceRenderer";
import { panChartWindow, zoomChartWindow } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartNavigation";
import { CHART_STYLES, type ChartScaleMode } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartWorkspace";

const data = Array.from({ length: 20_000 }, (_, i) => {
  const open = 100 + Math.sin(i * 0.27) * 6 + Math.cos(i * 0.063) * 8;
  const close = open + Math.sin(i * 1.71) * 2.4;
  return { time: 1_700_000_000 + i * 60, open, high: Math.max(open, close) + 1.4, low: Math.min(open, close) - 0.9, close };
});
const prepareStarted = performance.now();
const series = prepareNativePriceSeries(data);
const initialPreparationMs = performance.now() - prepareStarted;
let range = { from: 19_800, to: 19_999 };
let scale: ChartScaleMode = "linear", inverted = false;
document.body.innerHTML = `<main><h1>ARX native price-layer laboratory</h1><p>Synthetic observations · staged renderer · no broker or trading · not the application chart</p><nav><button id="left">Pan left</button><button id="right">Pan right</button><button id="zoom">Zoom in</button><button id="out">Zoom out</button><button id="invert">Invert axis</button><select id="scale" aria-label="Price scale"><option>linear</option><option>log</option><option>percent</option><option>indexed</option></select></nav><output id="state"></output><section>${CHART_STYLES.map(style => `<article><h2>${style}</h2><canvas data-style="${style}"></canvas></article>`).join("")}</section></main>`;
const css = document.createElement("style");
css.textContent = `body{margin:0;background:#090f1b;color:#dce7f6;font:14px system-ui}main{padding:20px}h1{font-size:24px;margin:0 0 8px}p,output{color:#a3b3c9}nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}button,select{padding:8px;background:#17243b;color:inherit;border:1px solid #3a506d;border-radius:5px}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:14px}article{min-width:0;background:#0d1625;border:1px solid #20314b}h2{font-size:15px;padding:0 14px}canvas{width:100%;height:230px;display:block}@media(max-width:600px){section{grid-template-columns:1fr}}`;
document.head.append(css);
const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas")];

function draw() {
  const metrics: object[] = [];
  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i]!, width = canvas.clientWidth, height = canvas.clientHeight, dpr = window.devicePixelRatio;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const result = createNativePriceFrame(series, { plot: { left: 8, top: 8, width: width - 72, height: height - 32 }, range, style: CHART_STYLES[i]!, scale, referencePrice: data[0]!.close, inverted });
    if (!result.ok) throw Error(result.reason);
    const frame = result.frame;
    // Fixture ruler, separate from the staged price painter. Real engine axis
    // tick density/formatting and timezone integration are remaining work.
    ctx.font = "11px monospace";
    for (let tick = 0; tick <= 4; tick++) {
      const y = frame.plot.top + frame.plot.height * tick / 4;
      ctx.strokeStyle = "#20314b"; ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(width - 64, y); ctx.stroke();
      const price = frame.yToPrice(y), value = price == null ? null : frame.axisValue(price);
      ctx.fillStyle = "#a3b3c9"; ctx.fillText(value == null ? "—" : value.toFixed(2), width - 60, y + 4);
    }
    paintNativePriceLayer(ctx, frame);
    ctx.fillStyle = "#a3b3c9"; ctx.fillText(`loaded bars ${Math.ceil(range.from)}–${Math.floor(range.to)}`, 8, height - 8);
    metrics.push({ style: CHART_STYLES[i], first: frame.first, last: frame.last, price: frame.barAtX(frame.logicalToX(19_900)!)?.close ?? null });
  }
  document.querySelector("output")!.textContent = `${scale} · ${inverted ? "inverted" : "normal"} · ${range.from.toFixed(2)}–${range.to.toFixed(2)}`;
  (window as any).__arxNativePriceQa.state = { range: { ...range }, scale, inverted, metrics };
}
(window as any).__arxNativePriceQa = {
  state: null,
  // Browser main-thread CPU + Canvas command submission timing only. This
  // excludes data preparation, compositor/presentation and whole-page startup.
  benchmark: async () => {
    const canvas = canvases[0]!, ctx = canvas.getContext("2d")!;
    const samples: number[] = [];
    for (let i = 0; i < 150; i++) {
      await new Promise(requestAnimationFrame);
      const begin = performance.now();
      const result = createNativePriceFrame(series, { plot: { left: 8, top: 8, width: canvas.clientWidth - 72, height: canvas.clientHeight - 32 }, range: { from: 19_800 - (i % 10), to: 19_999 - (i % 10) }, style: "candles" });
      if (!result.ok) throw Error(result.reason);
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight); paintNativePriceLayer(ctx, result.frame);
      if (i >= 30) samples.push(performance.now() - begin);
    }
    draw(); return { warmup: 30, loadedBars: data.length, visibleBars: 200, initialPreparationMs, samples, dpr: devicePixelRatio, userAgent: navigator.userAgent };
  },
};
for (const [id, update] of Object.entries({
  left: () => panChartWindow(range, -0.25, data.length), right: () => panChartWindow(range, 0.25, data.length),
  zoom: () => zoomChartWindow(range, 0.75, data.length), out: () => zoomChartWindow(range, 1.25, data.length),
})) document.getElementById(id)!.addEventListener("click", () => { const next = update(); if (next) range = next; draw(); });
document.getElementById("invert")!.addEventListener("click", () => { inverted = !inverted; draw(); });
document.getElementById("scale")!.addEventListener("change", event => { scale = (event.target as HTMLSelectElement).value as ChartScaleMode; draw(); });
window.addEventListener("resize", draw); draw();
