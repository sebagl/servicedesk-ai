import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";
import type { CallbackQueue } from "./callback-queue-actor";

export type CallbackQueueStub = ActorStub &
  Pick<CallbackQueue, "requestCallback" | "listCallbacks">;
export interface CallbackQueueNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CallbackQueueStub;
}
