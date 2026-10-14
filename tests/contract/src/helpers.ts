import type { Sandbox, SandboxHandle } from "@alineo-labs/sandbox";
import type { ProviderBinding } from "./binding";

/**
 * Run `fn` with a fresh sandbox and always close it. A leaked container is the failure this
 * suite is most likely to cause on a developer's machine, so closing is not optional.
 */
export async function withSandbox<T>(
  binding: ProviderBinding,
  name: string,
  fn: (sb: SandboxHandle, client: Sandbox) => Promise<T>,
): Promise<T> {
  const client = binding.createClient();
  const sb = await client.sandbox({
    image: binding.image,
    resources: binding.resources,
    name: `contract-${name}`,
  });
  try {
    // A scratch directory every domain can rely on. Images do not agree on whether it exists.
    await sb.exec("mkdir -p /workspace");
    return await fn(sb, client);
  } finally {
    await sb.close().catch(() => {});
  }
}
