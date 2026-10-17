import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import type { AppConfig } from "../src/config";
import { maskPhone } from "../src/logger";

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

type KvMock = { get: ReturnType<typeof vi.fn> };

function validKv(config: unknown): KvMock {
  return { get: vi.fn(async () => config) };
}

function rejectingKv(): KvMock {
  return {
    get: vi.fn(async () => {
      throw new Error("network error");
    }),
  };
}

function webhookReq(body: string | undefined, method = "POST"): Request {
  return new Request("http://x/webhooks/dynamic-variables", {
    method,
    body,
    headers: { "content-type": "application/json" },
  });
}

function initPayload(phone: string): string {
  return JSON.stringify({
    data: {
      event_type: "assistant.initialization",
      payload: {
        telnyx_end_user_target: phone,
        call_control_id: "cc-abc-123",
        assistant_id: "asst-xyz",
      },
    },
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function logEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((call) => call[0])
    .filter((s): s is string => typeof s === "string")
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

function findEvent(name: string): Record<string, unknown> | undefined {
  return logEvents().find((e) => e.event === name);
}

describe("/webhooks/dynamic-variables — shape", () => {
  it("POST with valid config returns full dynamic_variables payload", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000001")),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.booking_enabled).toBe("true");
    expect(body.dynamic_variables.system_status).toBe("ok");
    expect(body.dynamic_variables.today_local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]).toContain(body.dynamic_variables.today_weekday);
    expect(body.dynamic_variables.now_local_time).toMatch(/^\d{2}:\d{2}$/);
    expect(body.dynamic_variables.business_hours).toBe(
      "Monday to Friday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
    );
    expect(body.dynamic_variables.service_list).toBe(
      "Oil Change, Tire Rotation, General Maintenance Service",
    );
  });

  it("config failure → 200 degraded with booking_enabled 'false' and empty service_list", async () => {
    const env = { CONFIG: rejectingKv() };
    const res = await handler.fetch(
      webhookReq(JSON.stringify({ data: { event_type: "x", payload: {} } })),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.booking_enabled).toBe("false");
    expect(body.dynamic_variables.system_status).toBe("degraded");
    expect(body.dynamic_variables.service_list).toBe("");
    expect(body.dynamic_variables.business_hours).toBe("");
  });

  it("invalid JSON → 400", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(webhookReq("not json"), env as never);
    expect(res.status).toBe(400);
  });

  it("GET → 405", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq(undefined, "GET"),
      env as never,
    );
    expect(res.status).toBe(405);
  });

  it("missing payload fields are not an error — still 200", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq(JSON.stringify({ data: {} })),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.system_status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// business_hours announcement — driven by the validated config
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — business_hours announcement", () => {
  it("non-contiguous open_days → comma-separated day names in Monday–Sunday order", async () => {
    const config: AppConfig = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["mon", "wed", "fri"],
      },
    };
    const env = { CONFIG: validKv(config) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000010")),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.business_hours).toBe(
      "Monday, Wednesday, Friday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
    );
  });

  it("input open_days in a different order is presented in Monday–Sunday order", async () => {
    const config: AppConfig = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["fri", "mon", "wed"],
      },
    };
    const env = { CONFIG: validKv(config) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000011")),
      env as never,
    );
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.business_hours).toBe(
      "Monday, Wednesday, Friday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
    );
  });

  it("contiguous weekend range → 'Saturday to Sunday'", async () => {
    const config: AppConfig = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["sat", "sun"],
      },
    };
    const env = { CONFIG: validKv(config) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000012")),
      env as never,
    );
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.business_hours).toBe(
      "Saturday to Sunday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
    );
  });

  it("single weekday → just that day's name", async () => {
    const config: AppConfig = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["wed"],
      },
    };
    const env = { CONFIG: validKv(config) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000013")),
      env as never,
    );
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.business_hours).toBe(
      "Wednesday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
    );
  });

  it("CONFIG binding absent → degraded with empty business_hours", async () => {
    const env = {} as never;
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000014")),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.system_status).toBe("degraded");
    expect(body.dynamic_variables.booking_enabled).toBe("false");
    expect(body.dynamic_variables.business_hours).toBe("");
  });

  it("config with bad open_days is rejected → empty business_hours", async () => {
    const bad: AppConfig = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["mon", "funday"],
      },
    };
    const env = { CONFIG: validKv(bad) };
    const res = await handler.fetch(
      webhookReq(initPayload("+15550000015")),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.system_status).toBe("degraded");
    expect(body.dynamic_variables.booking_enabled).toBe("false");
    expect(body.dynamic_variables.business_hours).toBe("");
  });
});

describe("/webhooks/dynamic-variables — logging", () => {
  it("log line contains masked phone and never the full number", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const fullPhone = "+15550000001";
    await handler.fetch(webhookReq(initPayload(fullPhone)), env as never);
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev).toBeDefined();
    expect(ev!.caller).toBe("***0001");
    expect(JSON.stringify(ev)).not.toContain(fullPhone);
    expect(JSON.stringify(ev)).not.toContain("5550000001");
    expect(ev!.system_status).toBe("ok");
    expect(ev!.booking_enabled).toBe("true");
    expect(ev!.call_control_id).toBe("cc-abc-123");
    expect(ev!.assistant_id).toBe("asst-xyz");
    expect(typeof ev!.latency_ms).toBe("number");
  });
});

describe("maskPhone", () => {
  it("keeps last 4 digits and masks the rest", () => {
    expect(maskPhone("+15550000001")).toBe("***0001");
    expect(maskPhone("5550000001")).toBe("***0001");
    expect(maskPhone("tel:555-000-0001")).toBe("***0001");
  });
  it("handles short and empty input", () => {
    expect(maskPhone("")).toBe("***");
    expect(maskPhone("1")).toBe("***1");
    expect(maskPhone("12")).toBe("***12");
  });
});

describe("/webhooks/dynamic-variables — payload envelope and size", () => {
  it("accepts the event without a data envelope ({payload})", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(
        JSON.stringify({
          event_type: "assistant.initialization",
          payload: {
            telnyx_end_user_target: "+15550000002",
            call_control_id: "cc-no-envelope",
            assistant_id: "asst-1",
          },
        }),
      ),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("cc-no-envelope");
    expect(ev?.caller).toBe("***0002");
  });

  it("rejects a body over 10 KiB with 413 even without Content-Length", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const big = new TextEncoder().encode(
      JSON.stringify({ payload: { pad: "x".repeat(11 * 1024) } }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const req = new Request("http://x/webhooks/dynamic-variables", {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const res = await handler.fetch(req, env as never);
    expect(res.status).toBe(413);
    expect(env.CONFIG.get).not.toHaveBeenCalled();
  });
});

describe("/webhooks/dynamic-variables — bounded KV wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type PendingKv = KvMock & {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };

  function pendingKv(): PendingKv {
    let resolveFn!: (v: unknown) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    return {
      get: vi.fn(() => promise),
      resolve: resolveFn,
      reject: rejectFn,
    };
  }

  function captureUnhandled(): { list: unknown[]; off: () => void } {
    const list: unknown[] = [];
    const handler = (reason: unknown) => {
      list.push(reason);
    };
    process.on("unhandledRejection", handler);
    return {
      list,
      off: () => {
        process.off("unhandledRejection", handler);
      },
    };
  }

  it("config resolves before deadline → uses config and logs config_outcome=ok", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const promise = handler.fetch(
      webhookReq(initPayload("+15550000001")),
      env as never,
    );
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.system_status).toBe("ok");
    expect(body.dynamic_variables.booking_enabled).toBe("true");
    expect(body.dynamic_variables.service_list).toBe(
      "Oil Change, Tire Rotation, General Maintenance Service",
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.config_outcome).toBe("ok");
  });

  it("config never resolves → degraded at the 800ms deadline with empty service_list", async () => {
    const env = { CONFIG: pendingKv() };
    const promise = handler.fetch(
      webhookReq(initPayload("+15550000002")),
      env as never,
    );
    await vi.advanceTimersByTimeAsync(799);
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, string>;
    };
    expect(body.dynamic_variables.system_status).toBe("degraded");
    expect(body.dynamic_variables.booking_enabled).toBe("false");
    expect(body.dynamic_variables.service_list).toBe("");
    expect(body.dynamic_variables.business_hours).toBe("");
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.config_outcome).toBe("timeout");
  });

  it("config resolves after timeout → no second log, no unhandled rejection", async () => {
    const kv = pendingKv();
    const env = { CONFIG: kv };
    const { list, off } = captureUnhandled();
    try {
      const promise = handler.fetch(
        webhookReq(initPayload("+15550000003")),
        env as never,
      );
      await vi.advanceTimersByTimeAsync(800);
      const res = await promise;
      expect(res.status).toBe(200);
      const before = logEvents().filter(
        (e) => e.event === "webhook.dynamic_variables",
      ).length;
      kv.resolve(VALID_CONFIG);
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      const after = logEvents().filter(
        (e) => e.event === "webhook.dynamic_variables",
      ).length;
      expect(after).toBe(before);
      expect(list).toEqual([]);
    } finally {
      off();
    }
  });

  it("config rejects after timeout → no unhandled rejection", async () => {
    const kv = pendingKv();
    const env = { CONFIG: kv };
    const { list, off } = captureUnhandled();
    try {
      const promise = handler.fetch(
        webhookReq(initPayload("+15550000004")),
        env as never,
      );
      await vi.advanceTimersByTimeAsync(800);
      const res = await promise;
      expect(res.status).toBe(200);
      kv.reject(new Error("late kv failure"));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(list).toEqual([]);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// Early rejections — exactly one webhook.rejected log per case, no KV access,
// no request body / phone / call id leaking into the structured log.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — early rejection logging", () => {
  function rejections(): Array<Record<string, unknown>> {
    return logEvents().filter((e) => e.event === "webhook.rejected");
  }

  it("GET → method_not_allowed at 405, Allow header preserved, no KV access", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      new Request("http://x/webhooks/dynamic-variables", { method: "GET" }),
      env as never,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(env.CONFIG.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("method_not_allowed");
    expect(ev.http_status).toBe(405);
    expect(typeof ev.latency_ms).toBe("number");
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("call_control_id");
    expect(serialized).not.toContain("cc-secret-9876");
    expect(serialized).not.toContain("asst-secret");
    expect(serialized).not.toContain("5550001234");
  });

  it("body over 10 KiB → payload_too_large at 413, no KV access", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const big = new TextEncoder().encode(
      JSON.stringify({ payload: { pad: "x".repeat(11 * 1024) } }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const req = new Request("http://x/webhooks/dynamic-variables", {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const res = await handler.fetch(req, env as never);
    expect(res.status).toBe(413);
    expect(env.CONFIG.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("payload_too_large");
    expect(ev.http_status).toBe(413);
    expect(typeof ev.latency_ms).toBe("number");
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("xxxxx");
    expect(serialized).not.toContain("pad");
  });

  it("rejecting body stream → body_read_failed at 400, no KV access", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const req = new Request("http://x/webhooks/dynamic-variables", {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const res = await handler.fetch(req, env as never);
    expect(res.status).toBe(400);
    expect(env.CONFIG.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("body_read_failed");
    expect(ev.http_status).toBe(400);
    expect(typeof ev.latency_ms).toBe("number");
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("connection reset");
    expect(serialized).not.toContain("Error");
    expect(serialized).not.toContain("stack");
  });

  it("invalid JSON → invalid_json at 400, no KV access", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq("not json"),
      env as never,
    );
    expect(res.status).toBe(400);
    expect(env.CONFIG.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("invalid_json");
    expect(ev.http_status).toBe(400);
    expect(typeof ev.latency_ms).toBe("number");
  });

  it("does not log the request body, headers, or unvalidated identifiers", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const sentinels = {
      phone: "+15559990PH0N",
      callerId: "cc-SENTINEL-CALLER",
      assistantId: "asst-SENTINEL-ASSIST",
      auth: "Bearer SENTINEL-AUTH-TOKEN",
      rawBody:
        '{"data":{"payload":{"telnyx_end_user_target":"+15559990PH0N","call_control_id":"cc-SENTINEL-CALLER","assistant_id":"asst-SENTINEL-ASSIST",BROKEN',
    };
    const res = await handler.fetch(
      new Request("http://x/webhooks/dynamic-variables", {
        method: "POST",
        body: sentinels.rawBody,
        headers: {
          "content-type": "application/json",
          "x-call-control-id": "cc-SENTINEL-CALLER",
          authorization: sentinels.auth,
        },
      }),
      env as never,
    );
    expect(res.status).toBe(400);
    expect(env.CONFIG.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]!.reason).toBe("invalid_json");
    const allSerialized = JSON.stringify(logEvents());
    expect(allSerialized).not.toContain(sentinels.phone);
    expect(allSerialized).not.toContain(sentinels.callerId);
    expect(allSerialized).not.toContain(sentinels.assistantId);
    expect(allSerialized).not.toContain(sentinels.auth);
    expect(allSerialized).not.toContain("SENTINEL-AUTH-TOKEN");
    expect(allSerialized).not.toContain(sentinels.rawBody);
    expect(allSerialized).not.toContain("BROKEN");
    expect(allSerialized).not.toContain("telnyx_end_user_target");
  });
});

// ---------------------------------------------------------------------------
// call_control_id / assistant_id validation — only a bounded safe charset
// (^[A-Za-z0-9:_-]{1,128}$) reaches the structured log. Anything else is
// dropped to "" so an unauthenticated webhook payload cannot inject text,
// whitespace, or control bytes into runtime logs.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — id validation", () => {
  function payloadWithIds(
    callControlId: unknown,
    assistantId: unknown,
  ): string {
    return JSON.stringify({
      data: {
        event_type: "assistant.initialization",
        payload: {
          telnyx_end_user_target: "+15550000020",
          call_control_id: callControlId,
          assistant_id: assistantId,
        },
      },
    });
  }

  it("preserves valid ids that match the bounded charset", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds("cc-abc-123", "asst-xyz")),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("cc-abc-123");
    expect(ev?.assistant_id).toBe("asst-xyz");
  });

  it("preserves valid ids at the 128-char boundary", async () => {
    const id128 = "a".repeat(128);
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds(id128, id128)),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe(id128);
    expect(ev?.assistant_id).toBe(id128);
  });

  it("replaces oversized ids (>128 chars) with empty string", async () => {
    const id129 = "a".repeat(129);
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq(payloadWithIds(id129, id129)),
      env as never,
    );
    expect(res.status).toBe(200);
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
    const serialized = JSON.stringify(logEvents());
    expect(serialized).not.toContain(id129);
  });

  it("replaces whitespace and control characters with empty string", async () => {
    const bad = "cc with spaces\ncc\tctrl";
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds(bad, bad)),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
    const serialized = JSON.stringify(logEvents());
    expect(serialized).not.toContain("cc with spaces");
    expect(serialized).not.toContain("cc\tctrl");
  });

  it("replaces email-like values with empty string", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds("attacker@example.com", "asst@evil.com")),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
    const serialized = JSON.stringify(logEvents());
    expect(serialized).not.toContain("attacker@example.com");
    expect(serialized).not.toContain("asst@evil.com");
    expect(serialized).not.toContain("@");
  });

  it("replaces non-string values (number, object) with empty string", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds(12345, { nested: "object" })),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
    const serialized = JSON.stringify(logEvents());
    expect(serialized).not.toContain("nested");
    expect(serialized).not.toContain("object");
  });

  it("replaces null ids with empty string", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(payloadWithIds(null, null)),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
  });

  it("invalid sentinel values appear nowhere in captured logs or response", async () => {
    const sentinels = {
      callControlId: "cc-attacker@evil.com with spaces\nline2",
      assistantId: "asst\u0000null-byte\u0007bell",
    };
    const env = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      webhookReq(payloadWithIds(sentinels.callControlId, sentinels.assistantId)),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dynamic_variables: Record<string, unknown>;
    };
    const responseSerialized = JSON.stringify(body);
    expect(responseSerialized).not.toContain("attacker@evil.com");
    expect(responseSerialized).not.toContain("with spaces");
    expect(responseSerialized).not.toContain("line2");
    expect(responseSerialized).not.toContain("null-byte");
    expect(responseSerialized).not.toContain("bell");

    const allLogs = JSON.stringify(logEvents());
    expect(allLogs).not.toContain("attacker@evil.com");
    expect(allLogs).not.toContain("with spaces");
    expect(allLogs).not.toContain("line2");
    expect(allLogs).not.toContain("null-byte");
    expect(allLogs).not.toContain("bell");
    expect(allLogs).not.toContain("\u0000");
    expect(allLogs).not.toContain("\u0007");
  });

  it("valid request still produces exactly one webhook.dynamic_variables event", async () => {
    const env = { CONFIG: validKv(VALID_CONFIG) };
    await handler.fetch(
      webhookReq(initPayload("+15550000030")),
      env as never,
    );
    const events = logEvents().filter(
      (e) => e.event === "webhook.dynamic_variables",
    );
    expect(events).toHaveLength(1);
  });
});
