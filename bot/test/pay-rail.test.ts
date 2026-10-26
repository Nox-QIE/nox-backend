import { describe, expect, it } from "vitest";
import { countryGuess, parseCountry, payRail } from "../src/pay-rail.js";

describe("payment rail by country (F14-D04)", () => {
  it("pays in rupiah from Indonesia and on chain elsewhere, with a guess from the account language", () => {
    expect(payRail("ID")).toBe("rupiah");
    expect(payRail("SG")).toBe("onchain");
    expect(payRail(null)).toBe("onchain");
    expect(countryGuess("id")).toBe("ID");
    expect(countryGuess("id-ID")).toBe("ID");
    expect(countryGuess("en")).toBeNull();
    expect(countryGuess(undefined)).toBeNull();
    expect(parseCountry(" sg ")).toBe("SG");
    expect(parseCountry("IDN")).toBeNull();
    expect(parseCountry("")).toBeNull();
  });
});
