import { describe, it, expect } from "vitest";
import type { BusinessConfig } from "../src/config";
import {
  addDays,
  generateCandidateSlots,
  generateDaySlots,
  getBookingWindowDates,
  getDayOfWeek,
  getLocalDateString,
  getLocalTimeParts,
  getSlotTimes,
  isDateInWindow,
  isOpenDay,
  isSlotPast,
  isValidDate,
  isValidTime,
  isValidTimeFormat,
  validateSlotRequest,
} from "../src/scheduling";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CONFIG: BusinessConfig = {
  location_id: "main",
  timezone: "America/Mexico_City",
  open_days: ["mon", "tue", "wed", "thu", "fri"],
  slot_hours: { start: "09:00", end: "17:00", last_start: "16:00" },
  booking_window_days: 7,
  booking_enabled: true,
};

const MON_OCT19_2026 = "2026-10-19"; // Monday
const MON_DEC28_2026 = "2026-12-28"; // Monday

// ---------------------------------------------------------------------------
// Calibrator: construct an epoch ms that matches a given local date/time.
// Uses the timezone-aware API to find the offset — no hardcode UTC offset.
// Only valid for local times during business hours (where UTC date == local
// date for any offset −6…−5).
// ---------------------------------------------------------------------------

function localEpochMS(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const candidate = Date.UTC(y, m - 1, d, hour, minute, 0);
  if (getLocalDateString(candidate) !== date) {
    throw new Error(
      "localEpochMS: UTC date differs from local date — use a midday time",
    );
  }
  const local = getLocalTimeParts(candidate);
  const offsetMs = (hour * 60 + minute - local.hour * 60 - local.minute) * 60000;
  return candidate + offsetMs;
}

// ---------------------------------------------------------------------------
// Date validation (covers: malformed dates spec item)
// ---------------------------------------------------------------------------

describe("date validation", () => {
  it("accepts valid calendar dates", () => {
    expect(isValidDate("2026-10-19")).toBe(true);
    expect(isValidDate("2026-01-01")).toBe(true);
    expect(isValidDate("2026-12-31")).toBe(true);
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2026-04-30")).toBe(true);
    expect(isValidDate("2024-02-29")).toBe(true); // leap year
    expect(isValidDate("2000-02-29")).toBe(true); // divisible by 400
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-04-31")).toBe(false);
    expect(isValidDate("2026-01-32")).toBe(false);
    expect(isValidDate("2026-11-31")).toBe(false);
    expect(isValidDate("2026-02-29")).toBe(false); // not a leap year
    expect(isValidDate("2100-02-29")).toBe(false); // divisible by 100, not 400
  });

  it("rejects malformed date strings", () => {
    expect(isValidDate("2026-13-01")).toBe(false); // month > 12
    expect(isValidDate("2026-00-15")).toBe(false); // month = 0
    expect(isValidDate("2026-10")).toBe(false); // missing day
    expect(isValidDate("26-10-19")).toBe(false); // year not 4 digits
    expect(isValidDate("2026/10/19")).toBe(false); // wrong separator
    expect(isValidDate("2026-10-1")).toBe(false); // day not 2 digits
    expect(isValidDate("2026-10-19T00:00:00")).toBe(false); // datetime not date
    expect(isValidDate("")).toBe(false);
    expect(isValidDate("2026-10-19 ")).toBe(false); // trailing space
    expect(isValidDate("0000-00-00")).toBe(false);
    expect(isValidDate("9999-99-99")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Month/year boundaries (covers: spec item 5 — month/year boundaries)
// ---------------------------------------------------------------------------

describe("month/year boundaries (addDays)", () => {
  it("crosses month boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28"); // non-leap year
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // leap year
  });

  it("crosses year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles multiple-day jumps", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
    expect(addDays("2026-01-01", 365)).toBe("2027-01-01"); // 2026 is non-leap
  });
});

describe("leap date validation", () => {
  it("2024-02-29 is valid (leap year)", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
  });
  it("2000-02-29 is valid (divisible by 400)", () => {
    expect(isValidDate("2000-02-29")).toBe(true);
  });
  it("2026-02-29 is invalid (not divisible by 4)", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
  });
  it("2100-02-29 is invalid (divisible by 100, not 400)", () => {
    expect(isValidDate("2100-02-29")).toBe(false);
  });
  it("2026-02-28 is valid (last day of Feb in non-leap year)", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Time validation (covers: spec item 6 — invalid start times)
// ---------------------------------------------------------------------------

describe("time validation", () => {
  describe("isValidTimeFormat", () => {
    it("accepts whole-hour HH:mm format", () => {
      expect(isValidTimeFormat("09:00")).toBe(true);
      expect(isValidTimeFormat("12:00")).toBe(true);
      expect(isValidTimeFormat("16:00")).toBe(true);
      expect(isValidTimeFormat("23:00")).toBe(true);
    });
    it("rejects non-whole-hour times", () => {
      expect(isValidTimeFormat("09:30")).toBe(false);
      expect(isValidTimeFormat("09:15")).toBe(false);
      expect(isValidTimeFormat("10:01")).toBe(false);
      expect(isValidTimeFormat("12:59")).toBe(false);
    });
    it("rejects malformed time strings", () => {
      expect(isValidTimeFormat("9:00")).toBe(false); // not 2-digit hour
      expect(isValidTimeFormat("1000")).toBe(false); // no colon
      expect(isValidTimeFormat("10:60")).toBe(false); // ends with :60 not :00
      expect(isValidTimeFormat("")).toBe(false);
    });
  });

  describe("isValidTime with config", () => {
    it("accepts valid slot times 09:00–16:00", () => {
      expect(isValidTime("09:00", CONFIG)).toBe(true);
      expect(isValidTime("10:00", CONFIG)).toBe(true);
      expect(isValidTime("13:00", CONFIG)).toBe(true);
      expect(isValidTime("15:00", CONFIG)).toBe(true);
      expect(isValidTime("16:00", CONFIG)).toBe(true);
    });
    it("rejects out-of-range whole hours", () => {
      expect(isValidTime("08:00", CONFIG)).toBe(false); // before opening
      expect(isValidTime("17:00", CONFIG)).toBe(false); // after last start (=end)
    });
    it("rejects non-whole-hour slots", () => {
      expect(isValidTime("09:30", CONFIG)).toBe(false);
      expect(isValidTime("11:45", CONFIG)).toBe(false);
    });
    it("rejects malformed strings", () => {
      expect(isValidTime("9:00", CONFIG)).toBe(false);
      expect(isValidTime("10:60", CONFIG)).toBe(false);
      expect(isValidTime("", CONFIG)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Slot times derivation
// ---------------------------------------------------------------------------

describe("getSlotTimes", () => {
  it("returns exactly 8 slot times from 09:00 to 16:00", () => {
    const slots = getSlotTimes(CONFIG);
    expect(slots).toEqual([
      "09:00", "10:00", "11:00", "12:00",
      "13:00", "14:00", "15:00", "16:00",
    ]);
    expect(slots).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Day of week
// ---------------------------------------------------------------------------

describe("getDayOfWeek", () => {
  it("Monday is mon, Sunday is sun", () => {
    expect(getDayOfWeek(MON_OCT19_2026)).toBe("mon");
    expect(getDayOfWeek("2026-10-23")).toBe("fri");
    expect(getDayOfWeek("2026-10-24")).toBe("sat");
    expect(getDayOfWeek("2026-10-25")).toBe("sun");
    expect(getDayOfWeek(MON_DEC28_2026)).toBe("mon");
  });
});

describe("isOpenDay", () => {
  it("Mon–Fri open, Sat/Sun closed", () => {
    expect(isOpenDay(MON_OCT19_2026, CONFIG.open_days)).toBe(true);
    expect(isOpenDay("2026-10-24", CONFIG.open_days)).toBe(false); // Sat
    expect(isOpenDay("2026-10-25", CONFIG.open_days)).toBe(false); // Sun
  });
});

// ---------------------------------------------------------------------------
// Local date from epoch ms (timezone-aware)
// ---------------------------------------------------------------------------

describe("getLocalDateString", () => {
  it("noon UTC on Oct 19 maps to local Oct 19", () => {
    const noonUtc = Date.UTC(2026, 9, 19, 12, 0, 0);
    expect(getLocalDateString(noonUtc)).toBe("2026-10-19");
  });
  it("calibrator-backed local epoch is consistent", () => {
    const now = localEpochMS(MON_OCT19_2026, 10, 30);
    expect(getLocalDateString(now)).toBe("2026-10-19");
    expect(getLocalTimeParts(now)).toEqual({ hour: 10, minute: 30 });
  });
});

// ---------------------------------------------------------------------------
// UTC date vs. local date (spec item 4)
// ---------------------------------------------------------------------------

describe("instant whose UTC date differs from Mexico City date", () => {
  // Oct 19 03:00 UTC → Oct 18 21:00 local (UTC-6)
  const now = Date.UTC(2026, 9, 19, 3, 0, 0);

  it("UTC date string differs from local date string", () => {
    const utcDate = new Date(now).toISOString().slice(0, 10);
    const localDate = getLocalDateString(now);
    expect(utcDate).toBe("2026-10-19");
    expect(localDate).toBe("2026-10-18");
    expect(localDate).not.toBe(utcDate);
  });

  it("booking window starts from local date, not UTC date", () => {
    const window = getBookingWindowDates(now, CONFIG);
    expect(window[0]).toBe("2026-10-18"); // local "today"
  });

  it("window includes the UTC date as a future day", () => {
    const window = getBookingWindowDates(now, CONFIG);
    // Window is Oct 18..Oct 24 — Oct 19 is the 2nd entry
    expect(window[1]).toBe("2026-10-19");
  });
});

// ---------------------------------------------------------------------------
// Booking window generation
// ---------------------------------------------------------------------------

describe("getBookingWindowDates", () => {
  it("returns 7 consecutive calendar dates from local today", () => {
    const now = localEpochMS(MON_OCT19_2026, 8, 0);
    const window = getBookingWindowDates(now, CONFIG);
    expect(window).toHaveLength(7);
    expect(window[0]).toBe("2026-10-19");
    expect(window[6]).toBe("2026-10-25");
    // Consecutive
    for (let i = 1; i < window.length; i++) {
      expect(addDays(window[i - 1], 1)).toBe(window[i]);
    }
  });

  it("spans month/year boundary from late December", () => {
    const now = localEpochMS(MON_DEC28_2026, 12, 0);
    const window = getBookingWindowDates(now, CONFIG);
    expect(window[0]).toBe("2026-12-28");
    expect(window[3]).toBe("2026-12-31");
    expect(window[4]).toBe("2027-01-01"); // year boundary
    expect(window[6]).toBe("2027-01-03");
  });
});

// ---------------------------------------------------------------------------
// Window boundaries (spec item 3)
// ---------------------------------------------------------------------------

describe("window boundaries — today+6 included, today+7 excluded", () => {
  const now = localEpochMS(MON_OCT19_2026, 8, 0); // Mon Oct 19, before opening

  it("today+6 is in the window", () => {
    expect(isDateInWindow("2026-10-25", now, CONFIG)).toBe(true); // Sun, 6 days later
  });
  it("today+7 is not in the window", () => {
    expect(isDateInWindow("2026-10-26", now, CONFIG)).toBe(false);
  });
  it("today is in the window", () => {
    expect(isDateInWindow("2026-10-19", now, CONFIG)).toBe(true);
  });
  it("yesterday is not in the window", () => {
    expect(isDateInWindow("2026-10-18", now, CONFIG)).toBe(false);
  });
  it("validateSlotRequest rejects today+7 with date_out_of_range", () => {
    const err = validateSlotRequest("2026-10-26", "09:00", now, CONFIG);
    expect(err).toBe("date_out_of_range");
  });
  it("validateSlotRequest accepts today+6 (still in window, even if weekend)", () => {
    // Oct 25 is Sunday → would later fail date_not_open, but it passes window check
    // Wait — validateSlotRequest checks date_not_open before date_out_of_range
    // Actually, our order: date_invalid → date_out_of_range → date_not_open → time_invalid → slot_in_past
    // So "2026-10-25" passes date and window checks, fails date_not_open
    const err = validateSlotRequest("2026-10-25", "09:00", now, CONFIG);
    expect(err).toBe("date_not_open");
  });
});

// ---------------------------------------------------------------------------
// Eight slots on future weekday; none on weekends (spec item 1)
// ---------------------------------------------------------------------------

describe("eight slots on a future weekday; none on weekends", () => {
  const now = localEpochMS(MON_OCT19_2026, 8, 0); // Mon 08:00, before opening

  it("Monday has exactly 8 candidate slots", () => {
    const slots = generateDaySlots(MON_OCT19_2026, now, CONFIG);
    expect(slots).toEqual([
      "09:00", "10:00", "11:00", "12:00",
      "13:00", "14:00", "15:00", "16:00",
    ]);
    expect(slots).toHaveLength(8);
  });

  it("Saturday in window produces no slots (weekend)", () => {
    expect(generateDaySlots("2026-10-24", now, CONFIG)).toEqual([]);
  });

  it("Sunday in window produces no slots (weekend)", () => {
    expect(generateDaySlots("2026-10-25", now, CONFIG)).toEqual([]);
  });

  it("past calendar date produces no slots (even on a weekday)", () => {
    // Past date relative to now (Oct 19) — Oct 16 is Friday (previous week Friday)
    expect(generateDaySlots("2026-10-16", now, CONFIG)).toEqual([]);
  });

  it("candidate slots across the week exclude weekends", () => {
    const all = generateCandidateSlots(now, CONFIG);
    const satSun = all.filter(
      (s) => getDayOfWeek(s.date) === "sat" || getDayOfWeek(s.date) === "sun",
    );
    expect(satSun).toEqual([]);
    // Window: Oct 19..25 → weekdays: 19, 20, 21, 22, 23 (5 weekdays × 8 = 40 slots)
    // All weekday slots are future since now is 08:00 (before opening)
    expect(all).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// Today's elapsed slots and exact-start boundary (spec item 2)
// ---------------------------------------------------------------------------

describe("today's elapsed slots at 10:30 local", () => {
  const now = localEpochMS(MON_OCT19_2026, 10, 30);

  it("09:00 and 10:00 are past", () => {
    expect(isSlotPast(MON_OCT19_2026, "09:00", now)).toBe(true);
    expect(isSlotPast(MON_OCT19_2026, "10:00", now)).toBe(true);
  });
  it("11:00 through 16:00 are not past", () => {
    expect(isSlotPast(MON_OCT19_2026, "11:00", now)).toBe(false);
    expect(isSlotPast(MON_OCT19_2026, "16:00", now)).toBe(false);
  });
  it("generateDaySlots returns 6 remaining slots (11:00–16:00)", () => {
    expect(generateDaySlots(MON_OCT19_2026, now, CONFIG)).toEqual([
      "11:00", "12:00", "13:00", "14:00", "15:00", "16:00",
    ]);
  });
});

describe("exact-start boundary at 11:00 local (slot is 'at or before' now)", () => {
  const now = localEpochMS(MON_OCT19_2026, 11, 0);

  it("11:00 is past because it equals now (minutes equal too)", () => {
    expect(isSlotPast(MON_OCT19_2026, "11:00", now)).toBe(true);
  });
  it("generateDaySlots returns 5 remaining slots (12:00–16:00)", () => {
    expect(generateDaySlots(MON_OCT19_2026, now, CONFIG)).toEqual([
      "12:00", "13:00", "14:00", "15:00", "16:00",
    ]);
  });
});

describe("just-before boundary at 10:59 local (slot is after now)", () => {
  const now = localEpochMS(MON_OCT19_2026, 10, 59);

  it("11:00 is not past (hour 11 > 10)", () => {
    expect(isSlotPast(MON_OCT19_2026, "11:00", now)).toBe(false);
  });
  it("generateDaySlots returns 6 remaining slots (11:00–16:00)", () => {
    expect(generateDaySlots(MON_OCT19_2026, now, CONFIG)).toEqual([
      "11:00", "12:00", "13:00", "14:00", "15:00", "16:00",
    ]);
  });
});

describe("past boundary for future same-date edge case", () => {
  it("15:59 is past when now is 16:00 (same hour boundary)", () => {
    const now = localEpochMS(MON_OCT19_2026, 16, 0);
    expect(isSlotPast(MON_OCT19_2026, "16:00", now)).toBe(true); // exact
    expect(isSlotPast(MON_OCT19_2026, "15:00", now)).toBe(true); // earlier
    expect(generateDaySlots(MON_OCT19_2026, now, CONFIG)).toEqual([]); // no future slots
  });
});

// ---------------------------------------------------------------------------
// Candidate slot generation sanity check
// ---------------------------------------------------------------------------

describe("generateCandidateSlots", () => {
  it("preserves date+time pairs as objects", () => {
    const now = localEpochMS(MON_OCT19_2026, 8, 0);
    const all = generateCandidateSlots(now, CONFIG);
    const sample = all.find((s) => s.date === MON_OCT19_2026 && s.time === "09:00");
    expect(sample).toEqual({ date: MON_OCT19_2026, time: "09:00" });
  });
  it("uses each slot time exactly once per date", () => {
    const now = localEpochMS(MON_OCT19_2026, 8, 0);
    const all = generateCandidateSlots(now, CONFIG);
    const monSlots = all.filter((s) => s.date === MON_OCT19_2026);
    const times = monSlots.map((s) => s.time);
    expect(new Set(times).size).toBe(times.length); // no duplicates
  });
});

// ---------------------------------------------------------------------------
// validateSlotRequest — full validation pipeline
// ---------------------------------------------------------------------------

describe("validateSlotRequest", () => {
  const now = localEpochMS(MON_OCT19_2026, 8, 0); // Mon 08:00 (before opening)

  it("valid future slot returns null (no error)", () => {
    expect(validateSlotRequest(MON_OCT19_2026, "09:00", now, CONFIG)).toBeNull();
    expect(validateSlotRequest("2026-10-20", "14:00", now, CONFIG)).toBeNull();
  });

  it("returns date_invalid for malformed date", () => {
    expect(validateSlotRequest("2026-02-30", "09:00", now, CONFIG)).toBe(
      "date_invalid",
    );
    expect(validateSlotRequest("26-10-19", "09:00", now, CONFIG)).toBe(
      "date_invalid",
    );
  });

  it("returns date_out_of_range for yesterday or today+7", () => {
    expect(validateSlotRequest("2026-10-18", "09:00", now, CONFIG)).toBe(
      "date_out_of_range",
    );
    expect(validateSlotRequest("2026-10-26", "09:00", now, CONFIG)).toBe(
      "date_out_of_range",
    );
  });

  it("returns date_not_open for weekend", () => {
    expect(validateSlotRequest("2026-10-24", "09:00", now, CONFIG)).toBe(
      "date_not_open", // Sat
    );
    expect(validateSlotRequest("2026-10-25", "09:00", now, CONFIG)).toBe(
      "date_not_open", // Sun
    );
  });

  it("returns time_invalid for malformed/non-whole-hour/out-of-range times", () => {
    expect(validateSlotRequest("2026-10-20", "09:30", now, CONFIG)).toBe(
      "time_invalid",
    );
    expect(validateSlotRequest("2026-10-20", "17:00", now, CONFIG)).toBe(
      "time_invalid",
    );
    expect(validateSlotRequest("2026-10-20", "08:00", now, CONFIG)).toBe(
      "time_invalid",
    );
    expect(validateSlotRequest("2026-10-20", "9:00", now, CONFIG)).toBe(
      "time_invalid",
    );
    expect(validateSlotRequest("2026-10-20", "10:60", now, CONFIG)).toBe(
      "time_invalid",
    );
  });

  it("returns slot_in_past for today's leaked slots", () => {
    const later = localEpochMS(MON_OCT19_2026, 11, 30);
    expect(validateSlotRequest(MON_OCT19_2026, "09:00", later, CONFIG)).toBe(
      "slot_in_past",
    );
    expect(validateSlotRequest(MON_OCT19_2026, "11:00", later, CONFIG)).toBe(
      "slot_in_past",
    );
    // 12:00 is still future
    expect(validateSlotRequest(MON_OCT19_2026, "12:00", later, CONFIG)).toBeNull();
  });

  it("validation order: date_invalid beats date_out_of_range beats others", () => {
    expect(validateSlotRequest("2026-13-01", "09:00", now, CONFIG)).toBe(
      "date_invalid", // month 13 is invalid even if "out of range" too
    );
    // An invalid date and an invalid time — date_invalid should win
    expect(validateSlotRequest("2026-02-30", "25:00", now, CONFIG)).toBe(
      "date_invalid",
    );
  });
});

// ---------------------------------------------------------------------------
// Calibrator sanity check — uses timezone-aware API, no hardcoded offset
// ---------------------------------------------------------------------------

describe("localEpochMS calibrator", () => {
  it("produces epoch cumulating local wall clock time", () => {
    const now = localEpochMS(MON_OCT19_2026, 10, 30);
    expect(getLocalDateString(now)).toBe(MON_OCT19_2026);
    expect(getLocalTimeParts(now)).toEqual({ hour: 10, minute: 30 });
  });
  it("works at business-hours extremes (08:00 and 16:00)", () => {
    expect(getLocalTimeParts(localEpochMS(MON_OCT19_2026, 8, 0))).toEqual({
      hour: 8,
      minute: 0,
    });
    expect(getLocalTimeParts(localEpochMS(MON_OCT19_2026, 16, 0))).toEqual({
      hour: 16,
      minute: 0,
    });
  });
});
