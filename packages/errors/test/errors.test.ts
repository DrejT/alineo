import { describe, expect, it } from "vitest";
import {
  AlineoError,
  ERROR_CODES,
  errorCodeOf,
  isAlineoError,
  isErrorCode,
  isRetryable,
} from "../src/index.ts";

describe("ERROR_CODES", () => {
  it("uses UPPER_SNAKE_CASE for every code", () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    }
  });

  it("gives every code a summary and a valid HTTP status", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.summary.length, code).toBeGreaterThan(0);
      expect(spec.httpStatus, code).toBeGreaterThanOrEqual(400);
      expect(spec.httpStatus, code).toBeLessThan(600);
    }
  });

  it("keeps retryable consistent with category", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      // A permanent, config, capability or internal failure does not clear by itself.
      if (spec.category !== "transient") expect(spec.retryable, code).toBe(false);
      if (spec.category === "transient") expect(spec.retryable, code).toBe(true);
    }
  });
});

describe("AlineoError", () => {
  it("carries code, category, retryable and the default hint", () => {
    const err = new AlineoError("EXEC_NOT_READY", "execd not ready");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("EXEC_NOT_READY");
    expect(err.category).toBe("transient");
    expect(err.retryable).toBe(true);
    expect(err.hint).toContain("execd_image");
  });

  it("lets a call site override the hint and attach details and a cause", () => {
    const cause = new Error("connect ECONNREFUSED");
    const err = new AlineoError("SANDBOX_NOT_FOUND", "gone", {
      cause,
      hint: "custom",
      details: { sandboxId: "sb-1" },
    });
    expect(err.hint).toBe("custom");
    expect(err.details).toEqual({ sandboxId: "sb-1" });
    expect(err.cause).toBe(cause);
  });

  it("has no hint when neither the code nor the call site gives one", () => {
    const err = new AlineoError("INTERNAL", "boom");
    expect(err.hint).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe("errorCodeOf", () => {
  it("reads the code off an AlineoError", () => {
    expect(errorCodeOf(new AlineoError("SANDBOX_PAUSED", "paused"))).toBe("SANDBOX_PAUSED");
  });

  it("reads a known code off a plain object, as after a JSON round trip", () => {
    expect(errorCodeOf({ code: "PROVIDER_RATE_LIMITED" })).toBe("PROVIDER_RATE_LIMITED");
  });

  it("ignores a code string that is not one of ours", () => {
    expect(errorCodeOf({ code: "DOCKER::SANDBOX_NOT_FOUND" })).toBeUndefined();
    expect(errorCodeOf({ code: 404 })).toBeUndefined();
  });

  it("finds a code down the cause chain", () => {
    const inner = new AlineoError("EXEC_NOT_READY", "inner");
    const outer = new Error("wrapper", { cause: inner });
    expect(errorCodeOf(outer)).toBe("EXEC_NOT_READY");
  });

  it("stops at a bounded depth instead of looping on a cause cycle", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(errorCodeOf(a)).toBeUndefined();
  });

  it("returns undefined for values that are not objects", () => {
    expect(errorCodeOf(undefined)).toBeUndefined();
    expect(errorCodeOf("EXEC_NOT_READY")).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });
});

describe("isRetryable", () => {
  it("answers from the code", () => {
    expect(isRetryable(new AlineoError("PROVIDER_RATE_LIMITED", "429"))).toBe(true);
    expect(isRetryable(new AlineoError("SANDBOX_NOT_FOUND", "gone"))).toBe(false);
  });

  it("answers undefined, not false, when there is no code", () => {
    expect(isRetryable(new Error("plain"))).toBeUndefined();
  });
});

describe("isAlineoError", () => {
  it("recognises an instance", () => {
    expect(isAlineoError(new AlineoError("INTERNAL", "x"))).toBe(true);
  });

  it("recognises an error from another copy of the package by its brand", () => {
    const foreign = Object.assign(new Error("x"), {
      code: "INTERNAL",
      [Symbol.for("alineo.error")]: true,
    });
    expect(foreign instanceof AlineoError).toBe(false);
    expect(isAlineoError(foreign)).toBe(true);
  });

  it("rejects a branded value whose code is not known", () => {
    expect(isAlineoError({ code: "NOPE", [Symbol.for("alineo.error")]: true })).toBe(false);
  });

  it("rejects an ordinary error", () => {
    expect(isAlineoError(new Error("x"))).toBe(false);
  });
});

describe("isErrorCode", () => {
  it("rejects inherited property names", () => {
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode("constructor")).toBe(false);
  });
});
