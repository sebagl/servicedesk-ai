export { ConversationBooking } from "./actors/conversation-booking";
export { DayAgenda } from "./actors/day-agenda";
export { DayCallbacks } from "./actors/day-callbacks";
export { Metrics } from "./actors/metrics";
export { __resetMcpTokenCacheForTests } from "./http/auth";

import type { Env } from "./env";
import { route } from "./http/router";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return route(req, env);
  },
};
