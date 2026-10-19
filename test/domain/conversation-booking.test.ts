import { describe, it, expect, vi } from "vitest";

import {
  coordinateBooking,
  type ActorStorageLike,
  type ConversationBookingDeps,
  type ConversationBookingInput,
  type SavedBookingAttempt,
} from "../../src/domain/conversation-booking";
import { createFakeStorage } from "../support/fake-actor-storage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORAGE_KEY = "test-conversation";
const LOCATION_ID = "main";

const VALID_INPUT: ConversationBookingInput = {
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  customer_name: "Maria Lopez",
  customer_phone: "+52 55 1234 5678",
  confirmed: true,
};

const SUCCESS_RESULT = {
  kind: "confirmed" as const,
  booking_id: "b-001",
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
};

type AnyMock = ReturnType<typeof vi.fn>;

function callArg<T>(fn: AnyMock, index: number): T {
  const calls = fn.mock.calls as unknown as unknown[][];
  return calls[index]![0] as T;
}

function makeDeps(overrides?: {
  storage?: ActorStorageLike;
  executeBooking?: AnyMock;
  generateAttemptKey?: AnyMock;
  storageKey?: string;
  locationId?: string;
}) {
  const storage = overrides?.storage ?? createFakeStorage();
  let counter = 0;
  const generateAttemptKey =
    overrides?.generateAttemptKey ??
    vi.fn(() => `attempt-key-${++counter}`);
  const executeBooking =
    overrides?.executeBooking ??
    vi.fn(async () => SUCCESS_RESULT);
  return {
    deps: {
      storage,
      storageKey: overrides?.storageKey ?? STORAGE_KEY,
      generateAttemptKey,
      executeBooking,
      locationId: overrides?.locationId ?? LOCATION_ID,
    } satisfies ConversationBookingDeps,
    storage,
    executeBooking,
    generateAttemptKey,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinateBooking", () => {
  it("success then identical replay returns stored result without calling executor again", async () => {
    const { deps, executeBooking } = makeDeps();

    const r1 = await coordinateBooking(VALID_INPUT, deps);
    expect(r1).toEqual(SUCCESS_RESULT);
    expect(executeBooking).toHaveBeenCalledTimes(1);

    const r2 = await coordinateBooking(VALID_INPUT, deps);
    expect(r2).toEqual(SUCCESS_RESULT);
    expect(executeBooking).toHaveBeenCalledTimes(1);

    const arg = callArg<SavedBookingAttempt>(executeBooking, 0);
    expect(arg.attempt_key).toBe("attempt-key-1");
    expect(arg.location_id).toBe(LOCATION_ID);
    expect(arg.input).toEqual({
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
      customer_name: "Maria Lopez",
      customer_phone: "+52 55 1234 5678",
      confirmed: true,
    });
  });

  it("changed date/time after a confirmed booking returns conversation_already_booked without calling executor", async () => {
    const { deps, executeBooking } = makeDeps();
    await coordinateBooking(VALID_INPUT, deps);

    const changed = { ...VALID_INPUT, date: "2026-10-21", time: "11:00" };
    const r = await coordinateBooking(changed, deps);
    expect(r).toEqual({
      kind: "rejected",
      code: "conversation_already_booked",
    });
    expect(executeBooking).toHaveBeenCalledTimes(1);
  });

  it("definitive rejection persists idle and a corrected attempt is a fresh attempt", async () => {
    let callCount = 0;
    const executor = vi.fn(async (attempt: SavedBookingAttempt) => {
      callCount++;
      if (callCount === 1) {
        return { kind: "rejected" as const, code: "slot_unavailable" as const };
      }
      return {
        kind: "confirmed" as const,
        booking_id: "b-001",
        service_id: attempt.input.service_id,
        date: attempt.input.date,
        time: attempt.input.time,
      };
    });
    const { deps } = makeDeps({ executeBooking: executor });

    const r1 = await coordinateBooking(VALID_INPUT, deps);
    expect(r1).toEqual({ kind: "rejected", code: "slot_unavailable" });
    expect(executor).toHaveBeenCalledTimes(1);

    const corrected = { ...VALID_INPUT, time: "11:00" };
    const r2 = await coordinateBooking(corrected, deps);
    expect(r2).toEqual({
      kind: "confirmed",
      booking_id: "b-001",
      service_id: "oil_change",
      date: "2026-10-20",
      time: "11:00",
    });
    expect(executor).toHaveBeenCalledTimes(2);

    const retryArg = callArg<SavedBookingAttempt>(executor, 1);
    expect(retryArg.input.time).toBe("11:00");
    // Fresh attempt key for the corrected attempt.
    expect(retryArg.attempt_key).toBe("attempt-key-2");
  });

  it("ambiguous failure keeps pending and a changed request resolves the original input", async () => {
    let callCount = 0;
    const executor = vi.fn(async (attempt: SavedBookingAttempt) => {
      callCount++;
      if (callCount === 1) throw new Error("executor timeout");
      return {
        kind: "confirmed" as const,
        booking_id: "b-001",
        service_id: attempt.input.service_id,
        date: attempt.input.date,
        time: attempt.input.time,
      };
    });
    const { deps } = makeDeps({ executeBooking: executor });

    const r1 = await coordinateBooking(VALID_INPUT, deps);
    expect(r1).toEqual({ kind: "infrastructure_error" });
    expect(executor).toHaveBeenCalledTimes(1);

    const changed = { ...VALID_INPUT, time: "11:00" };
    const r2 = await coordinateBooking(changed, deps);
    expect(executor).toHaveBeenCalledTimes(2);

    // The second executor call used the ORIGINAL saved input, not the
    // changed current input — the pending aggregate is resolved first.
    const secondCall = callArg<SavedBookingAttempt>(executor, 1);
    expect(secondCall.input.time).toBe("10:00");
    // The same backend-generated attempt key was reused.
    expect(secondCall.attempt_key).toBe("attempt-key-1");

    // Current input differs from saved input → conversation_already_booked.
    expect(r2).toEqual({
      kind: "rejected",
      code: "conversation_already_booked",
    });
  });

  it("a failed pending write prevents execution entirely", async () => {
    const baseStorage = createFakeStorage();
    const failingPut = vi.fn(async () => {
      throw new Error("storage write failed");
    });
    const storage: ActorStorageLike = {
      get: baseStorage.get,
      put: failingPut,
    };
    const executor = vi.fn(async () => SUCCESS_RESULT);
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).not.toHaveBeenCalled();
    expect(failingPut).toHaveBeenCalledTimes(1);
  });

  it("a failed confirmation write recovers on the next call using the same attempt key", async () => {
    const executor = vi.fn(async () => SUCCESS_RESULT);

    const baseStorage = createFakeStorage();
    const originalPut = baseStorage.put;
    let putCount = 0;
    const conditionalPut = vi.fn(
      async (key: string, value: unknown): Promise<void> => {
        putCount++;
        // Allow the pending write (1st) and the retry confirmed write (3rd).
        // Fail the first confirmed write (2nd).
        if (putCount === 2) {
          throw new Error("confirmed write failed");
        }
        return originalPut(key, value);
      },
    );
    const storage: ActorStorageLike = {
      get: baseStorage.get,
      put: conditionalPut,
    };
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r1 = await coordinateBooking(VALID_INPUT, deps);
    expect(r1).toEqual({ kind: "infrastructure_error" });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(putCount).toBe(2);

    // Storage is still pending with the same attempt_key; retry resolves it.
    const r2 = await coordinateBooking(VALID_INPUT, deps);
    expect(r2).toEqual(SUCCESS_RESULT);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(putCount).toBe(3);

    const firstCall = callArg<SavedBookingAttempt>(executor, 0);
    const secondCall = callArg<SavedBookingAttempt>(executor, 1);
    expect(secondCall.attempt_key).toBe(firstCall.attempt_key);
    expect(secondCall.input).toEqual(firstCall.input);
  });

  it("null stored state fails closed without calling the executor", async () => {
    const storage = createFakeStorage();
    await storage.put(STORAGE_KEY, null);
    const executor = vi.fn(async () => SUCCESS_RESULT);
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("corrupt stored state (missing kind) fails closed without calling the executor", async () => {
    const storage = createFakeStorage();
    await storage.put(STORAGE_KEY, { foo: "bar" });
    const executor = vi.fn(async () => SUCCESS_RESULT);
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Executor result validation regressions.
  // -------------------------------------------------------------------------

  async function readAggregate(storage: ActorStorageLike): Promise<unknown> {
    return await storage.get(STORAGE_KEY);
  }

  it("malformed executor success (empty booking_id) preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(
      async () =>
        ({
          kind: "confirmed" as const,
          booking_id: "",
          service_id: "oil_change",
          date: "2026-10-20",
          time: "10:00",
        }),
    );
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).toHaveBeenCalledTimes(1);

    // Pending was persisted, but no idle/confirmed was ever written.
    const after = (await readAggregate(storage)) as {
      kind: string;
      attempt_key: string;
    };
    expect(after.kind).toBe("pending");
    expect(after.attempt_key).toBe("attempt-key-1");
  });

  it("malformed executor success (service_id mismatch with saved) preserves pending", async () => {
    const executor = vi.fn(
      async () =>
        ({
          kind: "confirmed" as const,
          booking_id: "b-001",
          service_id: "tire_rotation",
          date: "2026-10-20",
          time: "10:00",
        }),
    );
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  it("missing rejection code preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(async () => ({ kind: "rejected" as const }));
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  it("unknown rejection code preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(
      async () =>
        ({
          kind: "rejected" as const,
          code: "mysterious_failure",
        }),
    );
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  it("idempotency_key_conflict from executor preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(
      async () =>
        ({
          kind: "rejected" as const,
          code: "idempotency_key_conflict" as const,
        }),
    );
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as {
      kind: string;
      attempt_key: string;
    };
    expect(after.kind).toBe("pending");
    expect(after.attempt_key).toBe("attempt-key-1");
  });

  it("null executor result preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(async () => null as unknown as typeof SUCCESS_RESULT);
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  it("array executor result preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(async () => [] as unknown as typeof SUCCESS_RESULT);
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  it("executor result with unknown kind preserves pending and returns infrastructure_error", async () => {
    const executor = vi.fn(
      async () =>
        ({
          kind: "exploded" as unknown as "confirmed",
          booking_id: "b-001",
          service_id: "oil_change",
          date: "2026-10-20",
          time: "10:00",
        }),
    );
    const { deps, storage } = makeDeps({ executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });

    const after = (await readAggregate(storage)) as { kind: string };
    expect(after.kind).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Persisted confirmed result mismatches its own saved input.
  // -------------------------------------------------------------------------

  it("persisted confirmed result with mismatched service_id fails closed without calling executor", async () => {
    const storage = createFakeStorage();
    await storage.put(STORAGE_KEY, {
      kind: "confirmed",
      input: {
        service_id: "oil_change",
        date: "2026-10-20",
        time: "10:00",
        customer_name: "Maria Lopez",
        customer_phone: "+52 55 1234 5678",
        confirmed: true,
      },
      attempt_key: "stored-key",
      location_id: LOCATION_ID,
      result: {
        booking_id: "b-stored",
        service_id: "tire_rotation",
        date: "2026-10-20",
        time: "10:00",
      },
    });
    const executor = vi.fn(async () => SUCCESS_RESULT);
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("persisted confirmed result with mismatched time fails closed without calling executor", async () => {
    const storage = createFakeStorage();
    await storage.put(STORAGE_KEY, {
      kind: "confirmed",
      input: {
        service_id: "oil_change",
        date: "2026-10-20",
        time: "10:00",
        customer_name: "Maria Lopez",
        customer_phone: "+52 55 1234 5678",
        confirmed: true,
      },
      attempt_key: "stored-key",
      location_id: LOCATION_ID,
      result: {
        booking_id: "b-stored",
        service_id: "oil_change",
        date: "2026-10-20",
        time: "11:00",
      },
    });
    const executor = vi.fn(async () => SUCCESS_RESULT);
    const { deps } = makeDeps({ storage, executeBooking: executor });

    const r = await coordinateBooking(VALID_INPUT, deps);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(executor).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Pending resolution: definitive rejection + changed current input starts
  // a fresh attempt in the same call with a new key.
  // -------------------------------------------------------------------------

  it("pending rejection with changed input starts a fresh attempt in the same call using a new key", async () => {
    const storage = createFakeStorage();
    const OLD_INPUT = {
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
      customer_name: "Maria Lopez",
      customer_phone: "+52 55 1234 5678",
      confirmed: true,
    };
    await storage.put(STORAGE_KEY, {
      kind: "pending",
      input: OLD_INPUT,
      attempt_key: "old-attempt-key",
      location_id: LOCATION_ID,
    });

    let callCount = 0;
    const executor = vi.fn(async (attempt: SavedBookingAttempt) => {
      callCount++;
      if (callCount === 1) {
        return {
          kind: "rejected" as const,
          code: "slot_unavailable" as const,
        };
      }
      return {
        kind: "confirmed" as const,
        booking_id: "b-001",
        service_id: attempt.input.service_id,
        date: attempt.input.date,
        time: attempt.input.time,
      };
    });
    const { deps } = makeDeps({ storage, executeBooking: executor });

    // Changed current input (time 11:00 vs saved 10:00).
    const changed = { ...VALID_INPUT, time: "11:00" };
    const r = await coordinateBooking(changed, deps);

    expect(executor).toHaveBeenCalledTimes(2);

    // First executor call resolved the OLD pending: original input + key.
    const firstCall = callArg<SavedBookingAttempt>(executor, 0);
    expect(firstCall.input.time).toBe("10:00");
    expect(firstCall.attempt_key).toBe("old-attempt-key");

    // Second executor call was the fresh attempt: current input + new key.
    const secondCall = callArg<SavedBookingAttempt>(executor, 1);
    expect(secondCall.input.time).toBe("11:00");
    expect(secondCall.attempt_key).toBe("attempt-key-1");

    expect(r).toEqual({
      kind: "confirmed",
      booking_id: "b-001",
      service_id: "oil_change",
      date: "2026-10-20",
      time: "11:00",
    });

    // Final storage state is confirmed with the fresh attempt's data.
    const after = (await readAggregate(storage)) as {
      kind: string;
      attempt_key: string;
      input: { time: string };
      result: { booking_id: string };
    };
    expect(after.kind).toBe("confirmed");
    expect(after.attempt_key).toBe("attempt-key-1");
    expect(after.input.time).toBe("11:00");
    expect(after.result.booking_id).toBe("b-001");
  });

  it("pending rejection with same input persists idle and returns the rejection without a second call", async () => {
    const storage = createFakeStorage();
    const OLD_INPUT = {
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
      customer_name: "Maria Lopez",
      customer_phone: "+52 55 1234 5678",
      confirmed: true,
    };
    await storage.put(STORAGE_KEY, {
      kind: "pending",
      input: OLD_INPUT,
      attempt_key: "old-attempt-key",
      location_id: LOCATION_ID,
    });

    const executor = vi.fn(
      async () =>
        ({ kind: "rejected" as const, code: "slot_unavailable" as const }),
    );
    const { deps } = makeDeps({ storage, executeBooking: executor });

    // Same input as the saved pending.
    const r = await coordinateBooking(VALID_INPUT, deps);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ kind: "rejected", code: "slot_unavailable" });

    // Storage was transitioned to idle.
    const after = await readAggregate(storage);
    expect(after).toEqual({ kind: "idle" });
  });

  it("pending rejection with changed input but failed idle write does NOT execute the new attempt", async () => {
    const storage = createFakeStorage();
    const OLD_INPUT = {
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
      customer_name: "Maria Lopez",
      customer_phone: "+52 55 1234 5678",
      confirmed: true,
    };
    await storage.put(STORAGE_KEY, {
      kind: "pending",
      input: OLD_INPUT,
      attempt_key: "old-attempt-key",
      location_id: LOCATION_ID,
    });

    const originalPut = storage.put;
    let putCount = 0;
    const conditionalPut = vi.fn(
      async (key: string, value: unknown): Promise<void> => {
        putCount++;
        // The first put was the pre-population (handled before wrapping).
        // The second put (idle write) must fail. Any further puts also fail.
        if (putCount >= 2) {
          throw new Error("idle write failed");
        }
        return originalPut(key, value);
      },
    );
    const wrappedStorage: ActorStorageLike = {
      get: storage.get,
      put: conditionalPut,
    };

    const executor = vi.fn(
      async () =>
        ({ kind: "rejected" as const, code: "slot_unavailable" as const }),
    );
    const { deps } = makeDeps({
      storage: wrappedStorage,
      executeBooking: executor,
    });

    const changed = { ...VALID_INPUT, time: "11:00" };
    const r = await coordinateBooking(changed, deps);

    expect(r).toEqual({ kind: "infrastructure_error" });
    // Executor called exactly once — the fresh attempt was NOT executed.
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
