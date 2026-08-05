import { describe, expect, it } from "vitest";

/*
 * TEMPORARY — exists only to make CI fail on purpose, so we can confirm branch
 * protection actually blocks a merge on a red build. Delete with this branch.
 */
describe("branch protection", () => {
  it("fails deliberately", () => {
    expect(1).toBe(2);
  });
});
