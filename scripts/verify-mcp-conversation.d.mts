// Type declarations for scripts/verify-mcp-conversation.mjs.
// Mirrors the actual exports; consumed by the vitest regression test only.

export type CheckOutcome = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface Check {
  name: string;
  outcome: CheckOutcome;
  detail?: string;
}

export interface RunResult {
  outcome: CheckOutcome;
  exitCode: number;
  checks: Check[];
  bookingId: string | null;
  fatalError?: string;
}

export interface RunOptions {
  args: Record<string, string>;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  serviceId?: string;
}

export function parseArgs(argv: string[]):
  | { args: Record<string, string>; error?: undefined }
  | { error: string; args?: undefined };

export function deriveConversationId(runId: string): string;

export type FetchJsonResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: "timeout" | "network" };

export interface FetchJsonOptions {
  fetchImpl: typeof globalThis.fetch;
  fetchOptions: { method?: string; headers?: Record<string, string>; body?: string };
}

export function fetchJsonWithTimeout(
  url: string,
  options: FetchJsonOptions,
  timeoutMs: number,
): Promise<FetchJsonResult>;

export type ClassifyResult = {
  ok: boolean;
  payload?: unknown;
  code?: string;
  reason: string;
};

export function classifyToolResult(envelope: unknown): ClassifyResult;

export interface ConfirmedExpected {
  serviceId: string;
  date: string;
  time: string;
}

export type ValidateResult =
  | { ok: true; bookingId: string }
  | { ok: false; reason: string };

export function validateConfirmed(payload: unknown, expected: ConfirmedExpected): ValidateResult;

export function run(options: RunOptions): Promise<RunResult>;
