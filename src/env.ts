import type { KvNamespace, Secrets } from "@telnyx/edge-runtime";

import type {
  AgendaNamespace,
  ConversationBookingNamespace,
  DayCallbacksNamespace,
  MetricsNamespace,
} from "./actors/bindings";

// Bindings the fetch handler receives. Optional entries fail closed when
// missing (503) instead of being assumed present.
export interface Env {
  AGENDA: AgendaNamespace;
  CONVERSATION_BOOKING: ConversationBookingNamespace;
  DAY_CALLBACKS: DayCallbacksNamespace;
  METRICS?: MetricsNamespace;
  SECRETS?: Secrets;
  CONFIG?: KvNamespace;
}
