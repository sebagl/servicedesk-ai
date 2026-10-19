// Test page for evaluators: embeds the Telnyx AI Agent web widget so the
// assistant can be called from a browser while no phone number is attached.
// The assistant id comes from Edge secrets and is validated before it is
// placed in the HTML.

const ASSISTANT_ID_PATTERN = /^assistant-[A-Za-z0-9-]{1,100}$/;

// Pinned widget build with Subresource Integrity, like the portal's scripts.
const WIDGET_SRC = "https://unpkg.com/@telnyx/ai-agent-widget@0.36.0/dist/bundle.min.js";
const WIDGET_SRI = "sha384-HpQCPH/+U7KWqJp+MLUc/a2uw01ta4Mytbb0NxHShFezMnrsao9SpxjPm7H+7Se6";

export function isValidAssistantId(id: string): boolean {
  return ASSISTANT_ID_PATTERN.test(id);
}

export function renderCallPage(assistantId: string): string {
  if (!isValidAssistantId(assistantId)) {
    throw new Error("invalid assistant id");
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ServiceDesk AI — Talk to the receptionist</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1a1a1f; --muted: #5b5b66; --card: #ffffff; --line: #e3e3e8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141418; --fg: #ececf1; --muted: #a0a0ad; --card: #1d1d23; --line: #2e2e36; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 120px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
<main>
  <h1>ServiceDesk AI</h1>
  <p>Voice receptionist for an auto repair shop in Mexico City. Start a call with the button
  on this page, allow the microphone, and speak in English.</p>

  <section>
    <h2>Try saying</h2>
    <ul>
      <li>"What services do you offer?"</li>
      <li>"I'd like an oil change on Thursday."</li>
      <li>"Can I come on Saturday?"</li>
      <li>"I want to talk to a person."</li>
    </ul>
  </section>

  <section>
    <h2>Shop rules</h2>
    <ul>
      <li>Monday to Friday, 9 AM to 5 PM (last appointment 4 PM), Mexico City time.</li>
      <li>Bookings up to 7 days ahead, one car per time slot.</li>
      <li>Services: oil change, tire rotation, general maintenance.</li>
    </ul>
  </section>
</main>
<telnyx-ai-agent agent-id="${assistantId}"></telnyx-ai-agent>
<script async src="${WIDGET_SRC}" integrity="${WIDGET_SRI}" crossorigin="anonymous"></script>
</body>
</html>
`;
}
