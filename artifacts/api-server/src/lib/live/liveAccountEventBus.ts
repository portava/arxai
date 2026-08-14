// ── Live account event bus — instant SSE push on EA writes ──────────────────
//
// A single in-process EventEmitter, keyed by userId, that lets the EA-facing
// write routes (heartbeat, account sync, live positions snapshot) signal the
// per-user /me/live/account-stream SSE handler to rebuild its snapshot
// IMMEDIATELY instead of waiting up to the 3s fallback interval.
//
// POSTURE
//   - Advisory + best-effort: emitting never blocks, slows, or fails the EA
//     ACK path. A throwing listener can never propagate to the producer.
//   - Liveness only: this carries no payload beyond "user N's live state may
//     have changed". The SSE handler re-reads the SAME per-user scoped query
//     and honesty gates — the bus never injects data or bypasses a gate.
//   - Per-user isolation: a listener subscribed for user A is only ever invoked
//     for user A's events (the userId is the event name).
//   - Fallback intact: the 3s interval in the SSE handler stays in place; this
//     bus only makes the common case faster, it is not a correctness dependency.

import { EventEmitter } from "node:events";

class LiveAccountEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each connected SSE client adds one listener for its own userId. Raise the
    // ceiling well above the default 10 so concurrent live viewers don't trip a
    // MaxListenersExceededWarning. Listeners are removed on stream close.
    this.emitter.setMaxListeners(1000);
  }

  private key(userId: number | string): string {
    return `live-account:${String(userId)}`;
  }

  /** Subscribe to live-account change notifications for a single user. */
  on(userId: number | string, listener: () => void): void {
    this.emitter.on(this.key(userId), listener);
  }

  /** Unsubscribe a previously-registered listener (call on stream close). */
  off(userId: number | string, listener: () => void): void {
    this.emitter.off(this.key(userId), listener);
  }

  /**
   * Signal that user `userId`'s live account state may have changed. Best-effort:
   * a misbehaving listener is swallowed so the producer (an EA write route) is
   * never affected. Safe to call fire-and-forget after a DB write.
   */
  emit(userId: number | string | null | undefined): void {
    if (userId == null) return;
    try {
      this.emitter.emit(this.key(userId));
    } catch {
      // Advisory bus — never propagate a listener error to the EA write path.
    }
  }
}

// Module-singleton shared across the server process.
export const liveAccountEventBus = new LiveAccountEventBus();

/** Convenience wrapper: emit a live-account change for a user (best-effort). */
export function emitLiveAccountChanged(userId: number | string | null | undefined): void {
  liveAccountEventBus.emit(userId);
}
