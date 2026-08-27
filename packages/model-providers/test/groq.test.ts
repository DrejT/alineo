import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type * as GroqModule from "../src/groq";

let originalFetch: typeof fetch;
let originalKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.GROQ_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  mock.restore();
});

async function freshModule(): Promise<typeof GroqModule> {
  return import(`../src/groq?t=${crypto.randomUUID()}`) as Promise<typeof GroqModule>;
}

describe("groqProvider", () => {
  it("id/label/envVar match the registry's expectations", async () => {
    const { groqProvider } = await freshModule();
    expect(groqProvider.id).toBe("groq");
    expect(groqProvider.envVar).toBe("GROQ_API_KEY");
  });

  it("languageModel throws when GROQ_API_KEY is unset", async () => {
    delete process.env.GROQ_API_KEY;
    const { groqProvider } = await freshModule();
    expect(() => groqProvider.languageModel("llama-3.3-70b-versatile")).toThrow(
      "GROQ_API_KEY is not set on the dashboard server",
    );
  });

  it("languageModel returns a LanguageModel when GROQ_API_KEY is set", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { groqProvider } = await freshModule();
    const model = groqProvider.languageModel("llama-3.3-70b-versatile");
    expect(model).toBeDefined();
  });

  it("listModels returns [] without fetching when GROQ_API_KEY is unset", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchSpy = mock(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { groqProvider } = await freshModule();
    expect(await groqProvider.listModels()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listModels returns [] on a non-OK response", async () => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    ) as unknown as typeof fetch;
    const { groqProvider } = await freshModule();
    expect(await groqProvider.listModels()).toEqual([]);
  });

  it("listModels returns the provider's model list on success, and caches it", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { groqProvider } = await freshModule();
    expect(await groqProvider.listModels()).toEqual([{ id: "llama-3.3-70b-versatile" }]);
    await groqProvider.listModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
