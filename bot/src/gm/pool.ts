import type { GmCompletion, GmModel } from "./model.js";

export interface PoolEntry {
  /** "provider:model", e.g. "oxion:claude-opus-5.5". Used in logs and for pricing. */
  label: string;
  model: GmModel;
  weight: number;
}

/**
 * Several provider:model pairs behind one Game Master. Each game gets one primary, picked by
 * weight, so narration varies between games but keeps one voice inside a game. If the primary
 * fails, the others are tried in turn. A failing entry cools down so later calls skip it instead
 * of paying its timeout again.
 */
export class GmModelPool {
  private readonly coolUntil = new Map<string, number>();

  constructor(
    readonly entries: PoolEntry[],
    private readonly randomInt: (maxExclusive: number) => number,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = 60_000,
  ) {
    if (entries.length === 0) throw new Error("GM model pool is empty");
    if (entries.some((e) => !Number.isInteger(e.weight) || e.weight < 1)) throw new Error("GM pool weights must be integers ≥ 1");
  }

  /** A model for one game: weighted pick as primary, then the rest in configured order. */
  forGame(): GmModel {
    const total = this.entries.reduce((n, e) => n + e.weight, 0);
    let r = this.randomInt(total);
    let primary = this.entries[0]!;
    for (const e of this.entries) {
      if (r < e.weight) {
        primary = e;
        break;
      }
      r -= e.weight;
    }
    return new FailoverModel([primary, ...this.entries.filter((e) => e !== primary)], this);
  }

  isCooling(label: string) {
    return (this.coolUntil.get(label) ?? 0) > this.now();
  }

  markFailed(label: string) {
    this.coolUntil.set(label, this.now() + this.cooldownMs);
  }

  markOk(label: string) {
    this.coolUntil.delete(label);
  }
}

class FailoverModel implements GmModel {
  constructor(
    private readonly order: PoolEntry[],
    private readonly pool: GmModelPool,
  ) {}

  get model() {
    return this.order[0]!.label;
  }

  async complete(system: string, user: string, timeoutMs: number): Promise<GmCompletion> {
    const ready = this.order.filter((e) => !this.pool.isCooling(e.label));
    // If everything is cooling down, still try rather than skip the model entirely.
    const tryList = ready.length ? ready : this.order;
    let last: unknown = new Error("no GM model available");
    for (const e of tryList) {
      try {
        const r = await e.model.complete(system, user, timeoutMs);
        this.pool.markOk(e.label);
        return { ...r, model: e.label };
      } catch (err) {
        this.pool.markFailed(e.label);
        last = err;
      }
    }
    throw last;
  }
}
