import { isValidDate, isValidTimeSyntax } from "./scheduling";
import { loadConfig } from "./config";
import {
  createBooking as createBookingService,
  type BookingRequest,
  type BookingServiceResult,
} from "./booking-service";
import type { ActorNamespace, ActorStub, KvNamespace, Secrets } from "@telnyx/edge-runtime";
import type { DayAgenda } from "./agenda-actor";

const MAX_BODY_BYTES = 10 * 1024; // 10 KiB

const ALLOWED_FIELDS = new Set([
  "service_id",
  "date",
  "time",
  "customer_name",
  "customer_phone",
  "idempotency_key",
  "confirmed",
]);

type AgendaStub = ActorStub & Pick<DayAgenda, "getOccupiedSlots" | "createBooking">;
interface AgendaNamespace extends ActorNamespace {
  idFromName(name: string): AgendaStub;
}

interface Env {
  AGENDA?: AgendaNamespace;
  CONFIG?: KvNamespace;
  SECRETS?: Secrets;
}

export type BookingResponse =
  | { status: 200; body: { booking_id: string; service_id: string; date: string; time: string; status: "confirmed" } }
  | { status: 400; body: { error: string } }
  | { status: 413; body: { error: "payload_too_large" } }
  | { status: 503; body: { error: "service_unavailable" } };

async function readBoundedBody(
  req: Request,
): Promise<
  | { ok: true; text: string }
  | { ok: false; status: 400 }
  | { ok: false; status: 413 }
> {
  const reader = req.body?.getReader();
  if (!reader) {
    // No body stream — treat as empty (will fail JSON parse later).
    return { ok: true, text: "" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        // Stream read failure (network reset, aborted connection). The raw
        // error is intentionally discarded — surface a generic 400 so the
        // caller sees a controlled response without leaking internals.
        return { ok: false, status: 400 };
      }
      if (readResult.done) break;
      const value = readResult.value;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Oversized body — return 413 before awaiting cancel so the response
        // is not blocked if the reader's cancel rejects.
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    const text =
      chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
      decoder.decode();
    return { ok: true, text };
  } finally {
    // The reader lock is NOT released by cancel() or by read() returning
    // done. releaseLock() must be called explicitly. We do NOT await
    // cancel(): a hanging cancel must never delay the 400/413 response —
    // the bounded read above already produced the outcome. The .catch()
    // absorbs any rejection so the cancel promise is never an unhandled
    // rejection. releaseLock() runs synchronously regardless of whether
    // the cancel has settled, so the lock is freed promptly even when the
    // underlying source is wedged.
    reader.cancel().catch(() => {
      // intentionally ignored — rejection has no observable effect
    });
    reader.releaseLock();
  }
}

function validateStructure(raw: unknown): BookingRequest | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "bad_request" };
  }
  const obj = raw as Record<string, unknown>;

  // Reject unexpected fields
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { error: "unexpected_field" };
    }
  }

  // Field type and content validation
  const { service_id, date, time, customer_name, customer_phone, idempotency_key, confirmed } = obj;

  if (typeof service_id !== "string" || service_id.trim().length === 0 || service_id.length > 128) {
    return { error: "invalid_service_id" };
  }
  if (typeof date !== "string" || !isValidDate(date)) {
    return { error: "date_invalid" };
  }
  if (typeof time !== "string" || !isValidTimeSyntax(time)) {
    return { error: "time_invalid" };
  }
  if (typeof customer_name !== "string" || customer_name.trim().length === 0 || customer_name.length > 256) {
    return { error: "missing_customer_name" };
  }
  if (typeof customer_phone !== "string" || customer_phone.trim().length === 0 || customer_phone.length > 64) {
    return { error: "missing_customer_phone" };
  }
  if (typeof idempotency_key !== "string" || idempotency_key.trim().length === 0 || idempotency_key.length > 128) {
    return { error: "missing_idempotency_key" };
  }
  if (typeof confirmed !== "boolean") {
    return { error: "confirmed_required" };
  }

  return {
    service_id: service_id.trim(),
    date,
    time,
    customer_name: customer_name.trim(),
    customer_phone: customer_phone.trim(),
    idempotency_key: idempotency_key.trim(),
    confirmed,
  };
}

function mapServiceResultToHttp(result: BookingServiceResult): BookingResponse {
  switch (result.kind) {
    case "confirmed":
      return {
        status: 200,
        body: {
          booking_id: result.booking_id,
          service_id: result.service_id,
          date: result.date,
          time: result.time,
          status: "confirmed",
        },
      };
    case "rejected":
      return { status: 400, body: { error: result.code } };
    case "infrastructure_error":
      return { status: 503, body: { error: "service_unavailable" } };
  }
}

export async function handleBookingRequest(
  req: Request,
  env: Env,
): Promise<BookingResponse> {
  // Step 1: Read bounded body
  const bodyResult = await readBoundedBody(req);
  if (!bodyResult.ok) {
    if (bodyResult.status === 413) {
      return { status: 413, body: { error: "payload_too_large" } };
    }
    return { status: 400, body: { error: "bad_request" } };
  }

  // Step 2: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.text);
  } catch {
    return { status: 400, body: { error: "bad_request" } };
  }

  // Step 3: Structural validation (transport-layer concern: shape, sizes, types)
  const structured = validateStructure(parsed);
  if ("error" in structured) {
    return { status: 400, body: { error: structured.error } };
  }

  // Step 4: Check bindings — fail closed before reaching the service.
  if (!env.CONFIG || !env.AGENDA) {
    return { status: 503, body: { error: "service_unavailable" } };
  }

  // Step 5: Delegate to the transport-independent service. The adapter only
  // wires env into the minimal structural deps the service declares.
  const result = await createBookingService(structured, {
    loadConfig: async () => {
      const r = await loadConfig(env.CONFIG!);
      return r.ok ? r.config : null;
    },
    getAgenda: (name) => env.AGENDA!.idFromName(name),
  });

  return mapServiceResultToHttp(result);
}
