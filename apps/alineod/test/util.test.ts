import { describe, expect, test } from "bun:test";
import { createLimiter, errorMessage, mapLimit } from "../src/util";

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

describe("createLimiter", () => {
  test("never runs more than the limit at once, and runs everything", async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const done: number[] = [];

    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await Bun.sleep(5);
          running--;
          done.push(i);
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(done.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("starts waiting calls in the order they arrived", async () => {
    const limit = createLimiter(1);
    const started: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        limit(async () => {
          started.push(i);
          await Bun.sleep(1);
        }),
      ),
    );

    expect(started).toEqual([0, 1, 2, 3]);
  });

  test("a rejection frees its slot and reaches only its own caller", async () => {
    const limit = createLimiter(1);

    const failing = limit(() => Promise.reject(new Error("boom")));
    const after = limit(() => Promise.resolve("still runs"));

    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("still runs");
  });

  test("returns what the function returns", async () => {
    expect(await createLimiter(3)(() => Promise.resolve(42))).toBe(42);
  });
});

describe("mapLimit", () => {
  test("visits every item with the cap respected", async () => {
    const seen: number[] = [];
    let running = 0;
    let peak = 0;

    await mapLimit([1, 2, 3, 4, 5], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(3);
      running--;
      seen.push(n);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(3);
  });

  test("a limit of 1 keeps the order", async () => {
    const seen: number[] = [];
    await mapLimit([3, 1, 2], 1, (n) => {
      seen.push(n);
      return Promise.resolve();
    });
    expect(seen).toEqual([3, 1, 2]);
  });

  test("an empty list resolves", async () => {
    await mapLimit([], 4, () => Promise.reject(new Error("never called")));
  });
});
