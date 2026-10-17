// Local simulated integration tests for the MCP booking flow.
//
// These tests exercise the real fetch handler and the real MCP SDK end-to-end
// against real ConversationBooking and DayAgenda classes. They are NOT proof
// of runtime serialization, concurrency, or remote persistence — the
// StatefulActor base, secrets, KV, and namespaces are local fakes, and
// per-Actor storage is in-process. Do not draw cross-process or
// production-scale conclusions from these tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import handler from "../src/index";
import { ConversationBooking } from "../src/conversation-actor";
import { DayAgenda } from "../src/agenda-actor";
import { createFakeStorage } from "./support/fake-actor-storage";
import type { AppConfig } from "../src/config";
import type {
  ConversationBookingInput,
  ConversationBookingResult,
} from "../src/conversation-booking";
import type { CreateBookingInput } from "../src/agenda-actor";
import type { ActorStorageLike } from "../src/conversation-booking";
import { agendaActorName } from "../src/domain/business-rules";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CONFIG: AppConfig = {
  services: [
    { id: "oil_change", name: "Oil Change", duration_minutes: 60 },
    { id: "tire_rotation", name: "Tire Rotation", duration_minutes: 60 },
    {
      id: "general_maintenance",
      name: "General Maintenance Service",
      duration_minutes: 60,
    },
  ],
  business: {
    location_id: "main",
    timezone: "America/Mexico_City",
    open_days: ["mon", "tue", "wed", "thu", "fri"],
    slot_hours: { start: "09:00", end: "17:00", last_start: "16:00" },
    booking_window_days: 7,
    booking_enabled: true,
  },
};

const VALID_TOKEN = "mcp-integration-token";
const TEST_DATE = "2026-10-20"; // Tuesday — open weekday, future slot
const OTHER_DATE = "2026-10-21"; // Wednesday — open weekday, future slot

// MX-local epoch ms for a given local date/time. Same helper pattern as the
// existing agenda-actor suite — resolves via Intl.DateTimeFormat, no hard
// offset. Clock is frozen to Monday Oct 19, 2026 08:00 local: TEST_DATE and
// OTHER_DATE are both future open weekdays inside the 7-day window.
function localEpochMS(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const candidate = Date.UTC(y, m - 1, d, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(candidate));
  const ly = parts.find((p) => p.type === "year")!.value;
  const lm = parts.find((p) => p.type === "month")!.value;
  const ld = parts.find((p) => p.type === "day")!.value;
  const lh = Number(parts.find((p) => p.type === "hour")!.value);
  const lmin = Number(parts.find((p) => p.type === "minute")!.value);
  if (`${ly}-${lm}-${ld}` !== date) {
    throw new Error(`localEpochMS date mismatch for ${date}`);
  }
  const offsetMs = (hour * 60 + minute - lh * 60 - lmin) * 60000;
  return candidate + offsetMs;
}

const FROZEN_NOW = localEpochMS("2026-10-19", 8, 0);

const TEST_CUSTOMER_A = {
  customer_name: "Test Customer One",
  customer_phone: "+52 55 0000 0001",
};
const TEST_CUSTOMER_B = {
  customer_name: "Test Customer Two",
  customer_phone: "+52 55 0000 0002",
};

// ---------------------------------------------------------------------------
// Namespace fakes — real Actor classes, real per-name persisted storage,
// real MCP SDK plumbing through handler.fetch. Between calls Actor objects
// are reconstructed over the same underlying storage so persisted state
// survives each round trip (mimicking Actor instance eviction/restart at
// the persistence layer, not at the runtime dispatch layer).
// ---------------------------------------------------------------------------

type FakeStore = ReturnType<typeof createFakeStorage>;
interface AgendaStubLike {
  getOccupiedSlots(): Promise<{ occupied: string[] }>;
  createBooking(input: CreateBookingInput): Promise<{
    ok: boolean;
    booking_id?: string;
    service_id?: string;
    date?: string;
    time?: string;
    status?: string;
    code?: string;
  }>;
}

class FakeAgendaNamespace {
  private stores = new Map<string, FakeStore>();
  // Names whose NEXT createBooking() call should resolve the real DayAgenda
  // result (DayAgenda persists), then throw instead of returning it —
  // simulating an RPC delivery failure after the Agenda had already
  // persisted the booking. Subsequent createBooking() calls return normally.
  private throwOnceAfterRealResult = new Set<string>();

  idFromName(name: string): AgendaStubLike {
    if (!this.stores.has(name)) {
      this.stores.set(name, createFakeStorage());
    }
    const storage = this.stores.get(name)!;
    const env = ENV;
    const actor = new DayAgenda({ storage } as never, env as never);

    const shouldThrowOnce = this.throwOnceAfterRealResult.has(name);
    if (shouldThrowOnce) this.throwOnceAfterRealResult.delete(name);

    return {
      getOccupiedSlots: () => actor.getOccupiedSlots(),
      createBooking: async (input) => {
        const result = await actor.createBooking(input);
        if (shouldThrowOnce) {
          throw new Error(
            "simulated RPC delivery failure after DayAgenda persistence",
          );
        }
        return result;
      },
    };
  }

  armNextCreateBookingThrowOnceAfterPersist(name: string): void {
    this.throwOnceAfterRealResult.add(name);
  }

  async readAgendaState(name: string): Promise<unknown> {
    const store = this.stores.get(name);
    if (store === undefined) return undefined;
    return store.get("agenda");
  }

  async readOccupied(name: string): Promise<string[]> {
    const stub = this.idFromName(name);
    return (await stub.getOccupiedSlots()).occupied;
  }
}

interface ConversationBookingStubLike {
  book(input: ConversationBookingInput): Promise<ConversationBookingResult>;
}

class FakeConversationBookingNamespace {
  private stores = new Map<string, FakeStore>();
  // Names whose NEXT idFromName() call should construct an Actor whose storage
  // fails its second put (the confirmed-write path), simulating a response
  // lost after DayAgenda already persisted.
  private armSecondPutFailure = new Set<string>();

  idFromName(name: string): ConversationBookingStubLike {
    if (!this.stores.has(name)) {
      this.stores.set(name, createFakeStorage());
    }
    const baseStorage = this.stores.get(name)!;
    const env = ENV;

    let storage: ActorStorageLike;
    if (this.armSecondPutFailure.has(name)) {
      this.armSecondPutFailure.delete(name);
      let putsSeen = 0;
      const originalPut = baseStorage.put;
      storage = {
        get: baseStorage.get,
        put: async (key: string, value: unknown) => {
          putsSeen++;
          if (putsSeen === 2) {
            throw new Error("simulated lost response after DayAgenda persistence");
          }
          return originalPut(key, value);
        },
      };
    } else {
      storage = baseStorage;
    }

    const actor = new ConversationBooking({ storage } as never, env as never);
    return { book: (input) => actor.book(input) };
  }

  armNextIdFromNameConfirmedWriteFailure(name: string): void {
    this.armSecondPutFailure.add(name);
  }

  async readAggregate(name: string): Promise<unknown> {
    const store = this.stores.get(name);
    if (store === undefined) return undefined;
    return store.get("booking");
  }
}

// Shared env (mocked KV, mocked Secrets, real ConversationBooking/DayAgenda
// accessors). Created once per test in buildEnv() so each test gets its own
// isolated storage maps.
let ENV: unknown;
let AGENDA: FakeAgendaNamespace;
let CONVERSATION_BOOKING: FakeConversationBookingNamespace;
let KV: { get: ReturnType<typeof vi.fn>; put?: ReturnType<typeof vi.fn> };

function buildEnv(): {
  env: unknown;
  agenda: FakeAgendaNamespace;
  conversationBooking: FakeConversationBookingNamespace;
  kv: { get: ReturnType<typeof vi.fn> };
} {
  AGENDA = new FakeAgendaNamespace();
  CONVERSATION_BOOKING = new FakeConversationBookingNamespace();
  KV = { get: vi.fn(async () => VALID_CONFIG) };
  ENV = {
    SECRETS: {
      get: vi.fn(async (binding: string) => {
        if (binding === "MCP_AUTH") return VALID_TOKEN;
        if (binding === "SMOKE_AUTH") return "smoke";
        throw new Error(`unknown binding: ${binding}`);
      }),
    },
    CONFIG: KV,
    AGENDA,
    CONVERSATION_BOOKING,
  };
  return { env: ENV, agenda: AGENDA, conversationBooking: CONVERSATION_BOOKING, kv: KV };
}

// ---------------------------------------------------------------------------
// MCP request helpers — real JSON-RPC envelopes through the real handler.
// Manual authenticated clients can supply params._meta directly; an
// Assistant is not the only path that exercises telnyx_conversation_id.
// ---------------------------------------------------------------------------

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function mcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...bearer(token),
  };
}

function jsonRpcBody(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function mcpRequest(body: string): Request {
  return new Request("http://x/mcp", { method: "POST", headers: mcpHeaders(VALID_TOKEN), body });
}

function bookingToolCall(args: {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  confirmed: boolean;
}, conversationId: string, id: number): Request {
  const params = {
    name: "create_booking",
    arguments: args,
    _meta: { telnyx_conversation_id: conversationId },
  };
  return mcpRequest(jsonRpcBody(id, "tools/call", params));
}

function createHashActorName(conversationId: string): string {
  return `conversation-${createHash("sha256").update(conversationId).digest("hex")}`;
}

async function readToolText(res: Response): Promise<{
  isError: boolean;
  rawText: string;
  parsed: unknown;
}> {
  const body = (await res.json()) as {
    result: { isError: boolean; content: Array<{ type: string; text: string }> };
  };
  const text = body.result.content[0]!.text;
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // text is a bare error string like "service_unavailable"
  }
  return {
    isError: body.result.isError === true,
    rawText: text,
    parsed,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP booking flow — local simulated integration", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    buildEnv();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. New conversation books successfully; DayAgenda occupancy reflects it.
  // -------------------------------------------------------------------------
  it("new conversation books successfully and DayAgenda reflects the occupancy", async () => {
    const conversationId = "conv-new-1";
    const actorName = createHashActorName(conversationId);
    const agendaName = agendaActorName("main", TEST_DATE);

    const res = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        1,
      ),
      ENV as never,
    );

    expect(res.status).toBe(200);
    const tool = await readToolText(res);
    expect(tool.isError).toBe(false);
    expect(tool.parsed).toMatchObject({
      status: "confirmed",
      service_id: "oil_change",
      date: TEST_DATE,
      time: "10:00",
    });
    const bookingId = (tool.parsed as { booking_id: string }).booking_id;
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/i);

    // DayAgenda namespace was addressed by name and stored exactly one
    // booking on the slot. Synthetic customer data is never returned.
    const occupied = await AGENDA.readOccupied(agendaName);
    expect(occupied).toEqual(["10:00"]);

    const state = (await AGENDA.readAgendaState(agendaName)) as {
      date: string;
      bookings: Record<string, { time: string; customer_name: string }>;
      idempotency: Record<string, { booking_time: string }>;
    };
    expect(state.date).toBe(TEST_DATE);
    expect(Object.keys(state.bookings)).toEqual(["10:00"]);
    expect(state.bookings["10:00"]!.time).toBe("10:00");
    expect(Object.keys(state.idempotency)).toHaveLength(1);

    // Conversation aggregate is now confirmed.
    const conv = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      result: { booking_id: string; date: string; time: string };
    };
    expect(conv.kind).toBe("confirmed");
    expect(conv.result.booking_id).toBe(bookingId);
    expect(conv.result.date).toBe(TEST_DATE);
    expect(conv.result.time).toBe("10:00");

    // No customer data leaked into the response or the tool log line.
    expect(tool.rawText).not.toContain("Test Customer");
    expect(tool.rawText).not.toContain("0000 0001");
    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("Test Customer");
      expect(JSON.stringify(call)).not.toContain("0000 0001");
    }
  });

  // -------------------------------------------------------------------------
  // 2. Identical retry returns the same booking ID, with one stored booking.
  // -------------------------------------------------------------------------
  it("identical retry returns the same booking_id with only one stored booking", async () => {
    const conversationId = "conv-retry-2";
    const actorName = createHashActorName(conversationId);
    const agendaName = agendaActorName("main", TEST_DATE);

    const args = {
      service_id: "oil_change",
      date: TEST_DATE,
      time: "10:00",
      ...TEST_CUSTOMER_A,
      confirmed: true,
    };

    const first = await handler.fetch(bookingToolCall(args, conversationId, 1), ENV as never);
    expect(first.status).toBe(200);
    const firstTool = await readToolText(first);
    expect(firstTool.isError).toBe(false);
    const firstBookingId = (firstTool.parsed as { booking_id: string }).booking_id;

    const second = await handler.fetch(bookingToolCall(args, conversationId, 2), ENV as never);
    expect(second.status).toBe(200);
    const secondTool = await readToolText(second);
    expect(secondTool.isError).toBe(false);
    const secondBookingId = (secondTool.parsed as { booking_id: string }).booking_id;

    expect(secondBookingId).toBe(firstBookingId);

    // DayAgenda still has exactly one booking — replay did not duplicate.
    const occupied = await AGENDA.readOccupied(agendaName);
    expect(occupied).toEqual(["10:00"]);
    const state = (await AGENDA.readAgendaState(agendaName)) as {
      bookings: Record<string, unknown>;
      idempotency: Record<string, unknown>;
    };
    expect(Object.keys(state.bookings)).toHaveLength(1);
    expect(Object.keys(state.idempotency)).toHaveLength(1);

    // Conversation aggregate still confirmed with the original booking id.
    const conv = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      result: { booking_id: string };
    };
    expect(conv.kind).toBe("confirmed");
    expect(conv.result.booking_id).toBe(firstBookingId);
  });

  // -------------------------------------------------------------------------
  // 3. Same conversation changing date/time → conversation_already_booked;
  //    no second booking is created.
  // -------------------------------------------------------------------------
  it("same conversation changing date returns conversation_already_booked with no second booking", async () => {
    const conversationId = "conv-change-3";
    const agendaNameA = agendaActorName("main", TEST_DATE);
    const agendaNameB = agendaActorName("main", OTHER_DATE);

    const first = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        1,
      ),
      ENV as never,
    );
    expect(first.status).toBe(200);
    const firstTool = await readToolText(first);
    expect(firstTool.isError).toBe(false);
    const firstBookingId = (firstTool.parsed as { booking_id: string }).booking_id;

    // Same conversation, different date and time — must be rejected and must
    // not create a booking on the new agenda.
    const second = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: OTHER_DATE,
          time: "11:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        2,
      ),
      ENV as never,
    );
    expect(second.status).toBe(200);
    const secondTool = await readToolText(second);
    expect(secondTool.isError).toBe(true);
    expect(secondTool.parsed).toEqual({ error: "conversation_already_booked" });

    // First day's agenda has exactly the original booking.
    const occupiedA = await AGENDA.readOccupied(agendaNameA);
    expect(occupiedA).toEqual(["10:00"]);

    // Second day's agenda has NO bookings — rejected request did not write.
    // The agenda may not exist at all (never written); occupancy is the
    // authoritative check.
    const occupiedB = await AGENDA.readOccupied(agendaNameB);
    expect(occupiedB).toEqual([]);
    const stateB = await AGENDA.readAgendaState(agendaNameB);
    expect(stateB).toBeUndefined();

    // Conversation aggregate is still confirmed with the original booking id.
    const actorName = createHashActorName(conversationId);
    const conv = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      result: { booking_id: string };
    };
    expect(conv.kind).toBe("confirmed");
    expect(conv.result.booking_id).toBe(firstBookingId);
  });

  // -------------------------------------------------------------------------
  // 4. Another conversation targeting the occupied slot → slot_unavailable;
  //    it can then book a free slot.
  // -------------------------------------------------------------------------
  it("a second conversation is rejected on the occupied slot and succeeds on a free slot", async () => {
    const agendaName = agendaActorName("main", TEST_DATE);

    // First conversation books slot 10:00.
    const first = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        "conv-occupy-4a",
        1,
      ),
      ENV as never,
    );
    expect(first.status).toBe(200);
    const firstTool = await readToolText(first);
    expect(firstTool.isError).toBe(false);

    // Different conversation targeting the same slot must be rejected.
    const conflict = await handler.fetch(
      bookingToolCall(
        {
          service_id: "tire_rotation",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_B,
          confirmed: true,
        },
        "conv-occupy-4b",
        2,
      ),
      ENV as never,
    );
    expect(conflict.status).toBe(200);
    const conflictTool = await readToolText(conflict);
    expect(conflictTool.isError).toBe(true);
    expect(conflictTool.parsed).toEqual({ error: "slot_unavailable" });

    // Still exactly one booking — the rejected attempt did not write.
    const occupied = await AGENDA.readOccupied(agendaName);
    expect(occupied).toEqual(["10:00"]);

    // The same second conversation can pick a free slot and succeed.
    const retry = await handler.fetch(
      bookingToolCall(
        {
          service_id: "tire_rotation",
          date: TEST_DATE,
          time: "11:00",
          ...TEST_CUSTOMER_B,
          confirmed: true,
        },
        "conv-occupy-4b",
        3,
      ),
      ENV as never,
    );
    expect(retry.status).toBe(200);
    const retryTool = await readToolText(retry);
    expect(retryTool.isError).toBe(false);
    expect(retryTool.parsed).toMatchObject({
      status: "confirmed",
      service_id: "tire_rotation",
      date: TEST_DATE,
      time: "11:00",
    });

    const occupiedAfter = await AGENDA.readOccupied(agendaName);
    expect(occupiedAfter).toEqual(["10:00", "11:00"]);
  });

  // -------------------------------------------------------------------------
  // 5. Lost ConversationBooking confirmed-state write after DayAgenda
  //    persistence: the conversation Actor's confirmed-state put fails
  //    AFTER DayAgenda has already persisted. First call returns generic
  //    service_unavailable; retry with changed input resolves the original
  //    attempt via DayAgenda idempotency replay, returns
  //    conversation_already_booked, and creates no additional booking.
  //
  //    Failure mode: simulated by wrapping the conversation Actor's storage
  //    put() so the second call (the confirmed-state write) throws. DayAgenda
  //    runs end-to-end against the real fake storage.
  // -------------------------------------------------------------------------
  it("lost conversation-state write after DayAgenda persist: retry with changed input returns conversation_already_booked with no additional booking", async () => {
    const conversationId = "conv-lost-state-5";
    const actorName = createHashActorName(conversationId);
    const agendaName = agendaActorName("main", TEST_DATE);

    // Arm the conversation Actor's next call so its confirmed-write put
    // fails AFTER DayAgenda has already persisted. DayAgenda is real and
    // unaware — it persists normally and returns success.
    CONVERSATION_BOOKING.armNextIdFromNameConfirmedWriteFailure(actorName);

    const first = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        1,
      ),
      ENV as never,
    );
    expect(first.status).toBe(200);
    const firstTool = await readToolText(first);
    expect(firstTool.isError).toBe(true);
    // Generic service_unavailable — no domain code, no raw exception text.
    expect(firstTool.rawText).toBe("service_unavailable");

    // DayAgenda already has the booking; the lost confirmed-state write did
    // not roll it back.
    const occupiedAfterFirst = await AGENDA.readOccupied(agendaName);
    expect(occupiedAfterFirst).toEqual(["10:00"]);
    const stateAfterFirst = (await AGENDA.readAgendaState(agendaName)) as {
      bookings: Record<string, { id: string }>;
      idempotency: Record<string, { booking_id: string }>;
    };
    const persistedBookingId = Object.values(stateAfterFirst.bookings)[0]!.id;
    expect(Object.keys(stateAfterFirst.idempotency)).toHaveLength(1);
    expect(
      Object.values(stateAfterFirst.idempotency)[0]!.booking_id,
    ).toBe(persistedBookingId);

    // Conversation aggregate is still "pending" — the confirmed-state write
    // failed so the coordinator kept the original attempt intact.
    const pending = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      attempt_key: string;
      input: { service_id: string; date: string; time: string };
    };
    expect(pending.kind).toBe("pending");
    expect(pending.input.time).toBe("10:00");
    expect(pending.input.date).toBe(TEST_DATE);

    // Retry with changed input (same conversation). The coordinator must
    // resolve the ORIGINAL pending attempt before considering the new
    // input; the executor path uses DayAgenda's idempotency to return the
    // original booking without creating a duplicate.
    const retry = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "11:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        2,
      ),
      ENV as never,
    );
    expect(retry.status).toBe(200);
    const retryTool = await readToolText(retry);
    expect(retryTool.isError).toBe(true);
    expect(retryTool.parsed).toEqual({ error: "conversation_already_booked" });

    // DayAgenda still has exactly one booking — the retry resolved the
    // original attempt via idempotency replay, did not book the new slot.
    const occupiedAfterRetry = await AGENDA.readOccupied(agendaName);
    expect(occupiedAfterRetry).toEqual(["10:00"]);
    const stateAfterRetry = (await AGENDA.readAgendaState(agendaName)) as {
      bookings: Record<string, unknown>;
      idempotency: Record<string, unknown>;
    };
    expect(Object.keys(stateAfterRetry.bookings)).toHaveLength(1);
    expect(Object.keys(stateAfterRetry.idempotency)).toHaveLength(1);
    expect(
      (Object.values(stateAfterRetry.bookings)[0] as { id: string }).id,
    ).toBe(persistedBookingId);

    // Conversation aggregate is now confirmed, locked to the ORIGINAL
    // input (10:00) — the changed input (11:00) was rejected after the
    // original attempt resolved.
    const confirmed = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      attempt_key: string;
      input: { date: string; time: string };
      result: { booking_id: string; date: string; time: string };
    };
    expect(confirmed.kind).toBe("confirmed");
    expect(confirmed.attempt_key).toBe(pending.attempt_key);
    expect(confirmed.input.time).toBe("10:00");
    expect(confirmed.input.date).toBe(TEST_DATE);
    expect(confirmed.result.booking_id).toBe(persistedBookingId);
    expect(confirmed.result.time).toBe("10:00");
  });

  // -------------------------------------------------------------------------
  // 6. Lost RPC response from DayAgenda: DayAgenda.createBooking resolves
  //    successfully (the booking IS persisted), but the fake AGENDA namespace
  //    wrapper awaits that result and then throws once instead of returning
  //    it. This simulates an RPC delivery failure on the wire after the
  //    server-side write completed. ConversationBooking never sees the
  //    success — its executor catches the throw and returns
  //    infrastructure_error, which the coordinator treats as ambiguous and
  //    preserves the pending aggregate. Retry with changed input resolves
  //    the original attempt via DayAgenda idempotency replay, returns
  //    conversation_already_booked, preserves the original booking ID, and
  //    creates no additional booking.
  //
  //    Failure mode: simulated at the fake AGENDA namespace wrapper — the
  //    real DayAgenda runs end-to-end and persists; the wrapper then throws.
  //    DayAgenda's storage and the conversation Actor's storage are both
  //    fake but in-process and serialized.
  // -------------------------------------------------------------------------
  it("lost RPC response from DayAgenda: retry with changed input returns conversation_already_booked preserving the original booking ID", async () => {
    const conversationId = "conv-lost-rpc-6";
    const actorName = createHashActorName(conversationId);
    const agendaName = agendaActorName("main", TEST_DATE);

    // Arm the fake AGENDA namespace so its next createBooking() awaits the
    // real DayAgenda result (which persists the booking) and then throws.
    AGENDA.armNextCreateBookingThrowOnceAfterPersist(agendaName);

    const first = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "10:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        1,
      ),
      ENV as never,
    );
    expect(first.status).toBe(200);
    const firstTool = await readToolText(first);
    expect(firstTool.isError).toBe(true);
    // Generic service_unavailable — no domain code, no raw exception text.
    expect(firstTool.rawText).toBe("service_unavailable");

    // DayAgenda persisted the booking before the wrapper threw; the throw
    // did NOT roll it back.
    const occupiedAfterFirst = await AGENDA.readOccupied(agendaName);
    expect(occupiedAfterFirst).toEqual(["10:00"]);
    const stateAfterFirst = (await AGENDA.readAgendaState(agendaName)) as {
      bookings: Record<string, { id: string }>;
      idempotency: Record<string, { booking_id: string }>;
    };
    const persistedBookingId = Object.values(stateAfterFirst.bookings)[0]!.id;
    expect(Object.keys(stateAfterFirst.idempotency)).toHaveLength(1);
    expect(
      Object.values(stateAfterFirst.idempotency)[0]!.booking_id,
    ).toBe(persistedBookingId);

    // Conversation aggregate is still "pending" with the original attempt —
    // the throw on the executor path is classified as ambiguous by
    // validateExecutorResult, so the coordinator preserves pending and
    // returns infrastructure_error (which the MCP layer surfaces as
    // service_unavailable).
    const pending = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      attempt_key: string;
      input: { service_id: string; date: string; time: string };
    };
    expect(pending.kind).toBe("pending");
    expect(pending.input.time).toBe("10:00");
    expect(pending.input.date).toBe(TEST_DATE);

    // Retry with changed input (same conversation, different time). The
    // coordinator must resolve the ORIGINAL pending attempt with the
    // ORIGINAL attempt_key before considering the new input. This time the
    // AGENDA wrapper returns normally, so DayAgenda's idempotency replay
    // returns the original booking_id without creating a duplicate.
    const retry = await handler.fetch(
      bookingToolCall(
        {
          service_id: "oil_change",
          date: TEST_DATE,
          time: "11:00",
          ...TEST_CUSTOMER_A,
          confirmed: true,
        },
        conversationId,
        2,
      ),
      ENV as never,
    );
    expect(retry.status).toBe(200);
    const retryTool = await readToolText(retry);
    expect(retryTool.isError).toBe(true);
    expect(retryTool.parsed).toEqual({ error: "conversation_already_booked" });

    // DayAgenda still has exactly one booking — the retry resolved the
    // original attempt via idempotency replay, did not book the new slot.
    const occupiedAfterRetry = await AGENDA.readOccupied(agendaName);
    expect(occupiedAfterRetry).toEqual(["10:00"]);
    const stateAfterRetry = (await AGENDA.readAgendaState(agendaName)) as {
      bookings: Record<string, unknown>;
      idempotency: Record<string, unknown>;
    };
    expect(Object.keys(stateAfterRetry.bookings)).toHaveLength(1);
    expect(Object.keys(stateAfterRetry.idempotency)).toHaveLength(1);
    expect(
      (Object.values(stateAfterRetry.bookings)[0] as { id: string }).id,
    ).toBe(persistedBookingId);

    // Conversation aggregate is now confirmed, locked to the ORIGINAL
    // input (10:00) — the changed input (11:00) was rejected because the
    // original attempt resolved to the same booking. The same
    // attempt_key is reused — that is the recovery contract.
    const confirmed = (await CONVERSATION_BOOKING.readAggregate(actorName)) as {
      kind: string;
      attempt_key: string;
      input: { date: string; time: string };
      result: { booking_id: string; date: string; time: string };
    };
    expect(confirmed.kind).toBe("confirmed");
    expect(confirmed.attempt_key).toBe(pending.attempt_key);
    expect(confirmed.input.time).toBe("10:00");
    expect(confirmed.input.date).toBe(TEST_DATE);
    expect(confirmed.result.booking_id).toBe(persistedBookingId);
    expect(confirmed.result.time).toBe("10:00");
  });
});
