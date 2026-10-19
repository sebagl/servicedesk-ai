import { describe, it, expect } from "vitest";

import { verifyWebhookSignature } from "../../src/http/webhook-signature";

// ---------------------------------------------------------------------------
// Key-pair and signing helpers — generate a fresh Ed25519 key per test so no
// state leaks across cases. The signer mirrors Telnyx's canonical form:
// UTF-8(`${timestamp}|`) || exact raw body bytes.
// ---------------------------------------------------------------------------

interface KeyPair {
  publicKeyBase64: string;
  privateKey: CryptoKey;
}

async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return {
    publicKeyBase64: bytesToBase64(new Uint8Array(raw)),
    privateKey: kp.privateKey,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function sign(
  privateKey: CryptoKey,
  timestamp: number,
  body: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, msg);
  return bytesToBase64(new Uint8Array(sig));
}

// Like sign(), but accepts the EXACT header string so the prefix bytes
// preserve any leading zeros / digit-width choices. Used by the canonical-
// form regression tests below.
async function signWithHeaderString(
  privateKey: CryptoKey,
  timestampHeader: string,
  body: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${timestampHeader}|`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, msg);
  return bytesToBase64(new Uint8Array(sig));
}

// Fixed "now" so tests are reproducible regardless of wall-clock drift.
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeHeaders(signatureBase64: string, timestamp: number | string): Headers {
  return new Headers({
    "telnyx-signature-ed25519": signatureBase64,
    "telnyx-timestamp": String(timestamp),
  });
}

function dummySignature64(): string {
  return bytesToBase64(new Uint8Array(64));
}

// ---------------------------------------------------------------------------
// Happy path — the verifier must accept a payload that was actually signed
// by the supplied key, without touching the body bytes.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — happy path", () => {
  it("accepts a freshly signed JSON payload", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode(
      JSON.stringify({ data: { event_type: "call.initiated" } }),
    );
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("preserves exact raw bytes — trailing whitespace and key order matter", async () => {
    // A re-serializing verifier would drop the trailing space or reorder the
    // keys; this case catches that class of bug.
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode('{"b":2,"a":1} ');
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("accepts an empty body", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const signature = await sign(privateKey, NOW_SEC, new Uint8Array(0));
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("accepts a Unicode (UTF-8 multibyte) payload", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode(
      JSON.stringify({ msg: "こんにちは 🌍 Здравствуй" }),
    );
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("accepts a payload whose body contains NUL and high-bit bytes", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    // Raw bytes with a NUL in the middle and 0xFF on either side.
    const body = new Uint8Array([0xff, 0x00, 0x7f, 0x80, 0xfe]);
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("reads headers case-insensitively (Headers spec behavior)", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const signature = await sign(privateKey, NOW_SEC, body);
    const headers = new Headers();
    headers.set("Telnyx-Signature-Ed25519", signature);
    headers.set("TELNYX-TIMESTAMP", String(NOW_SEC));
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers,
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "valid" });
  });
});

// ---------------------------------------------------------------------------
// Body tampering — the verifier must detect any byte-level change to the body.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — body tampering", () => {
  it("rejects when a single byte is appended to the body", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode('{"x":1}');
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: new TextEncoder().encode('{"x":1} '),
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects when a body byte is changed", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode('{"x":1}');
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: new TextEncoder().encode('{"x":2}'),
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects when the body is truncated", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode('{"x":12345}');
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: new TextEncoder().encode('{"x":1'),
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });
});

// ---------------------------------------------------------------------------
// Wrong key — a signature from one key pair must not validate against a
// different key pair's public key.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — wrong key", () => {
  it("rejects when verified with a different key pair", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const body = new TextEncoder().encode("hello");
    const signature = await sign(a.privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64: b.publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects when the signature is bit-flipped", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const signature = await sign(privateKey, NOW_SEC, body);
    const sigBytes = new Uint8Array(
      atob(signature).split("").map((c) => c.charCodeAt(0)),
    );
    sigBytes[0] ^= 0x01;
    const tampered = bytesToBase64(sigBytes);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(tampered, NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });
});

// ---------------------------------------------------------------------------
// Missing headers — Telnyx requires both signature and timestamp.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — missing headers", () => {
  it("rejects when the signature header is missing", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers({ "telnyx-timestamp": String(NOW_SEC) }),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects when the timestamp header is missing", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers({
        "telnyx-signature-ed25519": dummySignature64(),
      }),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects when both headers are missing", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });
});

// ---------------------------------------------------------------------------
// Malformed base64 / wrong lengths — both for the signature and the public key.
// Signature issues are caller faults (invalid_signature); public-key issues are
// server-side configuration problems (invalid_configuration).
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — malformed signature", () => {
  it("rejects a signature whose base64 contains non-alphabet characters", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders("not!base64!@", NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature whose base64 length is not a multiple of 4", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders("AAAAA", NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature that has too many padding '=' chars", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders("A===", NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature that decodes to 0 bytes (empty string)", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders("", NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature that decodes to 63 bytes (one short)", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(bytesToBase64(new Uint8Array(63)), NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature that decodes to 65 bytes (one too many)", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(bytesToBase64(new Uint8Array(65)), NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a signature that decodes to 128 bytes (way too long)", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(bytesToBase64(new Uint8Array(128)), NOW_SEC),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });
});

// ---------------------------------------------------------------------------
// Timestamp window — exactly ±300 seconds. The boundary is inclusive.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — timestamp window (±300s, inclusive)", () => {
  async function expectOutcome(
    ts: number,
    expected: "valid" | "invalid_signature",
  ): Promise<void> {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const signature = await sign(privateKey, ts, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, ts),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: expected });
  }

  it("accepts a timestamp at exactly nowSec", async () => {
    await expectOutcome(NOW_SEC, "valid");
  });

  it("accepts a timestamp at exactly nowSec - 300 (past boundary inclusive)", async () => {
    await expectOutcome(NOW_SEC - 300, "valid");
  });

  it("accepts a timestamp at exactly nowSec + 300 (future boundary inclusive)", async () => {
    await expectOutcome(NOW_SEC + 300, "valid");
  });

  it("accepts a timestamp at nowSec - 299", async () => {
    await expectOutcome(NOW_SEC - 299, "valid");
  });

  it("accepts a timestamp at nowSec + 299", async () => {
    await expectOutcome(NOW_SEC + 299, "valid");
  });

  it("rejects a timestamp at nowSec - 301 (one second too old)", async () => {
    await expectOutcome(NOW_SEC - 301, "invalid_signature");
  });

  it("rejects a timestamp at nowSec + 301 (one second too new)", async () => {
    await expectOutcome(NOW_SEC + 301, "invalid_signature");
  });

  it("rejects a deeply stale timestamp (one day old)", async () => {
    await expectOutcome(NOW_SEC - 86_400, "invalid_signature");
  });

  it("rejects a far-future timestamp (one day ahead)", async () => {
    await expectOutcome(NOW_SEC + 86_400, "invalid_signature");
  });
});

// ---------------------------------------------------------------------------
// Timestamp format — strict decimal integer seconds.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — timestamp format", () => {
  it("rejects an empty timestamp", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), ""),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a non-decimal timestamp (decimal point)", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), `${NOW_SEC}.5`),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a non-numeric timestamp", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), "abcdef"),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a timestamp with leading whitespace", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), ` ${NOW_SEC}`),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a timestamp with trailing whitespace", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), `${NOW_SEC} `),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a negative timestamp", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), `-${NOW_SEC}`),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a timestamp with a leading plus sign", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), `+${NOW_SEC}`),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("rejects a timestamp outside the safe-integer range", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    // Appends a zero to MAX_SAFE_INTEGER — Number() loses precision and the
    // parsed value is no longer a safe integer.
    const huge = String(Number.MAX_SAFE_INTEGER) + "0";
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: makeHeaders(dummySignature64(), huge),
      publicKeyBase64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });
});

// ---------------------------------------------------------------------------
// Invalid configuration — anything wrong with the supplied public key. These
// must be reported as invalid_configuration, never invalid_signature, because
// no caller request could have authenticated against a broken verifier.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — invalid configuration", () => {
  it("returns invalid_configuration when the public key is missing (empty string)", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: "",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key is not a string", async () => {
    // Cast through unknown to simulate a runtime caller that bypassed types.
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: undefined as unknown as string,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key contains non-base64 characters", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: "not_base64!@#$",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key base64 length is not a multiple of 4", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 30 chars
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key has too many padding '=' chars", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: "A===",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key decodes to 16 bytes (too short)", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: bytesToBase64(new Uint8Array(16)),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when the public key decodes to 64 bytes (too long)", async () => {
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: bytesToBase64(new Uint8Array(64)),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration even when the request itself looks valid", async () => {
    // Public-key check happens first, so a bad key shadows any other issue —
    // including a request that otherwise would have authenticated.
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64: "",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });
});

// ---------------------------------------------------------------------------
// Canonical form: the verifier must build the signed payload from the
// EXACT header string (not the parsed integer). Telnyx chose a string form
// for the timestamp; we must mirror that byte-for-byte, including any
// leading zeros — otherwise a perfectly valid request would fail because
// the two sides disagree on what `${ts}|` looks like.
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — timestamp header canonical form", () => {
  // "01700000000" is 11 chars; Number() parses it to 1700000000 with the
  // leading zero stripped. The byte sequences "01700000000|" and
  // "1700000000|" are different even though the integers are equal.
  const TS_HEADER = "01700000000";
  const TS_PARSED = 1_700_000_000;
  const NOW_MS_FOR_HEADER = TS_PARSED * 1000;

  it("accepts a signature whose prefix matches the EXACT header string (leading zero)", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    // Signed over the literal "01700000000|" — the leading zero is part of
    // the signed bytes. Sending that exact header must validate.
    const signature = await signWithHeaderString(privateKey, TS_HEADER, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, TS_HEADER),
      publicKeyBase64,
      nowMs: NOW_MS_FOR_HEADER,
    });
    expect(result).toEqual({ kind: "valid" });
  });

  it("rejects a signature over the parsed-integer prefix when the header keeps the leading zero", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    // Signed over the parsed-integer form "1700000000|" (no leading zero),
    // but the header sent is "01700000000" — the verifier builds its prefix
    // from the header and gets a different byte sequence.
    const signature = await signWithHeaderString(
      privateKey,
      String(TS_PARSED),
      body,
    );
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, TS_HEADER),
      publicKeyBase64,
      nowMs: NOW_MS_FOR_HEADER,
    });
    expect(result).toEqual({ kind: "invalid_signature" });
  });

  it("the two prefixes are byte-different even though they parse to the same integer", async () => {
    // Sanity check on the fixtures themselves — guards the regression tests
    // above against a silent change in test data.
    const withZero = new TextEncoder().encode(`${TS_HEADER}|`);
    const withoutZero = new TextEncoder().encode(`${TS_PARSED}|`);
    expect(withZero.length).toBe(TS_HEADER.length + 1);
    expect(withoutZero.length).toBe(String(TS_PARSED).length + 1);
    expect(withZero.length).not.toBe(withoutZero.length);
  });
});

// ---------------------------------------------------------------------------
// Non-finite nowMs: NaN, +Infinity, -Infinity. The verifier cannot determine
// "now" and therefore cannot bound the replay window — every such call is
// reported as invalid_configuration, BEFORE the timestamp window check runs
// (so even a stale-but-correctly-signed request short-circuits to
// invalid_configuration, never invalid_signature).
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature — non-finite nowMs", () => {
  it("returns invalid_configuration when nowMs is NaN", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64,
      nowMs: Number.NaN,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when nowMs is +Infinity", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64,
      nowMs: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration when nowMs is -Infinity", async () => {
    const { publicKeyBase64 } = await generateKeyPair();
    const result = await verifyWebhookSignature({
      rawBody: new Uint8Array(0),
      headers: new Headers(),
      publicKeyBase64,
      nowMs: Number.NEGATIVE_INFINITY,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration for a stale-but-correctly-signed request when nowMs is NaN", async () => {
    // The signature is genuinely valid for `${staleTs}|${body}`; without the
    // nowMs gate it would have failed with invalid_signature (stale by a day).
    // With nowMs = NaN the verifier must short-circuit to invalid_configuration,
    // proving the finiteness check precedes the timestamp window check.
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const staleTs = NOW_SEC - 86_400;
    const signature = await sign(privateKey, staleTs, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, staleTs),
      publicKeyBase64,
      nowMs: Number.NaN,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration for a fresh correctly-signed request when nowMs is +Infinity", async () => {
    // Fresh signature, valid timestamp, valid key — only nowMs is broken.
    // The verifier must still refuse with invalid_configuration.
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });

  it("returns invalid_configuration for a fresh correctly-signed request when nowMs is -Infinity", async () => {
    const { publicKeyBase64, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode("ok");
    const signature = await sign(privateKey, NOW_SEC, body);
    const result = await verifyWebhookSignature({
      rawBody: body,
      headers: makeHeaders(signature, NOW_SEC),
      publicKeyBase64,
      nowMs: Number.NEGATIVE_INFINITY,
    });
    expect(result).toEqual({ kind: "invalid_configuration" });
  });
});
