import { describe, expect, it } from "bun:test";
import { AlineoError } from "@alineo-labs/errors";
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

  describe("by alineo code", () => {
    it("recognizes SANDBOX_NOT_FOUND", () => {
      expect(isSandboxGone(new AlineoError("SANDBOX_NOT_FOUND", "gone"))).toBe(true);
    });

    it("recognizes SANDBOX_NOT_RUNNING for Terminated and Failed", () => {
      for (const state of ["Terminated", "Failed"]) {
        const err = new AlineoError("SANDBOX_NOT_RUNNING", "not running", { details: { state } });
        expect(isSandboxGone(err)).toBe(true);
      }
    });

    it("does not treat SANDBOX_NOT_RUNNING in another state as gone", () => {
      for (const state of ["Pending", "Resuming", "Unknown"]) {
        const err = new AlineoError("SANDBOX_NOT_RUNNING", "not running", { details: { state } });
        expect(isSandboxGone(err)).toBe(false);
      }
    });

    it("does not treat SANDBOX_NOT_RUNNING with no state as gone", () => {
      expect(isSandboxGone(new AlineoError("SANDBOX_NOT_RUNNING", "not running"))).toBe(false);
    });

    it("does not treat a paused sandbox as gone", () => {
      expect(isSandboxGone(new AlineoError("SANDBOX_PAUSED", "paused"))).toBe(false);
    });

    it("decides by code even when the message was reworded", () => {
      const err = new AlineoError("SANDBOX_NOT_FOUND", "this text no longer matches any pattern");
      expect(isSandboxGone(err)).toBe(true);
    });

    it("an unrelated alineo code is not gone", () => {
      expect(isSandboxGone(new AlineoError("EXEC_NOT_READY", "execd not ready"))).toBe(false);
    });
  });
});
