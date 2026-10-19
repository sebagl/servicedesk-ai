// Streams a request body with a hard 10 KiB limit: a missing or false
// Content-Length must not let an unbounded body into memory. Returns both the
// decoded text and the exact raw bytes (needed for signature verification).

const MAX_BODY_BYTES = 10 * 1024;

export async function readBoundedBody(
  req: Request,
): Promise<
  | { ok: true; text: string; raw: Uint8Array }
  | { ok: false; status: 400 }
  | { ok: false; status: 413 }
> {
  const reader = req.body?.getReader();
  if (!reader) {
    // No body stream — treat as empty (will fail JSON parse later).
    return { ok: true, text: "", raw: new Uint8Array(0) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        // Stream read failure (network reset, aborted connection). The raw
        // error is intentionally discarded — surface a generic 400 so the
        // caller sees a controlled response without leaking internals.
        return { ok: false, status: 400 };
      }
      if (readResult.done) break;
      const value = readResult.value;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Oversized body — return 413 before awaiting cancel so the response
        // is not blocked if the reader's cancel rejects.
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    const text =
      chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
      decoder.decode();
    // Concatenate the exact bytes Telnyx signed — building from the chunks
    // (not from the decoded text) keeps the byte sequence identical for the
    // signature verifier, including any non-UTF-8 / non-canonical form a
    // re-encoder would have lost.
    const raw = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      raw.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, text, raw };
  } finally {
    // The reader lock is NOT released by cancel() or by read() returning
    // done. releaseLock() must be called explicitly. We do NOT await
    // cancel(): a hanging cancel must never delay the 400/413 response —
    // the bounded read above already produced the outcome. The .catch()
    // absorbs any rejection so the cancel promise is never an unhandled
    // rejection. releaseLock() runs synchronously regardless of whether
    // the cancel has settled, so the lock is freed promptly even when the
    // underlying source is wedged.
    reader.cancel().catch(() => {
      // intentionally ignored — rejection has no observable effect
    });
    reader.releaseLock();
  }
}
