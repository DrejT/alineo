import { describe, expect, it } from "bun:test";
import { AlineoError } from "@alineo-labs/errors";
import { formatError } from "../src/format-error";

describe("formatError", () => {
  it("prints the message alone for an error with no hint", () => {
    expect(formatError(new Error("boom"))).toBe("Error: boom");
  });

  it("prints the hint on its own line after the message", () => {
    const err = new AlineoError("EXEC_NOT_READY", "execd not ready for sandbox sb-1", {
      hint: "check that execd_image matches",
    });

    expect(formatError(err)).toBe(
      "Error: execd not ready for sandbox sb-1\nHint: check that execd_image matches",
    );
  });

  it("uses the default hint of a code that has one", () => {
    const err = new AlineoError("EXEC_NOT_READY", "execd not ready");

    expect(formatError(err)).toContain("\nHint: ");
  });

  it("prints a thrown string", () => {
    expect(formatError("nope")).toBe("Error: nope");
  });

  it("prints null without throwing", () => {
    expect(formatError(null)).toBe("Error: null");
  });
});
