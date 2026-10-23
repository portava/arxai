import {
  DomainEventSchema,
  type DomainEvent,
  type DomainEventByKind,
  type DomainEventKind,
} from "./domainEvents.types";

// Body of a domain event minus the envelope fields — the caller supplies the
// payload, the factory stamps the envelope.
export type DomainEventBody<K extends DomainEventKind> =
  Omit<DomainEventByKind[K], "eventId" | "occurredAt" | "kind"> & {
    source: string;
    correlationId?: string | null;
    occurredAt?: string;     // override for replay/backfill
    eventId?: string;        // override when caller already minted an id
  };

export interface EventFactoryDeps {
  now?: () => Date;
  newId?: () => string;
}

// crockford-base32 monotonic id, no external dependency. Replace via deps.newId
// if you adopt a real ULID lib.
function defaultNewId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `evt_${ts}_${rand}`;
}

// Pure factory: builds + validates an event, returning the parsed (typed) value
// or throwing a ZodError. Throwing is correct here — a malformed event must
// never reach the bus. Callers that want a Result-style return can wrap with
// `safeParse`.
export function createDomainEvent<K extends DomainEventKind>(
  kind: K,
  body: DomainEventBody<K>,
  deps: EventFactoryDeps = {},
): DomainEvent {
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? defaultNewId;

  const candidate = {
    eventId: body.eventId ?? newId(),
    occurredAt: body.occurredAt ?? now.toISOString(),
    correlationId: body.correlationId ?? null,
    kind,
    ...body,
  };
  return DomainEventSchema.parse(candidate);
}

// Boundary parser — use at every IO edge (HTTP body, websocket frame, queue
// message, db row JSON). Returns a discriminated union or throws.
export function parseDomainEvent(raw: unknown): DomainEvent {
  return DomainEventSchema.parse(raw);
}

// Non-throwing variant for IO edges that prefer Result-style handling.
export function safeParseDomainEvent(raw: unknown):
  | { ok: true; event: DomainEvent }
  | { ok: false; error: string } {
  const r = DomainEventSchema.safeParse(raw);
  return r.success
    ? { ok: true, event: r.data }
    : { ok: false, error: r.error.message };
}

// Type-narrow helper for handlers. `if (isEvent(e, "TRADE_OPENED")) ...`
export function isEvent<K extends DomainEventKind>(
  event: DomainEvent,
  kind: K,
): event is DomainEventByKind[K] {
  return event.kind === kind;
}
