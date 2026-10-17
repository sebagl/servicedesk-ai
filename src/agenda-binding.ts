import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";
import type { DayAgenda } from "./agenda-actor";

export type AgendaStub = ActorStub & Pick<DayAgenda, "getOccupiedSlots" | "createBooking">;
export interface AgendaNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): AgendaStub;
}
