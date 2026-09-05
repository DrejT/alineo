import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type * as NvidiaModule from "../src/nvidia";

let originalFetch: typeof fetch;
let originalKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.NVIDIA_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = originalKey;
  mock.restore();
});

async function freshModule(): Promise<typeof NvidiaModule> {
  return import(`../src/nvidia?t=${crypto.randomUUID()}`) as Promise<typeof NvidiaModule>;
}

describe("nvidiaProvider", () => {
  it("id/label/envVar match the registry's expectations", async () => {
    const { nvidiaProvider } = await freshModule();
    expect(nvidiaProvider.id).toBe("nvidia");
    expect(nvidiaProvider.envVar).toBe("NVIDIA_API_KEY");
  });

  it("languageModel throws when NVIDIA_API_KEY is unset", async () => {
    delete process.env.NVIDIA_API_KEY;
    const { nvidiaProvider } = await freshModule();
    expect(() => nvidiaProvider.languageModel("nvidia/nemotron-3.5-lightning-30b-a3b")).toThrow(
      "NVIDIA_API_KEY is not set on the dashboard server",
    );
  });

  it("languageModel returns a LanguageModel when NVIDIA_API_KEY is set", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    const { nvidiaProvider } = await freshModule();
    const model = nvidiaProvider.languageModel("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(model).toBeDefined();
  });

  it("listModels returns [] without fetching when NVIDIA_API_KEY is unset", async () => {
    delete process.env.NVIDIA_API_KEY;
    const fetchSpy = mock(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { nvidiaProvider } = await freshModule();
    expect(await nvidiaProvider.listModels()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listModels returns [] on a non-OK response", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    ) as unknown as typeof fetch;
    const { nvidiaProvider } = await freshModule();
    expect(await nvidiaProvider.listModels()).toEqual([]);
  });

  it("listModels returns the provider's model list on success, and caches it", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b" }] }), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { nvidiaProvider } = await freshModule();
    expect(await nvidiaProvider.listModels()).toEqual([
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    ]);
    await nvidiaProvider.listModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
