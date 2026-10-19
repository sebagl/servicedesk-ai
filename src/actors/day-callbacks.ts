import { randomUUID } from "node:crypto";
import { StatefulActor } from "@telnyx/edge-runtime";

// ---------------------------------------------------------------------------
// DayCallbacks — one Actor per local calendar date ("callbacks-YYYY-MM-DD").
// Persists the newest 200 callback requests in a single "queue" key, newest
// first. Per-conversation idempotency: the first request in a conversation
// wins inside this day's instance; subsequent requests for the same
// conversation return the original entry. Name and phone are accepted on
// the wire but never returned by the API surface; they live only inside
// the actor's persisted state.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "queue";
const MAX_ENTRIES = 200;

export interface CallbackRequestInput {
  conversation_id: string;
  customer_name: string;
  customer_phone: string;
  reason: string;
}

export interface CallbackEntry {
  id: string;
  conversation_id: string;
  customer_name: string;
  customer_phone: string;
  reason: string;
  created_at: string;
}

export interface CallbackRequestResult {
  request_id: string;
  created_at: string;
}

interface ActorStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

function isEntry(raw: unknown): raw is CallbackEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.conversation_id === "string" &&
    typeof e.customer_name === "string" &&
    typeof e.customer_phone === "string" &&
    typeof e.reason === "string" &&
    typeof e.created_at === "string"
  );
}

function validateQueue(raw: unknown): CallbackEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("callback queue storage is not an array");
  }
  const out: CallbackEntry[] = [];
  for (const item of raw) {
    if (!isEntry(item)) throw new Error("callback queue contains malformed entry");
    out.push(item);
  }
  return out;
}

export class DayCallbacks extends StatefulActor {
  async listCallbacks(): Promise<CallbackEntry[]> {
    try {
      const storage = (this.ctx as { storage: ActorStorageLike }).storage;
      const raw = await storage.get<unknown>(STORAGE_KEY);
      // Stored in newest-first order on write; return the same order so
      // the operator view matches the persistence layout.
      return validateQueue(raw);
    } catch {
      // Adapter-level failures (storage errors, corrupted aggregate) must
      // not leak. Throw — the demo route maps to 503.
      throw new Error("callback queue storage failed");
    }
  }

  async requestCallback(
    input: CallbackRequestInput,
  ): Promise<CallbackRequestResult> {
    try {
      const storage = (this.ctx as { storage: ActorStorageLike }).storage;
      const raw = await storage.get<unknown>(STORAGE_KEY);
      const queue = validateQueue(raw);

      const existing = queue.find(
        (e) => e.conversation_id === input.conversation_id,
      );
      if (existing !== undefined) {
        return { request_id: existing.id, created_at: existing.created_at };
      }

      const entry: CallbackEntry = {
        id: randomUUID(),
        conversation_id: input.conversation_id,
        customer_name: input.customer_name,
        customer_phone: input.customer_phone,
        reason: input.reason,
        created_at: new Date().toISOString(),
      };

      const next = [entry, ...queue].slice(0, MAX_ENTRIES);
      await storage.put(STORAGE_KEY, next);

      return { request_id: entry.id, created_at: entry.created_at };
    } catch {
      // Adapter-level failures (storage errors, corrupted aggregate) must
      // not leak. Throw — the MCP layer maps to service_unavailable.
      throw new Error("callback queue storage failed");
    }
  }
}
