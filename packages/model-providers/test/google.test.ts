import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let originalFetch: typeof fetch;
let originalKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.GEMINI_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
  mock.restore();
});

async function freshModule() {
  return import(`../src/google?t=${crypto.randomUUID()}`);
}

describe("googleProvider", () => {
  it("id/label/envVar match the registry's expectations", async () => {
    const { googleProvider } = await freshModule();
    expect(googleProvider.id).toBe("google");
    expect(googleProvider.envVar).toBe("GEMINI_API_KEY");
  });

  it("languageModel throws when GEMINI_API_KEY is unset", async () => {
    delete process.env.GEMINI_API_KEY;
    const { googleProvider } = await freshModule();
    expect(() => googleProvider.languageModel("gemini-flash-latest")).toThrow(
      "GEMINI_API_KEY is not set on the dashboard server",
    );
  });

  it("languageModel returns a LanguageModel when GEMINI_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { googleProvider } = await freshModule();
    const model = googleProvider.languageModel("gemini-flash-latest");
    expect(model).toBeDefined();
  });

  it("listModels returns [] without fetching when GEMINI_API_KEY is unset", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchSpy = mock(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { googleProvider } = await freshModule();
    expect(await googleProvider.listModels()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listModels returns [] on a non-OK response", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    ) as unknown as typeof fetch;
    const { googleProvider } = await freshModule();
    expect(await googleProvider.listModels()).toEqual([]);
  });

  it("listModels returns the provider's model list on success, and caches it", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "gemini-flash-latest" }] }), { status: 200 }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { googleProvider } = await freshModule();
    expect(await googleProvider.listModels()).toEqual([{ id: "gemini-flash-latest" }]);
    await googleProvider.listModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
