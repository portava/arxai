/** Bounded monotone queue for an inclusive high/low lookback. Rebuilt from the
 * unchanged prefix for each calculation, so revised bars and replay rollback
 * cannot leave stale extrema behind. Each observation enters/leaves once. */
export class ChartRangeWindow {
  private readonly values: Float64Array;
  private readonly indices: Float64Array;
  private head = 0;
  private size = 0;
  private lastNaN = -Infinity;
  constructor(private readonly period: number, private readonly maximum: boolean) {
    this.values = new Float64Array(period);
    this.indices = new Float64Array(period);
  }
  push(value: number, index: number): number {
    const oldest = index - this.period + 1;
    while (this.size && this.indices[this.head]! < oldest) {
      this.head = (this.head + 1) % this.period;
      this.size--;
    }
    if (Number.isNaN(value)) this.lastNaN = index;
    else {
      while (this.size) {
        const tail = (this.head + this.size - 1) % this.period;
        const best = this.maximum ? Math.max(this.values[tail]!, value) : Math.min(this.values[tail]!, value);
        // Object.is preserves Math.max/min's signed-zero convention too.
        if (!Object.is(best, value)) break;
        this.size--;
      }
      const tail = (this.head + this.size) % this.period;
      this.values[tail] = value;
      this.indices[tail] = index;
      this.size++;
    }
    return this.lastNaN >= oldest ? NaN : this.size ? this.values[this.head]! : this.maximum ? -Infinity : Infinity;
  }
}
