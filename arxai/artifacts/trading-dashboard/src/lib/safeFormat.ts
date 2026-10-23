// Safe formatters for values that come back partial from the API.
//
// Why this exists: three production crashes traced to the same shape:
//   - alerts.tsx        : `s.type.replace(...)` when `s.type` was null
//   - broker-recon.tsx  : `r.brokerOrders.length` when the field was undefined
//   - live-trading-ctl  : `new Date(e.createdAt).toISOString()` when createdAt
//                         was missing/invalid
//
// Use these at the render boundary instead of asserting non-null. None
// of these helpers throw; they always return a safe display string or
// an empty array, so an upstream contract drift downgrades the row
// from "perfect" to "Unknown" instead of crashing the entire route.

/** Returns the array unchanged if it's a real array, else `[]`. */
export function safeArray<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Returns the string unchanged when it's a non-empty string, else the
 * fallback ("—" by default). Use at the render boundary instead of
 * `??` for fields that might come back as empty strings or `null`.
 */
export function safeString(v: unknown, fallback = "—"): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** `safeArray(v).length` — for direct length reads at render time. */
export function safeLen(v: unknown[] | null | undefined): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Pretty-prints a snake_case-ish key as space-separated text. Returns
 * the fallback (default "—") if the input is not a non-empty string.
 */
export function safeLabel(v: string | null | undefined, fallback = "—"): string {
  return typeof v === "string" && v.length > 0 ? v.replace(/_/g, " ") : fallback;
}

/**
 * Returns a formatted time string from an ISO/epoch input. Returns the
 * fallback when the input is missing or `new Date(input)` is invalid.
 *
 * `mode = "time"` → HH:MM:SS (24h, local)
 * `mode = "datetime"` → locale date + time
 * `mode = "iso"` → full ISO string, sliced to "HH:MM:SS" by default
 */
export function safeDate(
  input: string | number | Date | null | undefined,
  mode: "time" | "datetime" | "iso" = "datetime",
  fallback = "—",
): string {
  if (input == null) return fallback;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  if (mode === "time") return d.toLocaleTimeString();
  if (mode === "iso") return d.toISOString().slice(11, 19);
  return d.toLocaleString();
}

/**
 * Formats an economic-event timestamp into explicitly-labelled UTC and local
 * parts so a calendar surface never renders an ambiguous bare time. The source
 * timestamp is always UTC (provider contract); the local part is derived via the
 * browser locale and tagged with the resolved IANA time zone.
 *
 * Returns `null` when the input is missing/invalid so the caller can render a
 * safe fallback instead of "Invalid Date".
 */
export function formatEventTimeParts(
  input: string | number | Date | null | undefined,
  opts: { withDate?: boolean } = {},
): { utcLabel: string; localLabel: string; timeZone: string } | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const timeOpts: Intl.DateTimeFormatOptions = opts.withDate
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  const utcLabel = `${d.toLocaleString([], { ...timeOpts, timeZone: "UTC" })} UTC`;
  const localLabel = `${d.toLocaleString([], { ...timeOpts, timeZone })} ${timeZone}`;
  return { utcLabel, localLabel, timeZone };
}

// T007 — additional safe render-boundary helpers. None of these throw;
// each returns a stable display string / safe number so a partial API
// response cannot blank the page.

/**
 * Coerces any input to a finite display number. Returns the fallback
 * (default `0`) for NaN / Infinity / null / undefined / non-numeric
 * strings. Use at the render boundary, not for arithmetic.
 */
export function safeCount(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Currency display with thousands separator and 2-decimal default. Never
 * renders "NaN" / "$undefined". Sign is preserved; pass `currency` to
 * change the prefix (e.g. "€"). Use only at the render boundary.
 */
export function safeMoney(
  v: unknown,
  opts: { currency?: string; digits?: number; fallback?: string } = {},
): string {
  const { currency = "$", digits = 2, fallback = `${opts.currency ?? "$"}0.00` } = opts;
  const n = typeof v === "number" ? v
          : typeof v === "string" && v.length > 0 ? Number(v)
          : NaN;
  if (!Number.isFinite(n)) return fallback;
  const abs = Math.abs(n);
  const fixed = abs.toFixed(digits);
  // After rounding to `digits`, the displayed value may be exactly zero
  // even when n was negative (e.g. -0.001 with digits=2). Suppress the
  // sign in that case so we never render "-$0.00".
  const sign = n < 0 && Number(fixed) > 0 ? "-" : "";
  const [whole, frac] = fixed.split(".");
  const wholeWithSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${currency}${frac ? `${wholeWithSep}.${frac}` : wholeWithSep}`;
}

/**
 * Percent display. Input is treated as already-a-percent (e.g. `42.5`
 * → "42.50%"). Use `fromFraction: true` for a 0–1 fraction. Never
 * renders "NaN%".
 */
export function safePercent(
  v: unknown,
  opts: { digits?: number; fromFraction?: boolean; fallback?: string } = {},
): string {
  const { digits = 2, fromFraction = false, fallback = "—" } = opts;
  const raw = typeof v === "number" ? v
            : typeof v === "string" && v.length > 0 ? Number(v)
            : NaN;
  if (!Number.isFinite(raw)) return fallback;
  const pct = fromFraction ? raw * 100 : raw;
  return `${pct.toFixed(digits)}%`;
}

/**
 * Normalises the many shapes an API list endpoint can return:
 * `T[]`, `{ items: T[] }`, `{ data: T[] }`, `{ rows: T[] }`,
 * `{ results: T[] }`, or `null/undefined/garbage` → `[]`.
 *
 * Use at the fetch boundary to keep render code as plain `.map()`.
 */
export function normalizeApiList<T = unknown>(
  raw: unknown,
  preferredKey?: string,
): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Caller can pin the exact wrapper key (e.g. `"items"` for a
    // paginated `{items,total}` response) to avoid ambiguous lookup
    // when more than one candidate key is present.
    if (preferredKey && Array.isArray(o[preferredKey])) {
      return o[preferredKey] as T[];
    }
    for (const k of ["items", "data", "rows", "results", "list"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}
