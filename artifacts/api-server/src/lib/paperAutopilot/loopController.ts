// Build FF — Bounded loop controller.
//
// SAFETY: never an infinite loop. Bounded by max_cycles_per_start. Honors
// stop flag, daily loss limit, error cap, and live-trade safety guard.
//
// Concurrency: a `runToken` (UUID) is minted on every start(). Every async
// continuation (runNext / setTimeout callback) checks `this.runToken` against
// the token captured when it was scheduled — if they differ, the callback is
// a stale ghost from a prior run and exits silently. stop() does NOT eagerly
// transition to IDLE; it sets state=STOPPING and the in-flight cycle (or its
// next runNext entry) finalizes the run, ensuring no overlap with a future
// start().

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { loadSettings, assertSafe } from "./settings.js";
import { runOneCycle } from "./autopilotService.js";
import type { LoopState } from "./types.js";

interface LoopStatus {
  state: LoopState;
  startedAt: string | null;
  startedBy: string | null;
  cyclesCompleted: number;
  cyclesPlanned: number;
  lastCycleId: string | null;
  lastCycleStatus: string | null;
  errorsThisRun: number;
  stopReason: string | null;
}

const MAX_ERRORS_PER_RUN = 3;

class Loop {
  private state: LoopState = "IDLE";
  private startedAt: Date | null = null;
  private startedBy: string | null = null;
  private cyclesCompleted = 0;
  private cyclesPlanned = 0;
  private lastCycleId: string | null = null;
  private lastCycleStatus: string | null = null;
  private errorsThisRun = 0;
  private stopReason: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private runId: string | null = null;
  private runToken: string | null = null;
  private inflight = false;

  status(): LoopStatus {
    return {
      state: this.state,
      startedAt: this.startedAt?.toISOString() ?? null,
      startedBy: this.startedBy,
      cyclesCompleted: this.cyclesCompleted,
      cyclesPlanned: this.cyclesPlanned,
      lastCycleId: this.lastCycleId,
      lastCycleStatus: this.lastCycleStatus,
      errorsThisRun: this.errorsThisRun,
      stopReason: this.stopReason,
    };
  }

  async start(startedBy: string): Promise<{ ok: boolean; status: LoopStatus; reason?: string }> {
    if (this.state !== "IDLE") {
      return { ok: false, status: this.status(), reason: `Loop already ${this.state} — wait for IDLE before starting again` };
    }
    if (this.inflight) {
      return { ok: false, status: this.status(), reason: "A previous cycle is still finalizing — try again in a moment" };
    }
    const settings = await loadSettings();
    assertSafe(settings);
    if (!settings.enabled) {
      return { ok: false, status: this.status(), reason: "Settings.enabled is false — flip it on first" };
    }
    const token = `ffrun_${randomUUID()}`;
    this.runToken = token;
    this.runId = token;
    this.state = "RUNNING";
    this.startedAt = new Date();
    this.startedBy = startedBy;
    this.cyclesCompleted = 0;
    this.cyclesPlanned = settings.maxCyclesPerStart;
    this.errorsThisRun = 0;
    this.stopReason = null;
    this.stopRequested = false;
    this.lastCycleId = null;
    this.lastCycleStatus = null;
    logger.info({ runId: this.runId, startedBy, cyclesPlanned: this.cyclesPlanned }, "FF: loop started");
    setImmediate(() => this.runNext(token));
    return { ok: true, status: this.status() };
  }

  stop(reason: string): { ok: boolean; status: LoopStatus } {
    if (this.state === "IDLE") return { ok: true, status: this.status() };
    this.stopRequested = true;
    this.stopReason = reason;
    if (this.state === "RUNNING") this.state = "STOPPING";
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info({ runId: this.runId, reason }, "FF: loop stop requested");
    // If no cycle is in flight and no timer is pending, finalize immediately.
    if (!this.inflight) this.finalize(reason, this.runToken);
    return { ok: true, status: this.status() };
  }

  private async runNext(token: string): Promise<void> {
    // Stale ghost: another start() already replaced the run, or stop() finalized.
    if (token !== this.runToken) return;
    if (this.stopRequested) { this.finalize("Stop requested", token); return; }
    if (this.cyclesCompleted >= this.cyclesPlanned) { this.finalize("max_cycles_per_start reached", token); return; }

    this.inflight = true;
    try {
      const settings = await loadSettings();
      assertSafe(settings);
      if (token !== this.runToken) return; // stale during await
      if (!settings.enabled) { this.finalize("settings.enabled flipped to false", token); return; }

      const summary = await runOneCycle();
      if (token !== this.runToken) return; // stale during await

      this.cyclesCompleted += 1;
      this.lastCycleId = summary.autopilot_cycle_id;
      this.lastCycleStatus = summary.status;
      if (summary.errors.length > 0) this.errorsThisRun += 1;

      if (this.errorsThisRun >= MAX_ERRORS_PER_RUN) { this.finalize(`error cap (${MAX_ERRORS_PER_RUN}) reached`, token); return; }
      if (this.cyclesCompleted >= this.cyclesPlanned) { this.finalize("max_cycles_per_start reached", token); return; }
      if (this.stopRequested) { this.finalize("Stop requested", token); return; }

      const intervalMs = Math.max(1000, settings.intervalSeconds * 1000);
      this.timer = setTimeout(() => this.runNext(token), intervalMs);
    } catch (err) {
      if (token !== this.runToken) return;
      this.errorsThisRun += 1;
      this.lastCycleStatus = "FAILED";
      logger.error({ err: String(err), runId: this.runId }, "FF: cycle failed");
      if (this.errorsThisRun >= MAX_ERRORS_PER_RUN) { this.finalize(`error cap reached: ${String(err).slice(0, 200)}`, token); return; }
      this.timer = setTimeout(() => this.runNext(token), 5000);
    } finally {
      this.inflight = false;
      // If stop was requested while we were running, complete the finalization now.
      if (this.stopRequested && token === this.runToken && this.state !== "IDLE") {
        this.finalize(this.stopReason ?? "Stop requested", token);
      }
    }
  }

  private finalize(reason: string, token: string | null): void {
    if (token !== null && token !== this.runToken) return; // already finalized/replaced
    if (!this.stopReason) this.stopReason = reason;
    this.state = "IDLE";
    this.runToken = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info({ runId: this.runId, reason, cyclesCompleted: this.cyclesCompleted }, "FF: loop finalized");
  }
}

export const paperAutopilotLoop = new Loop();
