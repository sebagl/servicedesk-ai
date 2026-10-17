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
