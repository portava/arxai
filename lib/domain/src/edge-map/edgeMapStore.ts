import type { EdgeMap, EdgeMapStorePort, EdgeTradeRecord } from "./edgeMap.types";

export function createInMemoryEdgeMapStore(): EdgeMapStorePort {
  const trades: EdgeTradeRecord[] = [];
  let map: EdgeMap | null = null;
  return {
    async putTrade(t) { trades.push({ ...t }); },
    async listTrades(filter) {
      let arr = [...trades];
      if (filter?.since) {
        const t = filter.since.getTime();
        arr = arr.filter((x) => Date.parse(x.closedAt) >= t);
      }
      if (filter?.until) {
        const t = filter.until.getTime();
        arr = arr.filter((x) => Date.parse(x.closedAt) <= t);
      }
      return arr;
    },
    async saveMap(m) { map = { ...m }; },
    async loadMap() { return map ? { ...map } : null; },
  };
}
