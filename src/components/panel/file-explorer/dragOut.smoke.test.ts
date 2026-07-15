import { describe, expect, it } from "vitest";

describe("vitest 环境冒烟", () => {
  it("能跑通", () => {
    expect(1 + 1).toBe(2);
  });
});
