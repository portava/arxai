import { expect, it } from "vitest";
import { StudyCalculator, type ChartStudy } from "./chartStudies";
import { validatePreferences } from "./chartWorkspace";

const config = { kind: "donchian", period: 3, color: "#38bdf8" } as ChartStudy;
const bars = [
  { time: 1, open: 10, high: 12, low: 8, close: 11 },
  { time: 2, open: 11, high: 15, low: 10, close: 12 },
  { time: 3, open: 12, high: 14, low: 9, close: 13 },
  { time: 4, open: 13, high: 14, low: 11, close: 12 },
  { time: 5, open: 12, high: 16, low: 7, close: 14 },
];

it("Donchian plots midpoint/high/low including the current bar after full warm-up", () => {
  expect(new StudyCalculator(config).calculate(bars).map(p => p.values)).toEqual([
    [null, null, null], [null, null, null], [11.5, 15, 8], [12, 15, 9], [11.5, 16, 7],
  ]);
  expect(validatePreferences({ studies: [config] }).studies).toHaveLength(1);
});

it("Donchian preserves flat ranges, period-one values and observed timestamps", () => {
  const data = bars.map(b => ({ ...b, open: 10, high: 10, low: 10, close: 10 }));
  expect(new StudyCalculator({ ...config, period: 1 }).calculate(data)).toEqual(
    data.map(b => ({ time: b.time, values: [10, 10, 10] })),
  );
});

it("range studies read highs/lows linearly on bulk loads instead of rescanning each lookback", () => {
  for (const kind of ["stochastic", "williams", "donchian"] as const) {
    let reads = 0;
    const data = Array.from({ length: 5000 }, (_, i) => ({ time: i + 1, open: 10, close: 10,
      get high() { reads++; return 11 + i % 13; }, get low() { reads++; return 9 - i % 7; },
    }));
    const calc = new StudyCalculator({ ...config, kind, period: 1000 });
    calc.calculate(data);
    expect(reads, kind).toBeGreaterThan(0);
    expect(reads, kind).toBeLessThanOrEqual(data.length * 4);
    expect(calc.points.at(-1)!.values.every(v => v !== null)).toBe(true);
  }
});

it("range studies recover from revised extrema, middle edits, truncate and replay append", () => {
  for (const kind of ["stochastic", "williams", "donchian"] as const) {
    const c = { ...config, kind, smoothing: 1, signal: 1 };
    const calc = new StudyCalculator(c);
    let data = bars.map(b => ({ ...b }));
    calc.calculate(data);
    data[4] = { ...data[4]!, high: 14, low: 11, close: 12 };
    calc.calculate(data, 4);
    expect(calc.points).toEqual(new StudyCalculator(c).calculate(data));
    data[1] = { ...data[1]!, high: 17, low: 6 };
    calc.calculate(data, 1);
    expect(calc.points).toEqual(new StudyCalculator(c).calculate(data));
    const prefix = data.slice(0, 3);
    calc.calculate(prefix, 3);
    expect(calc.points).toEqual(new StudyCalculator(c).calculate(prefix));
    calc.calculate(data, 3);
    expect(calc.points).toEqual(new StudyCalculator(c).calculate(data));
    expect(calc.points.slice(0, 3)).toEqual(new StudyCalculator(c).calculate(prefix));
  }
});

it("range windows match the simple extrema oracle through ties, signed zero and non-finite values", async () => {
  const { ChartRangeWindow } = await import("./chartRangeWindow");
  const data = [0, -0, 0, 3, 3, -2, Infinity, 1, NaN, 2, -Infinity, 4, 0, -0, 2];
  for (const period of [1, 2, 3, 7]) for (const maximum of [true, false]) {
    const window = new ChartRangeWindow(period, maximum);
    for (let i = 0; i < data.length; i++) {
      const slice = data.slice(Math.max(0, i - period + 1), i + 1);
      const expected = maximum ? Math.max(...slice) : Math.min(...slice);
      expect(Object.is(window.push(data[i]!, i), expected), `${period}/${maximum}/${i}`).toBe(true);
    }
  }
});
