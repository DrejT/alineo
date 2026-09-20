import { describe, expect, test } from "bun:test";
import { errorMessage } from "../src/util";

/** What OpenSandbox's client throws: the raw response body as `message`. */
const body = (o: unknown) => new Error(JSON.stringify(o));

describe("errorMessage", () => {
  test("unwraps an OpenSandbox error body to its message and code", () => {
    expect(
      errorMessage(body({ code: "DOCKER::SANDBOX_NOT_FOUND", message: "Sandbox sb-1 not found." })),
    ).toBe("Sandbox sb-1 not found. (DOCKER::SANDBOX_NOT_FOUND)");
  });

  test("a body with a message but no code is just the message", () => {
    expect(errorMessage(body({ message: "quota exceeded" }))).toBe("quota exceeded");
  });

  test("an ordinary error is unchanged", () => {
    expect(errorMessage(new Error("bridge did not answer"))).toBe("bridge did not answer");
  });

  test.each([
    ["JSON without a message", JSON.stringify({ code: "X" })],
    ["a non-string message", JSON.stringify({ message: 42 })],
    ["an empty message", JSON.stringify({ code: "X", message: "" })],
    ["a JSON array", "[1,2]"],
    ["text that only looks like JSON", "{not json"],
  ])("leaves %s as it was", (_name, raw) => {
    expect(errorMessage(new Error(raw))).toBe(raw);
  });

  test("a non-Error is stringified", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
