import type { ProviderBinding } from "./binding";
import { lifecycleDomain } from "./domains/lifecycle";
import { execDomain } from "./domains/exec";
import { filesDomain } from "./domains/files";
import { snapshotDomain } from "./domains/snapshot";
import { endpointDomain } from "./domains/endpoint";

export type { ProviderBinding } from "./binding";

/** Register every domain the provider claims to support. Call once per binding file. */
export function defineProviderContract(binding: ProviderBinding): void {
  lifecycleDomain(binding);
  execDomain(binding);
  filesDomain(binding);
  if (binding.capabilities.snapshot) snapshotDomain(binding);
  if (binding.capabilities.endpoint) endpointDomain(binding);
}
