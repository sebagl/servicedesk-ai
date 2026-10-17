// Minimal structured logger: one JSON object per line via console.log.
// The platform/runtime is responsible for capturing stdout; we never log
// customer PII (name, full phone), auth tokens, or raw request bodies.

export type LogFields = Record<string, string | number | boolean>;

// Keep only the trailing four digits so a caller's number is never exposed
// in full in any log line. Non-digit characters are stripped before slicing,
// so any caller-id format ("+1555...", "tel:555-...") collapses to the same
// masked tail.
export function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

export function logEvent(event: string, fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
