import type { ReplayPacket, MemoryIndexEntry } from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Memory Indexer — builds an inverted index over ReplayPackets keyed by
// (symbol, session, strategyId, regimeId, agentId). Powers fast retrieval
// for downstream learning loops without re-scanning every truth store.
//
// Pure function. Stable, deterministic group order.
//
// Project rule: every strategy tracked by symbol/session/regime/condition.
// ═══════════════════════════════════════════════════════════════════════════

export function indexReplays(
  packets: readonly ReplayPacket[],
): { entries: MemoryIndexEntry[]; reasons: string[] } {
  const reasons: string[] = [];
  // Use a Map of composite key → mutable accumulator so we keep one entry
  // per index tuple regardless of insertion order.
  const buckets = new Map<string, MutableEntry>();

  for (const p of packets) {
    // Each packet may map to MULTIPLE index keys if its inner records carry
    // varying envelopes — index by the canonical envelope first, then by
    // any agent that voted (so per-agent retrieval works).
    const seenKeysForPacket = new Set<string>();
    pushKey(buckets, seenKeysForPacket, p, {
      symbol:     p.envelope.symbol     ?? "",
      session:    p.envelope.session    ?? "",
      strategyId: p.envelope.strategyId ?? "",
      regimeId:   p.envelope.regimeId   ?? "",
      agentId:    p.envelope.agentId    ?? "",
    });
    for (const d of p.decisions) {
      for (const v of d.votes) {
        pushKey(buckets, seenKeysForPacket, p, {
          symbol:     p.envelope.symbol     ?? "",
          session:    p.envelope.session    ?? "",
          strategyId: p.envelope.strategyId ?? "",
          regimeId:   p.envelope.regimeId   ?? "",
          agentId:    v.agentId,
        });
      }
    }
  }

  // Stable ordering for callers/tests.
  const entries = [...buckets.values()]
    .map(finalize)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  reasons.push(`indexed ${packets.length} packets into ${entries.length} memory groups`);
  return { entries, reasons };
}

interface MutableEntry {
  symbol: string; session: string; strategyId: string;
  regimeId: string; agentId: string;
  packetIds: string[];
  packetIdSet: Set<string>;                      // de-dup
  firstSeenIso: string;
  lastSeenIso: string;
}

function pushKey(
  buckets: Map<string, MutableEntry>,
  seenForPacket: Set<string>,
  p: ReplayPacket,
  k: { symbol: string; session: string; strategyId: string; regimeId: string; agentId: string },
): void {
  const key = `${k.symbol}|${k.session}|${k.strategyId}|${k.regimeId}|${k.agentId}`;
  // Don't double-count the same packet inside the same group.
  const seenKey = `${key}::${p.packetId}`;
  if (seenForPacket.has(seenKey)) return;
  seenForPacket.add(seenKey);

  let entry = buckets.get(key);
  if (!entry) {
    entry = {
      ...k,
      packetIds: [],
      packetIdSet: new Set(),
      firstSeenIso: p.envelope.recordedAtIso,
      lastSeenIso: p.envelope.recordedAtIso,
    };
    buckets.set(key, entry);
  }
  if (!entry.packetIdSet.has(p.packetId)) {
    entry.packetIdSet.add(p.packetId);
    entry.packetIds.push(p.packetId);
  }
  if (p.envelope.recordedAtIso < entry.firstSeenIso) entry.firstSeenIso = p.envelope.recordedAtIso;
  if (p.envelope.recordedAtIso > entry.lastSeenIso)  entry.lastSeenIso  = p.envelope.recordedAtIso;
}

function finalize(e: MutableEntry): MemoryIndexEntry {
  return {
    symbol: e.symbol, session: e.session, strategyId: e.strategyId,
    regimeId: e.regimeId, agentId: e.agentId,
    packetIds: [...e.packetIds],
    count: e.packetIds.length,
    firstSeenIso: e.firstSeenIso,
    lastSeenIso: e.lastSeenIso,
  };
}

function keyOf(e: MemoryIndexEntry): string {
  return `${e.symbol}|${e.session}|${e.strategyId}|${e.regimeId}|${e.agentId}`;
}
