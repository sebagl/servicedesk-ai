// Standalone Ed25519 verifier for incoming Telnyx webhook requests.
// Pure: given the inputs, it returns a deterministic typed result. No I/O,
// no logging, no network access — caller-supplied headers and bodies are
// never logged, parsed, or transmitted.

export type VerifyResult =
  | { kind: "valid" }
  | { kind: "invalid_signature" }
  | { kind: "invalid_configuration" };

export interface VerifyWebhookSignatureInput {
  rawBody: Uint8Array;
  headers: Headers;
  publicKeyBase64: string;
  nowMs: number;
}

const SIG_HEADER = "telnyx-signature-ed25519";
const TS_HEADER = "telnyx-timestamp";

// Telnyx documents a 5-minute (300s) tolerance on either side of the
// received timestamp. Kept symmetric so future / past skew are treated
// identically — both bound replay windows.
const TOLERANCE_SECONDS = 300;

// Ed25519 raw public keys are exactly 32 bytes; raw signatures exactly 64.
// Hard-coding these lengths lets us fail fast on malformed inputs without
// round-tripping through the crypto API.
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Strict, padded base64 → Uint8Array. Returns null on any shape that the
// standard decoder would reject: empty, wrong length, bad padding, or any
// character outside the alphabet. We deliberately avoid atob / Buffer so the
// verifier behaves identically on Node and on the Telnyx Edge runtime.
// Return type is parameterized to Uint8Array<ArrayBuffer> so the result is
// directly assignable to crypto.subtle's BufferSource without a cast.
function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(value)) return null;

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let i = 0;

  for (let idx = 0; idx < value.length; idx += 4) {
    const a = BASE64_ALPHABET.indexOf(value[idx]!);
    const b = BASE64_ALPHABET.indexOf(value[idx + 1]!);
    const c =
      value[idx + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[idx + 2]!);
    const d =
      value[idx + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[idx + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;

    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (i < output.length) output[i++] = (chunk >> 16) & 0xff;
    if (i < output.length) output[i++] = (chunk >> 8) & 0xff;
    if (i < output.length) output[i++] = chunk & 0xff;
  }

  return output;
}

// Validates the timestamp header numerically (format, safe-integer range,
// ±TOLERANCE_SECONDS window around nowSec) and returns the parsed integer.
// The verifier uses the ORIGINAL header string — not this number — when
// building the signed payload, so any canonical form Telnyx chose (e.g.
// leading zeros) is preserved byte-for-byte.
function parseTimestamp(value: string, nowMs: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const ts = Number(value);
  if (!Number.isSafeInteger(ts)) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > TOLERANCE_SECONDS) return null;
  return ts;
}

export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<VerifyResult> {
  const { rawBody, headers, publicKeyBase64, nowMs } = input;

  // nowMs drives the replay window. A non-finite value means the caller
  // could not determine the current time, so no timestamp comparison would
  // be meaningful — refuse to verify anything and report the misconfiguration.
  if (!Number.isFinite(nowMs)) {
    return { kind: "invalid_configuration" };
  }

  // The public key is a server-side concern: if it is missing, malformed, or
  // the wrong length, no caller-supplied request could ever authenticate, and
  // the operator must fix the deployment before traffic is accepted. This
  // check runs early so a bad key never gets reported as a bad signature.
  if (typeof publicKeyBase64 !== "string" || publicKeyBase64.length === 0) {
    return { kind: "invalid_configuration" };
  }
  const keyBytes = decodeBase64(publicKeyBase64);
  if (keyBytes === null || keyBytes.length !== KEY_LENGTH) {
    return { kind: "invalid_configuration" };
  }

  // All header-level checks fall under invalid_signature: the request itself
  // is what failed to authenticate, regardless of the specific reason.
  const timestampHeader = headers.get(TS_HEADER);
  if (timestampHeader === null) return { kind: "invalid_signature" };
  const ts = parseTimestamp(timestampHeader, nowMs);
  if (ts === null) return { kind: "invalid_signature" };

  const signatureHeader = headers.get(SIG_HEADER);
  if (signatureHeader === null) return { kind: "invalid_signature" };
  const signatureBytes = decodeBase64(signatureHeader);
  if (signatureBytes === null || signatureBytes.length !== SIGNATURE_LENGTH) {
    return { kind: "invalid_signature" };
  }

  // Telnyx signs `${timestampHeader}|${rawBody}` exactly — no canonicalization,
  // no JSON re-serialization, no charset assumption beyond UTF-8 on the
  // prefix. Using the ORIGINAL header string (not the parsed integer) keeps
  // any leading-zero / digit-width choices Telnyx made, so the byte sequence
  // we verify matches the byte sequence Telnyx signed. Concatenating as
  // Uint8Array preserves the body bytes byte-for-byte.
  const prefix = new TextEncoder().encode(`${timestampHeader}|`);
  const signedPayload = new Uint8Array(prefix.length + rawBody.length);
  signedPayload.set(prefix, 0);
  signedPayload.set(rawBody, prefix.length);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const isValid = await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      signatureBytes,
      signedPayload,
    );
    return isValid
      ? { kind: "valid" }
      : { kind: "invalid_signature" };
  } catch {
    // A throw here means the platform refused to verify (Ed25519 unavailable,
    // bytes not a valid Ed25519 point, etc.) — a deployment / runtime problem,
    // not a signature mismatch. Refuse to claim the signature is invalid.
    return { kind: "invalid_configuration" };
  }
}
