import { describe, expect, it } from "bun:test";
import { findModelProvider, MODEL_PROVIDERS } from "../src/registry";

describe("MODEL_PROVIDERS", () => {
  it("includes nvidia, google, and groq", () => {
    expect(MODEL_PROVIDERS.map((p) => p.id).sort()).toEqual(["google", "groq", "nvidia"]);
  });
});

describe("findModelProvider", () => {
  it("finds a known provider by id", () => {
    expect(findModelProvider("google")?.label).toBe("Google (Gemini)");
    expect(findModelProvider("groq")?.label).toBe("Groq");
    expect(findModelProvider("nvidia")?.label).toBe("NVIDIA NIM");
  });

  it("returns undefined for an unknown provider id", () => {
    expect(findModelProvider("anthropic")).toBeUndefined();
    expect(findModelProvider("")).toBeUndefined();
  });
});
