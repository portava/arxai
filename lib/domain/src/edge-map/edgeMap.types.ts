import { z } from "zod/v4";

// Personal Edge Map — learn the trader's best/worst pairs, sessions,
// strategies, hold-time buckets, and behavior states. Adjust trade
// permissions based on proven edge in those dimensions.

export const EdgeDimensionSchema = z.enum([
  "PAIR", "SESSION", "STRATEGY", "HOLD_TIME_BUCKET", "BEHAVIOR_STATE",
]);
export type EdgeDimension = z.infer<typeof EdgeDimensionSchema>;

export const HoldTimeBucketSchema = z.enum([
  "UNDER_5M", "FIVE_TO_30M", "THIRTY_TO_120M", "TWO_TO_8H", "OVER_8H",
]);
export type HoldTimeBucket = z.infer<typeof HoldTimeBucketSchema>;

export const BehaviorStateSchema = z.enum([
  "CALM", "FOCUSED", "CAUTIOUS", "FRUSTRATED", "TILT",
]);
export type BehaviorState = z.infer<typeof BehaviorStateSchema>;

// A single completed trade, in the shape the edge-map cares about.
export interface EdgeTradeRecord {
  tradeId: string;
  closedAt: string;
  pair: string;
  session: "ASIA" | "LONDON" | "NY" | "OFF_HOURS";
  strategy: string;
  holdTimeBucket: HoldTimeBucket;
  behaviorState: BehaviorState;
  pnlR: number;
}

export interface EdgeBucket {
  dimension: EdgeDimension;
  key: string;                      // e.g. "EURUSD" or "LONDON"
  sampleCount: number;
  winCount: number;
  lossCount: number;
  totalR: number;
  expectancyR: number;              // totalR / sampleCount
  edgeScore: number;                // sample-weighted; 0..100
  reasons: string[];
}

export interface EdgeMap {
  byDimension: Record<EdgeDimension, EdgeBucket[]>;
  recordedThrough: string;
}

// Permission decision based on the map.
export const PermissionDecisionSchema = z.enum(["ALLOW", "REDUCE", "BLOCK"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export interface ProposedSetupForEdge {
  pair: string;
  session: "ASIA" | "LONDON" | "NY" | "OFF_HOURS";
  strategy: string;
  expectedHoldBucket: HoldTimeBucket;
  behaviorState: BehaviorState;
}

export interface PermissionVerdict {
  decision: PermissionDecision;
  sizeMultiplierCap: number;        // applied when REDUCE; 1.0 when ALLOW
  blockedDimensions: string[];      // dimension:key for any STRONG negative edges
  reasons: string[];
}

export interface EdgeMapStorePort {
  putTrade(t: EdgeTradeRecord): Promise<void>;
  listTrades(filter?: { since?: Date; until?: Date }): Promise<EdgeTradeRecord[]>;
  saveMap(map: EdgeMap): Promise<void>;
  loadMap(): Promise<EdgeMap | null>;
}

export const EDGE_MAP_THRESHOLDS = {
  trustFullSampleCount: 20,
  edgeScoreBlockBelow: 25,          // strong negative — BLOCK
  edgeScoreReduceBelow: 45,         // mild negative — REDUCE
  reduceMultiplierFloor: 0.5,
} as const;
