import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

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

async function freshModule() {
  return import(`../src/nvidia-embeddings?t=${crypto.randomUUID()}`);
}

describe("createNvidiaEmbeddingProvider", () => {
  it("defaults id to the default model", async () => {
    const { createNvidiaEmbeddingProvider } = await freshModule();
    expect(createNvidiaEmbeddingProvider().id).toBe("nvidia:nvidia/nv-embedqa-e5-v5");
  });

  it("id reflects a custom model", async () => {
    const { createNvidiaEmbeddingProvider } = await freshModule();
    expect(createNvidiaEmbeddingProvider({ model: "nvidia/other-model" }).id).toBe(
      "nvidia:nvidia/other-model",
    );
  });

  it("embed([]) returns [] without fetching", async () => {
    const fetchSpy = mock(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { createNvidiaEmbeddingProvider } = await freshModule();

    expect(await createNvidiaEmbeddingProvider().embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when NVIDIA_API_KEY is unset", async () => {
    delete process.env.NVIDIA_API_KEY;
    const { createNvidiaEmbeddingProvider } = await freshModule();

    await expect(createNvidiaEmbeddingProvider().embed(["hello"])).rejects.toThrow(
      "NVIDIA_API_KEY is not set on the dashboard server",
    );
  });

  it("throws with status and body on a non-OK response", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("bad request", { status: 400 })),
    ) as unknown as typeof fetch;
    const { createNvidiaEmbeddingProvider } = await freshModule();

    await expect(createNvidiaEmbeddingProvider().embed(["hello"])).rejects.toThrow(/400/);
  });

  it("returns embeddings re-sorted by the response's index field", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    let capturedBody: any;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const { createNvidiaEmbeddingProvider } = await freshModule();

    const result = await createNvidiaEmbeddingProvider({ inputType: "passage" }).embed([
      "first",
      "second",
    ]);

    expect(result).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(capturedBody).toEqual({
      input: ["first", "second"],
      model: "nvidia/nv-embedqa-e5-v5",
      input_type: "passage",
    });
  });
});
