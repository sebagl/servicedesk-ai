#!/usr/bin/env node
// scripts/verify-mcp-conversation.mjs
//
// One-booking-per-conversation verification over MCP.
//
// Sends five sequential tool calls and one final availability read against
// /mcp, with a single shared conversation id derived from --run-id. Passes
// only when:
//   1. get_availability reports booking_enabled=true and both the primary
//      and alternate times are available on the requested date.
//   2. create_booking with the primary time confirms and returns a
//      booking_id.
//   3. An identical retry with the same conversation id returns the SAME
//      booking_id.
//   4. A second create_booking on the same conversation with a different
//      time is rejected with conversation_already_booked.
//   5. A final get_availability read confirms the primary slot is occupied
//      and the alternate slot is still available.
//
// SAFETY:
//   - Each step returns an explicit PASS/FAIL/INCONCLUSIVE outcome. The
//     orchestrator stops at the first non-PASS outcome — no booking call is
//     ever made after a failed preflight, replay timeout, or tool error.
//   - Booking transport failures, service_unavailable responses, and
//     malformed success payloads are all INCONCLUSIVE: a booking may exist.
//   - Output is restricted to fixed labels and allowlisted tool codes. Raw
//     tool text, remote error strings, and caught exception messages are
//     never printed.
//   - Confirmed responses are cross-checked against the requested
//     service/date/time and must carry a nonempty booking_id.
//
// WARNING: This script creates ONE real synthetic booking on the target date
// at the primary time. There is no cleanup/cancellation endpoint. The
// synthetic customer data is intentionally generic and never logged, but the
// remote Actor persists the booking until manually cleared.
//
// Requirements:
//   - MCP_API_TOKEN in the environment (exported in the shell). It is read
//     from process.env ONLY and never printed, logged, or included in any
//     error message.
//   - Explicit base URL, date, primary time, alternate time, and run ID
//     arguments.
//
// Usage:
//   MCP_API_TOKEN=<token> node scripts/verify-mcp-conversation.mjs \
//     --base-url https://<edge-host> \
//     --date 2026-10-22 \
//     --time 11:00 \
//     --alternate-time 12:00 \
//     --run-id conv-probe-2026-10-22

import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SERVICE_ID = "oil_change";
const SYNTHETIC_CUSTOMER_NAME = "MCP Conversation Probe";
const SYNTHETIC_CUSTOMER_PHONE = "+52 55 0000 0000";

const REQUIRED_ARGS = ["base-url", "date", "time", "alternate-time", "run-id"];

// Allowlisted tool error codes; anything outside this set collapses to a
// fixed label so the script never echoes unverified remote text.
const ALLOWED_TOOL_ERROR_CODES = new Set([
  "date_out_of_range",
  "date_invalid",
  "date_not_open",
  "time_invalid",
  "slot_in_past",
  "slot_unavailable",
  "idempotency_key_conflict",
  "conversation_already_booked",
  "unknown_service",
  "confirmation_required",
  "booking_disabled",
  "service_unavailable",
]);

// Fixed labels for outcomes that do not map to an allowlisted code. These
// are the ONLY strings the script ever prints as a detail.
const LABEL = Object.freeze({
  TRANSPORT_TIMEOUT: "transport_timeout",
  TRANSPORT_UNAVAILABLE: "transport_unavailable",
  HTTP_NON_2XX: "http_non_2xx",
  ENVELOPE_INVALID: "envelope_invalid",
  TOOL_ERROR_UNCLASSIFIED: "tool_error_unclassified",
  CONFIRMED_PAYLOAD_MISMATCH: "confirmed_payload_mismatch",
  BOOKING_ID_MISSING: "booking_id_missing",
  NO_ERROR_RETURNED: "no_error_returned",
  REPLAY_ID_MISMATCH: "replay_booking_id_mismatch",
  BOOKING_DISABLED: "booking_disabled_false",
  SLOT_NOT_AVAILABLE: "slot_not_available",
  AVAILABILITY_TIMES_MISSING: "availability_times_missing",
  UNEXPECTED_FETCH: "unexpected_fetch_call",
});

// ---------------------------------------------------------------------------
// Argument and ID helpers
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        return { error: `Missing value for --${key}` };
      }
      args[key] = val;
      i++;
    }
  }
  return { args };
}

export function deriveConversationId(runId) {
  return `conv-${runId}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Performs a fetch with a fixed AbortController timeout. The timer stays
// armed through response body consumption so a stalled body cannot hang the
// script indefinitely; it is cleared in a finally so it is always released.
export async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const { fetchImpl, fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const body = await res.json();
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, kind: "timeout" };
    }
    return { ok: false, kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP envelope helpers
// ---------------------------------------------------------------------------

function mcpHeaders(token) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

function toolCallBody(id, name, arguments_, meta) {
  const params = { name, arguments: arguments_ };
  if (meta !== undefined) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

function bookingArgs(serviceId, date, time) {
  return {
    service_id: serviceId,
    date,
    time,
    customer_name: SYNTHETIC_CUSTOMER_NAME,
    customer_phone: SYNTHETIC_CUSTOMER_PHONE,
    confirmed: true,
  };
}

// Decodes a JSON-RPC tool result envelope and classifies the outcome to a
// fixed label or allowlisted code. Never returns the raw tool text.
export function classifyToolResult(envelope) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.result === null ||
    typeof envelope.result !== "object" ||
    !Array.isArray(envelope.result.content) ||
    envelope.result.content.length === 0
  ) {
    return { ok: false, reason: LABEL.ENVELOPE_INVALID };
  }
  const first = envelope.result.content[0];
  if (!first || typeof first !== "object" || typeof first.text !== "string") {
    return { ok: false, reason: LABEL.ENVELOPE_INVALID };
  }
  const text = first.text;
  const isError = envelope.result.isError === true;

  if (isError) {
    if (text === "service_unavailable") {
      return { ok: false, code: "service_unavailable", reason: LABEL.TOOL_ERROR_UNCLASSIFIED };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      const code = parsed.error;
      if (ALLOWED_TOOL_ERROR_CODES.has(code)) {
        return { ok: false, code, reason: code };
      }
      return { ok: false, code, reason: LABEL.TOOL_ERROR_UNCLASSIFIED };
    }
    return { ok: false, reason: LABEL.TOOL_ERROR_UNCLASSIFIED };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: LABEL.ENVELOPE_INVALID };
  }
  return { ok: true, payload: parsed };
}

// Validates a confirmed booking payload. The payload must declare status
// "confirmed" and echo the requested service/date/time with a nonempty
// booking_id. Any mismatch collapses to a non-PASS outcome so the caller
// can stop before issuing further booking requests.
export function validateConfirmed(payload, expected) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: LABEL.CONFIRMED_PAYLOAD_MISMATCH };
  }
  if (payload.status !== "confirmed") {
    return { ok: false, reason: LABEL.CONFIRMED_PAYLOAD_MISMATCH };
  }
  if (typeof payload.booking_id !== "string" || payload.booking_id.length === 0) {
    return { ok: false, reason: LABEL.BOOKING_ID_MISSING };
  }
  if (payload.service_id !== expected.serviceId) {
    return { ok: false, reason: LABEL.CONFIRMED_PAYLOAD_MISMATCH };
  }
  if (payload.date !== expected.date) {
    return { ok: false, reason: LABEL.CONFIRMED_PAYLOAD_MISMATCH };
  }
  if (payload.time !== expected.time) {
    return { ok: false, reason: LABEL.CONFIRMED_PAYLOAD_MISMATCH };
  }
  return { ok: true, bookingId: payload.booking_id };
}

// ---------------------------------------------------------------------------
// Step primitives
// ---------------------------------------------------------------------------

async function readAvailability(ctx, stepId) {
  const body = toolCallBody(stepId, "get_availability", { date: ctx.date });
  const fetchRes = await fetchJsonWithTimeout(
    ctx.mcpUrl,
    {
      fetchImpl: ctx.fetchImpl,
      fetchOptions: {
        method: "POST",
        headers: mcpHeaders(ctx.token),
        body: JSON.stringify(body),
      },
    },
    ctx.timeoutMs,
  );

  if (!fetchRes.ok) {
    return {
      outcome: "FAIL",
      detail: fetchRes.kind === "timeout" ? LABEL.TRANSPORT_TIMEOUT : LABEL.TRANSPORT_UNAVAILABLE,
    };
  }
  if (fetchRes.status !== 200) {
    return { outcome: "FAIL", detail: LABEL.HTTP_NON_2XX };
  }
  const classified = classifyToolResult(fetchRes.body);
  if (!classified.ok) {
    return { outcome: "FAIL", detail: classified.reason };
  }
  return { outcome: "PASS", payload: classified.payload };
}

// Returns one of: { kind: "confirmed", bookingId }, { kind: "tool_error", code, reason }, { kind: "malformed", reason }, { kind: "transport", reason }, { kind: "http", reason }.
async function callCreateBooking(ctx, stepId, time) {
  const body = toolCallBody(
    stepId,
    "create_booking",
    bookingArgs(ctx.serviceId, ctx.date, time),
    { telnyx_conversation_id: ctx.conversationId },
  );
  const fetchRes = await fetchJsonWithTimeout(
    ctx.mcpUrl,
    {
      fetchImpl: ctx.fetchImpl,
      fetchOptions: {
        method: "POST",
        headers: mcpHeaders(ctx.token),
        body: JSON.stringify(body),
      },
    },
    ctx.timeoutMs,
  );

  if (!fetchRes.ok) {
    return {
      kind: "transport",
      reason: fetchRes.kind === "timeout" ? LABEL.TRANSPORT_TIMEOUT : LABEL.TRANSPORT_UNAVAILABLE,
    };
  }
  if (fetchRes.status !== 200) {
    return { kind: "http", reason: LABEL.HTTP_NON_2XX };
  }
  const classified = classifyToolResult(fetchRes.body);
  if (!classified.ok) {
    if (classified.code === "service_unavailable") {
      return { kind: "tool_error", code: "service_unavailable", reason: LABEL.TOOL_ERROR_UNCLASSIFIED };
    }
    if (classified.code) {
      return { kind: "tool_error", code: classified.code, reason: classified.reason };
    }
    return { kind: "tool_error", reason: classified.reason };
  }
  const validated = validateConfirmed(classified.payload, {
    serviceId: ctx.serviceId,
    date: ctx.date,
    time,
  });
  if (!validated.ok) {
    return { kind: "malformed", reason: validated.reason };
  }
  return { kind: "confirmed", bookingId: validated.bookingId };
}

// Every booking kind other than "confirmed" is INCONCLUSIVE because the
// actor may have stored the booking before returning a degraded response.
function bookingOutcomeFromKind(kind) {
  return kind === "confirmed" ? "PASS" : "INCONCLUSIVE";
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function step1Availability(ctx) {
  const res = await readAvailability(ctx, 1);
  if (res.outcome !== "PASS") return res;
  const payload = res.payload;
  if (payload.booking_enabled !== true) {
    return { outcome: "FAIL", detail: LABEL.BOOKING_DISABLED };
  }
  if (!Array.isArray(payload.available_times)) {
    return { outcome: "FAIL", detail: LABEL.AVAILABILITY_TIMES_MISSING };
  }
  if (!payload.available_times.includes(ctx.primaryTime)) {
    return { outcome: "FAIL", detail: LABEL.SLOT_NOT_AVAILABLE };
  }
  if (!payload.available_times.includes(ctx.alternateTime)) {
    return { outcome: "FAIL", detail: LABEL.SLOT_NOT_AVAILABLE };
  }
  return { outcome: "PASS" };
}

async function step2FirstBooking(ctx) {
  const res = await callCreateBooking(ctx, 2, ctx.primaryTime);
  if (res.kind === "confirmed") {
    return { outcome: "PASS", bookingId: res.bookingId };
  }
  return { outcome: bookingOutcomeFromKind(res.kind), detail: res.reason };
}

async function step3Replay(ctx, expectedBookingId) {
  const res = await callCreateBooking(ctx, 3, ctx.primaryTime);
  if (res.kind === "confirmed") {
    if (res.bookingId !== expectedBookingId) {
      return { outcome: "FAIL", detail: LABEL.REPLAY_ID_MISMATCH };
    }
    return { outcome: "PASS" };
  }
  return { outcome: bookingOutcomeFromKind(res.kind), detail: res.reason };
}

async function step4Alternate(ctx) {
  const res = await callCreateBooking(ctx, 4, ctx.alternateTime);
  if (res.kind === "confirmed") {
    return { outcome: "FAIL", detail: LABEL.NO_ERROR_RETURNED };
  }
  if (res.kind === "tool_error") {
    // service_unavailable may mean the actor stored the booking and then
    // failed on the way out — collapse to INCONCLUSIVE.
    if (res.code === "service_unavailable") {
      return { outcome: "INCONCLUSIVE", detail: res.reason };
    }
    if (res.code === "conversation_already_booked") {
      return { outcome: "PASS" };
    }
    // Any other allowlisted rejection means the actor did not see the
    // conversation-already-booked state we expected.
    return { outcome: "FAIL", detail: res.reason };
  }
  return { outcome: bookingOutcomeFromKind(res.kind), detail: res.reason };
}

async function step5PostAvailability(ctx) {
  const res = await readAvailability(ctx, 5);
  if (res.outcome !== "PASS") {
    return { outcome: "FAIL", detail: res.detail, subchecks: [] };
  }
  const times = res.payload.available_times;
  if (!Array.isArray(times)) {
    return {
      outcome: "FAIL",
      detail: LABEL.AVAILABILITY_TIMES_MISSING,
      subchecks: [],
    };
  }
  const primaryOccupied = !times.includes(ctx.primaryTime);
  const alternateAvailable = times.includes(ctx.alternateTime);
  const subchecks = [
    {
      name: "post.availability.primary_occupied",
      outcome: primaryOccupied ? "PASS" : "FAIL",
      detail: primaryOccupied ? undefined : LABEL.SLOT_NOT_AVAILABLE,
    },
    {
      name: "post.availability.alternate_available",
      outcome: alternateAvailable ? "PASS" : "FAIL",
      detail: alternateAvailable ? undefined : LABEL.SLOT_NOT_AVAILABLE,
    },
  ];
  return {
    outcome: primaryOccupied && alternateAvailable ? "PASS" : "FAIL",
    subchecks,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function validateArgs(args, token) {
  for (const k of REQUIRED_ARGS) {
    if (!args[k]) return { error: `Missing required argument: --${k}` };
  }
  if (args["time"] === args["alternate-time"]) {
    return { error: "--time and --alternate-time must be distinct." };
  }
  if (!token || token.length === 0) {
    return { error: "MCP_API_TOKEN is not set in the environment. Export it before running." };
  }
  return { ok: true };
}

function summarize(checks, bookingId, fatalError) {
  const failed = checks.some((c) => c.outcome === "FAIL");
  const inconclusive = checks.some((c) => c.outcome === "INCONCLUSIVE");
  let outcome;
  let exitCode;
  if (fatalError) {
    outcome = "FAIL";
    exitCode = 2;
  } else if (inconclusive) {
    outcome = "INCONCLUSIVE";
    exitCode = 2;
  } else if (failed) {
    outcome = "FAIL";
    exitCode = 1;
  } else {
    outcome = "PASS";
    exitCode = 0;
  }
  return { outcome, exitCode, checks, bookingId, fatalError };
}

export async function run({
  args,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  serviceId = DEFAULT_SERVICE_ID,
}) {
  const checks = [];
  const validation = validateArgs(args, token);
  if (validation.error) {
    return summarize(checks, null, validation.error);
  }

  const ctx = {
    baseUrl: args["base-url"],
    mcpUrl: `${args["base-url"]}/mcp`,
    date: args["date"],
    primaryTime: args["time"],
    alternateTime: args["alternate-time"],
    conversationId: deriveConversationId(args["run-id"]),
    serviceId,
    token,
    fetchImpl,
    timeoutMs,
  };

  const r1 = await step1Availability(ctx);
  checks.push({ name: "availability.preflight", outcome: r1.outcome, detail: r1.detail });
  if (r1.outcome !== "PASS") {
    return summarize(checks, null);
  }

  const r2 = await step2FirstBooking(ctx);
  let bookingId = null;
  if (r2.bookingId) bookingId = r2.bookingId;
  checks.push({ name: "booking.first", outcome: r2.outcome, detail: r2.detail });
  if (r2.outcome !== "PASS") {
    return summarize(checks, bookingId);
  }

  const r3 = await step3Replay(ctx, bookingId);
  checks.push({ name: "booking.replay", outcome: r3.outcome, detail: r3.detail });
  if (r3.outcome !== "PASS") {
    return summarize(checks, bookingId);
  }

  const r4 = await step4Alternate(ctx);
  checks.push({ name: "booking.alternate", outcome: r4.outcome, detail: r4.detail });
  if (r4.outcome !== "PASS") {
    return summarize(checks, bookingId);
  }

  const r5 = await step5PostAvailability(ctx);
  if (Array.isArray(r5.subchecks) && r5.subchecks.length > 0) {
    checks.push(...r5.subchecks);
  } else {
    checks.push({ name: "post.availability", outcome: r5.outcome, detail: r5.detail });
  }

  return summarize(checks, bookingId);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.error("Usage: MCP_API_TOKEN=<token> node scripts/verify-mcp-conversation.mjs \\");
  console.error("  --base-url <url> --date <YYYY-MM-DD> --time <HH:mm> \\");
  console.error("  --alternate-time <HH:mm> --run-id <id>");
}

function printResult(result) {
  for (const c of result.checks) {
    const tag =
      c.outcome === "PASS" ? "PASS" : c.outcome === "INCONCLUSIVE" ? "INCONCLUSIVE" : "FAIL";
    console.log(`  [${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (result.bookingId) {
    console.log(`  booking_id: ${result.bookingId}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.error) {
    console.error(parsed.error);
    printUsage();
    process.exit(2);
  }
  const args = parsed.args;

  for (const k of REQUIRED_ARGS) {
    if (!args[k]) {
      console.error(`Missing required argument: --${k}`);
      printUsage();
      process.exit(2);
    }
  }
  if (args["time"] === args["alternate-time"]) {
    console.error("--time and --alternate-time must be distinct.");
    process.exit(2);
  }

  const token = process.env.MCP_API_TOKEN;
  if (!token || token.length === 0) {
    console.error("MCP_API_TOKEN is not set in the environment. Export it before running.");
    printUsage();
    process.exit(2);
  }

  console.log("=== MCP One-Booking-Per-Conversation Verification ===");
  console.log(`Base URL:        ${args["base-url"]}`);
  console.log(`Date:            ${args["date"]}`);
  console.log(`Primary time:    ${args["time"]}`);
  console.log(`Alternate time:  ${args["alternate-time"]}`);
  console.log(`Run ID:          ${args["run-id"]}`);
  console.log(`Conversation ID: ${deriveConversationId(args["run-id"])}`);
  console.log();
  console.log("WARNING: This run creates ONE real synthetic booking at the");
  console.log("primary time. There is no cleanup/cancellation endpoint. The");
  console.log("remote Actor will retain the booking until cleared manually.");

  const result = await run({ args, token, fetchImpl: globalThis.fetch });
  printResult(result);

  if (result.fatalError) {
    console.error(result.fatalError);
    console.error("FAIL: preflight validation failed.");
    process.exit(result.exitCode);
  }
  if (result.outcome === "INCONCLUSIVE") {
    console.error("INCONCLUSIVE: a booking may have been created but could not be confirmed.");
    process.exit(result.exitCode);
  }
  if (result.outcome === "FAIL") {
    console.error("FAIL: one or more checks did not pass.");
    process.exit(result.exitCode);
  }
  console.log("PASS: all checks succeeded.");
  process.exit(0);
}

// Direct execution only — never run main() on import (test harness imports this file).
if (
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error("Unexpected error.");
    process.exit(1);
  });
}
