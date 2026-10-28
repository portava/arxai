// Scheduling only: every admitted report still owns its database transaction.
// The database command lock remains authoritative across processes/restarts.
import { createHash } from "node:crypto";
export class ResultReceiptCapacityError extends Error {
  constructor() {
    super("LIVE_RESULT_RECEIPT_CAPACITY");
  }
}
type Limits = {
  perKey: number;
  global: number;
  perKeyBytes: number;
  globalBytes: number;
};
type KeyState = { tail: Promise<void>; pending: number; bytes: number };
const DEFAULT_LIMITS: Limits = {
  perKey: 64,
  global: 512,
  perKeyBytes: 512 * 1024,
  globalBytes: 8 * 1024 * 1024,
};
export class ResultReceiptScheduler {
  private readonly keys = new Map<string, KeyState>();
  private pending = 0;
  private bytes = 0;
  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {
    if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v <= 0))
      throw new Error("RESULT_RECEIPT_LIMIT_INVALID");
  }
  get snapshot() {
    return { keys: this.keys.size, pending: this.pending, bytes: this.bytes };
  }
  async run<T>(
    userId: number,
    commandId: string,
    weightBytes: number,
    receipt: () => Promise<T>,
  ): Promise<T> {
    // Fixed-size map keys prevent an input-controlled command string from being
    // retained once per queue slot. User remains part of the scheduling identity.
    const key = createHash("sha256")
      .update(JSON.stringify([userId, commandId]))
      .digest("hex");
    const previous = this.keys.get(key);
    if (
      !Number.isSafeInteger(weightBytes) ||
      weightBytes < 0 ||
      this.pending >= this.limits.global ||
      (previous?.pending ?? 0) >= this.limits.perKey ||
      this.bytes + weightBytes > this.limits.globalBytes ||
      (previous?.bytes ?? 0) + weightBytes > this.limits.perKeyBytes
    ) {
      throw new ResultReceiptCapacityError();
    }
    const state = previous ?? { tail: Promise.resolve(), pending: 0, bytes: 0 };
    const turn = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.pending++;
    state.bytes += weightBytes;
    this.pending++;
    this.bytes += weightBytes;
    this.keys.set(key, state);
    try {
      await turn;
      return await receipt();
    } finally {
      // Failure propagates to its own caller; it never poisons the next turn.
      state.pending--;
      state.bytes -= weightBytes;
      this.pending--;
      this.bytes -= weightBytes;
      if (state.pending === 0) this.keys.delete(key);
      release();
    }
  }
}
export const resultReceiptScheduler = new ResultReceiptScheduler();
