import type { KvNamespace, Secrets } from "@telnyx/edge-runtime";

import type {
  AgendaNamespace,
  CallbackQueueNamespace,
  ConversationBookingNamespace,
  CounterNamespace,
  MetricsNamespace,
} from "./actors/bindings";

// Bindings the fetch handler receives. Optional entries fail closed when
// missing (503) instead of being assumed present.
export interface Env {
  COUNTER: CounterNamespace;
  AGENDA: AgendaNamespace;
  CONVERSATION_BOOKING: ConversationBookingNamespace;
  CALLBACK_QUEUE: CallbackQueueNamespace;
  METRICS?: MetricsNamespace;
  SECRETS?: Secrets;
  CONFIG?: KvNamespace;
}
