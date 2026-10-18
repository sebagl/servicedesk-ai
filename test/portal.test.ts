import { describe, it, expect, vi } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import { DayAgenda } from "../src/agenda-actor";
import { computeKpis, summarizeObservability, type DayBookings } from "../src/portal";
import { emptySnapshot, type MetricsSnapshot } from "../src/metrics-actor";
import { addDays, getLocalDateString } from "../src/scheduling";
import type { AppConfig } from "../src/config";

const PORTAL_TOKEN = "portal-test-token-value";
const API_PATHS = ["/api/appointments", "/api/kpis", "/api/observability"] as const;

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

function booking(time: string, phone: string) {
  return {
    time,
    service_id: "oil_change",
    customer_name: `Name ${phone}`,
    customer_phone: phone,
    created_at: "2026-10-18T10:00:00.000Z",
  };
}

function snapshot(partial: Partial<MetricsSnapshot>): MetricsSnapshot {
  return { ...emptySnapshot(), ...partial };
}

function makeEnv(opts: { secret?: string | null; metrics?: Record<string, MetricsSnapshot> } = {}) {
  const today = getLocalDateString(Date.now());
  const agendaByName: Record<string, unknown[]> = {
    [`main-${today}`]: [booking("09:00", "+5215500000001")],
    [`main-${addDays(today, 2)}`]: [booking("11:00", "+5215500000002")],
  };
  const listBookings = vi.fn();
  const agenda = {
    idFromName: vi.fn((name: string) => ({
      listBookings: vi.fn(async () => {
        listBookings(name);
        return { bookings: agendaByName[name] ?? [] };
      }),
    })),
  };
  const listCallbacks = vi.fn(async () => [
    {
      id: "cb-1",
      conversation_id: "conv-9",
      customer_name: "Bob",
      customer_phone: "+5215599999999",
      reason: "pricing",
      created_at: "2026-10-18T09:00:00.000Z",
    },
  ]);
  const callbackQueue = { idFromName: vi.fn(() => ({ listCallbacks })) };
  const metricsByName = opts.metrics ?? {};
  const metrics = {
    idFromName: vi.fn((name: string) => ({
      record: vi.fn(),
      snapshot: vi.fn(async () => metricsByName[name] ?? emptySnapshot()),
    })),
  };
  const kv = { get: vi.fn(async () => VALID_CONFIG) };
  const secret = opts.secret === undefined ? PORTAL_TOKEN : opts.secret;
  const secrets = {
    get: vi.fn(async (b: string) => {
      if (b !== "PORTAL_AUTH") throw new Error("unexpected binding");
      if (secret === null) throw new Error("missing");
      return secret;
    }),
  };
  return {
    env: { SECRETS: secrets, CONFIG: kv, AGENDA: agenda, CALLBACK_QUEUE: callbackQueue, METRICS: metrics },
    agenda,
    callbackQueue,
    metrics,
    kv,
    listBookings,
  };
}

function get(path: string, token?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(`http://x${path}`, { method, headers });
}

describe("/api/* — PORTAL_AUTH gate", () => {
  for (const path of API_PATHS) {
    it(`${path}: missing secret → 503, no actor or KV call`, async () => {
      const m = makeEnv({ secret: null });
      const res = await handler.fetch(get(path, PORTAL_TOKEN), m.env as never);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "service_unavailable" });
      expect(m.agenda.idFromName).not.toHaveBeenCalled();
      expect(m.metrics.idFromName).not.toHaveBeenCalled();
      expect(m.callbackQueue.idFromName).not.toHaveBeenCalled();
      expect(m.kv.get).not.toHaveBeenCalled();
    });

    it(`${path}: missing or wrong bearer → 401, no actor or KV call`, async () => {
      for (const token of [undefined, "wrong-token"]) {
        const m = makeEnv();
        const res = await handler.fetch(get(path, token), m.env as never);
        expect(res.status).toBe(401);
        expect(m.agenda.idFromName).not.toHaveBeenCalled();
        expect(m.metrics.idFromName).not.toHaveBeenCalled();
        expect(m.callbackQueue.idFromName).not.toHaveBeenCalled();
        expect(m.kv.get).not.toHaveBeenCalled();
      }
    });

    it(`${path}: wrong method → 405`, async () => {
      const m = makeEnv();
      const res = await handler.fetch(get(path, PORTAL_TOKEN, "POST"), m.env as never);
      expect(res.status).toBe(405);
    });
  }

  it("other bearer tokens are not accepted", async () => {
    const m = makeEnv();
    const res = await handler.fetch(get("/api/kpis", "test-smoke-token-value"), m.env as never);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/appointments", () => {
  it("fans out to the 7 known DayAgenda names and returns bookings + callbacks", async () => {
    const m = makeEnv();
    const res = await handler.fetch(get("/api/appointments", PORTAL_TOKEN), m.env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timezone: string; days: DayBookings[]; callbacks: unknown[] };
    const today = getLocalDateString(Date.now());
    expect(body.timezone).toBe("America/Mexico_City");
    expect(body.days.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(today, i)));
    expect(m.listBookings.mock.calls.map((c) => c[0])).toEqual(body.days.map((d) => `main-${d.date}`));
    expect(body.days[0]!.bookings[0]).toEqual(booking("09:00", "+5215500000001"));
    expect(body.callbacks).toEqual([
      {
        id: "cb-1",
        created_at: "2026-10-18T09:00:00.000Z",
        customer_name: "Bob",
        customer_phone: "+5215599999999",
        reason: "pricing",
      },
    ]);
  });

  it("actor failure → 503 with a generic body", async () => {
    const m = makeEnv();
    m.callbackQueue.idFromName.mockImplementation(() => {
      throw new Error("boom detail");
    });
    const res = await handler.fetch(get("/api/appointments", PORTAL_TOKEN), m.env as never);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("boom");
  });
});

describe("KPI math", () => {
  it("computes follow-up KPIs from fixed fixtures", () => {
    const snapshots = [
      snapshot({
        availability_conversations: ["a", "b", "c"],
        booked_conversations: ["a"],
        counters: {
          "mcp.create_booking.slot_unavailable": 2,
          "mcp.create_booking.date_not_open": 1,
          "mcp.create_booking.ok": 5,
          "mcp.create_booking.confirmation_required": 4,
        },
      }),
      snapshot({
        availability_conversations: ["c", "d"],
        booked_conversations: ["d", "e"],
        counters: { "mcp.create_booking.time_invalid": 1 },
      }),
    ];
    const days: DayBookings[] = [
      { date: "2026-10-19", bookings: [booking("09:00", "+1"), booking("10:00", "+2")] },
      { date: "2026-10-20", bookings: [booking("09:00", " +1 ")] },
    ];
    expect(computeKpis(snapshots, days, 3)).toEqual({
      checked_availability_not_booked: 2, // b, c
      unserved_requests: 4,
      pending_callbacks: 3,
      follow_up_opportunities: 9,
      upcoming_maintenance_reminders: 2,
      bookings_confirmed_7d: 3, // a, d, e
    });
  });

  it("is all zeros with no data", () => {
    expect(computeKpis([emptySnapshot()], [], 0)).toEqual({
      checked_availability_not_booked: 0,
      unserved_requests: 0,
      pending_callbacks: 0,
      follow_up_opportunities: 0,
      upcoming_maintenance_reminders: 0,
      bookings_confirmed_7d: 0,
    });
  });

  it("GET /api/kpis reads the last 7 daily Metrics actors", async () => {
    const today = getLocalDateString(Date.now());
    const m = makeEnv({
      metrics: {
        [`metrics-${today}`]: snapshot({ availability_conversations: ["x", "y"], booked_conversations: ["x"] }),
        [`metrics-${addDays(today, -6)}`]: snapshot({ counters: { "mcp.create_booking.slot_unavailable": 2 } }),
        [`metrics-${addDays(today, -7)}`]: snapshot({ counters: { "mcp.create_booking.slot_unavailable": 50 } }),
      },
    });
    const res = await handler.fetch(get("/api/kpis", PORTAL_TOKEN), m.env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window_days: number; kpis: Record<string, number> };
    expect(m.metrics.idFromName.mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: 7 }, (_, i) => `metrics-${addDays(today, -i)}`),
    );
    expect(body).toEqual({
      window_days: 7,
      kpis: {
        follow_up_opportunities: 4,
        checked_availability_not_booked: 1,
        unserved_requests: 2,
        pending_callbacks: 1,
        upcoming_maintenance_reminders: 2,
        bookings_confirmed_7d: 1,
      },
    });
  });
});

describe("GET /api/observability", () => {
  it("summarizes today's webhook and tool metrics", async () => {
    const today = getLocalDateString(Date.now());
    const recent = [{ ts: "2026-10-18T10:00:00.000Z", event: "webhook", outcome: "ok", latency_ms: 12 }];
    const m = makeEnv({
      metrics: {
        [`metrics-${today}`]: snapshot({
          counters: {
            "webhook.ok": 3,
            "webhook.rejected": 1,
            "mcp.get_availability.ok": 4,
            "mcp.get_availability.date_invalid": 1,
          },
          latency: { webhook: { sum: 40, count: 4 }, "mcp.get_availability": { sum: 100, count: 5 } },
          recent,
        }),
      },
    });
    const res = await handler.fetch(get("/api/observability", PORTAL_TOKEN), m.env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof summarizeObservability> & Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.booking_enabled).toBe(true);
    expect(body.webhook).toEqual({ ok: 3, degraded: 0, rejected: 1, avg_latency_ms: 10 });
    expect(body.tools.find((t) => t.tool === "get_availability")).toEqual({
      tool: "get_availability",
      calls: 5,
      errors: 1,
      by_outcome: { ok: 4, date_invalid: 1 },
      avg_latency_ms: 20,
    });
    expect(body.tools).toHaveLength(4);
    expect(body.recent).toEqual(recent);
  });

  it("reports degraded instead of failing when config or metrics are down", async () => {
    const m = makeEnv();
    m.kv.get.mockRejectedValue(new Error("kv down"));
    m.metrics.idFromName.mockImplementation(() => {
      throw new Error("metrics down");
    });
    const res = await handler.fetch(get("/api/observability", PORTAL_TOKEN), m.env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", config_ok: false, metrics_ok: false, booking_enabled: false });
  });
});

describe("DayAgenda.listBookings", () => {
  it("returns the day's bookings sorted by time", async () => {
    const date = "2026-10-20";
    const mk = (time: string) => ({
      id: `id-${time}`,
      service_id: "oil_change",
      date,
      time,
      customer_name: "N",
      customer_phone: "P",
      created_at: "2026-10-18T10:00:00.000Z",
      idempotency_key: `k-${time}`,
    });
    const state = {
      date,
      bookings: { "14:00": mk("14:00"), "09:00": mk("09:00") },
      idempotency: {},
    };
    const storage = { get: vi.fn(async () => state), put: vi.fn() };
    const actor = new DayAgenda({ storage } as never, {} as never);
    (actor as unknown as { ctx: unknown }).ctx = { storage };
    const { bookings } = await actor.listBookings();
    expect(bookings.map((b) => b.time)).toEqual(["09:00", "14:00"]);
    expect(bookings[0]).toEqual({
      time: "09:00",
      service_id: "oil_change",
      customer_name: "N",
      customer_phone: "P",
      created_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("empty agenda → no bookings", async () => {
    const storage = { get: vi.fn(async () => undefined), put: vi.fn() };
    const actor = new DayAgenda({ storage } as never, {} as never);
    (actor as unknown as { ctx: unknown }).ctx = { storage };
    expect(await actor.listBookings()).toEqual({ bookings: [] });
  });
});

describe("GET /portal", () => {
  it("returns a self-contained HTML page with no data and no secret reads", async () => {
    const m = makeEnv();
    const res = await handler.fetch(get("/portal"), m.env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("react@18.3.1");
    expect(html).toContain("/api/appointments");
    expect(html).not.toContain("+52155");
    expect(html).not.toContain(PORTAL_TOKEN);
    expect(m.env.SECRETS.get).not.toHaveBeenCalled();
    expect(m.agenda.idFromName).not.toHaveBeenCalled();
    expect(m.metrics.idFromName).not.toHaveBeenCalled();
  });

  it("wrong method → 405", async () => {
    const res = await handler.fetch(get("/portal", undefined, "POST"), makeEnv().env as never);
    expect(res.status).toBe(405);
  });
});
