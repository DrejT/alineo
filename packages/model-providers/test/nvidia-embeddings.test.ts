import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type * as NvidiaEmbeddingsModule from "../src/nvidia-embeddings";

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

async function freshModule(): Promise<typeof NvidiaEmbeddingsModule> {
  return import(`../src/nvidia-embeddings?t=${crypto.randomUUID()}`) as Promise<
    typeof NvidiaEmbeddingsModule
  >;
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

    // bun-types types `.rejects` as `Matchers<unknown>`, whose `toThrow` returns `void` —
    // the actual runtime behavior (awaiting the rejection) isn't reflected in the type.
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression
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

    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- see comment on the earlier .rejects. usage above
    await expect(createNvidiaEmbeddingProvider().embed(["hello"])).rejects.toThrow(/400/);
  });

  it("returns embeddings re-sorted by the response's index field", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    let capturedBody: { input: string[]; model: string; input_type: string } | undefined;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as {
        input: string[];
        model: string;
        input_type: string;
      };
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

  it("a per-call opts.type overrides the constructor-time default", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    const capturedInputTypes: string[] = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedInputTypes.push(
        (JSON.parse(init.body as string) as { input_type: string }).input_type,
      );
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    const { createNvidiaEmbeddingProvider } = await freshModule();
    // Constructed with the "query" default (the module's own fallback).
    const provider = createNvidiaEmbeddingProvider();

    await provider.embed(["a fact being stored"], { type: "passage" });
    await provider.embed(["a search string"], { type: "query" });
    await provider.embed(["falls back to the constructor default"]);

    expect(capturedInputTypes).toEqual(["passage", "query", "query"]);
  });
});
