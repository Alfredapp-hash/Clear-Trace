import { describe, expect, it } from "vitest";
import { CURATED_BROKER_COUNT } from "./count";
import { BROKER_UNIVERSE } from "./universe";

describe("CURATED_BROKER_COUNT", () => {
  it("matches the curated broker universe", () => {
    expect(CURATED_BROKER_COUNT).toBe(BROKER_UNIVERSE.length);
  });
});
