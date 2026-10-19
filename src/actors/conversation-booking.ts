import { randomUUID } from "node:crypto";
import { StatefulActor } from "@telnyx/edge-runtime";
import type { KvNamespace } from "@telnyx/edge-runtime";

import type { AgendaNamespace } from "./bindings";
import {
  createBooking,
  type BookingServiceResult,
} from "../services/booking";
import {
  coordinateBooking,
  type ActorStorageLike,
  type ConversationBookingInput,
  type ConversationBookingResult,
  type SavedBookingAttempt,
} from "../domain/conversation-booking";
import { loadConfig } from "../domain/config";
import { LOCATION_ID } from "../domain/business-rules";

// ---------------------------------------------------------------------------
// ConversationBooking — one StatefulActor per trusted Telnyx conversation
// (see docs/architecture.md). Persists a single aggregate (idle / pending /
// confirmed) keyed under "booking". Confirmed replays return the stored
// result without loading KV or contacting AGENDA — those bindings are only
// consulted inside the executor path. RPC callers never supply config,
// location, attempt key, or credentials; the adapter injects them from
// this.env and the persisted saved attempt.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "booking";

interface ConversationBookingBindings {
  CONFIG?: KvNamespace;
  AGENDA?: AgendaNamespace;
}

export class ConversationBooking extends StatefulActor {
  async book(
    input: ConversationBookingInput,
  ): Promise<ConversationBookingResult> {
    try {
      const storage = (this.ctx as { storage: ActorStorageLike }).storage;
      return await coordinateBooking(input, {
        storage,
        storageKey: STORAGE_KEY,
        generateAttemptKey: () => randomUUID(),
        executeBooking: (attempt) => this.executeBooking(attempt),
        locationId: LOCATION_ID,
      });
    } catch {
      // Adapter-level failures (state corruption, encoding errors, unexpected
      // throw paths) must not leak. Return generic infrastructure_error.
      return { kind: "infrastructure_error" };
    }
  }

  private async executeBooking(
    attempt: SavedBookingAttempt,
  ): Promise<BookingServiceResult> {
    const env = this.env as unknown as ConversationBookingBindings;
    if (!env.CONFIG || !env.AGENDA) {
      return { kind: "infrastructure_error" };
    }

    const configResult = await loadConfig(env.CONFIG);
    if (!configResult.ok) {
      return { kind: "infrastructure_error" };
    }

    // The saved attempt binds to a specific location. A config whose
    // location_id does not match indicates a stale or mismatched booking
    // context; fail closed without routing to DayAgenda.
    if (configResult.config.business.location_id !== attempt.location_id) {
      return { kind: "infrastructure_error" };
    }

    const agenda = env.AGENDA;
    return await createBooking(
      {
        service_id: attempt.input.service_id,
        date: attempt.input.date,
        time: attempt.input.time,
        customer_name: attempt.input.customer_name,
        customer_phone: attempt.input.customer_phone,
        idempotency_key: attempt.attempt_key,
        confirmed: attempt.input.confirmed,
      },
      {
        loadConfig: async () => configResult.config,
        getAgenda: (name) => agenda.idFromName(name),
      },
    );
  }
}
