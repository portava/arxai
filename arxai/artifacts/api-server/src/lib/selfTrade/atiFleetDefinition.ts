import { z } from "zod/v4";

export const ATI_FLEET_BASELINE = "self-trade-owner-fleet-supervised-v1";
export const ATI_FLEET_SCOPE = "OWNER_FLEET_AFTER_SUPERVISION";
export const ATI_FLEET_CAPTURE = "PERSISTED_OWNER_FLEET_CYCLES";
export const ATI_FLEET_SYMBOL = "V75";
export const ATI_FLEET_ENGINE = "SELF_TRADE_FLEET_DECISION";

export const cleanFleetVersion = z.object({
  engine: z.literal(ATI_FLEET_ENGINE),
  build: z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/), sourceState: z.literal("clean") }),
  decisionSettingsHash: z.hash("sha256"),
});
