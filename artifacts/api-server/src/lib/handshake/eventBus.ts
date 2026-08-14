// ── ARX Handshake System — lightweight in-process event bus ─────────────────
//
// A single typed EventEmitter for cross-layer readiness + layer-update events.
// This is ADVISORY: listeners may surface, log, or invalidate cached state, but
// nothing here gates, slows, or alters any execution path. It does NOT replace
// `alertManager` (user-facing alerts) or `security/events` (audit) — those
// remain the channels for their respective concerns.
//
// WIRING POSTURE: the bus defines the typed channels for every cross-layer
// update a dependent may care about (price, candles, specs, scanner signal,
// news, heartbeat, position sync, NAV, ledger, discrepancy, role). The handshake
// coordinator SUBSCRIBES to these to invalidate its advisory cache so a fresh
// read happens after a layer changes. PRODUCERS are wired by the owning layer
// in its own phase; until a producer publishes, the channel is simply quiet.
// No producer hot path (live dispatch, scanner scan loop, EA heartbeat ingest)
// is modified here — emitting is opt-in and best-effort.

import { EventEmitter } from "node:events";
import type {
  HandshakeLayerKey,
  HandshakeLayerStatus,
  HandshakeOverallStatus,
  HandshakeType,
} from "@workspace/domain/handshake";

// Common shape for a layer-update notification. `symbol`/`userId` are optional
// scoping hints; `at` is an ISO timestamp.
export interface LayerUpdateEvent {
  symbol?: string;
  userId?: number;
  at: string;
}

export interface HandshakeEventMap {
  // ── Handshake lifecycle ──
  // A handshake type finished evaluating.
  "handshake:evaluated": {
    type: HandshakeType;
    overallStatus: HandshakeOverallStatus;
    at: string;
  };
  // A layer was observed in a non-PASS state during an evaluation.
  "layer:not-ready": {
    layer: HandshakeLayerKey;
    status: HandshakeLayerStatus;
    detail: string;
    at: string;
  };

  // ── Cross-layer update channels (a layer update notifies dependents) ──
  "layer:price": LayerUpdateEvent;
  "layer:candles": LayerUpdateEvent;
  "layer:specs": LayerUpdateEvent;
  "layer:scanner-signal": LayerUpdateEvent;
  "layer:news": LayerUpdateEvent;
  "layer:heartbeat": LayerUpdateEvent;
  "layer:position-sync": LayerUpdateEvent;
  "layer:nav": LayerUpdateEvent;
  "layer:ledger": LayerUpdateEvent;
  "layer:discrepancy": LayerUpdateEvent;
  "layer:role": LayerUpdateEvent;
}

export type HandshakeEventName = keyof HandshakeEventMap;

// The cross-layer update channels (excludes the two lifecycle events). The
// coordinator subscribes to these to invalidate its advisory cache.
export const LAYER_UPDATE_EVENTS = [
  "layer:price",
  "layer:candles",
  "layer:specs",
  "layer:scanner-signal",
  "layer:news",
  "layer:heartbeat",
  "layer:position-sync",
  "layer:nav",
  "layer:ledger",
  "layer:discrepancy",
  "layer:role",
] as const satisfies readonly HandshakeEventName[];

class HandshakeEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Defensive: never let a misbehaving listener crash the process. The bus
    // is advisory; a listener error must not affect any caller.
    this.emitter.setMaxListeners(100);
  }

  on<E extends HandshakeEventName>(
    event: E,
    listener: (payload: HandshakeEventMap[E]) => void,
  ): void {
    this.emitter.on(event, listener as (payload: unknown) => void);
  }

  off<E extends HandshakeEventName>(
    event: E,
    listener: (payload: HandshakeEventMap[E]) => void,
  ): void {
    this.emitter.off(event, listener as (payload: unknown) => void);
  }

  emit<E extends HandshakeEventName>(event: E, payload: HandshakeEventMap[E]): void {
    // Best-effort: a throwing listener must never propagate to the producer.
    try {
      this.emitter.emit(event, payload);
    } catch {
      // Advisory bus — swallow. Producers are never affected by a listener.
    }
  }
}

// Module-singleton bus shared across the server process.
export const handshakeEventBus = new HandshakeEventBus();
