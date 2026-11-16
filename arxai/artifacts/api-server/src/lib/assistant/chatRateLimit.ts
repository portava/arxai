// AI chat audit 2026-11-04 (A6). Per-user sliding-window limiter for the
// assistant endpoints that cost model tokens (messages, voice, instant-trade
// commands, conversation creation). In-memory and per-process: good enough to
// stop a runaway client or script from burning the token budget, not a
// substitute for the gateway's own quotas. Fails OPEN only in the sense that a
// process restart clears the windows; it never blocks a user below the limit.

export interface RateLimitRule {
  /** Maximum events allowed inside the window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
  windowMs: number;
}

export const CHAT_MESSAGE_RULE: RateLimitRule = { limit: 40, windowMs: 10 * 60_000 };
export const CONVERSATION_CREATE_RULE: RateLimitRule = { limit: 30, windowMs: 60 * 60_000 };
export const TRADE_COMMAND_RULE: RateLimitRule = { limit: 30, windowMs: 10 * 60_000 };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly rule: RateLimitRule, private readonly now: () => number = () => Date.now()) {}

  /** Records an event if allowed and returns the verdict. */
  check(key: string): RateLimitVerdict {
    const t = this.now();
    const floor = t - this.rule.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((ts) => ts > floor);
    if (arr.length >= this.rule.limit) {
      const oldest = arr[0]!;
      this.hits.set(key, arr);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.rule.windowMs - t) / 1000)),
        limit: this.rule.limit,
        windowMs: this.rule.windowMs,
      };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.sweep(floor);
    return { allowed: true, remaining: this.rule.limit - arr.length, retryAfterSeconds: 0, limit: this.rule.limit, windowMs: this.rule.windowMs };
  }

  /** Test/ops helper. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear(); else this.hits.delete(key);
  }

  private sweep(floor: number): void {
    for (const [k, arr] of this.hits) {
      const live = arr.filter((ts) => ts > floor);
      if (live.length === 0) this.hits.delete(k); else this.hits.set(k, live);
    }
  }
}

export const chatMessageLimiter = new SlidingWindowLimiter(CHAT_MESSAGE_RULE);
export const conversationCreateLimiter = new SlidingWindowLimiter(CONVERSATION_CREATE_RULE);
export const tradeCommandLimiter = new SlidingWindowLimiter(TRADE_COMMAND_RULE);

export function rateLimitBody(v: RateLimitVerdict): { error: "rate_limited"; retryAfterSeconds: number; limit: number; windowSeconds: number } {
  return { error: "rate_limited", retryAfterSeconds: v.retryAfterSeconds, limit: v.limit, windowSeconds: Math.round(v.windowMs / 1000) };
}
