import { describe, expect, it } from "bun:test";
import { isSandboxGone } from "../src/sandbox-gone";

describe("isSandboxGone", () => {
  it("recognizes a 404-shaped error via its code (DOCKER::SANDBOX_NOT_FOUND)", () => {
    expect(isSandboxGone({ code: "DOCKER::SANDBOX_NOT_FOUND" })).toBe(true);
  });

  it("recognizes a 404-shaped error via its message when there is no code", () => {
    expect(isSandboxGone(new Error("404: SANDBOX_NOT_FOUND"))).toBe(true);
  });

  it("recognizes an Exited-after-reboot container (200 OK, state Terminated/Failed)", () => {
    expect(
      isSandboxGone(
        new Error("SandboxHandle sb-1 is Terminated — can only connect to Running sandboxes"),
      ),
    ).toBe(true);
    expect(
      isSandboxGone(
        new Error("SandboxHandle sb-1 is Failed — can only connect to Running sandboxes"),
      ),
    ).toBe(true);
  });

  it("does not match a Paused sandbox — that's recoverable without a restore", () => {
    expect(
      isSandboxGone(
        new Error(
          "SandboxHandle sb-1 is Paused — can only connect to Running sandboxes " +
            "(pass allowPaused to connect to a Paused one)",
        ),
      ),
    ).toBe(false);
  });

  it("does not match an unrelated error", () => {
    expect(isSandboxGone(new Error("ECONNREFUSED"))).toBe(false);
  });

  it("does not throw on a non-object value", () => {
    expect(isSandboxGone(null)).toBe(false);
    expect(isSandboxGone("plain string")).toBe(false);
    expect(isSandboxGone(undefined)).toBe(false);
  });
});
