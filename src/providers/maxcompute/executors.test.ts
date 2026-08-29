import { describe, expect, it } from "vitest";

import { assertMaxComputeProjectScope } from "./executors.ts";

describe("MaxCompute project scope", () => {
  it("allows the configured project", () => {
    expect(() => assertMaxComputeProjectScope("analytics", "analytics")).not.toThrow();
  });

  it("rejects cross-project metadata access", () => {
    expect(() => assertMaxComputeProjectScope("other-project", "analytics")).toThrowError(
      expect.objectContaining({
        status: 403,
        message: expect.stringContaining("configured project"),
      }),
    );
  });
});
