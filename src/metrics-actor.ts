import { StatefulActor } from "@telnyx/edge-runtime";

// ---------------------------------------------------------------------------
// Metrics — one Actor per local day ("metrics-YYYY-MM-DD"). Persists a single
// aggregate of counters, latency sums, two bounded conversation-id sets and
// the newest 50 events. Inputs carry only event/outcome labels, latency and a
// correlation id, so customer name and phone can never land in here.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "metrics";
const MAX_CONVERSATIONS = 500;
const MAX_RECENT = 50;

const LABEL_PATTERN = /^[a-z0-9_.]{1,64}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export interface MetricInput {
  // "mcp.<tool>", "webhook" or "callback"; counters key on `${event}.${outcome}`.
  event: string;
  outcome: string;
  latency_ms?: number;
  telnyx_conversation_id?: string;
}

export interface MetricEventRecord {
  ts: string;
  event: string;
  outcome: string;
  latency_ms?: number;
  telnyx_conversation_id?: string;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  latency: Record<string, { sum: number; count: number }>;
  availability_conversations: string[];
  booked_conversations: string[];
  recent: MetricEventRecord[];
}

export function emptySnapshot(): MetricsSnapshot {
  return {
    counters: {},
    latency: {},
    availability_conversations: [],
    booked_conversations: [],
    recent: [],
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateSnapshot(raw: unknown): MetricsSnapshot {
  if (raw === undefined) return emptySnapshot();
  if (!isObject(raw)) throw new Error("metrics state is not an object");
  const { counters, latency, availability_conversations, booked_conversations, recent } = raw;
  if (!isObject(counters) || !Object.values(counters).every((n) => typeof n === "number"))
    throw new Error("invalid counters");
  if (
    !isObject(latency) ||
    !Object.values(latency).every(
      (l) => isObject(l) && typeof l.sum === "number" && typeof l.count === "number",
    )
  )
    throw new Error("invalid latency");
  if (!isStringArray(availability_conversations) || !isStringArray(booked_conversations))
    throw new Error("invalid conversation sets");
  if (!Array.isArray(recent) || !recent.every(isObject)) throw new Error("invalid recent");
  return {
    counters: counters as Record<string, number>,
    latency: latency as Record<string, { sum: number; count: number }>,
    availability_conversations,
    booked_conversations,
    recent: recent as unknown as MetricEventRecord[],
  };
}

// Newest-last set capped at MAX_CONVERSATIONS: the oldest ids drop off first.
function addToSet(set: string[], id: string): string[] {
  if (set.includes(id)) return set;
  return [...set, id].slice(-MAX_CONVERSATIONS);
}

export class Metrics extends StatefulActor {
  async record(input: MetricInput): Promise<void> {
    if (!LABEL_PATTERN.test(input.event) || !LABEL_PATTERN.test(input.outcome)) {
      throw new Error("invalid metric label");
    }
    const latency =
      typeof input.latency_ms === "number" && Number.isFinite(input.latency_ms)
        ? Math.max(0, Math.round(input.latency_ms))
        : undefined;
    const conversationId =
      typeof input.telnyx_conversation_id === "string" &&
      CONVERSATION_ID_PATTERN.test(input.telnyx_conversation_id)
        ? input.telnyx_conversation_id
        : undefined;

    const state = validateSnapshot(await this.ctx.storage.get<unknown>(STORAGE_KEY));

    const key = `${input.event}.${input.outcome}`;
    state.counters[key] = (state.counters[key] ?? 0) + 1;

    if (latency !== undefined) {
      const prev = state.latency[input.event] ?? { sum: 0, count: 0 };
      state.latency[input.event] = { sum: prev.sum + latency, count: prev.count + 1 };
    }

    if (conversationId !== undefined) {
      if (input.event === "mcp.get_availability") {
        state.availability_conversations = addToSet(state.availability_conversations, conversationId);
      }
      if (input.event === "mcp.create_booking" && input.outcome === "ok") {
        state.booked_conversations = addToSet(state.booked_conversations, conversationId);
      }
    }

    const record: MetricEventRecord = {
      ts: new Date().toISOString(),
      event: input.event,
      outcome: input.outcome,
    };
    if (latency !== undefined) record.latency_ms = latency;
    if (conversationId !== undefined) record.telnyx_conversation_id = conversationId;
    state.recent = [record, ...state.recent].slice(0, MAX_RECENT);

    await this.ctx.storage.put(STORAGE_KEY, state);
  }

  async snapshot(): Promise<MetricsSnapshot> {
    return validateSnapshot(await this.ctx.storage.get<unknown>(STORAGE_KEY));
  }
}
