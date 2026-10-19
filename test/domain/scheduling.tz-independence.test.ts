// Subtask 2.3a TZ-independence test (interviewers test from the US).
// Spawns Node to compute scheduling results with TZ=UTC,
// TZ=America/New_York, and TZ=America/Los_Angeles, then asserts the results
// are byte-identical across all three. All scheduling uses the injected
// `now` + the workshop timezone (America/Mexico_City) via
// Intl.DateTimeFormat; the process TZ must not leak in.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const SCHEDULING_SOURCE = resolve(__dirname_local, "..", "..", "src", "domain", "scheduling.ts");

// Bundle scheduling.ts to a plain JS file using esbuild (already a dep).
// This gives the spawned child processes a require-able CommonJS module
// without needing a TS loader in the child.
const TMP_DIR = mkdtempSync(resolve(tmpdir(), "sched-tz-test-"));
const BUNDLED_PATH = resolve(TMP_DIR, "scheduling.cjs");

// Bundle once at module load (runs before tests).
execFileSync(resolve(__dirname_local, "..", "..", "node_modules", ".bin", "esbuild"), [
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${BUNDLED_PATH}`,
  SCHEDULING_SOURCE,
], { stdio: "pipe", encoding: "utf-8" });

// Process TZ values: interviewers may be Eastern or Pacific; we also test UTC.
const TZs = ["UTC", "America/New_York", "America/Los_Angeles"] as const;

const CONFIG = {
  location_id: "main",
  timezone: "America/Mexico_City",
  open_days: ["mon", "tue", "wed", "thu", "fri"],
  slot_hours: { start: "09:00", end: "17:00", last_start: "16:00" },
  booking_window_days: 7,
  booking_enabled: true,
} as const;

// Calibrator using the timezone-aware API (no hardcoded offset).
function localEpochMS(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const candidate = Date.UTC(y, m - 1, d, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(candidate));
  const ly = parts.find((p) => p.type === "year")!.value;
  const lm = parts.find((p) => p.type === "month")!.value;
  const ld = parts.find((p) => p.type === "day")!.value;
  const lh = Number(parts.find((p) => p.type === "hour")!.value);
  const lmin = Number(parts.find((p) => p.type === "minute")!.value);
  if (`${ly}-${lm}-${ld}` !== date) {
    throw new Error(`localEpochMS date mismatch for ${date}`);
  }
  const offsetMs = (hour * 60 + minute - lh * 60 - lmin) * 60000;
  return candidate + offsetMs;
}

// Fixed January (winter) and July (summer) noon workshop-local instants.
// 2026-01-12 is a Monday; 2026-07-13 is a Monday.
const JAN_NOON = localEpochMS("2026-01-12", 12, 0); // winter
const JUL_NOON = localEpochMS("2026-07-13", 12, 0); // summer

// UTC/local date boundary fixtures.
// 2026-07-13 09:00 UTC → local 03:00 Jul 13 (still same calendar day).
const JUL_UTC_MORNING = Date.UTC(2026, 6, 13, 9, 0, 0);
// 2026-01-12 03:00 UTC → local Jan 11 21:00 (different calendar day).
const JAN_UTC_FOR_JAN11 = Date.UTC(2026, 0, 12, 3, 0, 0);

function runInTZ(
  tz: string,
  scenarioBody: string,
  now: number,
): unknown {
  const script = [
    `const mod = require(${JSON.stringify(BUNDLED_PATH)});`,
    `const cfg = ${JSON.stringify(CONFIG)};`,
    `const now = ${now};`,
    `const result = (${scenarioBody})(mod, now, cfg);`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n");

  const out = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: tz },
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

// Each scenario is a self-contained expression body using (mod, now, cfg).
// Returns a JSON-serializable result.
const SCENARIOS: Array<{ name: string; body: string; now: number }> = [
  {
    name: "JAN_NOON window first + count",
    now: JAN_NOON,
    body: `(mod, now, cfg) => {
      const w = mod.getBookingWindowDates(now, cfg);
      return { first: w[0], count: w.length };
    }`,
  },
  {
    name: "JAN_NOON Monday day slots",
    now: JAN_NOON,
    body: `(mod, now, cfg) => mod.generateDaySlots("2026-01-12", now, cfg)`,
  },
  {
    name: "JAN_NOON candidate count",
    now: JAN_NOON,
    body: `(mod, now, cfg) => mod.generateCandidateSlots(now, cfg).length`,
  },
  {
    name: "JUL_NOON window first + count",
    now: JUL_NOON,
    body: `(mod, now, cfg) => {
      const w = mod.getBookingWindowDates(now, cfg);
      return { first: w[0], count: w.length };
    }`,
  },
  {
    name: "JUL_NOON Monday day slots",
    now: JUL_NOON,
    body: `(mod, now, cfg) => mod.generateDaySlots("2026-07-13", now, cfg)`,
  },
  {
    name: "JUL_NOON candidate count",
    now: JUL_NOON,
    body: `(mod, now, cfg) => mod.generateCandidateSlots(now, cfg).length`,
  },
  {
    name: "JUL_UTC_MORNING local date (Jul 13, not Jul 14)",
    now: JUL_UTC_MORNING,
    body: `(mod, now, cfg) => mod.getLocalDateString(now)`,
  },
  {
    name: "JUL_UTC_MORNING candidate count",
    now: JUL_UTC_MORNING,
    body: `(mod, now, cfg) => mod.generateCandidateSlots(now, cfg).length`,
  },
  {
    name: "JAN_UTC_FOR_JAN11 local date (Jan 11, not Jan 12)",
    now: JAN_UTC_FOR_JAN11,
    body: `(mod, now, cfg) => mod.getLocalDateString(now)`,
  },
  {
    name: "JAN_UTC_FOR_JAN11 window first + count + candidates",
    now: JAN_UTC_FOR_JAN11,
    body: `(mod, now, cfg) => {
      const w = mod.getBookingWindowDates(now, cfg);
      return {
        first: w[0],
        count: w.length,
        candidates: mod.generateCandidateSlots(now, cfg).length,
      };
    }`,
  },
  {
    name: "JAN_NOON validateSlotRequest valid future slot",
    now: JAN_NOON,
    body: `(mod, now, cfg) => mod.validateSlotRequest("2026-01-13", "10:00", now, cfg)`,
  },
  {
    name: "JAN_NOON validateSlotRequest slot in past (today 09:00 vs noon now)",
    now: JAN_NOON,
    body: `(mod, now, cfg) => mod.validateSlotRequest("2026-01-12", "09:00", now, cfg)`,
  },
  {
    name: "JUL_NOON validateSlotRequest valid future slot",
    now: JUL_NOON,
    body: `(mod, now, cfg) => mod.validateSlotRequest("2026-07-14", "14:00", now, cfg)`,
  },
];

describe("scheduling is TZ-independent across US caller timezones", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: identical across ${TZs.join(", ")}`, () => {
      const results: Record<string, unknown> = {};
      for (const tz of TZs) {
        results[tz] = runInTZ(tz, s.body, s.now);
      }
      const baseline = JSON.stringify(results[TZs[0]]);
      for (const tz of TZs) {
        expect(
          JSON.stringify(results[tz]),
          `TZ=${tz} differs from TZ=${TZs[0]} for "${s.name}"`,
        ).toBe(baseline);
      }
    });
  }
});
