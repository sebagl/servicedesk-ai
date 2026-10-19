import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler, { __resetMcpTokenCacheForTests } from "../../src/index";
import { Metrics } from "../../src/actors/metrics";
import { recordMetric, metricsActorName } from "../../src/observability/metrics";
import type { MetricsNamespace } from "../../src/actors/bindings";
import { getLocalDateString } from "../../src/domain/scheduling";
import { __resetWebhookKeyCacheForTests } from "../../src/http/routes/dynamic-variables";
import type { AppConfig } from "../../src/domain/config";
import { createFakeStorage } from "../support/fake-actor-storage";

const MCP_TOKEN = "mcp-test-token-value";
const CUSTOMER_NAME = "Alice Smith";
const CUSTOMER_PHONE = "+5215512345678";

const VALID_CONFIG: AppConfig = {
  services: [{ id: "oil_change", name: "Oil Change", duration_minutes: 60 }],
  business: {
    location_id: "main",
    timezone: "America/Mexico_City",
    open_days: ["mon", "tue", "wed", "thu", "fri"],
    slot_hours: { start: "09:00", end: "17:00", last_start: "16:00" },
    booking_window_days: 7,
    booking_enabled: true,
  },
};

function makeActor(): { actor: Metrics; storage: ReturnType<typeof createFakeStorage> } {
  const storage = createFakeStorage();
  const actor = new Metrics({} as never, {} as never);
  (actor as unknown as { ctx: unknown }).ctx = { storage: { get: storage.get, put: storage.put } };
  return { actor, storage };
}

function throwingMetrics(): MetricsNamespace {
  return {
    idFromName: () => ({
      record: vi.fn(async () => {
        throw new Error("metrics down");
      }),
      snapshot: vi.fn(),
    }),
  } as unknown as MetricsNamespace;
}

function hangingMetrics(): MetricsNamespace {
  return {
    idFromName: () => ({
      record: vi.fn(() => new Promise<void>(() => {})),
      snapshot: vi.fn(),
    }),
  } as unknown as MetricsNamespace;
}

function capturingMetrics() {
  const record = vi.fn(async (_input: unknown) => {});
  const idFromName = vi.fn(() => ({ record, snapshot: vi.fn() }));
  return { ns: { idFromName } as unknown as MetricsNamespace, record, idFromName };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  __resetMcpTokenCacheForTests();
  __resetWebhookKeyCacheForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Metrics actor", () => {
  it("aggregates counters, latency, conversation sets and recent events", async () => {
    const { actor } = makeActor();
    await actor.record({ event: "mcp.get_availability", outcome: "ok", latency_ms: 10, telnyx_conversation_id: "c1" });
    await actor.record({ event: "mcp.get_availability", outcome: "ok", latency_ms: 30, telnyx_conversation_id: "c1" });
    await actor.record({ event: "mcp.create_booking", outcome: "slot_unavailable", latency_ms: 5, telnyx_conversation_id: "c1" });
    await actor.record({ event: "mcp.create_booking", outcome: "ok", latency_ms: 7, telnyx_conversation_id: "c2" });
    await actor.record({ event: "callback", outcome: "requested" });

    const s = await actor.snapshot();
    expect(s.counters).toEqual({
      "mcp.get_availability.ok": 2,
      "mcp.create_booking.slot_unavailable": 1,
      "mcp.create_booking.ok": 1,
      "callback.requested": 1,
    });
    expect(s.latency["mcp.get_availability"]).toEqual({ sum: 40, count: 2 });
    expect(s.latency.callback).toBeUndefined();
    expect(s.availability_conversations).toEqual(["c1"]);
    expect(s.booked_conversations).toEqual(["c2"]);
    expect(s.recent).toHaveLength(5);
    expect(s.recent[0]).toMatchObject({ event: "callback", outcome: "requested" });
  });

  it("caps recent events at 50 (newest first) and conversation sets at 500", async () => {
    const { actor } = makeActor();
    for (let i = 0; i < 510; i++) {
      await actor.record({ event: "mcp.get_availability", outcome: "ok", telnyx_conversation_id: `c${i}` });
    }
    const s = await actor.snapshot();
    expect(s.recent).toHaveLength(50);
    expect(s.recent[0]!.telnyx_conversation_id).toBe("c509");
    expect(s.availability_conversations).toHaveLength(500);
    expect(s.availability_conversations[0]).toBe("c10");
  });

  it("empty actor snapshots to zeros", async () => {
    const { actor } = makeActor();
    expect(await actor.snapshot()).toEqual({
      counters: {},
      latency: {},
      availability_conversations: [],
      booked_conversations: [],
      recent: [],
    });
  });

  it("rejects labels outside the allowed charset and never persists extra fields", async () => {
    const { actor, storage } = makeActor();
    await expect(actor.record({ event: "bad event\n", outcome: "ok" })).rejects.toThrow();
    await actor.record({
      event: "mcp.create_booking",
      outcome: "ok",
      customer_name: CUSTOMER_NAME,
      customer_phone: CUSTOMER_PHONE,
    } as never);
    const persisted = JSON.stringify(storage.put.mock.calls);
    expect(persisted).not.toContain(CUSTOMER_NAME);
    expect(persisted).not.toContain("5512345678");
  });
});

describe("recordMetric — best effort", () => {
  it("routes to the local-day actor name", async () => {
    const { ns, idFromName, record } = capturingMetrics();
    await recordMetric(ns, { event: "webhook", outcome: "ok", latency_ms: 3 });
    expect(idFromName).toHaveBeenCalledWith(metricsActorName(getLocalDateString(Date.now())));
    expect(record).toHaveBeenCalledWith({ event: "webhook", outcome: "ok", latency_ms: 3 });
  });

  it("missing binding, throwing actor and hanging actor all resolve", async () => {
    await expect(recordMetric(undefined, { event: "webhook", outcome: "ok" })).resolves.toBeUndefined();
    await expect(recordMetric(throwingMetrics(), { event: "webhook", outcome: "ok" })).resolves.toBeUndefined();
    const start = Date.now();
    await expect(recordMetric(hangingMetrics(), { event: "webhook", outcome: "ok" })).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

function mcpCall(name: string, args: unknown, conversationId?: string): Request {
  const params: Record<string, unknown> = { name, arguments: args };
  if (conversationId !== undefined) params._meta = { telnyx_conversation_id: conversationId };
  return new Request("http://x/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });
}

function mcpEnv(metrics?: MetricsNamespace, extra: Record<string, unknown> = {}): never {
  return {
    SECRETS: { get: vi.fn(async (b: string) => (b === "MCP_AUTH" ? MCP_TOKEN : "")) },
    CONFIG: { get: vi.fn(async () => VALID_CONFIG) },
    METRICS: metrics,
    ...extra,
  } as never;
}

describe("MCP tool results are unaffected by metrics failures", () => {
  const dayCallbacks = () => ({
    idFromName: () => ({
      requestCallback: vi.fn(async () => ({ request_id: "req-1", created_at: "2026-10-18T10:00:00.000Z" })),
    }),
  });

  for (const [label, factory] of [
    ["throwing", throwingMetrics],
    ["hanging", hangingMetrics],
  ] as const) {
    it(`get_service_catalog with ${label} metrics returns the same body`, async () => {
      const baseline = await (await handler.fetch(mcpCall("get_service_catalog", {}), mcpEnv())).json();
      const res = await handler.fetch(mcpCall("get_service_catalog", {}), mcpEnv(factory()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(baseline);
    });

    it(`request_callback with ${label} metrics still records`, async () => {
      const args = { customer_name: CUSTOMER_NAME, customer_phone: CUSTOMER_PHONE, reason: "pricing" };
      const res = await handler.fetch(
        mcpCall("request_callback", args, "conv-1"),
        mcpEnv(factory(), { DAY_CALLBACKS: dayCallbacks() }),
      );
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(body.result.content[0]!.text)).toEqual({ status: "recorded", request_id: "req-1" });
    });
  }

  it("records tool outcomes and callback.requested without customer data", async () => {
    const { ns, record } = capturingMetrics();
    const args = { customer_name: CUSTOMER_NAME, customer_phone: CUSTOMER_PHONE, reason: "pricing" };
    await handler.fetch(mcpCall("request_callback", args, "conv-1"), mcpEnv(ns, { DAY_CALLBACKS: dayCallbacks() }));
    const inputs = record.mock.calls.map((c) => c[0]);
    expect(inputs).toContainEqual({ event: "callback", outcome: "requested", telnyx_conversation_id: "conv-1" });
    expect(inputs).toContainEqual(
      expect.objectContaining({ event: "mcp.request_callback", outcome: "ok", telnyx_conversation_id: "conv-1" }),
    );
    const serialized = JSON.stringify(inputs) + logs.join("\n");
    expect(serialized).not.toContain(CUSTOMER_NAME);
    expect(serialized).not.toContain(CUSTOMER_PHONE);
  });
});

describe("webhook results are unaffected by metrics failures", () => {
  async function signedWebhook(body: string): Promise<{ req: Request; key: string }> {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(`${ts}|${body}`)),
    );
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    return {
      key: b64(raw),
      req: new Request("http://x/webhooks/dynamic-variables", {
        method: "POST",
        headers: { "content-type": "application/json", "telnyx-timestamp": ts, "telnyx-signature-ed25519": b64(sig) },
        body,
      }),
    };
  }

  function webhookEnv(key: string, metrics?: MetricsNamespace): never {
    return {
      SECRETS: { get: vi.fn(async () => key) },
      CONFIG: { get: vi.fn(async () => VALID_CONFIG) },
      METRICS: metrics,
    } as never;
  }

  it("signed delivery returns ok variables with a throwing or hanging Metrics actor", async () => {
    for (const metrics of [throwingMetrics(), hangingMetrics()]) {
      __resetWebhookKeyCacheForTests();
      const { req, key } = await signedWebhook(JSON.stringify({ data: { payload: {} } }));
      const res = await handler.fetch(req, webhookEnv(key, metrics));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dynamic_variables: Record<string, string> };
      expect(body.dynamic_variables.system_status).toBe("ok");
      expect(body.dynamic_variables.booking_enabled).toBe("true");
    }
  });

  it("records webhook.ok on success and webhook.rejected on a bad method", async () => {
    const { ns, record } = capturingMetrics();
    const { req, key } = await signedWebhook(JSON.stringify({ data: { payload: {} } }));
    await handler.fetch(req, webhookEnv(key, ns));
    const rejected = await handler.fetch(
      new Request("http://x/webhooks/dynamic-variables", { method: "GET" }),
      webhookEnv(key, throwingMetrics()),
    );
    expect(rejected.status).toBe(405);
    await handler.fetch(new Request("http://x/webhooks/dynamic-variables", { method: "GET" }), webhookEnv(key, ns));
    const outcomes = record.mock.calls.map((c) => (c[0] as { event: string; outcome: string }).outcome);
    expect(outcomes).toEqual(["ok", "rejected"]);
  });
});
