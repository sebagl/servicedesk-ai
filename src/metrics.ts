import type { ActorNamespace, ActorStub, IdFromNameOptions } from "@telnyx/edge-runtime";
import type { Metrics, MetricInput } from "./metrics-actor";
import { getLocalDateString } from "./scheduling";
import { logEvent } from "./logger";

export type MetricsStub = ActorStub & Pick<Metrics, "record" | "snapshot">;
export interface MetricsNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): MetricsStub;
}

// Long enough for a healthy Actor write, short enough that a slow one adds
// at most this much to a webhook or tool call.
const RECORD_TIMEOUT_MS = 300;

export function metricsActorName(date: string): string {
  return `metrics-${date}`;
}

// Metrics are best-effort: every failure (missing binding, throw, timeout)
// is swallowed so a booking, webhook or tool result is never affected.
export async function recordMetric(
  metrics: MetricsNamespace | undefined,
  input: MetricInput,
): Promise<void> {
  if (metrics === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = metrics.idFromName(metricsActorName(getLocalDateString(Date.now())));
    const outcome = await Promise.race([
      stub.record(input).then(() => "ok" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), RECORD_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timeout") logEvent("metrics.record_failed", { reason: "timeout" });
  } catch {
    logEvent("metrics.record_failed", { reason: "error" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
