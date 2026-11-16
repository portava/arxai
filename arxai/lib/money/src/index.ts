// @workspace/money — money that cannot lie.
//
// WHY A VALUE OBJECT AND NOT A NUMBER
// -----------------------------------
// A `number` holding a monetary amount carries three lies at once:
//
//   1. IT IS BINARY FLOATING POINT. 0.1 + 0.2 !== 0.3. Accumulate a few thousand
//      such additions across a P/L ledger and the total drifts from the sum of
//      its parts — slowly, silently, and in a direction nobody chose.
//   2. IT HAS NO CURRENCY. `pnl + fee` compiles whether or not both are dollars.
//      Adding JPY to USD is not a rounding error, it is a wrong answer off by a
//      factor of ~150, and nothing in the type system objects.
//   3. IT HAS NO SCALE. $1.005 is not representable in cents, so SOMETHING must
//      decide how to round it. When that decision is implicit it is made
//      differently in different places, and the same trade books two amounts.
//
// This module removes all three. Amounts are integer minor units in a `bigint`
// (no float error, and no 2^53 ceiling — a portfolio in JPY minor units passes
// 2^53 at around 9 quadrillion yen, which is not a comfortable margin to rely
// on). Currency and scale ride along with every amount. `add`/`sub` THROW on a
// mismatch rather than coercing, because a coerced total is a plausible wrong
// number, and this codebase's whole thesis is that a plausible wrong number is
// worse than an error.
//
// ROUNDING IS EXPLICIT AND NAMED. Every operation that cannot be exact takes a
// rounding mode, defaulting to HALF_UP (half away from zero) — the convention
// used for cash. It is never left to `Math.round`, whose half-to-+Infinity
// behaviour is asymmetric about zero and silently biases a ledger containing
// both credits and debits.
//
// SCOPE: pure arithmetic. Imports nothing. No clock, no feed, nothing from the
// dispatch/gate path. This module cannot place, size, or authorise a trade.

/** How to resolve an amount that is not exactly representable at the scale. */
export type RoundingMode =
  /** Half away from zero: 2.5 → 3, −2.5 → −3. The cash convention, and symmetric. */
  | "HALF_UP"
  /** Half to even ("banker's"): 2.5 → 2, 3.5 → 4. Unbiased over many roundings. */
  | "HALF_EVEN"
  /** Toward zero: 2.9 → 2, −2.9 → −2. */
  | "TRUNCATE"
  /** Toward −Infinity. */
  | "FLOOR"
  /** Toward +Infinity. */
  | "CEIL";

/**
 * ISO-4217 minor-unit exponents for the currencies ARX actually handles.
 *
 * Deliberately NOT defaulted to 2 for unknown codes. Defaulting would silently
 * treat JPY as having cents (every yen amount off by 100×) or invent a scale for
 * a code that is simply a typo. An unknown currency must be given an explicit
 * scale by the caller, or construction throws. Fail closed.
 */
export const ISO_4217_SCALE: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0, XAF: 0, XOF: 0, XPF: 0,
  // Two-decimal
  USD: 2, EUR: 2, GBP: 2, CHF: 2, AUD: 2, NZD: 2, CAD: 2, SGD: 2, HKD: 2,
  SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, ZAR: 2, MXN: 2, BRL: 2, TRY: 2,
  INR: 2, CNY: 2, RUB: 2, THB: 2, ILS: 2, AED: 2, SAR: 2, NGN: 2, KES: 2,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

/** Is this a syntactically valid ISO-4217 alpha-3 code? */
export function isIso4217Code(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

/** The ISO-4217 minor-unit exponent, or `null` when the code is not known. */
export function scaleForCurrency(currency: string): number | null {
  const s = ISO_4217_SCALE[currency];
  return s === undefined ? null : s;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Divide two bigints, resolving the remainder by the named mode.
 *
 * All rounding in this module funnels through here, so there is exactly one
 * place where a fraction of a minor unit becomes a decision.
 *
 * THE NUMERATOR MUST CARRY ITS SIGN. FLOOR and CEIL are DIRECTIONAL: they mean
 * "toward −Infinity" and "toward +Infinity", not "down in magnitude" and "up in
 * magnitude". Stripping the sign before rounding and re-applying it afterwards —
 * which is the obvious way to write this, and how it was written first — makes
 * FLOOR(−1.001) return −1.00 instead of −1.01, silently rounding a debt in the
 * debtor's favour. The unit suite catches exactly that.
 */
function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new Error("Money: division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return negative ? -q : q;

  const twice = r * 2n;
  let up: boolean;
  switch (mode) {
    case "HALF_UP":
      up = twice >= d;
      break;
    case "HALF_EVEN":
      up = twice > d || (twice === d && q % 2n === 1n);
      break;
    case "TRUNCATE":
      up = false;
      break;
    case "FLOOR":
      up = negative; // magnitude grows when moving toward −Infinity
      break;
    case "CEIL":
      up = !negative;
      break;
  }
  const mag = up ? q + 1n : q;
  return negative ? -mag : mag;
}

/**
 * An exact monetary amount: integer minor units, a currency, and a scale.
 *
 * Immutable — every operation returns a new instance, so an amount cannot be
 * mutated out from under a caller holding a reference to it.
 */
export class Money {
  /** Amount in minor units (cents, yen, fils …). Always an exact integer. */
  readonly minor: bigint;
  /** ISO-4217 alpha-3 code. */
  readonly currency: string;
  /** Decimal places: 2 for USD, 0 for JPY, 3 for KWD. */
  readonly scale: number;

  private constructor(minor: bigint, currency: string, scale: number) {
    this.minor = minor;
    this.currency = currency;
    this.scale = scale;
    Object.freeze(this);
  }

  /**
   * Construct from an exact count of minor units.
   *
   * `scale` may be omitted only for a currency in the ISO-4217 table; an unknown
   * code with no explicit scale THROWS rather than assuming 2.
   */
  static fromMinor(minor: bigint | number, currency: string, scale?: number): Money {
    const cur = Money.requireCurrency(currency);
    const sc = Money.requireScale(cur, scale);
    if (typeof minor === "number") {
      if (!Number.isInteger(minor)) {
        throw new Error(`Money.fromMinor: ${minor} is not an integer count of minor units`);
      }
      if (!Number.isSafeInteger(minor)) {
        throw new Error(`Money.fromMinor: ${minor} exceeds the safe-integer range; pass a bigint`);
      }
      return new Money(BigInt(minor), cur, sc);
    }
    return new Money(minor, cur, sc);
  }

  /**
   * Construct from a decimal amount.
   *
   * PREFER A STRING. A string is parsed exactly, digit by digit. A `number` has
   * already lost precision before this function is entered — `0.1 + 0.2` arrives
   * as 0.30000000000000004 and no constructor can recover the 0.3 that was
   * meant. Numbers are accepted for ergonomics, rounded at the scale by `mode`,
   * and rejected outright when non-finite.
   *
   * More decimal places than the scale allows are ROUNDED, not truncated
   * silently: "1.005" at scale 2 becomes 101 minor units under HALF_UP.
   */
  static of(
    value: string | number | bigint,
    currency: string,
    opts: { scale?: number; mode?: RoundingMode } = {},
  ): Money {
    const cur = Money.requireCurrency(currency);
    const sc = Money.requireScale(cur, opts.scale);
    const mode = opts.mode ?? "HALF_UP";

    if (typeof value === "bigint") {
      return new Money(value * pow10(sc), cur, sc);
    }

    const text = Money.toPlainDecimal(value);
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
      throw new Error(`Money.of: ${JSON.stringify(text)} is not a decimal amount`);
    }
    const sign = m[1] === "-" ? -1n : 1n;
    const whole = m[2] === "" ? "0" : m[2]!;
    const frac = m[3] ?? "";

    // Scale up to the target, then round whatever is left over. The sign goes
    // INTO divRound, not around it, so FLOOR/CEIL stay directional.
    const scaled = BigInt(whole + (frac || "0").padEnd(Math.max(frac.length, 1), "0"));
    const digits = Math.max(frac.length, 1);
    const minor = divRound(sign * scaled * pow10(sc), pow10(digits), mode);
    return new Money(minor, cur, sc);
  }

  /** Zero in the given currency. */
  static zero(currency: string, scale?: number): Money {
    return Money.fromMinor(0n, currency, scale);
  }

  private static requireCurrency(currency: string): string {
    const cur = currency.trim().toUpperCase();
    if (!isIso4217Code(cur)) {
      throw new Error(`Money: ${JSON.stringify(currency)} is not an ISO-4217 alpha-3 code`);
    }
    return cur;
  }

  private static requireScale(currency: string, scale?: number): number {
    if (scale !== undefined) {
      if (!Number.isInteger(scale) || scale < 0 || scale > 8) {
        throw new Error(`Money: scale ${scale} is out of range [0, 8]`);
      }
      return scale;
    }
    const known = scaleForCurrency(currency);
    if (known === null) {
      throw new Error(
        `Money: unknown currency ${currency} — pass an explicit scale rather than assuming one`,
      );
    }
    return known;
  }

  /**
   * A `number` rendered without exponent notation, at full precision.
   *
   * `String(1e-7)` is "1e-7", which the decimal parser would reject; and
   * `toFixed` beyond 20 places throws. This normalises both.
   */
  /**
   * Normalise a string or number into plain (non-exponent) decimal text.
   *
   * An exponent-form STRING ("1e-7") is routed through `Number` and is therefore
   * only as exact as a double — but rejecting it outright is a footgun, because
   * `Money.of(String(x))` is the most natural thing a caller writes and
   * `String(1e-7)` is exponent form. Plain decimal strings never touch a float.
   */
  private static toPlainDecimal(value: string | number): string {
    if (typeof value === "number") return Money.numberToDecimalString(value);
    const t = value.trim();
    return /[eE]/.test(t) ? Money.numberToDecimalString(Number(t)) : t;
  }

  private static numberToDecimalString(v: number): string {
    if (!Number.isFinite(v)) {
      throw new Error(`Money.of: ${v} is not a finite amount`);
    }
    // Every double at or above 2^52 is an integer, and `toFixed` switches to
    // exponent form at 1e21 — so integers go through BigInt, which is exact at
    // any magnitude and never produces an exponent.
    if (Number.isInteger(v)) return BigInt(v).toString();
    const s = String(v);
    if (!s.includes("e") && !s.includes("E")) return s;
    // Exponent form: expand via toFixed at the highest legal precision.
    return v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  private requireSame(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Money.${op}: currency mismatch ${this.currency} vs ${other.currency} — ` +
          "convert explicitly with a rate you can name, never implicitly",
      );
    }
    if (this.scale !== other.scale) {
      throw new Error(
        `Money.${op}: scale mismatch ${this.scale} vs ${other.scale} for ${this.currency}`,
      );
    }
  }

  /** Exact addition. THROWS on a currency or scale mismatch. */
  add(other: Money): Money {
    this.requireSame(other, "add");
    return new Money(this.minor + other.minor, this.currency, this.scale);
  }

  /** Exact subtraction. THROWS on a currency or scale mismatch. */
  sub(other: Money): Money {
    this.requireSame(other, "sub");
    return new Money(this.minor - other.minor, this.currency, this.scale);
  }

  /**
   * Multiply by a dimensionless scalar (a quantity, a rate, a percentage).
   *
   * The scalar is converted to an exact rational before multiplying, so
   * `Money.of("0.10","USD").mul(3)` is exactly 30 cents rather than 30.000000004
   * rounded by luck.
   */
  mul(factor: number | bigint | string, mode: RoundingMode = "HALF_UP"): Money {
    if (typeof factor === "bigint") {
      return new Money(this.minor * factor, this.currency, this.scale);
    }
    const text = Money.toPlainDecimal(factor);
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
    if (!m) throw new Error(`Money.mul: ${JSON.stringify(text)} is not a number`);
    const sign = m[1] === "-" ? -1n : 1n;
    const frac = m[3] ?? "";
    const num = BigInt((m[2] === "" ? "0" : m[2]!) + frac);
    const den = pow10(frac.length);
    return new Money(divRound(sign * this.minor * num, den, mode), this.currency, this.scale);
  }

  /** Divide by a dimensionless scalar. */
  div(divisor: number | bigint | string, mode: RoundingMode = "HALF_UP"): Money {
    if (typeof divisor === "bigint") {
      return new Money(divRound(this.minor, divisor, mode), this.currency, this.scale);
    }
    const text = Money.toPlainDecimal(divisor);
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
    if (!m) throw new Error(`Money.div: ${JSON.stringify(text)} is not a number`);
    const sign = m[1] === "-" ? -1n : 1n;
    const frac = m[3] ?? "";
    const num = BigInt((m[2] === "" ? "0" : m[2]!) + frac);
    if (num === 0n) throw new Error("Money.div: division by zero");
    const den = pow10(frac.length);
    return new Money(divRound(sign * this.minor * den, num, mode), this.currency, this.scale);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency, this.scale);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  /**
   * Split into `ratios.length` parts whose sum EQUALS this amount exactly.
   *
   * Remainder minor units are handed out one at a time, largest-ratio first, so
   * nothing is lost or conjured. Naively multiplying by each ratio and rounding
   * leaves a stray unit that has to go somewhere; the usual outcome is that it
   * quietly goes nowhere and a ledger fails to balance by a cent.
   */
  allocate(ratios: readonly number[]): Money[] {
    if (ratios.length === 0) throw new Error("Money.allocate: no ratios given");
    if (ratios.some((r) => !(r >= 0) || !Number.isFinite(r))) {
      throw new Error("Money.allocate: ratios must be finite and non-negative");
    }
    const total = ratios.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new Error("Money.allocate: ratios sum to zero");

    // Scale ratios into integers to keep the split exact.
    const SCALE = 1_000_000;
    const weights = ratios.map((r) => BigInt(Math.round((r / total) * SCALE)));
    const weightTotal = weights.reduce((a, b) => a + b, 0n);

    const parts = weights.map((w) => (this.minor * w) / weightTotal);
    let remainder = this.minor - parts.reduce((a, b) => a + b, 0n);

    // Hand out the remaining units, largest weight first, deterministically.
    const order = weights
      .map((w, i) => ({ w, i }))
      .sort((a, b) => (b.w === a.w ? a.i - b.i : b.w > a.w ? 1 : -1));
    const step = remainder < 0n ? -1n : 1n;
    let k = 0;
    while (remainder !== 0n) {
      parts[order[k % order.length]!.i] += step;
      remainder -= step;
      k++;
    }
    return parts.map((p) => new Money(p, this.currency, this.scale));
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  /** −1, 0 or 1. THROWS on a currency or scale mismatch. */
  compare(other: Money): -1 | 0 | 1 {
    this.requireSame(other, "compare");
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }
  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.scale === other.scale &&
      this.minor === other.minor
    );
  }
  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }
  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }
  isZero(): boolean {
    return this.minor === 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Exact decimal string, always with `scale` decimal places. */
  toDecimalString(): string {
    const neg = this.minor < 0n;
    const abs = neg ? -this.minor : this.minor;
    if (this.scale === 0) return `${neg ? "-" : ""}${abs.toString()}`;
    const s = abs.toString().padStart(this.scale + 1, "0");
    const whole = s.slice(0, -this.scale);
    const frac = s.slice(-this.scale);
    return `${neg ? "-" : ""}${whole}.${frac}`;
  }

  /** `"1234.56 USD"` — amount and currency together, never one without the other. */
  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  /**
   * A `number`, for display or for a model input. LOSSY BY CONSTRUCTION.
   *
   * Named `toNumberUnsafe` so it cannot be reached for absent-mindedly: the
   * moment an amount becomes a float it is back to being a number that can lie,
   * and it must never be converted back into a Money and treated as exact.
   */
  toNumberUnsafe(): number {
    return Number(this.minor) / Number(pow10(this.scale));
  }

  /** Serialisable form that survives a JSON round-trip without precision loss. */
  toJSON(): { minor: string; currency: string; scale: number } {
    return { minor: this.minor.toString(), currency: this.currency, scale: this.scale };
  }

  static fromJSON(j: { minor: string; currency: string; scale: number }): Money {
    return Money.fromMinor(BigInt(j.minor), j.currency, j.scale);
  }
}

/** Sum a list of amounts. THROWS on any currency or scale mismatch. */
export function sumMoney(amounts: readonly Money[]): Money | null {
  if (amounts.length === 0) return null;
  return amounts.reduce((a, b) => a.add(b));
}
