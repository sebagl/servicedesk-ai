#!/usr/bin/env node
// scripts/verify-booking-concurrency.mjs
//
// Bounded remote booking concurrency test.
// Sends 20 booking requests with concurrency capped at 5 against the same
// slot. Passes only if exactly 1 confirms and 19 return slot_unavailable.
//
// WARNING: This creates ONE real synthetic booking. It is NOT a load test
// and NOT proof of production-scale correctness. It verifies the Actor's
// single-threaded dispatch under bounded concurrency for the specific
// slot under test.
//
// Requirements:
//   - SMOKE_TEST_TOKEN in the environment (exported in the shell).
//   - Explicit base URL, date, time, and run ID arguments.
//
// Usage:
//   SMOKE_TEST_TOKEN=<token> node scripts/verify-booking-concurrency.mjs \
//     --base-url https://servicedesk-ai-a666861a-1.telnyxcompute.com \
//     --date 2026-10-22 \
//     --time 11:00 \
//     --run-id my-concurrency-run
//
// The token is read from the process environment ONLY.
// It is never printed, logged, or included in error messages.

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        console.error(`Missing value for --${key}`);
        process.exit(2);
      }
      args[key] = val;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { args, positional };
}

const { args } = parseArgs(process.argv);

const BASE_URL = args["base-url"];
const DATE = args["date"];
const TIME = args["time"];
const RUN_ID = args["run-id"];

const REQUIRED = ["base-url", "date", "time", "run-id"];
for (const k of REQUIRED) {
  if (!args[k]) {
    console.error(`Missing required argument: --${k}`);
    console.error("Usage: SMOKE_TEST_TOKEN=<token> node scripts/verify-booking-concurrency.mjs \\");
    console.error("  --base-url <url> --date <YYYY-MM-DD> --time <HH:mm> --run-id <id>");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Token from environment only — never read .env, never print it
// ---------------------------------------------------------------------------

const TOKEN = process.env.SMOKE_TEST_TOKEN;
if (!TOKEN || TOKEN.length === 0) {
  console.error("SMOKE_TEST_TOKEN is not set in the environment. Export it before running.");
  console.error("Example: export SMOKE_TEST_TOKEN=$(...); node scripts/verify-booking-concurrency.mjs ...");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONCURRENCY = 5;
const TOTAL_REQUESTS = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const SERVICE_ID = "oil_change";
const CUSTOMER_NAME = "Concurrency Probe";
const CUSTOMER_PHONE = "+52 55 0000 0000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { ok: true, res };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, kind: "timeout" };
    }
    return { ok: false, kind: "network", message: "request failed (network)" };
  }
}

async function checkPreflight() {
  const url = `${BASE_URL}/demo/availability?date=${DATE}`;
  const result = await fetchWithTimeout(
    url,
    { method: "GET", headers: authHeaders() },
    REQUEST_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.kind === "timeout") {
      console.error("Preflight: availability request timed out.");
    } else {
      console.error(`Preflight: availability request failed (${result.kind}).`);
    }
    return null;
  }
  const res = result.res;
  if (res.status !== 200) {
    console.error(`Preflight: availability returned HTTP ${res.status}.`);
    const body = await res.text().catch(() => "(unreadable)");
    console.error(`  body: ${body.slice(0, 200)}`);
    return null;
  }
  const body = await res.json();
  if (body.booking_enabled !== true) {
    console.error("Preflight: booking_enabled is not true. Stopping.");
    return null;
  }
  const slot = body.slots?.find((s) => s.time === TIME);
  if (!slot) {
    console.error(`Preflight: slot ${TIME} not found in availability for ${DATE}.`);
    console.error("  Available slots:", body.slots?.map((s) => s.time).join(", ") || "none");
    return null;
  }
  if (slot.available !== true) {
    console.error(`Preflight: slot ${TIME} is already occupied. Stopping.`);
    return null;
  }
  console.log(`Preflight: slot ${TIME} on ${DATE} is available and booking_enabled=true.`);
  return true;
}

function makeBookingBody(idempotencyKey) {
  return JSON.stringify({
    service_id: SERVICE_ID,
    date: DATE,
    time: TIME,
    customer_name: CUSTOMER_NAME,
    customer_phone: CUSTOMER_PHONE,
    idempotency_key: idempotencyKey,
    confirmed: true,
  });
}

function makeIdempotencyKey(index) {
  return `${RUN_ID}-req-${String(index).padStart(2, "0")}`;
}

async function sendBookingRequest(index) {
  const key = makeIdempotencyKey(index);
  const url = `${BASE_URL}/demo/bookings`;
  const result = await fetchWithTimeout(
    url,
    { method: "POST", headers: authHeaders(), body: makeBookingBody(key) },
    REQUEST_TIMEOUT_MS,
  );
  if (!result.ok) {
    return { index, key, outcome: result.kind === "timeout" ? "timeout" : "network_error" };
  }
  const res = result.res;
  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (res.status === 200 && body.status === "confirmed" && typeof body.booking_id === "string") {
    return { index, key, outcome: "confirmed", bookingId: body.booking_id };
  }
  if (res.status === 400 && body.error === "slot_unavailable") {
    return { index, key, outcome: "slot_unavailable" };
  }
  if (res.status === 400 && typeof body.error === "string") {
    return { index, key, outcome: "domain_error", code: body.error, httpStatus: res.status };
  }
  if (res.status === 400) {
    return { index, key, outcome: "unexpected_400", httpStatus: res.status, body };
  }
  return { index, key, outcome: "unexpected_status", httpStatus: res.status, body };
}

// Bounded concurrency pool
async function runBounded(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function checkPostflight() {
  const url = `${BASE_URL}/demo/availability?date=${DATE}`;
  const result = await fetchWithTimeout(
    url,
    { method: "GET", headers: authHeaders() },
    REQUEST_TIMEOUT_MS,
  );
  if (!result.ok) {
    console.error("Postflight: availability request failed. Cannot verify occupancy.");
    return null;
  }
  const res = result.res;
  if (res.status !== 200) {
    console.error(`Postflight: availability returned HTTP ${res.status}.`);
    return null;
  }
  const body = await res.json();
  const slot = body.slots?.find((s) => s.time === TIME);
  if (!slot) {
    console.error(`Postflight: slot ${TIME} not found in availability.`);
    return null;
  }
  return slot.available === false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Booking Concurrency Verification ===");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Date: ${DATE}  Time: ${TIME}  Run ID: ${RUN_ID}`);
  console.log(`Requests: ${TOTAL_REQUESTS}  Concurrency: ${CONCURRENCY}`);
  console.log();

  // Preflight
  const preflightOk = await checkPreflight();
  if (!preflightOk) {
    console.error("Preflight failed. Stopping.");
    process.exit(1);
  }

  // Send 20 requests with bounded concurrency
  console.log(`Sending ${TOTAL_REQUESTS} booking requests (concurrency: ${CONCURRENCY})...`);
  const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, i) => () =>
    sendBookingRequest(i),
  );
  const results = await runBounded(tasks, CONCURRENCY);

  // Tally outcomes
  const counts = {
    confirmed: 0,
    slot_unavailable: 0,
    domain_error: 0,
    unexpected_400: 0,
    unexpected_status: 0,
    network_error: 0,
    timeout: 0,
  };
  let confirmedId = null;

  for (const r of results) {
    counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    if (r.outcome === "confirmed") {
      confirmedId = r.bookingId;
    }
    if (r.outcome !== "confirmed" && r.outcome !== "slot_unavailable") {
      console.error(
        `  Request ${r.index} (key=${r.key}): ${r.outcome}` +
        (r.code ? ` code=${r.code}` : "") +
        (r.httpStatus ? ` HTTP ${r.httpStatus}` : ""),
      );
    }
  }

  console.log();
  console.log("=== Results ===");
  console.log(`  confirmed: ${counts.confirmed}`);
  console.log(`  slot_unavailable: ${counts.slot_unavailable}`);
  console.log(`  domain_error (other): ${counts.domain_error}`);
  console.log(`  unexpected_400: ${counts.unexpected_400}`);
  console.log(`  unexpected_status: ${counts.unexpected_status}`);
  console.log(`  network_error: ${counts.network_error}`);
  console.log(`  timeout: ${counts.timeout}`);

  const ambiguous = counts.network_error + counts.timeout;
  const unexpected =
    counts.domain_error +
    counts.unexpected_400 +
    counts.unexpected_status +
    ambiguous;

  console.log();
  console.log(`  ambiguous (network/timeout): ${ambiguous}`);
  console.log(`  unexpected total: ${unexpected}`);

  if (confirmedId) {
    console.log(`  winning booking_id: ${confirmedId}`);
  } else {
    console.log("  winning booking_id: (none)");
  }

  // Pass criteria
  const pass =
    counts.confirmed === 1 &&
    counts.slot_unavailable === 19 &&
    unexpected === 0;

  console.log();
  if (!pass) {
    console.error("FAIL: Expected exactly 1 confirmed and 19 slot_unavailable with no unexpected/ambiguous outcomes.");
    console.error(`  Got: ${counts.confirmed} confirmed, ${counts.slot_unavailable} slot_unavailable, ${unexpected} unexpected/ambiguous.`);
    process.exit(1);
  }

  console.log("PASS: Exactly 1 confirmed, 19 slot_unavailable, no unexpected outcomes.");

  // Postflight: verify slot is occupied
  console.log();
  console.log("Checking postflight availability...");
  const occupied = await checkPostflight();
  if (occupied === null) {
    console.error("Postflight check failed. Results above are inconclusive.");
    process.exit(1);
  }
  if (!occupied) {
    console.error(`FAIL: Slot ${TIME} on ${DATE} is NOT occupied after the confirmed booking.`);
    process.exit(1);
  }
  console.log(`PASS: Slot ${TIME} on ${DATE} is occupied in postflight availability.`);
  console.log();
  console.log("=== Verification complete ===");
  console.log(`Booking ID: ${confirmedId}`);
  console.log("Note: This created one real synthetic booking. No cleanup/cancellation endpoint exists.");
  console.log("Note: This is NOT a load test or proof of production-scale correctness.");
}

main().catch((err) => {
  // Never print the token or credentials in the error.
  console.error("Unexpected error:", err.message || "(no message)");
  process.exit(1);
});
