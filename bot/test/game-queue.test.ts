import { describe, expect, it } from "vitest";
import { GameQueue } from "../src/chain/viem-ledger.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GameQueue ordering", () => {
  it("runs one kind in parallel, but a new kind waits for the previous one", async () => {
    const q = new GameQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };
    const all = [
      q.run(job("create", 5), null),
      q.run(job("night-wolf", 30), "commitNightAction"),
      q.run(job("night-seer", 10), "commitNightAction"),
      // Sent while the night is still in flight (a fast table): must not start before both nights end.
      q.run(job("vote-a", 5), "castVote"),
      q.run(job("vote-b", 5), "castVote"),
      q.run(job("record", 5), null),
    ];
    await Promise.all(all);
    const at = (e: string) => log.indexOf(e);
    // Night commitments overlap each other.
    expect(at("start night-seer")).toBeLessThan(at("end night-wolf"));
    // Votes start only after every night commitment ended, and overlap each other.
    expect(at("start vote-a")).toBeGreaterThan(at("end night-wolf"));
    expect(at("start vote-a")).toBeGreaterThan(at("end night-seer"));
    expect(at("start vote-b")).toBeLessThan(at("end vote-a"));
    // The ordered step waits for all votes.
    expect(at("start record")).toBeGreaterThan(at("end vote-a"));
    expect(at("start record")).toBeGreaterThan(at("end vote-b"));
  });

  it("keeps going after a failed action", async () => {
    const q = new GameQueue();
    const done: string[] = [];
    const failed = q.run(async () => {
      throw new Error("boom");
    }, "commitNightAction");
    const vote = q.run(async () => void done.push("vote"), "castVote");
    await expect(failed).rejects.toThrow("boom");
    await vote;
    expect(done).toEqual(["vote"]);
  });
});
