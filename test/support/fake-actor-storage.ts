import { vi } from "vitest";

// In-memory ActorStorage fake whose put() serializes via JSON and get()
// returns a fresh deserialized copy. This mimics real persistence — the
// Actor cannot hold live references; each read is a new object.
//
// Exposes vi.fn spies for get, put, delete so tests can assert call counts.

export function createFakeStorage() {
  let store: Map<string, string> = new Map();

  const get = vi.fn(async (key: string): Promise<unknown> => {
    const raw = store.get(key);
    if (raw === undefined) return undefined;
    return JSON.parse(raw);
  });

  const put = vi.fn(async (key: string, value: unknown): Promise<void> => {
    store.set(key, JSON.stringify(value));
  });

  const del = vi.fn(async (key: string): Promise<boolean> => {
    const had = store.has(key);
    store.delete(key);
    return had;
  });

  return { get, put, del };
}
