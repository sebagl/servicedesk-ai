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

import { DayCallbacks } from "../../src/actors/day-callbacks";
import { callbacksActorName } from "../../src/domain/business-rules";
import { addDays, getLocalDateString } from "../../src/domain/scheduling";
import { createFakeStorage } from "../support/fake-actor-storage";

const CALLBACK_DATE = "2026-10-20";

function entry(opts: { id?: string; conversation_id?: string; created_at?: string } = {}) {
  return {
    id: opts.id ?? "req-1",
    conversation_id: opts.conversation_id ?? "conv-1",
    customer_name: "Alice",
    customer_phone: "+5215512345678",
    reason: "pricing",
    created_at: opts.created_at ?? "2026-10-20T10:00:00.000Z",
  };
}

function makeActor(storage: ReturnType<typeof createFakeStorage>): DayCallbacks {
  const actor = new DayCallbacks({ storage } as never, {} as never);
  return actor;
}

describe("DayCallbacks.listCallbacks", () => {
  it("returns [] when the queue key is absent", async () => {
    const storage = createFakeStorage();
    const actor = makeActor(storage);
    expect(await actor.listCallbacks()).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("returns persisted entries in stored (newest-first) order", async () => {
    const storage = createFakeStorage();
    const queue = [entry({ id: "req-1", created_at: "2026-10-20T10:00:00.000Z" }), entry({ id: "req-2", created_at: "2026-10-20T09:00:00.000Z" })];
    await storage.put("queue", queue);
    const actor = makeActor(storage);
    const out = await actor.listCallbacks();
    expect(out.map((e) => e.id)).toEqual(["req-1", "req-2"]);
  });

  it("storage read failure throws (HTTP layer maps to 503)", async () => {
    const storage = createFakeStorage();
    storage.get.mockRejectedValueOnce(new Error("read failed"));
    const actor = makeActor(storage);
    await expect(actor.listCallbacks()).rejects.toThrow();
  });

  it("malformed aggregate throws", async () => {
    const storage = createFakeStorage();
    await storage.put("queue", "not an array");
    const actor = makeActor(storage);
    await expect(actor.listCallbacks()).rejects.toThrow();
  });

  it("malformed entry throws", async () => {
    const storage = createFakeStorage();
    await storage.put("queue", [{ id: "req-1" }]);
    const actor = makeActor(storage);
    await expect(actor.listCallbacks()).rejects.toThrow();
  });
});

describe("DayCallbacks.requestCallback", () => {
  it("first call records a new entry, returns its id and created_at", async () => {
    const storage = createFakeStorage();
    const actor = makeActor(storage);
    const result = await actor.requestCallback({
      conversation_id: "conv-1",
      customer_name: "Alice",
      customer_phone: "+5215512345678",
      reason: "pricing",
    });
    expect(typeof result.request_id).toBe("string");
    expect(result.request_id.length).toBeGreaterThan(0);
    expect(typeof result.created_at).toBe("string");
    const stored = await storage.get("queue");
    expect(stored).toHaveLength(1);
  });

  it("same conversation inside the same day is idempotent (returns original entry)", async () => {
    const storage = createFakeStorage();
    const actor = makeActor(storage);
    const a = await actor.requestCallback({
      conversation_id: "conv-replay",
      customer_name: "Alice",
      customer_phone: "+5215512345678",
      reason: "pricing",
    });
    const b = await actor.requestCallback({
      conversation_id: "conv-replay",
      customer_name: "Alice",
      customer_phone: "+5215512345678",
      reason: "pricing",
    });
    expect(b.request_id).toBe(a.request_id);
    expect(b.created_at).toBe(a.created_at);
    const stored = (await storage.get("queue")) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it("newest entry is stored first (newest-first ordering)", async () => {
    const storage = createFakeStorage();
    const actor = makeActor(storage);
    await actor.requestCallback({
      conversation_id: "conv-A",
      customer_name: "A",
      customer_phone: "+5215500000001",
      reason: "first",
    });
    await actor.requestCallback({
      conversation_id: "conv-B",
      customer_name: "B",
      customer_phone: "+5215500000002",
      reason: "second",
    });
    const stored = (await storage.get("queue")) as Array<{ conversation_id: string }>;
    expect(stored.map((e) => e.conversation_id)).toEqual(["conv-B", "conv-A"]);
  });

  it("caps the queue at 200 entries (oldest dropped)", async () => {
    const storage = createFakeStorage();
    const actor = makeActor(storage);
    for (let i = 0; i < 205; i++) {
      await actor.requestCallback({
        conversation_id: `conv-${i}`,
        customer_name: "x",
        customer_phone: "+5215500000000",
        reason: "bulk",
      });
    }
    const stored = (await storage.get("queue")) as Array<{ conversation_id: string }>;
    expect(stored).toHaveLength(200);
    expect(stored[0]!.conversation_id).toBe("conv-204");
    expect(stored[199]!.conversation_id).toBe("conv-5");
  });

  it("storage write failure throws", async () => {
    const storage = createFakeStorage();
    storage.put.mockRejectedValueOnce(new Error("write failed"));
    const actor = makeActor(storage);
    await expect(
      actor.requestCallback({
        conversation_id: "conv-1",
        customer_name: "x",
        customer_phone: "+5215500000000",
        reason: "y",
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-day naming contract — exercised end-to-end through the request_callback
// tool and the /demo/callbacks listing merge.
// ---------------------------------------------------------------------------

import handler from "../../src/index";
import { __resetMcpTokenCacheForTests } from "../../src/index";

beforeEach(() => {
  __resetMcpTokenCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MCP_TOKEN = "mcp-test-token-value";

function mcpCall(args: unknown, conversationId: string): Request {
  return new Request("http://x/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "request_callback",
        arguments: args,
        _meta: { telnyx_conversation_id: conversationId },
      },
    }),
  });
}

function smokeCallbacks(): Request {
  return new Request("http://x/demo/callbacks", {
    headers: { authorization: "Bearer smoke-token" },
  });
}

describe("per-day DayCallbacks routing", () => {
  it("a callback recorded today lands in callbacks-<today>", async () => {
    const today = getLocalDateString(Date.now());
    const writeStubs = new Map<string, { requestCallback: ReturnType<typeof vi.fn>; stored: unknown[] }>();
    function stubFor(name: string) {
      let s = writeStubs.get(name);
      if (s === undefined) {
        const stored: unknown[] = [];
        const requestCallback = vi.fn(async (input: { conversation_id: string }) => {
          const e = {
            id: `id-${stored.length + 1}`,
            conversation_id: input.conversation_id,
            customer_name: "Alice",
            customer_phone: "+5215512345678",
            reason: "pricing",
            created_at: new Date(Date.now() + stored.length).toISOString(),
          };
          stored.unshift(e);
          return { request_id: e.id, created_at: e.created_at };
        });
        s = { requestCallback, stored };
        writeStubs.set(name, s);
      }
      return s;
    }
    const idFromName = vi.fn((name: string) => ({
      requestCallback: stubFor(name).requestCallback,
      listCallbacks: vi.fn(async () => stubFor(name).stored),
    }));

    const res = await handler.fetch(
      mcpCall({ customer_name: "Alice", customer_phone: "+5215512345678", reason: "pricing" }, "conv-per-day-1"),
      { SECRETS: { get: vi.fn(async (b: string) => (b === "MCP_AUTH" ? MCP_TOKEN : "")) }, DAY_CALLBACKS: { idFromName } } as never,
    );
    expect(res.status).toBe(200);
    const calledNames = idFromName.mock.calls.map((c) => c[0]);
    expect(calledNames).toContain(callbacksActorName(today));
    // The today's stub received exactly one entry.
    expect(stubFor(callbacksActorName(today)).stored).toHaveLength(1);
  });

  it("7-day listing merges days newest first across the last 7 actors", async () => {
    const today = getLocalDateString(Date.now());
    const yesterday = addDays(today, -1);
    const twoDaysAgo = addDays(today, -2);
    const stubsByName: Record<string, { listCallbacks: ReturnType<typeof vi.fn> }> = {};
    function ensureStub(name: string, entries: unknown[]) {
      stubsByName[name] = {
        listCallbacks: vi.fn(async () => entries),
      };
    }
    ensureStub(callbacksActorName(today), [
      { id: "a", conversation_id: "c1", customer_name: "A", customer_phone: "+5215500000001", reason: "r1", created_at: "2026-10-20T10:00:00.000Z" },
    ]);
    ensureStub(callbacksActorName(yesterday), [
      { id: "b", conversation_id: "c2", customer_name: "B", customer_phone: "+5215500000002", reason: "r2", created_at: "2026-10-19T11:00:00.000Z" },
    ]);
    ensureStub(callbacksActorName(twoDaysAgo), [
      { id: "c", conversation_id: "c3", customer_name: "C", customer_phone: "+5215500000003", reason: "r3", created_at: "2026-10-18T12:00:00.000Z" },
    ]);
    const idFromName = vi.fn((name: string) => {
      const s = stubsByName[name];
      if (s !== undefined) return s;
      return { listCallbacks: vi.fn(async () => []) };
    });
    const res = await handler.fetch(
      smokeCallbacks(),
      { SECRETS: { get: vi.fn(async (b: string) => (b === "SMOKE_AUTH" ? "smoke-token" : "")) }, DAY_CALLBACKS: { idFromName } } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { callbacks: Array<{ id: string; created_at: string }> };
    // The three populated days come back in newest-first order.
    expect(body.callbacks.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(body.callbacks.map((c) => c.created_at)).toEqual([
      "2026-10-20T10:00:00.000Z",
      "2026-10-19T11:00:00.000Z",
      "2026-10-18T12:00:00.000Z",
    ]);
    // Exactly 7 actor lookups, one per local day.
    expect(idFromName).toHaveBeenCalledTimes(7);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: 7 }, (_, i) => callbacksActorName(addDays(today, -i))),
    );
  });

  it("different days produce independent entries (no cross-day idempotency)", async () => {
    const today = CALLBACK_DATE;
    const tomorrow = addDays(today, 1);
    const stubsByName: Record<string, { requestCallback: ReturnType<typeof vi.fn> }> = {};
    function ensureStub(name: string) {
      if (stubsByName[name] !== undefined) return stubsByName[name];
      const stored: unknown[] = [];
      const requestCallback = vi.fn(async (input: { conversation_id: string }) => {
        const e = {
          id: `${name}-${stored.length + 1}`,
          conversation_id: input.conversation_id,
          customer_name: "Alice",
          customer_phone: "+5215512345678",
          reason: "pricing",
          created_at: "2026-10-20T10:00:00.000Z",
        };
        stored.unshift(e);
        return { request_id: e.id, created_at: e.created_at };
      });
      stubsByName[name] = { requestCallback };
      return stubsByName[name];
    }
    const idFromName = vi.fn((name: string) => ensureStub(name));
    const env = { SECRETS: { get: vi.fn(async () => MCP_TOKEN) }, DAY_CALLBACKS: { idFromName } };
    // Pin Date.now() so getLocalDateString returns CALLBACK_DATE.
    const realNow = Date.now;
    const target = new Date(`${today}T15:00:00Z`).getTime();
    Date.now = () => target;
    try {
      // First request — recorded on CALLBACK_DATE.
      const r1 = await handler.fetch(mcpCall({ customer_name: "Alice", customer_phone: "+5215512345678", reason: "pricing" }, "conv-cross-day"), env as never);
      const id1 = JSON.parse(((await r1.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).request_id;
      // Second request one day later — recorded on the next day, distinct request_id.
      Date.now = () => target + 24 * 60 * 60 * 1000;
      const r2 = await handler.fetch(mcpCall({ customer_name: "Alice", customer_phone: "+5215512345678", reason: "pricing" }, "conv-cross-day"), env as never);
      const id2 = JSON.parse(((await r2.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).request_id;
      expect(id1).not.toBe(id2);
      expect(idFromName).toHaveBeenCalledWith(callbacksActorName(today));
      expect(idFromName).toHaveBeenCalledWith(callbacksActorName(tomorrow));
    } finally {
      Date.now = realNow;
    }
  });
});
