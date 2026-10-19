// Entry point declared in telnyx.toml. Every Actor class must be exported
// from here; `telnyx-edge types` reads these exports to generate bindings.
export { CallbackQueue } from "./actors/callback-queue";
export { ConversationBooking } from "./actors/conversation-booking";
export { Counter } from "./actors/counter";
export { DayAgenda } from "./actors/day-agenda";
export { Metrics } from "./actors/metrics";
export { __resetMcpTokenCacheForTests } from "./http/auth";

import type { Env } from "./env";
import { route } from "./http/router";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return route(req, env);
  },
};
