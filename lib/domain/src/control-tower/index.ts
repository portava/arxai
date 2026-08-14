export * from "./systemMode.types";
export * from "./systemMode.engine";
export * from "./authorityManager.engine";
export * from "./decisionRouter.engine";
export * from "./safetyCoordinator.engine";
export * from "./rolloutManager.engine";
export * from "./lockdown.engine";
export * from "./recoveryMode.engine";
export * from "./controlTower.engine";

// In-memory ModeChangeLog port impl (deep-copy on append + list, like compliance-log).
import type { ModeChangeLogEntry, ModeChangeLogPort, SystemMode } from "./systemMode.types";

export function createInMemoryModeChangeLog(): ModeChangeLogPort {
  const entries: ModeChangeLogEntry[] = [];
  return {
    async append(e) {
      entries.push({ ...e, reasons: [...e.reasons] });
    },
    async list(filter) {
      let out = entries.map((e) => ({ ...e, reasons: [...e.reasons] }));
      if (filter?.since) {
        const t = filter.since.getTime();
        out = out.filter((e) => Date.parse(e.recordedAt) >= t);
      }
      if (filter?.toMode) {
        const m: SystemMode = filter.toMode;
        out = out.filter((e) => e.toMode === m);
      }
      return out;
    },
  };
}
