// One-click mode — pure logic shared by the hook, the toggle, the panel and
// the surfaces that honour the mode (chart entry, position lists).
//
// "One-click mode" is the MT5-style system-wide switch: once the user has read
// the disclaimer and accepted, every Buy / Sell / Close across the app executes
// on the first click, with no ticket and no confirmation dialog. The server
// side is unchanged — live clicks still go through the instant-trade router and
// its gate set (arm state, master-live access, exposure, cooldown), demo clicks
// still go through the per-user demo-command queue. This file only decides
// what the mode IS from the server's answers, and runs the demo command chain.
//
// Scope follows the account mode: a LIVE_SHARED session toggles the live arm,
// a DEMO session toggles the demo one-click flag. Paper has no one-click.

export type OneClickScope = "live" | "demo";

export type OneClickSettings = {
  ok?: boolean;
  demoOneClickEnabled?: boolean;
  liveOneClickEnabled?: boolean;
  oneClickArmed?: boolean;
  oneClickArmedAt?: string | null;
  canEnableLive?: boolean;
  canEnableLiveBlockedReason?: string | null;
  defaultSymbol?: string | null;
  defaultVolume?: number | string | null;
  defaultOrderType?: string | null;
  maxLotPerClick?: number | string | null;
  allowOrdersWithoutStopLoss?: boolean;
};

export type OneClickStatus = {
  armed?: boolean;
  armedAt?: string | null;
  bridgeType?: "OWN" | "SHARED" | "NONE" | string;
  canArm?: boolean;
  canArmBlockReason?: string | null;
  executionReadinessState?: "READY" | "BLOCKED" | "STALE" | "UNAVAILABLE" | string;
  executionBlockReason?: string | null;
  defaultVolume?: number | string | null;
  defaultSymbol?: string | null;
};

export type OneClickModeView = {
  /** True when one-click mode is ON for the current account scope. */
  on: boolean;
  /** Which account the mode applies to. null = this account mode has no one-click (paper, unknown). */
  scope: OneClickScope | null;
  /** True when the user may turn the mode on from here. */
  canEnable: boolean;
  /** Plain-English reason the mode cannot be turned on (or is not available). */
  blockReason: string | null;
  /** Lot size the one-click buttons use when the user has not typed one. */
  defaultVolume: number;
  /** Server cap per click, when the settings carry one. */
  maxLotPerClick: number | null;
  /** True while either server answer is still loading. */
  loading: boolean;
};

export const DEFAULT_ONE_CLICK_VOLUME = 0.01;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const BLOCK_REASON_COPY: Record<string, string> = {
  NO_BRIDGE_CONFIGURED: "No trading bridge is configured for your account.",
  SHARED_BRIDGE_ONE_CLICK_NOT_PERMITTED: "Your account needs admin permission before one-click can be turned on.",
  MASTER_LIVE_USER_ACCESS_BLOCKED: "Your live trading access is not yet fully approved.",
  DEFAULT_VOLUME_NOT_SET: "Set a default lot size in One-click settings first.",
  USER_NOT_APPROVED_FOR_MASTER_LIVE: "Admin live-trading approval is required.",
  USER_MASTER_LIVE_TOGGLE_OFF: "Live trading is currently disabled for your account.",
  USER_MASTER_LIVE_SUSPENDED: "Your live account is suspended.",
  USER_MASTER_LIVE_REVOKED: "Your live access has been revoked.",
  LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS: "Live one-click needs approved live access.",
};

export function humanizeOneClickBlock(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return BLOCK_REASON_COPY[reason] ?? reason.replace(/_/g, " ").toLowerCase();
}

export function deriveOneClickMode(input: {
  settings: OneClickSettings | null | undefined;
  status: OneClickStatus | null | undefined;
  isLiveShared: boolean;
  isDemo: boolean;
  loading?: boolean;
}): OneClickModeView {
  const { settings, status, isLiveShared, isDemo } = input;
  const loading = !!input.loading;
  const scope: OneClickScope | null = isLiveShared ? "live" : isDemo ? "demo" : null;
  const defaultVolume =
    num(settings?.defaultVolume) ?? num(status?.defaultVolume) ?? DEFAULT_ONE_CLICK_VOLUME;
  const maxLotPerClick = num(settings?.maxLotPerClick);

  if (scope == null) {
    return {
      on: false, scope: null, canEnable: false,
      blockReason: loading ? null : "One-click trading is available on demo and live accounts only.",
      defaultVolume, maxLotPerClick, loading,
    };
  }

  if (scope === "demo") {
    return {
      on: settings?.demoOneClickEnabled === true,
      scope, canEnable: !loading && !!settings,
      blockReason: null, defaultVolume, maxLotPerClick, loading,
    };
  }

  // live: the instant-trade router opens a position when the user is armed OR
  // the live flag is on, but only once master-live access passes.
  const armedOrEnabled = settings?.oneClickArmed === true || settings?.liveOneClickEnabled === true;
  const on = armedOrEnabled && settings?.canEnableLive === true;
  const canEnable = !loading && (status?.canArm === true || (status == null && settings?.canEnableLive === true));
  const blockReason = on || canEnable
    ? null
    : humanizeOneClickBlock(status?.canArmBlockReason ?? settings?.canEnableLiveBlockedReason) ??
      (loading ? null : "One-click cannot be turned on for this account right now.");
  return { on, scope, canEnable, blockReason, defaultVolume, maxLotPerClick, loading };
}

/**
 * The broker's lot rules for a symbol (EA-enumerated SYMBOL_VOLUME_MIN /
 * _STEP / _MAX). Any field may be unknown; unknown falls back to 0.01 steps.
 */
export type LotSpec = { volumeMin?: number | null; volumeStep?: number | null; volumeMax?: number | null };

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const decimalsOf = (step: number) => Math.min(8, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
const roundTo = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(decimalsOf(step)));

/** Lowest of the per-click cap and the broker's max. */
function upperBound(max: number | null, spec?: LotSpec | null): number | null {
  const caps = [max, spec?.volumeMax].filter(pos);
  return caps.length ? Math.min(...caps) : null;
}

/**
 * Round a typed lot to the symbol's volume step (0.01 when unknown), raise it
 * to the broker's minimum, and clamp it to the per-click cap / broker max.
 * Returns null when the input is not a positive number.
 */
export function normalizeLot(raw: string | number, max: number | null, spec?: LotSpec | null): number | null {
  const n = num(raw);
  if (n == null || n <= 0) return null;
  const step = pos(spec?.volumeStep) ? spec!.volumeStep! : 0.01;
  let rounded = roundTo(n, step);
  if (pos(spec?.volumeMin) && rounded < spec!.volumeMin!) rounded = spec!.volumeMin!;
  if (rounded <= 0) return null;
  const hi = upperBound(max, spec);
  if (hi != null && rounded > hi) return hi;
  return rounded;
}

export function stepLot(current: number, dir: 1 | -1, max: number | null, spec?: LotSpec | null): number {
  const brokerStep = pos(spec?.volumeStep) ? spec!.volumeStep! : null;
  const base = current < 0.1 ? 0.01 : current < 1 ? 0.1 : 1;
  const step = brokerStep != null ? Math.max(brokerStep, base) : base;
  const unit = brokerStep ?? 0.01;
  const min = pos(spec?.volumeMin) ? spec!.volumeMin! : unit;
  const next = roundTo(current + dir * step, unit);
  if (next < min) return min;
  const hi = upperBound(max, spec);
  if (hi != null && next > hi) return hi;
  return next;
}

/** The lot a one-click button fires: the default, never above the per-click cap. */
export function oneClickVolume(defaultVolume: number, maxLotPerClick: number | null): number {
  return pos(maxLotPerClick) && defaultVolume > maxLotPerClick ? maxLotPerClick : defaultVolume;
}

/**
 * Lots to close for a fractional (e.g. 50%) close: floored to the symbol's
 * volume step so the broker never gets an off-step volume. Returns null when
 * the fraction would close less than the minimum or leave less than the
 * minimum open (a partial close the broker would refuse) — the caller then
 * offers only a full close.
 */
export function partialCloseVolume(positionLots: number | null | undefined, fraction: number, spec?: LotSpec | null): number | null {
  if (!pos(positionLots ?? null) || !(fraction > 0 && fraction < 1)) return null;
  const step = pos(spec?.volumeStep) ? spec!.volumeStep! : 0.01;
  const min = pos(spec?.volumeMin) ? spec!.volumeMin! : step;
  const raw = positionLots! * fraction;
  const floored = Number((Math.floor(raw / step + 1e-9) * step).toFixed(decimalsOf(step)));
  if (floored < min - 1e-9) return null;
  const remaining = positionLots! - floored;
  if (remaining < min - 1e-9) return null;
  return floored;
}

// ─── Demo command chain ──────────────────────────────────────────────────────
// draft → confirm → dispatch → poll until terminal. Same chain the demo ticket
// and OpenDemoPositions use; the user's confirmation is the one-click itself.

export type DemoCommandOutcome = {
  ok: boolean;
  status: string;
  reason: string | null;
  commandId: string | null;
};

export const DEMO_TERMINAL_STATUSES = new Set(["FILLED_DEMO", "PLACED_DEMO", "CANCELLED_DEMO", "REJECTED", "FAILED", "BLOCKED"]);
/** Broker-confirmed outcomes: a fill, a pending order placed (v1.32), or a pending order cancelled. */
export const DEMO_SUCCESS_STATUSES = new Set(["FILLED_DEMO", "PLACED_DEMO", "CANCELLED_DEMO"]);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function runDemoCommand(
  base: string,
  commandType: "PLACE_MARKET_ORDER" | "PLACE_PENDING_ORDER" | "CLOSE_POSITION" | "MODIFY_SLTP" | "CANCEL_PENDING_ORDER",
  payload: Record<string, unknown>,
  opts: { fetchImpl?: FetchLike; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DemoCommandOutcome> {
  const f: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const json = async (r: Response) => { try { return await r.json(); } catch { return {}; } };
  const headers = { "content-type": "application/json" };

  const draft = await f(`${base}/api/me/demo-commands`, {
    method: "POST", credentials: "include", headers, body: JSON.stringify({ commandType, payload }),
  });
  const d = await json(draft);
  if (!d?.ok || !d?.command?.commandId) {
    return { ok: false, status: "FAILED", reason: d?.reason ?? `HTTP ${draft.status}`, commandId: null };
  }
  const commandId = String(d.command.commandId);
  const enc = encodeURIComponent(commandId);

  const conf = await f(`${base}/api/me/demo-commands/${enc}/confirm`, { method: "POST", credentials: "include", headers, body: "{}" });
  const cj = await json(conf);
  if (!cj?.ok) return { ok: false, status: "FAILED", reason: `CONFIRM_FAILED: ${cj?.reason ?? conf.status}`, commandId };

  const disp = await f(`${base}/api/me/demo-commands/${enc}/dispatch`, { method: "POST", credentials: "include", headers, body: "{}" });
  const dj = await json(disp);
  if (!dj?.ok) return { ok: false, status: "FAILED", reason: `DISPATCH_FAILED: ${dj?.reason ?? disp.status}`, commandId };

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const r = await f(`${base}/api/me/demo-commands/${enc}`, { credentials: "include" });
    if (!r.ok) continue;
    const j = await json(r);
    const c = j?.command;
    if (!c) continue;
    if (DEMO_TERMINAL_STATUSES.has(c.status)) {
      return { ok: DEMO_SUCCESS_STATUSES.has(c.status), status: c.status, reason: c.reason ?? null, commandId };
    }
  }
  return { ok: false, status: "TIMEOUT", reason: "No terminal status within 60 s. Check Recent demo commands.", commandId };
}
