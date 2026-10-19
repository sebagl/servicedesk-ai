import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../../src/index";
import { renderCallPage } from "../../src/call/page";

const PASSWORD = "demo-password-for-tests";
const ASSISTANT_ID = "assistant-00000000-1111-2222-3333-444444444444";

function secrets(values: Record<string, string>) {
  return {
    get: vi.fn(async (binding: string) => {
      if (binding in values) return values[binding];
      throw new Error(`unexpected binding: ${binding}`);
    }),
  };
}

function configuredEnv(): unknown {
  return { SECRETS: secrets({ CALL_PAGE_AUTH: PASSWORD, ASSISTANT_ID }) };
}

function basic(password: string, user = "evaluator"): Record<string, string> {
  return { authorization: `Basic ${btoa(`${user}:${password}`)}` };
}

function callReq(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request("http://x/call", { method, headers });
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function logged(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("GET /call — password-protected web call page", () => {
  it("missing credentials → 401 with a Basic challenge", async () => {
    const res = await handler.fetch(callReq(), configuredEnv() as never);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(await res.text()).not.toContain(ASSISTANT_ID);
  });

  it("wrong password → 401 and the submitted password is never logged", async () => {
    const res = await handler.fetch(callReq(basic("not-the-password")), configuredEnv() as never);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(ASSISTANT_ID);
    expect(logged()).toContain("invalid_password");
    expect(logged()).not.toContain("not-the-password");
  });

  it("correct password → 200 HTML with the widget, pinned with SRI, not cached", async () => {
    const res = await handler.fetch(callReq(basic(PASSWORD)), configuredEnv() as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<telnyx-ai-agent agent-id="${ASSISTANT_ID}">`);
    expect(html).toMatch(/@telnyx\/ai-agent-widget@\d+\.\d+\.\d+\/dist\/bundle\.min\.js" integrity="sha384-/);
    expect(logged()).not.toContain(PASSWORD);
  });

  it("the username is ignored; only the password matters", async () => {
    const res = await handler.fetch(callReq(basic(PASSWORD, "anyone")), configuredEnv() as never);
    expect(res.status).toBe(200);
  });

  it("missing secrets → 503 before checking credentials", async () => {
    const res = await handler.fetch(callReq(basic(PASSWORD)), { SECRETS: secrets({}) } as never);
    expect(res.status).toBe(503);
  });

  it("malformed assistant id in secrets → 503, never rendered", async () => {
    const env = { SECRETS: secrets({ CALL_PAGE_AUTH: PASSWORD, ASSISTANT_ID: '"><script>x</script>' }) };
    const res = await handler.fetch(callReq(basic(PASSWORD)), env as never);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("<script>x");
  });

  it("non-GET → 405", async () => {
    const res = await handler.fetch(callReq(basic(PASSWORD), "POST"), configuredEnv() as never);
    expect(res.status).toBe(405);
  });

  it("malformed Basic header → 401", async () => {
    const res = await handler.fetch(
      callReq({ authorization: "Basic !!!not-base64!!!" }),
      configuredEnv() as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("renderCallPage", () => {
  it("refuses an id that does not look like a Telnyx assistant id", () => {
    expect(() => renderCallPage("assistant-<x>")).toThrow();
  });
});
