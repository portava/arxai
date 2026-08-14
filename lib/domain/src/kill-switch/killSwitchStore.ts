import type { KillSwitchState, KillSwitchStorePort } from "./killSwitch.types";

export function createInMemoryKillSwitchStore(): KillSwitchStorePort {
  let state: KillSwitchState | null = null;
  return {
    async saveState(s) { state = { ...s, activeTriggers: [...s.activeTriggers] }; },
    async loadState() {
      if (!state) return null;
      return { ...state, activeTriggers: [...state.activeTriggers] };
    },
  };
}
