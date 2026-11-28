/**
 * Where specs live when the MCP is served to other people. The stdio server keeps specs in the
 * user's own `agentsDir` and may read any local file. A served MCP must do neither: it has no
 * "local" user, and a file path from a stranger is a file read on the server.
 *
 * `SpecStore` is the seam. A deployer passes a store that keeps specs per user (the HTTP handler
 * builds one per request, so it can look at who is calling). The default is an in-memory store
 * that lives as long as the server object, which is enough for one session.
 */
import { validateAgentSpec, type AgentSpec, type AgentSpecInput } from "alineo";
import { fetchPublicJson, type PublicFetchOptions } from "./public-fetch.js";

export interface SpecSummary {
  name: string;
  harness: string;
  description: string;
}

export interface SpecStore {
  put(name: string, spec: AgentSpec): Promise<void>;
  get(name: string): Promise<AgentSpec | undefined>;
  list(): Promise<SpecSummary[]>;
  /** `false` when there was nothing to remove. */
  remove(name: string): Promise<boolean>;
}

/** A name safe to use as a file name or key: no slash, no dot-dot, no leading dot. */
export const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const MAX_STORED_SPECS = 100;
export const MAX_REGISTRY_DEPENDENCIES = 20;

export function summarize(name: string, spec: Partial<AgentSpecInput>): SpecSummary {
  return {
    name,
    harness: (typeof spec.harness === "object" ? spec.harness.id : spec.harness) ?? "?",
    description: spec.description ?? spec.title ?? "",
  };
}

export class MemorySpecStore implements SpecStore {
  private readonly specs = new Map<string, AgentSpec>();

  put(name: string, spec: AgentSpec): Promise<void> {
    if (!this.specs.has(name) && this.specs.size >= MAX_STORED_SPECS) {
      return Promise.reject(
        new Error(`At most ${MAX_STORED_SPECS} specs can be stored. Remove one first.`),
      );
    }
    this.specs.set(name, spec);
    return Promise.resolve();
  }

  get(name: string): Promise<AgentSpec | undefined> {
    return Promise.resolve(this.specs.get(name));
  }

  list(): Promise<SpecSummary[]> {
    return Promise.resolve([...this.specs].map(([name, spec]) => summarize(name, spec)));
  }

  remove(name: string): Promise<boolean> {
    return Promise.resolve(this.specs.delete(name));
  }
}

/**
 * A stored spec in the shape a caller writes: `harness: { id, version }` and
 * `model: { provider, id }`. The store keeps the normalized form, whose flat `provider` and
 * `harnessVersion` are deprecated input. A caller that passes a spec back to run_start would
 * otherwise get a deprecation warning for fields it never wrote.
 */
export function specForCaller(spec: AgentSpec): AgentSpecInput {
  const { harness, harnessVersion, model, provider, ...rest } = spec;
  return {
    ...rest,
    harness: harnessVersion === undefined ? harness : { id: harness, version: harnessVersion },
    model: provider === undefined ? model : { provider, id: model },
  } as AgentSpecInput;
}

export interface AddRemoteSpecInput {
  /** The spec itself. */
  spec?: unknown;
  /** Or a public https URL to fetch it from. Exactly one of the two. */
  url?: string;
  /** Store it under this name instead of the spec's own. */
  name?: string;
}

export interface AddRemoteSpecResult {
  name: string;
  resolvedDependencies: string[];
  spec: AgentSpec;
}

function checkName(name: string): string {
  if (!SPEC_NAME.test(name)) {
    throw new Error(
      `'${name}' is not a usable spec name. Use 1 to 64 letters, digits, dot, underscore or hyphen, starting with a letter or digit.`,
    );
  }
  return name;
}

/**
 * Add a spec to a store without touching the local disk. Takes the spec inline or by public URL.
 * A URL is fetched under `public-fetch.ts`'s rules, and so is every `registryDependencies` URL it
 * names, with a cap on how many are followed.
 */
export async function addRemoteSpec(
  store: SpecStore,
  input: AddRemoteSpecInput,
  fetchOptions: PublicFetchOptions = {},
): Promise<AddRemoteSpecResult> {
  if ((input.spec === undefined) === (input.url === undefined)) {
    throw new Error("Give exactly one of `spec` (the spec object) or `url` (a public https URL).");
  }
  const budget = { remaining: MAX_REGISTRY_DEPENDENCIES };

  const load = async (source: AddRemoteSpecInput): Promise<AgentSpec> => {
    const raw =
      source.url !== undefined ? await fetchPublicJson(source.url, fetchOptions) : source.spec;
    return validateAgentSpec(raw);
  };

  const resolveDependencies = async (spec: AgentSpec, ancestry: string[]): Promise<string[]> => {
    const resolved: string[] = [];
    for (const depUrl of spec.registryDependencies ?? []) {
      if (ancestry.includes(depUrl)) {
        throw new Error(`Circular registryDependencies: ${[...ancestry, depUrl].join(" -> ")}`);
      }
      if (--budget.remaining < 0) {
        throw new Error(
          `More than ${MAX_REGISTRY_DEPENDENCIES} registryDependencies. Refusing to follow them all.`,
        );
      }
      const dep = await load({ url: depUrl });
      await resolveDependencies(dep, [...ancestry, depUrl]);
      await store.put(checkName(dep.name), dep);
      resolved.push(depUrl);
    }
    return resolved;
  };

  const spec = await load(input);
  const resolvedDependencies = await resolveDependencies(
    spec,
    input.url !== undefined ? [input.url] : [],
  );
  const name = checkName(input.name ?? spec.name);
  await store.put(name, spec);
  return { name, resolvedDependencies, spec };
}
