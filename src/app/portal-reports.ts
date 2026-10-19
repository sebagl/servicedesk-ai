import type { KvNamespace } from "@telnyx/edge-runtime";

import type {
  AgendaNamespace,
  CallbackQueueNamespace,
  MetricsNamespace,
} from "../actors/bindings";
import type { CallbackEntry } from "../actors/callback-queue";
import type { BookingListItem } from "../actors/day-agenda";
import { emptySnapshot, type MetricsSnapshot } from "../actors/metrics";
import { LOCATION_ID, TIMEZONE, agendaActorName } from "../domain/business-rules";
import { loadConfig } from "../domain/config";
import { addDays, getLocalDateString } from "../domain/scheduling";
import { metricsActorName } from "../observability/metrics";

// Operator portal reports. Results intentionally carry customer name/phone
// (operator view); none of it is ever logged.

export interface PortalDeps {
  config?: KvNamespace;
  agenda?: AgendaNamespace;
  callbackQueue?: CallbackQueueNamespace;
  metrics?: MetricsNamespace;
}

export interface DayBookings {
  date: string;
  bookings: BookingListItem[];
}

export interface Kpis {
  follow_up_opportunities: number;
  checked_availability_not_booked: number;
  unserved_requests: number;
  pending_callbacks: number;
  upcoming_maintenance_reminders: number;
  bookings_confirmed_7d: number;
}

const WINDOW_DAYS = 7;
const TOOLS = ["get_service_catalog", "get_availability", "create_booking", "request_callback"] as const;
// Booking attempts the shop had to turn away: taken slot, closed day, or a
// time outside business hours.
const UNSERVED_OUTCOMES = ["slot_unavailable", "date_not_open", "time_invalid"] as const;

// Today plus the next six local days; fixed actor names, so no scans.
function upcomingDates(now: number): string[] {
  const today = getLocalDateString(now);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
}

// Today and the six previous local days.
function pastDates(now: number): string[] {
  const today = getLocalDateString(now);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, -i));
}

async function loadAppointments(
  agenda: AgendaNamespace,
  callbackQueue: CallbackQueueNamespace,
  now: number,
): Promise<{ days: DayBookings[]; callbacks: CallbackEntry[] }> {
  const days = await Promise.all(
    upcomingDates(now).map(async (date) => {
      const { bookings } = await agenda.idFromName(agendaActorName(LOCATION_ID, date)).listBookings();
      return { date, bookings };
    }),
  );
  const callbacks = await callbackQueue.idFromName("main").listCallbacks();
  return { days, callbacks };
}

async function loadSnapshots(metrics: MetricsNamespace, dates: string[]): Promise<MetricsSnapshot[]> {
  return Promise.all(dates.map((d) => metrics.idFromName(metricsActorName(d)).snapshot()));
}

function sumCounter(snapshots: MetricsSnapshot[], key: string): number {
  return snapshots.reduce((acc, s) => acc + (s.counters[key] ?? 0), 0);
}

export function computeKpis(
  snapshots: MetricsSnapshot[],
  days: DayBookings[],
  pendingCallbacks: number,
): Kpis {
  const checked = new Set(snapshots.flatMap((s) => s.availability_conversations));
  const booked = new Set(snapshots.flatMap((s) => s.booked_conversations));
  let notBooked = 0;
  for (const id of checked) if (!booked.has(id)) notBooked++;

  const unserved = UNSERVED_OUTCOMES.reduce(
    (acc, o) => acc + sumCounter(snapshots, `mcp.create_booking.${o}`),
    0,
  );
  const customers = new Set(days.flatMap((d) => d.bookings.map((b) => b.customer_phone.trim())));

  return {
    follow_up_opportunities: notBooked + unserved + pendingCallbacks,
    checked_availability_not_booked: notBooked,
    unserved_requests: unserved,
    pending_callbacks: pendingCallbacks,
    upcoming_maintenance_reminders: customers.size,
    bookings_confirmed_7d: booked.size,
  };
}

function average(l: { sum: number; count: number } | undefined): number {
  return l === undefined || l.count === 0 ? 0 : Math.round(l.sum / l.count);
}

export function summarizeObservability(snapshot: MetricsSnapshot) {
  const c = snapshot.counters;
  const tools = TOOLS.map((tool) => {
    const prefix = `mcp.${tool}.`;
    const byOutcome: Record<string, number> = {};
    for (const [key, n] of Object.entries(c)) {
      if (key.startsWith(prefix)) byOutcome[key.slice(prefix.length)] = n;
    }
    const calls = Object.values(byOutcome).reduce((a, b) => a + b, 0);
    return {
      tool,
      calls,
      errors: calls - (byOutcome.ok ?? 0),
      by_outcome: byOutcome,
      avg_latency_ms: average(snapshot.latency[`mcp.${tool}`]),
    };
  });
  return {
    webhook: {
      ok: c["webhook.ok"] ?? 0,
      degraded: c["webhook.degraded"] ?? 0,
      rejected: c["webhook.rejected"] ?? 0,
      avg_latency_ms: average(snapshot.latency.webhook),
    },
    tools,
    recent: snapshot.recent,
  };
}

// Each report returns null when a required binding is missing; Actor
// failures propagate as thrown errors. The HTTP layer maps both to 503.

export async function getAppointmentsReport(deps: PortalDeps, now: number) {
  if (!deps.agenda || !deps.callbackQueue) return null;
  const { days, callbacks } = await loadAppointments(deps.agenda, deps.callbackQueue, now);
  return {
    timezone: TIMEZONE,
    days,
    callbacks: callbacks.map((e) => ({
      id: e.id,
      created_at: e.created_at,
      customer_name: e.customer_name,
      customer_phone: e.customer_phone,
      reason: e.reason,
    })),
  };
}

export async function getKpisReport(deps: PortalDeps, now: number) {
  if (!deps.agenda || !deps.callbackQueue || !deps.metrics) return null;
  const [{ days, callbacks }, snapshots] = await Promise.all([
    loadAppointments(deps.agenda, deps.callbackQueue, now),
    loadSnapshots(deps.metrics, pastDates(now)),
  ]);
  return { window_days: WINDOW_DAYS, kpis: computeKpis(snapshots, days, callbacks.length) };
}

// Observability must still answer when a dependency is down: that is
// exactly when an operator opens it. Failures turn into status "degraded".
export async function getObservabilityReport(deps: PortalDeps, now: number) {
  let configOk = false;
  let bookingEnabled = false;
  if (deps.config) {
    try {
      const result = await loadConfig(deps.config);
      if (result.ok) {
        configOk = true;
        bookingEnabled = result.config.business.booking_enabled;
      }
    } catch {
      configOk = false;
    }
  }

  let metricsOk = false;
  let snapshot = emptySnapshot();
  if (deps.metrics) {
    try {
      snapshot = (await loadSnapshots(deps.metrics, [getLocalDateString(now)]))[0] ?? emptySnapshot();
      metricsOk = true;
    } catch {
      metricsOk = false;
    }
  }

  return {
    status: configOk && metricsOk ? "ok" : "degraded",
    config_ok: configOk,
    metrics_ok: metricsOk,
    booking_enabled: bookingEnabled,
    ...summarizeObservability(snapshot),
  };
}
