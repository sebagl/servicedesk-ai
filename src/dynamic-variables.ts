import type { KvNamespace, Secrets } from "@telnyx/edge-runtime";

import { loadConfig, type ConfigResult } from "./config";
import { readBoundedBody } from "./bookings";
import { getLocalDateString, getLocalTimeParts } from "./scheduling";
import { logEvent, maskPhone } from "./logger";
import { verifyWebhookSignature } from "./webhook-signature";

interface Env {
  CONFIG?: KvNamespace;
  SECRETS?: Secrets;
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
const WEBHOOK_KEY_WAIT_MS = 200;

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

// Race the secrets read for the Ed25519 verification key against a fixed
// deadline. Mirrors loadConfigBounded: a late resolution is discarded, a
// late rejection is converted to ok:false so it cannot escape as an
// unhandled rejection. The setTimeout handle is always cleared once the race
// settles, so the timer does not outlive the request.
async function loadWebhookKeyBounded(
  secrets: Secrets,
): Promise<{ ok: true; key: string } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keyPromise = secrets.get("WEBHOOK_PUBLIC_KEY").then(
    (key): { ok: true; key: string } | { ok: false } =>
      typeof key === "string" && key.length > 0
        ? { ok: true, key }
        : { ok: false },
    (): { ok: false } => ({ ok: false }),
  );
  const timeoutPromise = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), WEBHOOK_KEY_WAIT_MS);
  });
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

  if (req.method !== "POST") {
    logEvent("webhook.rejected", {
      reason: "method_not_allowed",
      http_status: 405,
      latency_ms: Date.now() - start,
    });
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
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    logEvent("webhook.rejected", {
      reason: "body_read_failed",
      http_status: 400,
      latency_ms: Date.now() - start,
    });
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Verify the delivery before parsing or touching KV. The key read is
  // bounded (200ms) so a slow secrets backend cannot stall the assistant
  // init path; any failure — missing binding, empty value, late or rejected
  // promise — collapses to a generic 503, with no leaked detail.
  if (env.SECRETS === undefined) {
    logEvent("webhook.rejected", {
      reason: "key_unavailable",
      http_status: 503,
      latency_ms: Date.now() - start,
    });
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  const keyResult = await loadWebhookKeyBounded(env.SECRETS);
  if (!keyResult.ok) {
    logEvent("webhook.rejected", {
      reason: "key_unavailable",
      http_status: 503,
      latency_ms: Date.now() - start,
    });
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
      reason: "key_unavailable",
      http_status: 503,
      latency_ms: Date.now() - start,
    });
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
  if (verifyOutcome.kind === "invalid_signature") {
    logEvent("webhook.rejected", {
      reason: "invalid_signature",
      http_status: 401,
      latency_ms: Date.now() - start,
    });
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
