import { StatefulActor } from "@telnyx/edge-runtime";

export class Counter extends StatefulActor {
  async increment(amount = 1): Promise<{ count: number }> {
    const count = (await this.ctx.storage.get<number>("count")) ?? 0;
    const next = count + amount;
    await this.ctx.storage.put("count", next);
    return { count: next };
  }

  async read(): Promise<{ count: number }> {
    return { count: (await this.ctx.storage.get<number>("count")) ?? 0 };
  }
}
