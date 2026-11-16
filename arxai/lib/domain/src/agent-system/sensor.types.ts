// sensor.types — public facade for the five sensor reading shapes.
// Sensors collect FACTS only; agents interpret them.

export type {
  MarketObservation,
  AccountObservation,
  ExecutionObservation,
  BehaviorObservation,
  NewsObservation,
  UpcomingNewsEvent,
  EmotionalState,
  NewsSeverity,
  SessionLabel,
  MarketDataPort,
  AccountPort,
  ExecutionDiagnosticsPort,
  BehaviorPort,
  NewsPort,
} from "./agentSystem.types";

export {
  EmotionalStateSchema,
  NewsSeveritySchema,
  SessionLabelSchema,
} from "./agentSystem.types";
