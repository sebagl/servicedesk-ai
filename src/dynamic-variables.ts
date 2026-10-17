import type { KvNamespace } from "@telnyx/edge-runtime";

import { loadConfig, type ConfigResult } from "./config";
import { readBoundedBody } from "./bookings";
import { getLocalDateString, getLocalTimeParts } from "./scheduling";
import { logEvent, maskPhone } from "./logger";

interface Env {
  CONFIG?: KvNamespace;
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

// Telnyx calls this endpoint at assistant initialization to fetch runtime
// variables it can interpolate into the conversation. We must answer 200
// quickly regardless of internal state so the call continues; a degraded
// system_status signals the assistant to be cautious about taking bookings.
// NOTE: Telnyx request signature verification is a planned follow-up; the
// endpoint is currently unauthenticated because it returns only non-sensitive
// business info.

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
