import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { NoxGameAbi } from "../src/chain/contracts.js";
import { alreadyDone } from "../src/chain/viem-ledger.js";

const revert = (functionName: string, errorName: string, args: readonly unknown[] = []) =>
  new BaseError("simulate failed", {
    cause: new ContractFunctionRevertedError({ abi: NoxGameAbi, functionName, data: encodeErrorResult({ abi: NoxGameAbi, errorName, args } as never) as Hex }),
  });

describe("alreadyDone: a retry's revert that proves the earlier try landed", () => {
  it("recognises repeats of each step", () => {
    expect(alreadyDone("createGame", revert("createGame", "AlreadyExists"))).toBe(true);
    expect(alreadyDone("joinGame", revert("joinGame", "AlreadyJoined"))).toBe(true);
    expect(alreadyDone("commitNightAction", revert("commitNightAction", "AlreadyCommitted"))).toBe(true);
    expect(alreadyDone("castVote", revert("castVote", "AlreadyVoted"))).toBe(true);
    expect(alreadyDone("commitRoles", revert("commitRoles", "WrongStatus", [1, 2]))).toBe(true);
    expect(alreadyDone("revealAndFinalize", revert("revealAndFinalize", "WrongStatus", [2, 3]))).toBe(true);
    expect(alreadyDone("cancelGame", revert("cancelGame", "WrongStatus", [2, 4]))).toBe(true);
    expect(alreadyDone("recordRound", revert("recordRound", "WrongRound", [3, 2]))).toBe(true);
  });

  it("does not hide real failures", () => {
    expect(alreadyDone("joinGame", revert("joinGame", "GameFull"))).toBe(false);
    expect(alreadyDone("castVote", revert("castVote", "AlreadyJoined"))).toBe(false);
    expect(alreadyDone("revealAndFinalize", revert("revealAndFinalize", "WrongStatus", [2, 4]))).toBe(false); // cancelled, not finalized
    expect(alreadyDone("cancelGame", revert("cancelGame", "WrongStatus", [2, 3]))).toBe(false); // finalized, cannot cancel
    expect(alreadyDone("recordRound", revert("recordRound", "WrongRound", [2, 4]))).toBe(false);
    expect(alreadyDone("revealAndFinalize", revert("revealAndFinalize", "BadReveal", ["0x0000000000000000000000000000000000000001"]))).toBe(false);
    expect(alreadyDone("createGame", new Error("fetch failed"))).toBe(false);
  });
});
