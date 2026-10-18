import type { KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { loadConfig, type ConfigResult } from "./config";
import { readBoundedBody } from "./bookings";
import { getLocalDateString, getLocalTimeParts } from "./scheduling";
import { logEvent, maskPhone } from "./logger";
import { verifyWebhookSignature } from "./webhook-signature";
import { recordMetric, type MetricsNamespace } from "./metrics";

interface Env {
  CONFIG?: KvNamespace;
  SECRETS?: Secrets;
  METRICS?: MetricsNamespace;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAY_TOKENS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];

const WEEKDAY_LONG: Record<WeekdayToken, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function formatBusinessHours(
  openDays: readonly string[],
  slotHours: { start: string; end: string; last_start: string },
  timezone: string,
): string {
  const indices = openDays
    .map((d) => WEEKDAY_TOKENS.indexOf(d as WeekdayToken))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) return "";
  const contiguous = indices.every(
    (v, i) => i === 0 || v === indices[i - 1]! + 1,
  );
  const first = WEEKDAY_LONG[WEEKDAY_TOKENS[indices[0]!]!];
  const last = WEEKDAY_LONG[WEEKDAY_TOKENS[indices[indices.length - 1]!]!];
  const daysPart =
    contiguous && indices.length > 1
      ? `${first} to ${last}`
      : indices.map((i) => WEEKDAY_LONG[WEEKDAY_TOKENS[i]!]).join(", ");
  return `${daysPart}, ${slotHours.start}-${slotHours.end}, last appointment ${slotHours.last_start} (${timezone})`;
}

// Cap on how long the dynamic-variables webhook will wait for KV config. A
// slow KV must not stall the 200 the caller expects at assistant init.
const CONFIG_WAIT_MS = 800;

// Tight cap on the secrets read used to fetch the Ed25519 public key. The
// secret store is normally warm, but a hung lookup must not stall the
// assistant-init path — verifyWebhookSignature needs the key, and the
// webhook cannot answer the call without it.
const WEBHOOK_KEY_WAIT_MS = 1000;

// Race loadConfig against a fixed deadline so the webhook cannot hang on a
// slow KV. A late resolution is discarded; a late rejection is caught so it
// cannot escape as an unhandled promise rejection.
async function loadConfigBounded(
  kv: KvNamespace,
): Promise<ConfigResult | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const configPromise = loadConfig(kv).catch(
    (): ConfigResult => ({ ok: false }),
  );
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CONFIG_WAIT_MS);
  });
  const outcome = await Promise.race([configPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

// Module-level cache for a successfully read WEBHOOK_PUBLIC_KEY. The bound
// lookup normally lands in 700+ms on a warm instance (production telemetry),
// which is half of the 1500ms budget Telnyx gives the whole webhook. A
// successful read is immutable for the lifetime of the instance, so we
// short-circuit subsequent requests with this cache and only ever reach
// SECRETS once per instance. Failures are deliberately not cached: a slow
// or empty read on one request must be retried on the next.
let cachedWebhookKey: string | null = null;

// Test-only escape hatch so suites that drive the handler directly can
// observe the first-lookup semantics in isolation. Production code never
// calls this — the cache is invalidated by an instance restart, which is
// the right time to re-read a binding that may have rotated.
export function __resetWebhookKeyCacheForTests(): void {
  cachedWebhookKey = null;
}

// Race the secrets read for the Ed25519 verification key against the fixed
// 1000ms deadline. A late resolution is discarded; a late rejection is
// captured by the .then(_, onRejected) pair so it never escapes as an
// unhandled rejection. The setTimeout handle is cleared once the race
// settles so the timer does not outlive the request. A synchronous throw
// from secrets.get (e.g. an unwired binding) is caught by the surrounding
// try and reported as key_read_failed. The three failure modes are
// reported with distinct, structured reasons so an operator can distinguish
// a slow lookup (key_timeout), an empty or non-string value (key_empty), and
// a rejected promise or synchronous throw (key_read_failed) from runtime
// logs without learning anything about the key value itself.
//
// Diagnostic timing: when the underlying secrets.get operation eventually
// settles — even if the 1000ms timeout has already returned 503 — exactly one
// webhook.key_lookup_completed event is emitted with outcome (ok / empty /
// read_failed), elapsed_ms from the lookup start, after_timeout, and cached.
// A cache hit emits the event with outcome=ok, elapsed_ms≈0, cached=true
// so the warm-path latency stays visible in the same diagnostic stream.
// The log never carries the key, its length, headers, bodies, or raw errors;
// it only records that the lookup settled and how long it took.
async function loadWebhookKeyBounded(
  secrets: Secrets,
): Promise<
  | { ok: true; key: string }
  | { ok: false; reason: "key_timeout" | "key_empty" | "key_read_failed" }
> {
  // Cache hit: short-circuit the bounded lookup so a warm instance never
  // pays the production-observed ~700ms cost on the assistant-init path.
  // We still emit the completion event so the diagnostic stream keeps
  // showing that the warm path is engaged.
  if (cachedWebhookKey !== null) {
    logEvent("webhook.key_lookup_completed", {
      outcome: "ok",
      elapsed_ms: 0,
      after_timeout: false,
      cached: true,
    });
    return { ok: true, key: cachedWebhookKey };
  }

  const startMs = Date.now();
  let timedOut = false;

  const emitCompletion = (
    outcome: "ok" | "empty" | "read_failed",
    afterTimeout: boolean,
  ): void => {
    logEvent("webhook.key_lookup_completed", {
      outcome,
      elapsed_ms: Date.now() - startMs,
      after_timeout: afterTimeout,
      cached: false,
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let keyPromise: Promise<
    | { ok: true; key: string }
    | { ok: false; reason: "key_empty" | "key_read_failed" }
  >;
  try {
    const raw = secrets.get("WEBHOOK_PUBLIC_KEY");
    keyPromise = Promise.resolve(raw).then(
      (key): { ok: true; key: string } | { ok: false; reason: "key_empty" } =>
        typeof key === "string" && key.length > 0
          ? { ok: true, key }
          : { ok: false, reason: "key_empty" },
      (): { ok: false; reason: "key_read_failed" } => ({
        ok: false,
        reason: "key_read_failed",
      }),
    );
  } catch {
    // Synchronous throw from secrets.get — there is no keyPromise to observe,
    // so the completion event is emitted inline. A sync throw means we
    // never had a key in hand, so nothing is cached here either.
    emitCompletion("read_failed", false);
    return { ok: false, reason: "key_read_failed" };
  }

  // Observe keyPromise so a late settle still produces the diagnostic event
  // even if the timeout has already returned 503. keyPromise never rejects
  // (both .then handlers are provided), so no .catch() fallback is needed
  // and no unhandled rejection can escape from this attachment. Only a
  // real, non-empty key is cached: empty values, late rejections, and the
  // timeout path leave the cache empty so the next request retries.
  keyPromise.then((result) => {
    let outcome: "ok" | "empty" | "read_failed";
    if (result.ok) {
      outcome = "ok";
      cachedWebhookKey = result.key;
    } else if (result.reason === "key_empty") {
      outcome = "empty";
    } else {
      outcome = "read_failed";
    }
    emitCompletion(outcome, timedOut);
  });

  const timeoutPromise = new Promise<{ ok: false; reason: "key_timeout" }>(
    (resolve) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          resolve({ ok: false, reason: "key_timeout" });
        },
        WEBHOOK_KEY_WAIT_MS,
      );
    },
  );
  const outcome = await Promise.race([keyPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

// Telnyx calls this endpoint at assistant initialization to fetch runtime
// variables it can interpolate into the conversation. We must answer 200
// quickly regardless of internal state so the call continues; a degraded
// system_status signals the assistant to be cautious about taking bookings.
// Each delivery is verified against the Ed25519 public key stored in
// SECRETS.WEBHOOK_PUBLIC_KEY; a missing / slow / failed secret lookup fails
// closed (503) so an unauthenticated caller cannot reach the handler.

export async function handleDynamicVariables(
  req: Request,
  env: Env,
): Promise<Response> {
  const start = Date.now();
  const recordRejected = () =>
    recordMetric(env.METRICS, {
      event: "webhook",
      outcome: "rejected",
      latency_ms: Date.now() - start,
    });

  if (req.method !== "POST") {
    logEvent("webhook.rejected", {
      reason: "method_not_allowed",
      http_status: 405,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  // Same streaming byte limit as the booking adapter: a missing or false
  // Content-Length must not let an unbounded body into memory.
  const bodyResult = await readBoundedBody(req);
  if (!bodyResult.ok) {
    if (bodyResult.status === 413) {
      logEvent("webhook.rejected", {
        reason: "payload_too_large",
        http_status: 413,
        latency_ms: Date.now() - start,
      });
      await recordRejected();
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    logEvent("webhook.rejected", {
      reason: "body_read_failed",
      http_status: 400,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Verify the delivery before parsing or touching KV. The key read is
  // bounded (1000ms) so a slow secrets backend cannot stall the assistant
  // init path; every failure mode — missing binding, empty value, late or
  // rejected promise, synchronous throw — collapses to a generic 503, with
  // no leaked detail. The diagnostic reason on the log line is the only
  // way to tell them apart.
  if (env.SECRETS === undefined) {
    logEvent("webhook.rejected", {
      reason: "secrets_binding_missing",
      http_status: 503,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  const keyResult = await loadWebhookKeyBounded(env.SECRETS);
  if (!keyResult.ok) {
    logEvent("webhook.rejected", {
      reason: keyResult.reason,
      http_status: 503,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }

  const verifyOutcome = await verifyWebhookSignature({
    rawBody: bodyResult.raw,
    headers: req.headers,
    publicKeyBase64: keyResult.key,
    nowMs: Date.now(),
  });
  if (verifyOutcome.kind === "invalid_configuration") {
    // A malformed key is a deployment problem; surface the same generic 503
    // a slow secrets lookup would, so an operator can fix the binding
    // without distinguishing the two cases by status code.
    logEvent("webhook.rejected", {
      reason: "verification_configuration_invalid",
      http_status: 503,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (verifyOutcome.kind === "invalid_signature") {
    logEvent("webhook.rejected", {
      reason: "invalid_signature",
      http_status: 401,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyResult.text);
  } catch {
    logEvent("webhook.rejected", {
      reason: "invalid_json",
      http_status: 400,
      latency_ms: Date.now() - start,
    });
    await recordRejected();
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // The docs describe the event's `payload` fields without being explicit
  // about a `data` envelope, so accept both {data:{payload}} and {payload}.
  const root =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const data =
    typeof root.data === "object" && root.data !== null ? root.data : root;
  const payload =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).payload
      : undefined;
  const payloadObj =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  // call_control_id and assistant_id arrive in an unauthenticated webhook
  // payload; only a bounded safe charset is forwarded to the structured log so
  // a hostile payload cannot inject newlines, control bytes, or arbitrary text
  // into runtime logs.
  const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
  function readSafeId(value: unknown): string {
    return typeof value === "string" && ID_PATTERN.test(value) ? value : "";
  }
  const callControlId = readSafeId(payloadObj.call_control_id);
  const callerRaw =
    typeof payloadObj.telnyx_end_user_target === "string"
      ? payloadObj.telnyx_end_user_target
      : "";
  const assistantId = readSafeId(payloadObj.assistant_id);

  let bookingEnabled = false;
  let serviceList = "";
  let businessHours = "";
  let systemStatus = "ok";
  let configOutcome: "ok" | "timeout" | "load_failed" | "absent" = "ok";
  if (env.CONFIG === undefined) {
    configOutcome = "absent";
    systemStatus = "degraded";
  } else {
    const cfgResult = await loadConfigBounded(env.CONFIG);
    if (cfgResult === "timeout") {
      configOutcome = "timeout";
      systemStatus = "degraded";
    } else if (!cfgResult.ok) {
      configOutcome = "load_failed";
      systemStatus = "degraded";
    } else {
      configOutcome = "ok";
      bookingEnabled = cfgResult.config.business.booking_enabled;
      serviceList = cfgResult.config.services
        .map((s) => s.name)
        .join(", ");
      businessHours = formatBusinessHours(
        cfgResult.config.business.open_days,
        cfgResult.config.business.slot_hours,
        cfgResult.config.business.timezone,
      );
    }
  }

  const now = Date.now();
  const todayLocal = getLocalDateString(now);
  const [yy, mm, dd] = todayLocal.split("-").map(Number);
  const weekday =
    WEEKDAY_NAMES[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
  const timeParts = getLocalTimeParts(now);
  const hh = String(timeParts.hour).padStart(2, "0");
  const min = String(timeParts.minute).padStart(2, "0");

  logEvent("webhook.dynamic_variables", {
    call_control_id: callControlId,
    caller: maskPhone(callerRaw),
    assistant_id: assistantId,
    system_status: systemStatus,
    booking_enabled: bookingEnabled ? "true" : "false",
    config_outcome: configOutcome,
    latency_ms: Date.now() - start,
  });
  await recordMetric(env.METRICS, {
    event: "webhook",
    outcome: systemStatus,
    latency_ms: Date.now() - start,
  });

  return Response.json({
    dynamic_variables: {
      booking_enabled: bookingEnabled ? "true" : "false",
      system_status: systemStatus,
      today_local: todayLocal,
      today_weekday: weekday,
      now_local_time: `${hh}:${min}`,
      business_hours: businessHours,
      service_list: serviceList,
    },
  });
}
