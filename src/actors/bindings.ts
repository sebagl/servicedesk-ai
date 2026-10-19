import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";

import type { CallbackQueue } from "./callback-queue";
import type { ConversationBooking } from "./conversation-booking";
import type { Counter } from "./counter";
import type { DayAgenda } from "./day-agenda";
import type { Metrics } from "./metrics";

// Typed stubs and namespaces for every Actor binding declared in telnyx.toml.
// Only the RPC methods each caller is allowed to use are exposed.

export type AgendaStub = ActorStub &
  Pick<DayAgenda, "getOccupiedSlots" | "createBooking" | "listBookings">;
export interface AgendaNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): AgendaStub;
}

export type ConversationBookingStub = ActorStub & Pick<ConversationBooking, "book">;
export interface ConversationBookingNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): ConversationBookingStub;
}

export type CallbackQueueStub = ActorStub &
  Pick<CallbackQueue, "requestCallback" | "listCallbacks">;
export interface CallbackQueueNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CallbackQueueStub;
}

export type MetricsStub = ActorStub & Pick<Metrics, "record" | "snapshot">;
export interface MetricsNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): MetricsStub;
}

export type CounterStub = ActorStub & Pick<Counter, "increment" | "read">;
export interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CounterStub;
}
