import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import type { AppConfig } from "../src/config";
import { maskPhone } from "../src/logger";
import { __resetWebhookKeyCacheForTests } from "../src/dynamic-variables";

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

// ---------------------------------------------------------------------------
// Key pair + signing — a fresh Ed25519 key per test so no state leaks across
// cases. The signer mirrors Telnyx's canonical form:
// UTF-8(`${timestamp}|`) || exact raw body bytes.
// ---------------------------------------------------------------------------

interface KeyPair {
  publicKeyBase64: string;
  privateKey: CryptoKey;
}

async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    publicKeyBase64: bytesToBase64(raw),
    privateKey: kp.privateKey,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function signBody(
  privateKey: CryptoKey,
  timestamp: number | string,
  body: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, msg);
  return bytesToBase64(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// KV + SECRETS mocks. Each test gets a fresh keypair and a default-env helper
// so a request signed with the test's key validates against the matching
// SECRETS mock without any per-test plumbing.
// ---------------------------------------------------------------------------

type KvMock = { get: ReturnType<typeof vi.fn> };
type SecretsMock = { get: ReturnType<typeof vi.fn> };
interface WebhookEnv {
  CONFIG?: KvMock;
  SECRETS?: SecretsMock;
}

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

function secretsEnv(publicKeyBase64: string, kv?: KvMock): WebhookEnv {
  const secrets: SecretsMock = {
    get: vi.fn(async (binding: string) => {
      if (binding === "WEBHOOK_PUBLIC_KEY") return publicKeyBase64;
      throw new Error(`unexpected binding: ${binding}`);
    }),
  };
  return kv === undefined ? { SECRETS: secrets } : { CONFIG: kv, SECRETS: secrets };
}

function invalidKeySecrets(kv?: KvMock): WebhookEnv {
  // 16 bytes (too short for Ed25519) — surfaces as invalid_configuration in
  // the verifier. The handler must report a generic 503, never parse or
  // reach KV.
  const tooShort = bytesToBase64(new Uint8Array(16));
  const secrets: SecretsMock = {
    get: vi.fn(async (binding: string) => {
      if (binding === "WEBHOOK_PUBLIC_KEY") return tooShort;
      throw new Error(`unexpected binding: ${binding}`);
    }),
  };
  return kv === undefined ? { SECRETS: secrets } : { CONFIG: kv, SECRETS: secrets };
}

function rejectingSecrets(kv?: KvMock): WebhookEnv {
  const secrets: SecretsMock = {
    get: vi.fn(async () => {
      throw new Error("secret store down");
    }),
  };
  return kv === undefined ? { SECRETS: secrets } : { CONFIG: kv, SECRETS: secrets };
}

interface PendingSecrets {
  env: WebhookEnv;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

function pendingSecrets(kv?: KvMock): PendingSecrets {
  let resolveFn!: (v: string) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const secrets: SecretsMock = {
    get: vi.fn((binding: string) => {
      if (binding === "WEBHOOK_PUBLIC_KEY") return promise;
      return Promise.reject(new Error(`unexpected binding: ${binding}`));
    }),
  };
  return {
    env: kv === undefined ? { SECRETS: secrets } : { CONFIG: kv, SECRETS: secrets },
    resolve: resolveFn,
    reject: rejectFn,
  };
}

// ---------------------------------------------------------------------------
// Request builder — auto-signs with the current keypair and the current
// "now". Tamper / omit / override options cover the rejection cases.
// ---------------------------------------------------------------------------

let keyPair: KeyPair;

interface WebhookReqOptions {
  method?: string;
  // Sign one body, send a different one — exercises the byte-level check.
  tamperBody?: string;
  // Override the timestamp header sent on the wire.
  timestampHeader?: number | string;
  // Override the signature header sent on the wire. null → header omitted.
  signatureHeader?: string | null;
  omitSignature?: boolean;
  omitTimestamp?: boolean;
  // Sign with a different key (e.g. wrong-key tests).
  privateKey?: CryptoKey;
  // Build the request body from raw bytes instead of a UTF-8 string.
  rawBody?: Uint8Array;
  // Stream a large body that exceeds 10 KiB without Content-Length.
  largeBody?: Uint8Array;
  extraHeaders?: Record<string, string>;
}

async function webhookReq(
  body?: string,
  opts: WebhookReqOptions = {},
): Promise<Request> {
  const ts = opts.timestampHeader ?? Math.floor(Date.now() / 1000);
  const tsString = String(ts);
  let bytes: Uint8Array;
  if (opts.rawBody !== undefined) bytes = opts.rawBody;
  else if (body !== undefined) bytes = new TextEncoder().encode(body);
  else bytes = new Uint8Array(0);

  const signingKey = opts.privateKey ?? keyPair.privateKey;
  const signature = await signBody(signingKey, tsString, bytes);

  // The wire body that goes into the Request. readBoundedBody reads it back
  // as raw bytes and feeds them to the signature verifier — sending as a
  // string (instead of Uint8Array) keeps the test type system happy and is
  // byte-equivalent for ASCII/UTF-8 inputs.
  const sendBody =
    opts.tamperBody !== undefined ? opts.tamperBody : body ?? "";

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.omitTimestamp) headers["telnyx-timestamp"] = tsString;
  if (opts.signatureHeader !== null && !opts.omitSignature) {
    headers["telnyx-signature-ed25519"] =
      opts.signatureHeader ?? signature;
  }
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  if (opts.largeBody !== undefined) {
    const big = opts.largeBody;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    return new Request("http://x/webhooks/dynamic-variables", {
      method: opts.method ?? "POST",
      body: stream,
      headers,
      duplex: "half",
    } as RequestInit);
  }

  const method = opts.method ?? "POST";
  // GET / HEAD cannot carry a body — strip it so the Request constructor
  // accepts the call. The method-not-allowed test only cares about the
  // method; the body, if any, would be discarded upstream.
  const useBody = method === "GET" || method === "HEAD" ? undefined : sendBody;

  return new Request("http://x/webhooks/dynamic-variables", {
    method,
    body: useBody,
    headers,
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

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  keyPair = await generateKeyPair();
  __resetWebhookKeyCacheForTests();
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000001")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, rejectingKv());
    const res = await handler.fetch(
      await webhookReq(JSON.stringify({ data: { event_type: "x", payload: {} } })),
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

  it("signed malformed JSON → 400", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(await webhookReq("not json"), env as never);
    expect(res.status).toBe(400);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });

  it("GET → 405", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(undefined, { method: "GET" }),
      env as never,
    );
    expect(res.status).toBe(405);
  });

  it("missing payload fields are not an error — still 200", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(JSON.stringify({ data: {} })),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(config));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000010")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(config));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000011")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(config));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000012")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(config));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000013")),
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
    const env = secretsEnv(keyPair.publicKeyBase64);
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000014")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(bad));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000015")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const fullPhone = "+15550000001";
    await handler.fetch(await webhookReq(initPayload(fullPhone)), env as never);
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const big = new Uint8Array(11 * 1024);
    const req = await webhookReq(undefined, { largeBody: big });
    const res = await handler.fetch(req, env as never);
    expect(res.status).toBe(413);
    expect(env.SECRETS!.get).not.toHaveBeenCalled();
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });
});

describe("/webhooks/dynamic-variables — bounded KV wait", () => {
  beforeEach(() => {
    // Only fake the timers the handler actually schedules via setTimeout; let
    // crypto.subtle and queueMicrotask use the real event loop so WebCrypto
    // operations (used by the signature verifier) make progress.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
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

  // Advance fake time in small steps until `predicate` returns true, so the
  // handler can complete all async setup (body read, key lookup, signature
  // verification) before its internal 800ms KV timer is even scheduled.
  async function advanceUntil(
    predicate: () => boolean,
    stepMs = 50,
    capMs = 5000,
  ): Promise<void> {
    let advanced = 0;
    while (!predicate() && advanced < capMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
      advanced += stepMs;
    }
  }

  it("config resolves before deadline → uses config and logs config_outcome=ok", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    let resolved = false;
    const promise = handler
      .fetch(await webhookReq(initPayload("+15550000001")), env as never)
      .then((r) => {
        resolved = true;
        return r;
      });
    await advanceUntil(() => resolved);
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
    const env = secretsEnv(keyPair.publicKeyBase64, pendingKv());
    let resolved = false;
    const promise = handler
      .fetch(await webhookReq(initPayload("+15550000002")), env as never)
      .then((r) => {
        resolved = true;
        return r;
      });
    await advanceUntil(() => resolved);
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
    const env = secretsEnv(keyPair.publicKeyBase64, kv);
    const { list, off } = captureUnhandled();
    try {
      let resolved = false;
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000003")), env as never)
        .then((r) => {
          resolved = true;
          return r;
        });
      await advanceUntil(() => resolved);
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
    const env = secretsEnv(keyPair.publicKeyBase64, kv);
    const { list, off } = captureUnhandled();
    try {
      let resolved = false;
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000004")), env as never)
        .then((r) => {
          resolved = true;
          return r;
        });
      await advanceUntil(() => resolved);
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
// Early rejections — exactly one webhook.rejected log per case, no SECRETS /
// CONFIG access, no request body / phone / call id leaking into the log.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — early rejection logging", () => {
  function rejections(): Array<Record<string, unknown>> {
    return logEvents().filter((e) => e.event === "webhook.rejected");
  }

  it("GET → method_not_allowed at 405, Allow header preserved, no SECRETS/CONFIG access", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      new Request("http://x/webhooks/dynamic-variables", { method: "GET" }),
      env as never,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(env.SECRETS!.get).not.toHaveBeenCalled();
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
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

  it("body over 10 KiB → payload_too_large at 413, no SECRETS/CONFIG access", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const big = new Uint8Array(11 * 1024);
    const req = await webhookReq(undefined, { largeBody: big });
    const res = await handler.fetch(req, env as never);
    expect(res.status).toBe(413);
    expect(env.SECRETS!.get).not.toHaveBeenCalled();
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("payload_too_large");
    expect(ev.http_status).toBe(413);
    expect(typeof ev.latency_ms).toBe("number");
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("xxxxx");
    expect(serialized).not.toContain("pad");
  });

  it("rejecting body stream → body_read_failed at 400, no SECRETS/CONFIG access", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
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
    expect(env.SECRETS!.get).not.toHaveBeenCalled();
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
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

  it("signed malformed JSON → invalid_json at 400, no CONFIG access", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(await webhookReq("not json"), env as never);
    expect(res.status).toBe(400);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
    const ev = rejections()[0]!;
    expect(ev.reason).toBe("invalid_json");
    expect(ev.http_status).toBe(400);
    expect(typeof ev.latency_ms).toBe("number");
  });

  it("does not log the request body, headers, or unvalidated identifiers", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const sentinels = {
      phone: "+15559990PH0N",
      callerId: "cc-SENTINEL-CALLER",
      assistantId: "asst-SENTINEL-ASSIST",
      auth: "Bearer SENTINEL-AUTH-TOKEN",
      rawBody:
        '{"data":{"payload":{"telnyx_end_user_target":"+15559990PH0N","call_control_id":"cc-SENTINEL-CALLER","assistant_id":"asst-SENTINEL-ASSIST",BROKEN',
    };
    const res = await handler.fetch(
      await webhookReq(sentinels.rawBody, { extraHeaders: {
        "x-call-control-id": "cc-SENTINEL-CALLER",
        authorization: sentinels.auth,
      } }),
      env as never,
    );
    expect(res.status).toBe(400);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
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
// Signature verification — only an Ed25519 signature over the exact body
// bytes, header strings, and within the timestamp window passes.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — signature verification", () => {
  it("accepts a freshly signed JSON payload", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000100")),
      env as never,
    );
    expect(res.status).toBe(200);
  });

  it("rejects a body byte change after signing (tampered body)", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    // Sign one body, send a different one.
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000101"), {
        tamperBody: initPayload("+15550000199"),
      }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("invalid_signature");
    expect(ev?.http_status).toBe(401);
  });

  it("rejects when the signature header is missing", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000102"), { omitSignature: true }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("invalid_signature");
    expect(ev?.http_status).toBe(401);
  });

  it("rejects when the timestamp header is missing", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000103"), { omitTimestamp: true }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp (one day old)", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const stale = Math.floor(Date.now() / 1000) - 86_400;
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000104"), {
        timestampHeader: stale,
      }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });

  it("rejects a far-future timestamp", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000105"), {
        timestampHeader: future,
      }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });

  it("rejects a signature produced by a different key", async () => {
    const otherKeyPair = await generateKeyPair();
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000106"), {
        privateKey: otherKeyPair.privateKey,
      }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
  });

  it("rejection log does not leak the signature, key, or request body", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const sentinels = {
      sig: "SIG-SENTINEL-ABCDEF",
      body: "BODY-SENTINEL-PAYLOAD",
      phone: "+15559999SIG",
    };
    const res = await handler.fetch(
      await webhookReq(initPayload(sentinels.phone), {
        signatureHeader: sentinels.sig,
        tamperBody: sentinels.body,
      }),
      env as never,
    );
    expect(res.status).toBe(401);
    const allLogs = JSON.stringify(logEvents());
    expect(allLogs).not.toContain(sentinels.sig);
    expect(allLogs).not.toContain(sentinels.body);
    expect(allLogs).not.toContain(sentinels.phone);
    expect(allLogs).not.toContain(keyPair.publicKeyBase64);
    expect(allLogs).not.toContain("telnyx-signature-ed25519");
  });
});

// ---------------------------------------------------------------------------
// Secret binding — missing / rejecting / timing out the secrets lookup must
// fail closed (503) without leaking the reason, and must not touch KV.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — secret key binding", () => {
  it("503 when SECRETS binding is absent", async () => {
    const env: WebhookEnv = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000200")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json())).toEqual({ error: "service_unavailable" });
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("secrets_binding_missing");
    expect(ev?.http_status).toBe(503);
  });

  it("503 when the key read rejects", async () => {
    const env = rejectingSecrets(validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000201")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_read_failed");
    expect(ev?.http_status).toBe(503);
  });

  it("503 when the stored key is not a valid Ed25519 public key", async () => {
    const env = invalidKeySecrets(validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000202")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("verification_configuration_invalid");
    expect(ev?.http_status).toBe(503);
  });

  it("503 when the key read resolves to an empty string", async () => {
    const secrets: SecretsMock = {
      get: vi.fn(async (binding: string) => {
        if (binding === "WEBHOOK_PUBLIC_KEY") return "";
        throw new Error(`unexpected binding: ${binding}`);
      }),
    };
    const env: WebhookEnv = { CONFIG: validKv(VALID_CONFIG), SECRETS: secrets };
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000203")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(env.CONFIG!.get).not.toHaveBeenCalled();
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_empty");
    expect(ev?.http_status).toBe(503);
  });

    describe("key read never settles (1000ms deadline)", () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

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

    // Advance fake time until the handler completes (or the cap is hit) so
    // a slow body read or signature verification cannot leave a scheduled
    // timer stranded past our 1000ms window.
    async function advanceUntilResolved<T>(
      promise: Promise<T>,
      stepMs = 25,
      capMs = 5000,
    ): Promise<void> {
      let advanced = 0;
      while (advanced < capMs) {
        const settled = await Promise.race([
          promise.then(() => true, () => true),
          Promise.resolve(false),
        ]);
        if (settled) return;
        await vi.advanceTimersByTimeAsync(stepMs);
        advanced += stepMs;
      }
    }

    it("times out at 1000ms → 503, no CONFIG access, no unhandled rejection", async () => {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      let resolved = false;
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000204")), ps.env as never)
        .then((r) => {
          resolved = true;
          return r;
        });
      await advanceUntilResolved(promise);
      const res = await promise;
      expect(res.status).toBe(503);
      expect((await res.json())).toEqual({ error: "service_unavailable" });
      expect(ps.env.CONFIG!.get).not.toHaveBeenCalled();
      const ev = findEvent("webhook.rejected");
      expect(ev?.reason).toBe("key_timeout");
      expect(ev?.http_status).toBe(503);
      expect(resolved).toBe(true);
    });

    it("times out after 1000ms (not 500ms) — advancing only 500ms keeps the read pending", async () => {
      // Reproduce the key/secret timeout with bounded fake-time progress so
      // the test can observe exactly when the deadline fires. The handler
      // must still be waiting at 500ms (the previous deadline) and must
      // return 503 with key_timeout only after the 1000ms mark.
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000320")), ps.env as never)
        .then((r) => r);
      // 500ms (the old deadline) must NOT settle the request.
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      // Advancing further to 1000ms must fire the deadline and produce 503.
      await vi.advanceTimersByTimeAsync(500);
      await advanceUntilResolved(promise);
      const res = await promise;
      expect(res.status).toBe(503);
      const ev = logEvents()
        .filter((e) => e.event === "webhook.rejected")
        .slice(-1)[0];
      expect(ev?.reason).toBe("key_timeout");
      expect(ev?.http_status).toBe(503);
      // Late resolve after timeout must not change the recorded outcome.
      ps.resolve(keyPair.publicKeyBase64);
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      const rejections = logEvents().filter(
        (e) => e.event === "webhook.rejected",
      );
      expect(rejections).toHaveLength(1);
    });

    it("key resolving at 300ms reaches signature verification → 200", async () => {
      // A key that resolves at 300ms must beat the 1000ms deadline and the
      // handler must proceed to signature verification. The request body is
      // signed with the test keypair, so a valid signature yields 200; this
      // proves the slower lookup no longer accidentally trips the timeout.
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000321")), ps.env as never)
        .then((r) => r);
      await vi.advanceTimersByTimeAsync(300);
      ps.resolve(keyPair.publicKeyBase64);
      await advanceUntilResolved(promise);
      const res = await promise;
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dynamic_variables: Record<string, string>;
      };
      expect(body.dynamic_variables.system_status).toBe("ok");
      expect(body.dynamic_variables.booking_enabled).toBe("true");
      // Only the success log should appear; no rejection.
      const rejections = logEvents().filter(
        (e) => e.event === "webhook.rejected",
      );
      expect(rejections).toHaveLength(0);
      const ok = findEvent("webhook.dynamic_variables");
      expect(ok?.reason).toBeUndefined();
    });

    it("key resolving at 677ms reaches signature verification → 200 (regression for remote completion latency)", async () => {
      // Regression test: a key that resolves at 677ms (the completion time
      // observed on the remote runtime after the 503 timeout fired) must
      // still beat the 1000ms deadline and reach signature verification
      // with a valid signed request. With the previous 500ms deadline this
      // lookup would have been cut off as key_timeout; the 1000ms deadline
      // proves the handler no longer returns 503 for late but valid keys.
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const promise = handler
        .fetch(await webhookReq(initPayload("+15550000322")), ps.env as never)
        .then((r) => r);
      // 500ms (the previous deadline) must NOT settle the request.
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      // Resolve the lookup at 677ms — must beat the 1000ms deadline.
      await vi.advanceTimersByTimeAsync(177);
      ps.resolve(keyPair.publicKeyBase64);
      await advanceUntilResolved(promise);
      const res = await promise;
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dynamic_variables: Record<string, string>;
      };
      expect(body.dynamic_variables.system_status).toBe("ok");
      expect(body.dynamic_variables.booking_enabled).toBe("true");
      // Only the success log should appear; no rejection.
      const rejections = logEvents().filter(
        (e) => e.event === "webhook.rejected",
      );
      expect(rejections).toHaveLength(0);
      const ok = findEvent("webhook.dynamic_variables");
      expect(ok?.reason).toBeUndefined();
    });

    it("key resolves after timeout → no extra log, no CONFIG read, no unhandled rejection", async () => {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const { list, off } = captureUnhandled();
      try {
        const promise = handler.fetch(
          await webhookReq(initPayload("+15550000205")),
          ps.env as never,
        );
        await advanceUntilResolved(promise);
        const res = await promise;
        expect(res.status).toBe(503);
        ps.resolve(keyPair.publicKeyBase64);
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => process.nextTick(resolve));
        expect(ps.env.CONFIG!.get).not.toHaveBeenCalled();
        const rejections = logEvents().filter(
          (e) => e.event === "webhook.rejected",
        );
        expect(rejections).toHaveLength(1);
        expect(list).toEqual([]);
      } finally {
        off();
      }
    });

    it("key rejects after timeout → no unhandled rejection", async () => {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const { list, off } = captureUnhandled();
      try {
        const promise = handler.fetch(
          await webhookReq(initPayload("+15550000206")),
          ps.env as never,
        );
        await advanceUntilResolved(promise);
        const res = await promise;
        expect(res.status).toBe(503);
        ps.reject(new Error("late secret failure"));
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => process.nextTick(resolve));
        expect(list).toEqual([]);
      } finally {
        off();
      }
    });
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds("cc-abc-123", "asst-xyz")),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("cc-abc-123");
    expect(ev?.assistant_id).toBe("asst-xyz");
  });

  it("preserves valid ids at the 128-char boundary", async () => {
    const id128 = "a".repeat(128);
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds(id128, id128)),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe(id128);
    expect(ev?.assistant_id).toBe(id128);
  });

  it("replaces oversized ids (>128 chars) with empty string", async () => {
    const id129 = "a".repeat(129);
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(payloadWithIds(id129, id129)),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds(bad, bad)),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds("attacker@example.com", "asst@evil.com")),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds(12345, { nested: "object" })),
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
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(payloadWithIds(null, null)),
      env as never,
    );
    const ev = findEvent("webhook.dynamic_variables");
    expect(ev?.call_control_id).toBe("");
    expect(ev?.assistant_id).toBe("");
  });

  it("invalid sentinel values appear nowhere in captured logs or response", async () => {
    const sentinels = {
      callControlId: "cc-attacker@evil.com with spaces\nline2",
      assistantId: "asst\0null-byte\u0007bell",
    };
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(payloadWithIds(sentinels.callControlId, sentinels.assistantId)),
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
    expect(allLogs).not.toContain("\0");
    expect(allLogs).not.toContain("\x07");
  });

  it("valid request still produces exactly one webhook.dynamic_variables event", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    await handler.fetch(
      await webhookReq(initPayload("+15550000030")),
      env as never,
    );
    const events = logEvents().filter(
      (e) => e.event === "webhook.dynamic_variables",
    );
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Diagnostic labels — the four safe, distinct webhook.rejected reasons used
// when the 503 is for an infrastructure problem on the key/secret path.
// Each case must surface exactly one reason and never leak the key value,
// the request body, or the underlying error message.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — diagnostic labels for key/secret failures", () => {
  function syncThrowingSecrets(): WebhookEnv {
    // Mirrors a binding that throws before returning a promise — e.g. an
    // unwired handle on a backend that does not lazily wrap exceptions.
    const secrets: SecretsMock = {
      get: vi.fn((binding: string) => {
        if (binding === "WEBHOOK_PUBLIC_KEY") {
          throw new Error("sync boom");
        }
        throw new Error(`unexpected binding: ${binding}`);
      }),
    };
    return { CONFIG: validKv(VALID_CONFIG), SECRETS: secrets };
  }

  function emptyKeySecrets(): WebhookEnv {
    const secrets: SecretsMock = {
      get: vi.fn(async (binding: string) => {
        if (binding === "WEBHOOK_PUBLIC_KEY") return "";
        throw new Error(`unexpected binding: ${binding}`);
      }),
    };
    return { CONFIG: validKv(VALID_CONFIG), SECRETS: secrets };
  }

  function nonStringKeySecrets(): WebhookEnv {
    // Resolves to a non-string value — the loader must reject this as
    // key_empty rather than letting it reach the verifier.
    const secrets = {
      get: vi.fn((binding: string) => {
        if (binding === "WEBHOOK_PUBLIC_KEY") {
          return Promise.resolve(12345 as unknown as string);
        }
        return Promise.reject(new Error(`unexpected binding: ${binding}`));
      }),
    } as unknown as SecretsMock;
    return { CONFIG: validKv(VALID_CONFIG), SECRETS: secrets };
  }

  it("secrets_binding_missing when env.SECRETS is undefined", async () => {
    const env: WebhookEnv = { CONFIG: validKv(VALID_CONFIG) };
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000300")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json())).toEqual({ error: "service_unavailable" });
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("secrets_binding_missing");
    expect(ev?.http_status).toBe(503);
  });

  it("key_timeout when the 1000ms deadline fires first", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const promise = handler.fetch(
        await webhookReq(initPayload("+15550000301")),
        ps.env as never,
      );
      let advanced = 0;
      while (advanced < 5000) {
        const settled = await Promise.race([
          promise.then(() => true, () => true),
          Promise.resolve(false),
        ]);
        if (settled) break;
        await vi.advanceTimersByTimeAsync(25);
        advanced += 25;
      }
      const res = await promise;
      expect(res.status).toBe(503);
      const ev = findEvent("webhook.rejected");
      expect(ev?.reason).toBe("key_timeout");
      expect(ev?.http_status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("key_empty when the key resolves to an empty string", async () => {
    const env = emptyKeySecrets();
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000302")),
      env as never,
    );
    expect(res.status).toBe(503);
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_empty");
    expect(ev?.http_status).toBe(503);
  });

  it("key_empty when the key resolves to a non-string value", async () => {
    const env = nonStringKeySecrets();
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000303")),
      env as never,
    );
    expect(res.status).toBe(503);
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_empty");
    expect(ev?.http_status).toBe(503);
  });

  it("key_read_failed when secrets.get rejects with a promise", async () => {
    const env = rejectingSecrets(validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000304")),
      env as never,
    );
    expect(res.status).toBe(503);
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_read_failed");
    expect(ev?.http_status).toBe(503);
  });

  it("key_read_failed when secrets.get throws synchronously", async () => {
    const env = syncThrowingSecrets();
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000305")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json())).toEqual({ error: "service_unavailable" });
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("key_read_failed");
    expect(ev?.http_status).toBe(503);
    // The synchronous throw's message must not reach the log or the response.
    const allLogs = JSON.stringify(logEvents());
    expect(allLogs).not.toContain("sync boom");
  });

  it("verification_configuration_invalid when the stored key is malformed", async () => {
    const env = invalidKeySecrets(validKv(VALID_CONFIG));
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000306")),
      env as never,
    );
    expect(res.status).toBe(503);
    const ev = findEvent("webhook.rejected");
    expect(ev?.reason).toBe("verification_configuration_invalid");
    expect(ev?.http_status).toBe(503);
  });

  it("each diagnostic label appears as a fixed token — no key, body, or raw error leaks", async () => {
    const cases: Array<{ name: string; reason: string; env: WebhookEnv; phone: string }> = [
      {
        name: "secrets_binding_missing",
        reason: "secrets_binding_missing",
        env: { CONFIG: validKv(VALID_CONFIG) },
        phone: "+15550000310",
      },
      {
        name: "key_empty",
        reason: "key_empty",
        env: emptyKeySecrets(),
        phone: "+15550000311",
      },
      {
        name: "key_read_failed (promise rejection)",
        reason: "key_read_failed",
        env: rejectingSecrets(validKv(VALID_CONFIG)),
        phone: "+15550000312",
      },
      {
        name: "key_read_failed (synchronous throw)",
        reason: "key_read_failed",
        env: syncThrowingSecrets(),
        phone: "+15550000313",
      },
      {
        name: "verification_configuration_invalid",
        reason: "verification_configuration_invalid",
        env: invalidKeySecrets(validKv(VALID_CONFIG)),
        phone: "+15550000314",
      },
    ];
    const validReasons = new Set([
      "secrets_binding_missing",
      "key_timeout",
      "key_empty",
      "key_read_failed",
      "verification_configuration_invalid",
    ]);
    for (const c of cases) {
      // Snapshot the rejection log before each iteration so we can identify
      // the event produced by this specific request, regardless of what
      // earlier tests in this loop (or in the file) already emitted.
      const before = logEvents().filter(
        (e) => e.event === "webhook.rejected",
      ).length;
      const res = await handler.fetch(
        await webhookReq(initPayload(c.phone)),
        c.env as never,
      );
      expect(res.status).toBe(503);
      const after = logEvents().filter(
        (e) => e.event === "webhook.rejected",
      );
      const emitted = after.slice(before);
      expect(emitted, `case ${c.name}: emitted event`).toHaveLength(1);
      expect(emitted[0]!.reason, `case ${c.name}: reason`).toBe(c.reason);
      expect(validReasons.has(c.reason)).toBe(true);
    }
    const allLogs = JSON.stringify(logEvents());
    // The phone sentinels are caller identifiers, not keys — masking would
    // happen on the success path, but a 503 path must never log them either.
    for (const c of cases) {
      expect(allLogs, `phone ${c.phone} leaked`).not.toContain(c.phone);
    }
    // No underlying error message from the secret store reaches the log.
    expect(allLogs).not.toContain("secret store down");
    expect(allLogs).not.toContain("sync boom");
    expect(allLogs).not.toContain("Error");
    expect(allLogs).not.toContain("stack");
    // No raw key bytes (the valid key is base64; the invalid one is too).
    expect(allLogs).not.toContain(keyPair.publicKeyBase64);
  });
});

// ---------------------------------------------------------------------------
// Diagnostic timing — every call to loadWebhookKeyBounded must emit exactly
// one webhook.key_lookup_completed event when the underlying secrets.get
// operation settles (resolves or rejects), even if the 1000ms timeout has
// already returned 503. The event carries only the settlement outcome
// (ok / empty / read_failed), elapsed_ms, and after_timeout — never the key,
// its length, headers, bodies, or raw errors.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — key lookup completion diagnostic", () => {
  function completions(): Array<Record<string, unknown>> {
    return logEvents().filter(
      (e) => e.event === "webhook.key_lookup_completed",
    );
  }

  function syncThrowingSecrets(): WebhookEnv {
    const secrets: SecretsMock = {
      get: vi.fn((binding: string) => {
        if (binding === "WEBHOOK_PUBLIC_KEY") {
          throw new Error("sync boom");
        }
        throw new Error(`unexpected binding: ${binding}`);
      }),
    };
    return { CONFIG: validKv(VALID_CONFIG), SECRETS: secrets };
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

  it("completes before timeout with outcome=ok and after_timeout=false", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const before = completions().length;
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000400")),
      env as never,
    );
    expect(res.status).toBe(200);
    const emitted = completions().slice(before);
    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.outcome).toBe("ok");
    expect(ev.after_timeout).toBe(false);
    expect(typeof ev.elapsed_ms).toBe("number");
    expect(ev.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    // The completion log must not leak the key, the request body, the
    // caller, the headers, or any underlying error message.
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain(keyPair.publicKeyBase64);
    expect(serialized).not.toContain("+15550000400");
    expect(serialized).not.toContain("Error");
    expect(serialized).not.toContain("stack");
  });

  it("completes after timeout with outcome=ok and after_timeout=true (late success)", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const before = completions().length;
      const promise = handler.fetch(
        await webhookReq(initPayload("+15550000401")),
        ps.env as never,
      );
      // Wait for the handler to settle with a 503 (timeout won the race).
      let advanced = 0;
      while (advanced < 5000) {
        const settled = await Promise.race([
          promise.then(() => true, () => true),
          Promise.resolve(false),
        ]);
        if (settled) break;
        await vi.advanceTimersByTimeAsync(25);
        advanced += 25;
      }
      const res = await promise;
      expect(res.status).toBe(503);
      // No completion event yet — the key lookup is still pending.
      expect(completions().slice(before)).toHaveLength(0);
      // Late success: resolve the secret store after the timeout.
      ps.resolve(keyPair.publicKeyBase64);
      // Drain microtasks so the late .then() fires.
      await new Promise<void>((r) => process.nextTick(r));
      await new Promise<void>((r) => process.nextTick(r));
      const emitted = completions().slice(before);
      expect(emitted).toHaveLength(1);
      const ev = emitted[0]!;
      expect(ev.outcome).toBe("ok");
      expect(ev.after_timeout).toBe(true);
      expect(typeof ev.elapsed_ms).toBe("number");
      expect(ev.elapsed_ms as number).toBeGreaterThanOrEqual(0);
      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(keyPair.publicKeyBase64);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records outcome=read_failed and after_timeout=true when the lookup rejects after timeout (no unhandled rejection)", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const { list, off } = captureUnhandled();
    try {
      const ps = pendingSecrets(validKv(VALID_CONFIG));
      const before = completions().length;
      const promise = handler.fetch(
        await webhookReq(initPayload("+15550000402")),
        ps.env as never,
      );
      let advanced = 0;
      while (advanced < 5000) {
        const settled = await Promise.race([
          promise.then(() => true, () => true),
          Promise.resolve(false),
        ]);
        if (settled) break;
        await vi.advanceTimersByTimeAsync(25);
        advanced += 25;
      }
      const res = await promise;
      expect(res.status).toBe(503);
      // Late rejection: reject the secret store after the timeout.
      ps.reject(new Error("late secret failure"));
      await new Promise<void>((r) => process.nextTick(r));
      await new Promise<void>((r) => process.nextTick(r));
      const emitted = completions().slice(before);
      expect(emitted).toHaveLength(1);
      const ev = emitted[0]!;
      expect(ev.outcome).toBe("read_failed");
      expect(ev.after_timeout).toBe(true);
      expect(typeof ev.elapsed_ms).toBe("number");
      // The raw error message must not reach the log.
      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain("late secret failure");
      expect(serialized).not.toContain("Error");
      expect(serialized).not.toContain("stack");
      // And no unhandled rejection escapes from the late settle.
      expect(list).toEqual([]);
    } finally {
      off();
      vi.useRealTimers();
    }
  });

  it("records outcome=read_failed and after_timeout=false when secrets.get throws synchronously", async () => {
    const env = syncThrowingSecrets();
    const before = completions().length;
    const res = await handler.fetch(
      await webhookReq(initPayload("+15550000403")),
      env as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json())).toEqual({ error: "service_unavailable" });
    const emitted = completions().slice(before);
    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.outcome).toBe("read_failed");
    expect(ev.after_timeout).toBe(false);
    expect(typeof ev.elapsed_ms).toBe("number");
    // The raw synchronous throw message must not reach the log.
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("sync boom");
    expect(serialized).not.toContain("Error");
    expect(serialized).not.toContain("stack");
  });
});

// ---------------------------------------------------------------------------
// WEBHOOK_PUBLIC_KEY cache — the bound lookup is the dominant cost on the
// warm assistant-init path (≈700ms per request in production telemetry),
// and Telnyx only gives the whole webhook a 1500ms budget. A successful
// read is immutable for the lifetime of the instance, so we cache it
// module-level and short-circuit subsequent lookups. Failures are never
// cached: a slow or empty read on one request must be retried on the next.
// ---------------------------------------------------------------------------

describe("/webhooks/dynamic-variables — WEBHOOK_PUBLIC_KEY cache", () => {
  it("second request serves from cache; SECRETS.get is not called again", async () => {
    const env = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res1 = await handler.fetch(
      await webhookReq(initPayload("+15550000500")),
      env as never,
    );
    expect(res1.status).toBe(200);
    expect(env.SECRETS!.get).toHaveBeenCalledTimes(1);

    const res2 = await handler.fetch(
      await webhookReq(initPayload("+15550000501")),
      env as never,
    );
    expect(res2.status).toBe(200);
    // The warm path short-circuits the bounded lookup, so the secret store
    // is not consulted a second time on the same env.
    expect(env.SECRETS!.get).toHaveBeenCalledTimes(1);

    // The cache-hit completion is recorded with cached=true so the
    // diagnostic stream keeps showing that the warm path is engaged.
    const cached = logEvents().filter(
      (e) => e.event === "webhook.key_lookup_completed" && e.cached === true,
    );
    expect(cached).toHaveLength(1);
    expect(cached[0]!.outcome).toBe("ok");
    expect(cached[0]!.after_timeout).toBe(false);
    expect(typeof cached[0]!.elapsed_ms).toBe("number");
    // And the cached completion must never carry the key value.
    expect(JSON.stringify(cached)).not.toContain(keyPair.publicKeyBase64);
  });

  it("failed lookup is not cached; a subsequent valid lookup retries SECRETS.get", async () => {
    // First request: secrets.get rejects with a promise → key_read_failed,
    // 503, and the module-level cache stays empty by design.
    const failing = rejectingSecrets(validKv(VALID_CONFIG));
    const res1 = await handler.fetch(
      await webhookReq(initPayload("+15550000502")),
      failing as never,
    );
    expect(res1.status).toBe(503);
    expect(failing.SECRETS!.get).toHaveBeenCalledTimes(1);

    // Second request: a different env whose SECRETS returns the valid key.
    // Because the first failure did not populate the cache, the handler
    // must call SECRETS.get on the new env and succeed.
    const valid = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res2 = await handler.fetch(
      await webhookReq(initPayload("+15550000503")),
      valid as never,
    );
    expect(res2.status).toBe(200);
    expect(valid.SECRETS!.get).toHaveBeenCalledTimes(1);

    // The first failure emitted cached=false (a real lookup that read
    // nothing useful) and the second emitted cached=false too (another
    // real lookup that read the key). No cached=true should be present
    // because the cache stayed empty through the failure.
    const cachedHits = logEvents().filter(
      (e) => e.event === "webhook.key_lookup_completed" && e.cached === true,
    );
    expect(cachedHits).toHaveLength(0);
  });

  it("empty key is not cached; a subsequent valid lookup retries SECRETS.get", async () => {
    const empty: WebhookEnv = {
      CONFIG: validKv(VALID_CONFIG),
      SECRETS: {
        get: vi.fn(async (binding: string) => {
          if (binding === "WEBHOOK_PUBLIC_KEY") return "";
          throw new Error(`unexpected binding: ${binding}`);
        }),
      },
    };
    const res1 = await handler.fetch(
      await webhookReq(initPayload("+15550000504")),
      empty as never,
    );
    expect(res1.status).toBe(503);
    expect(empty.SECRETS!.get).toHaveBeenCalledTimes(1);

    const valid = secretsEnv(keyPair.publicKeyBase64, validKv(VALID_CONFIG));
    const res2 = await handler.fetch(
      await webhookReq(initPayload("+15550000505")),
      valid as never,
    );
    expect(res2.status).toBe(200);
    expect(valid.SECRETS!.get).toHaveBeenCalledTimes(1);
  });
});
