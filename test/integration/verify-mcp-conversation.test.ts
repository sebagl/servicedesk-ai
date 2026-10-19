import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Imports the script as an ESM module. The script guards main() behind
// `import.meta.url === pathToFileURL(process.argv[1]).href`, so importing
// it from the vitest harness never triggers the CLI entry point.
import {
  run,
  fetchJsonWithTimeout,
  classifyToolResult,
  validateConfirmed,
  parseArgs,
  deriveConversationId,
} from "../../scripts/verify-mcp-conversation.mjs";
import type { Check, RunResult } from "../../scripts/verify-mcp-conversation.mjs";

// ---------------------------------------------------------------------------
// Types and fixtures
// ---------------------------------------------------------------------------

// Minimal response shape the script depends on. Real fetch responses expose
// much more, but the script only reads `status` and `json()`.
interface MockResponse {
  status: number;
  json: () => Promise<unknown>;
}

const VALID_ARGS: Record<string, string> = {
  "base-url": "https://x.example",
  date: "2026-10-22",
  time: "11:00",
  "alternate-time": "12:00",
  "run-id": "r1",
};

const VALID_TOKEN = "test-token-secret";

function makeJsonResponse(body: unknown, status = 200): MockResponse {
  return {
    status,
    json: async () => body,
  };
}

function makeAvailabilityOk(): MockResponse {
  return makeJsonResponse({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            date: VALID_ARGS.date,
            timezone: "America/Mexico_City",
            booking_enabled: true,
            available_times: [VALID_ARGS.time, VALID_ARGS["alternate-time"]],
          }),
        },
      ],
    },
  });
}

function makeConfirmed(bookingId = "bid-1"): MockResponse {
  return makeJsonResponse({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmed",
            booking_id: bookingId,
            service_id: "oil_change",
            date: VALID_ARGS.date,
            time: VALID_ARGS.time,
          }),
        },
      ],
    },
  });
}

function makeToolError(code: string): MockResponse {
  return makeJsonResponse({
    result: {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: code }) }],
    },
  });
}

// A Response whose .json() returns a promise that rejects with an
// AbortError only when the supplied signal fires. Mirrors how undici
// behaves when an in-progress body read is aborted.
function makeStalledResponse(signal: AbortSignal | null | undefined): MockResponse {
  const s = signal ?? undefined;
  return {
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (s && s.aborted) {
          onAbort();
          return;
        }
        s?.addEventListener("abort", onAbort, { once: true });
      }),
  };
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

describe("verify-mcp-conversation script", () => {
  let logs: string[] = [];
  let errs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  describe("parseArgs / deriveConversationId", () => {
    it("extracts every --flag value pair", () => {
      const r = parseArgs([
        "node",
        "script.mjs",
        "--base-url",
        "https://x",
        "--date",
        "2026-10-22",
        "--time",
        "11:00",
        "--alternate-time",
        "12:00",
        "--run-id",
        "r1",
      ]);
      expect(r.error).toBeUndefined();
      expect(r.args).toEqual({
        "base-url": "https://x",
        date: "2026-10-22",
        time: "11:00",
        "alternate-time": "12:00",
        "run-id": "r1",
      });
    });

    it("returns an error when a flag has no value", () => {
      const r = parseArgs(["node", "script.mjs", "--base-url"]);
      expect(r.error).toMatch(/Missing value for --base-url/);
    });

    it("returns an error when the next token is another flag", () => {
      const r = parseArgs(["node", "script.mjs", "--base-url", "--date", "2026-10-22"]);
      expect(r.error).toMatch(/Missing value for --base-url/);
    });

    it("derives a conversation id from the run id", () => {
      expect(deriveConversationId("r1")).toBe("conv-r1");
    });
  });

  describe("classifyToolResult", () => {
    it("returns ENVELOPE_INVALID for missing result.content", () => {
      expect(classifyToolResult({}).reason).toBe("envelope_invalid");
    });

    it("passes a well-formed success payload through", () => {
      const r = classifyToolResult({
        result: { content: [{ type: "text", text: JSON.stringify({ booking_enabled: true }) }] },
      });
      if (!r.ok) throw new Error("expected ok=true");
      expect((r.payload as { booking_enabled: boolean }).booking_enabled).toBe(true);
    });

    it("collapses unlisted tool error codes to TOOL_ERROR_UNCLASSIFIED", () => {
      const r = classifyToolResult({
        result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "made_up_code" }) }] },
      });
      expect(r.reason).toBe("tool_error_unclassified");
    });

    it("preserves an allowlisted tool error code", () => {
      const r = classifyToolResult({
        result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "slot_unavailable" }) }] },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("slot_unavailable");
      expect(r.code).toBe("slot_unavailable");
    });
  });

  describe("validateConfirmed", () => {
    const expected = { serviceId: "oil_change", date: "2026-10-22", time: "11:00" };

    it("accepts a payload that echoes the request", () => {
      const r = validateConfirmed(
        { status: "confirmed", booking_id: "b1", service_id: "oil_change", date: "2026-10-22", time: "11:00" },
        expected,
      );
      expect(r).toEqual({ ok: true, bookingId: "b1" });
    });

    it("rejects mismatched service_id", () => {
      const r = validateConfirmed(
        { status: "confirmed", booking_id: "b1", service_id: "other", date: "2026-10-22", time: "11:00" },
        expected,
      );
      expect(r).toEqual({ ok: false, reason: "confirmed_payload_mismatch" });
    });

    it("rejects empty booking_id", () => {
      const r = validateConfirmed(
        { status: "confirmed", booking_id: "", service_id: "oil_change", date: "2026-10-22", time: "11:00" },
        expected,
      );
      expect(r).toEqual({ ok: false, reason: "booking_id_missing" });
    });

    it("rejects status that is not confirmed", () => {
      const r = validateConfirmed(
        { status: "pending", booking_id: "b1", service_id: "oil_change", date: "2026-10-22", time: "11:00" },
        expected,
      );
      expect(r).toEqual({ ok: false, reason: "confirmed_payload_mismatch" });
    });
  });

  // -------------------------------------------------------------------------
  // Orchestrator behavior
  // -------------------------------------------------------------------------

  it("failed preflight sends no booking", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({ error: "service_unavailable" }, 503) as unknown as Response,
    );
    const result: RunResult = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.checks[0]).toEqual({
      name: "availability.preflight",
      outcome: "FAIL",
      detail: "http_non_2xx",
    });
    expect(result.checks.some((c: Check) => c.name.startsWith("booking"))).toBe(false);
  });

  it("failed preflight with tool error sends no booking", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => makeToolError("booking_disabled") as unknown as Response);
    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.checks[0]?.detail).toBe("booking_disabled");
  });

  it("missing time slot in availability preflight stops the run", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                date: VALID_ARGS.date,
                timezone: "America/Mexico_City",
                booking_enabled: true,
                available_times: ["10:00"],
              }),
            },
          ],
        },
      }) as unknown as Response,
    );
    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.checks[0]?.detail).toBe("slot_not_available");
  });

  it("booking_disabled in availability stops the run", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                date: VALID_ARGS.date,
                timezone: "America/Mexico_City",
                booking_enabled: false,
                available_times: [VALID_ARGS.time, VALID_ARGS["alternate-time"]],
              }),
            },
          ],
        },
      }) as unknown as Response,
    );
    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.checks[0]?.detail).toBe("booking_disabled_false");
  });

  it("replay timeout sends no subsequent request", async () => {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url: string | URL | Request, options?: RequestInit) => {
      calls.push(options);
      if (calls.length === 1) return makeAvailabilityOk() as unknown as Response;
      if (calls.length === 2) return makeConfirmed("bid-1") as unknown as Response;
      // Third call (replay): body stalls until the AbortController fires.
      return makeStalledResponse(options?.signal) as unknown as Response;
    });

    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 50,
    });

    expect(calls).toHaveLength(3);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.exitCode).toBe(2);
    expect(result.bookingId).toBe("bid-1");
    expect(result.checks.map((c: Check) => c.name)).toEqual([
      "availability.preflight",
      "booking.first",
      "booking.replay",
    ]);
    expect(result.checks[2]?.outcome).toBe("INCONCLUSIVE");
    expect(result.checks[2]?.detail).toBe("transport_timeout");
  });

  it("tool service_unavailable on booking is INCONCLUSIVE and stops the run", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls.push(1);
      if (calls.length === 1) return makeAvailabilityOk() as unknown as Response;
      return makeJsonResponse({
        result: {
          isError: true,
          content: [{ type: "text", text: "service_unavailable" }],
        },
      }) as unknown as Response;
    });
    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.exitCode).toBe(2);
    expect(result.checks[1]?.outcome).toBe("INCONCLUSIVE");
    expect(result.checks[1]?.detail).toBe("tool_error_unclassified");
  });

  it("malformed booking success payload is INCONCLUSIVE and stops the run", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      callCount++;
      if (callCount === 1) return makeAvailabilityOk() as unknown as Response;
      return makeJsonResponse({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "confirmed",
                booking_id: "bid-1",
                service_id: "WRONG",
                date: VALID_ARGS.date,
                time: VALID_ARGS.time,
              }),
            },
          ],
        },
      }) as unknown as Response;
    });
    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.checks[1]?.outcome).toBe("INCONCLUSIVE");
    expect(result.checks[1]?.detail).toBe("confirmed_payload_mismatch");
  });

  it("remote error sentinel never appears in stdout or stderr", async () => {
    const SENTINEL = `__sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const TOKEN_SENTINEL = "secret-token-xyz-9999";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `internal server crash details: ${SENTINEL}`,
            },
          ],
        },
      }) as unknown as Response,
    );
    const result = await run({
      args: VALID_ARGS,
      token: TOKEN_SENTINEL,
      fetchImpl,
      timeoutMs: 1000,
    });

    const allOutput = [...logs, ...errs].join("\n");
    expect(allOutput).not.toContain(SENTINEL);
    expect(allOutput).not.toContain("internal server crash");
    expect(allOutput).not.toContain(TOKEN_SENTINEL);
    expect(allOutput).not.toContain("MCP Conversation Probe");
    expect(allOutput).not.toContain("+52 55 0000 0000");
    expect(result.outcome).toBe("FAIL");
  });

  it("happy path returns PASS and exercises every step", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls.push(1);
      if (calls.length === 1) return makeAvailabilityOk() as unknown as Response;
      if (calls.length === 2) return makeConfirmed("bid-1") as unknown as Response;
      if (calls.length === 3) return makeConfirmed("bid-1") as unknown as Response; // replay
      if (calls.length === 4) {
        // alternate time on same conversation: conversation_already_booked
        return makeToolError("conversation_already_booked") as unknown as Response;
      }
      return makeJsonResponse({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                date: VALID_ARGS.date,
                timezone: "America/Mexico_City",
                booking_enabled: true,
                available_times: [VALID_ARGS["alternate-time"]],
              }),
            },
          ],
        },
      }) as unknown as Response;
    });

    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(calls).toHaveLength(5);
    expect(result.outcome).toBe("PASS");
    expect(result.exitCode).toBe(0);
    expect(result.bookingId).toBe("bid-1");
    expect(result.checks.every((c: Check) => c.outcome === "PASS")).toBe(true);
    expect(result.checks.map((c: Check) => c.name)).toEqual([
      "availability.preflight",
      "booking.first",
      "booking.replay",
      "booking.alternate",
      "post.availability.primary_occupied",
      "post.availability.alternate_available",
    ]);
  });

  it("alternate booking returning service_unavailable is INCONCLUSIVE and skips postflight", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls.push(1);
      if (calls.length === 1) return makeAvailabilityOk() as unknown as Response;
      if (calls.length === 2) return makeConfirmed("bid-1") as unknown as Response;
      if (calls.length === 3) return makeConfirmed("bid-1") as unknown as Response;
      // Alternate-time booking surfaces service_unavailable: we cannot tell
      // whether the actor persisted anything before failing, so the run is
      // INCONCLUSIVE and the orchestrator must NOT issue the postflight
      // availability read.
      return makeJsonResponse({
        result: {
          isError: true,
          content: [{ type: "text", text: "service_unavailable" }],
        },
      }) as unknown as Response;
    });

    const result = await run({
      args: VALID_ARGS,
      token: VALID_TOKEN,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(calls).toHaveLength(4);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.exitCode).not.toBe(0);
    expect(result.bookingId).toBe("bid-1");
    expect(result.checks.map((c: Check) => c.name)).toEqual([
      "availability.preflight",
      "booking.first",
      "booking.replay",
      "booking.alternate",
    ]);
    expect(result.checks[3]?.outcome).toBe("INCONCLUSIVE");
    expect(result.checks[3]?.detail).toBe("tool_error_unclassified");
  });

  // -------------------------------------------------------------------------
  // Body-timeout enforcement
  // -------------------------------------------------------------------------

  it("stalled response body is aborted by the AbortController", async () => {
    let aborted = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url: string | URL | Request, options?: RequestInit) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return makeStalledResponse(options?.signal) as unknown as Response;
    });

    const start = Date.now();
    const result = await fetchJsonWithTimeout(
      "http://x/mcp",
      {
        fetchImpl,
        fetchOptions: { method: "POST", headers: {}, body: "{}" },
      },
      50,
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.kind).toBe("timeout");
    expect(aborted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("fetchJsonWithTimeout clears the timer on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => makeJsonResponse({ ok: true }) as unknown as Response);
    const result = await fetchJsonWithTimeout(
      "http://x/mcp",
      {
        fetchImpl,
        fetchOptions: { method: "POST", headers: {}, body: "{}" },
      },
      5_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.body).toEqual({ ok: true });
  });
});
