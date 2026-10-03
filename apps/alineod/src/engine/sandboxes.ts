/**
 * Raw-sandbox operations: create/list/get/checkpoint/fork/close/credentials/egress. The Pi-agent
 * subsystem (`spawn.ts`, `stream.ts`, ...) is a separate concern built on top of these same
 * sandboxes — this module is the one alineod never had before (§1 of PLAN.md's gap list).
 */
import { SandboxStatus, type SandboxOptions, type NetworkRule } from "@alineo-labs/sandbox";
import type { SandboxDetails } from "@alineo-labs/core";
import { client, register, resolveLive, forget, findSandboxDetails } from "./sandbox-registry";
import { sdkAdapter } from "./registry";
import { HttpError } from "./errors";
import { errorMessage } from "../util";
import { rememberResources, recallResources } from "../state/sandbox-resources";

export interface CreateSandboxBody {
  name?: string;
  image?: string;
  resources: { cpu: string; memory: string; gpu?: string };
  env?: Record<string, string>;
  timeout?: number;
  networkPolicy?: { defaultAction?: "allow" | "deny"; egress: NetworkRule[] };
  credentialProxy?: boolean;
}

const DEFAULT_IMAGE = "node:22";

export async function createSandbox(body: CreateSandboxBody): Promise<SandboxDetails> {
  if (!body.resources?.cpu || !body.resources?.memory) {
    throw new HttpError(400, "resources.cpu and resources.memory are required");
  }
  const opts: SandboxOptions = {
    image: body.image ?? DEFAULT_IMAGE,
    resources: body.resources,
    name: body.name,
    env: body.env,
    timeout: body.timeout,
    networkPolicy: body.networkPolicy,
    credentialProxy: body.credentialProxy,
  };
  let sb;
  try {
    sb = await client.sandbox(opts);
  } catch (err) {
    throw new HttpError(502, `failed to create sandbox: ${errorMessage(err)}`);
  }
  register(sb);
  rememberResources(sb.sandboxId, body.resources);
  const details = await sdkAdapter.getSandboxDetails(sb.name, sb.sandboxId);
  if (!details) throw new HttpError(500, "sandbox created but missing from the ledger");
  return details;
}

export async function listSandboxes(opts?: {
  status?: "running" | "completed";
  limit?: number;
}): Promise<SandboxDetails[]> {
  return sdkAdapter.listAllSandboxDetails({
    ...opts,
    status: opts?.status === "running" ? SandboxStatus.Running : opts?.status === "completed" ? SandboxStatus.Completed : undefined,
  });
}

export async function getSandbox(sandboxId: string): Promise<SandboxDetails> {
  const details = await findSandboxDetails(sandboxId);
  if (!details) throw new HttpError(404, `no sandbox ${sandboxId}`);
  return details;
}

/** The raw substrate ledger for one sandbox (`sandbox.created`, `exec.started`/`.output`/
 *  `.completed`, `sandbox.checkpoint_created`, ...) — the audit trail's per-sandbox view. alineod
 *  never exposed this over HTTP before; `sb.exec()`'s own replay-on-resume is what consumes it
 *  internally, but an operator reading what happened had no route to ask for it either. */
export async function getSandboxLedger(sandboxId: string) {
  const details = await findSandboxDetails(sandboxId);
  if (!details) throw new HttpError(404, `no sandbox ${sandboxId}`);
  return sdkAdapter.readAll(details.name, sandboxId);
}

export async function closeSandbox(sandboxId: string): Promise<void> {
  const sb = await resolveLive(sandboxId).catch(() => undefined);
  if (!sb) throw new HttpError(404, `no sandbox ${sandboxId}`);
  await sb.close();
  forget(sandboxId);
}

export async function checkpointSandbox(sandboxId: string, name?: string): Promise<string> {
  const sb = await resolveOrThrow(sandboxId);
  return sb.checkpoint(name);
}

export async function listCheckpoints(sandboxId: string) {
  const sb = await resolveOrThrow(sandboxId);
  return sb.listCheckpoints();
}

export async function forkSandbox(
  sandboxId: string,
  tag?: string,
): Promise<{ sandboxId: string; name: string }> {
  const sb = await resolveOrThrow(sandboxId);
  const child = await sb.fork(tag);
  register(child);
  const parentResources = recallResources(sandboxId);
  if (parentResources) rememberResources(child.sandboxId, parentResources);
  return { sandboxId: child.sandboxId, name: child.name };
}

export interface CredentialBindingBody {
  host: string;
  pathPrefix?: string;
  injection:
    | { type: "header"; name: string }
    | { type: "substitution"; placeholder: string; in: Array<"path" | "query" | "header" | "body"> };
}

export async function setCredential(
  sandboxId: string,
  name: string,
  value: string,
  binding: CredentialBindingBody,
): Promise<void> {
  const sb = await resolveOrThrow(sandboxId);
  await sb.credentials.set(name, value, binding);
}

export async function removeCredential(sandboxId: string, name: string): Promise<void> {
  const sb = await resolveOrThrow(sandboxId);
  await sb.credentials.remove(name);
}

export async function listCredentials(sandboxId: string) {
  const sb = await resolveOrThrow(sandboxId);
  return sb.credentials.listBindings();
}

export async function getEgress(sandboxId: string) {
  const sb = await resolveOrThrow(sandboxId);
  return sb.egress.get();
}

export async function patchEgress(sandboxId: string, rules: NetworkRule[]): Promise<void> {
  const sb = await resolveOrThrow(sandboxId);
  await sb.egress.patch(rules);
}

export async function deleteEgress(sandboxId: string, targets: string[]): Promise<void> {
  const sb = await resolveOrThrow(sandboxId);
  await sb.egress.delete(targets);
}

async function resolveOrThrow(sandboxId: string) {
  try {
    return await resolveLive(sandboxId);
  } catch (err) {
    throw new HttpError(404, `no sandbox ${sandboxId}: ${errorMessage(err)}`);
  }
}
