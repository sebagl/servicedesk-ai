import type { KvNamespace } from "@telnyx/edge-runtime";

export interface Service {
  id: string;
  name: string;
  duration_minutes: number;
}

export interface BusinessConfig {
  location_id: string;
  timezone: string;
  open_days: string[];
  slot_hours: { start: string; end: string; last_start: string };
  booking_window_days: number;
  booking_enabled: boolean;
}

export interface AppConfig {
  services: Service[];
  business: BusinessConfig;
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false };

const CONFIG_KEY = "config/main";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function validateService(raw: unknown, ids: Set<string>): Service | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || r.id.length === 0) return null;
  if (!isString(r.name) || r.name.length === 0) return null;
  if (!isNumber(r.duration_minutes) || r.duration_minutes !== 60) return null;
  if (ids.has(r.id)) return null;
  ids.add(r.id);
  return { id: r.id, name: r.name, duration_minutes: r.duration_minutes };
}

function validateBusiness(raw: unknown): BusinessConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.location_id) || r.location_id.length === 0) return null;
  if (!isString(r.timezone) || r.timezone !== "America/Mexico_City") return null;
  if (!Array.isArray(r.open_days) || r.open_days.length === 0) return null;
  if (!r.open_days.every(isString)) return null;
  if (typeof r.slot_hours !== "object" || r.slot_hours === null) return null;
  const sh = r.slot_hours as Record<string, unknown>;
  if (!isString(sh.start) || sh.start !== "09:00") return null;
  if (!isString(sh.end) || sh.end !== "17:00") return null;
  if (!isString(sh.last_start) || sh.last_start !== "16:00") return null;
  if (!isNumber(r.booking_window_days) || r.booking_window_days !== 7) return null;
  if (!isBoolean(r.booking_enabled)) return null;
  return {
    location_id: r.location_id,
    timezone: r.timezone,
    open_days: r.open_days,
    slot_hours: { start: sh.start, end: sh.end, last_start: sh.last_start },
    booking_window_days: r.booking_window_days,
    booking_enabled: r.booking_enabled,
  };
}

function validateConfig(raw: unknown): AppConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.services) || r.services.length === 0) return null;
  const ids = new Set<string>();
  const services: Service[] = [];
  for (const s of r.services) {
    const valid = validateService(s, ids);
    if (valid === null) return null;
    services.push(valid);
  }
  const business = validateBusiness(r.business);
  if (business === null) return null;
  return { services, business };
}

export async function loadConfig(
  kv: KvNamespace,
): Promise<ConfigResult> {
  try {
    const raw = await kv.get<unknown>(CONFIG_KEY, { type: "json" });
    if (raw === null || raw === undefined) return { ok: false };
    const config = validateConfig(raw);
    if (config === null) return { ok: false };
    return { ok: true, config };
  } catch {
    return { ok: false };
  }
}
