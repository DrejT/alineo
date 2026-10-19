import { AlineoError } from "@alineo-labs/errors";
import type {
  CreateSandboxRequest,
  EgressChannel,
  ExecChannel,
  ListSandboxesFilter,
  SandboxProviderDescriptor,
  PtyChannel,
  SandboxInfo,
  SandboxProvider,
  SandboxState as State,
  SnapshotInfo,
  SnapshotState as SnapState,
} from "@alineo-labs/provider";
import { ControlClient } from "./control";
import { EgressClient } from "./egress";
import { ExecClient } from "./exec";
import { withLineEndingRepair } from "./line-endings";
import { PtyClient } from "./pty";
import { SandboxState, SnapshotState } from "./types";
import type { Sandbox, Snapshot } from "./types";

/** The port `execd` listens on inside a sandbox. */
const EXECD_PORT = 44772;

/**
 * Where an OpenSandbox state sits in alineo's states.
 *
 * `Unknown`, and any state added after this was written, is `provisioning`, never `running`:
 * calling a sandbox running before it is would hide its startup deadline.
 */
export function stateOf(native: SandboxState | string): State {
  switch (native) {
    case SandboxState.Running:
      return "running";
    case SandboxState.Pausing:
      return "pausing";
    case SandboxState.Paused:
      return "paused";
    case SandboxState.Resuming:
      return "resuming";
    case SandboxState.Stopping:
      return "stopping";
    case SandboxState.Terminated:
      return "terminated";
    case SandboxState.Failed:
      return "failed";
    default:
      return "provisioning";
  }
}

/**
 * The OpenSandbox state a state filter means. The inverse of {@link stateOf}, for list filters.
 *
 * Not a true inverse: `stateOf` also maps `Unknown` and any state it has not heard of to
 * `provisioning`, and this maps `provisioning` to `Pending` only. A `provisioning` filter
 * therefore misses sandboxes the adapter would report as provisioning from an unrecognised state.
 */
function nativeStateOf(state: State): SandboxState {
  switch (state) {
    case "running":
      return SandboxState.Running;
    case "pausing":
      return SandboxState.Pausing;
    case "paused":
      return SandboxState.Paused;
    case "resuming":
      return SandboxState.Resuming;
    case "stopping":
      return SandboxState.Stopping;
    case "terminated":
      return SandboxState.Terminated;
    case "failed":
      return SandboxState.Failed;
    case "provisioning":
      return SandboxState.Pending;
  }
}

/** Committing and Pushing are both "not ready yet". */
export function snapshotStateOf(native: SnapshotState | string): SnapState {
  if (native === SnapshotState.Ready) return "ready";
  if (native === SnapshotState.Failed) return "failed";
  return "pending";
}

function toSandboxInfo(raw: Sandbox): SandboxInfo {
  return {
    id: raw.id,
    state: stateOf(raw.status.state),
    nativeState: raw.status.state,
    ...(raw.status.reason !== undefined ? { reason: raw.status.reason } : {}),
    ...(raw.status.message !== undefined ? { message: raw.status.message } : {}),
    createdAt: raw.createdAt,
    ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
    ...(raw.snapshotId !== undefined ? { snapshotId: raw.snapshotId } : {}),
  };
}

function toSnapshotInfo(raw: Snapshot): SnapshotInfo {
  return {
    id: raw.id,
    sandboxId: raw.sandboxId,
    state: snapshotStateOf(raw.state),
    createdAt: raw.createdAt,
  };
}

export interface OpenSandboxProviderOptions {
  baseUrl: string;
  /** Empty or absent for a local server with no auth. */
  apiKey?: string;
  /**
   * Send `execd` and sidecar traffic through the server. Required when the server runs in Docker
   * (`alineo init`), because the sandbox's own address is not reachable from the host.
   */
  useServerProxy?: boolean;
  /** How patiently `connectExec` waits for `execd`. The defaults give about 80 seconds. */
  execReadiness?: { retries?: number; delayMs?: number };
  /** A prepared control client, for tests. Otherwise one is built from `baseUrl` and `apiKey`. */
  control?: ControlClient;
}

/**
 * OpenSandbox as a {@link SandboxProvider}.
 *
 * A thin adapter over the three HTTP clients in this package: it holds their configuration,
 * maps OpenSandbox's states onto alineo's states, and owns the one piece of logic that is not a
 * pass-through, which is waiting for `execd` to accept a connection.
 */
export class OpenSandboxProvider implements SandboxProvider {
  readonly id = "opensandbox";

  readonly descriptor: SandboxProviderDescriptor = {
    id: "opensandbox",
    label: "OpenSandbox",
    capabilities: {
      // On the Docker runtime a snapshot is a `docker commit`: files, not processes.
      snapshot: { kind: "filesystem" },
      pause: true,
      // Egress and credential injection need the server configured with an egress image and the
      // `dns+nft` mode. This adapter cannot tell from here, so it does not claim them.
      egress: "unverified",
      credentials: "unverified",
      pty: true,
      code: true,
    },
  };

  /** The underlying client, for the few callers that need an OpenSandbox-only call. Not portable. */
  readonly control: ControlClient;
  readonly egress: EgressChannel;

  private readonly useServerProxy: boolean | undefined;
  private readonly retries: number;
  private readonly delayMs: number;

  constructor(options: OpenSandboxProviderOptions) {
    this.control =
      options.control ??
      new ControlClient({ baseUrl: options.baseUrl, apiKey: options.apiKey ?? "" });
    this.useServerProxy = options.useServerProxy;
    this.retries = options.execReadiness?.retries ?? 45;
    this.delayMs = options.execReadiness?.delayMs ?? 2_000;
    this.egress = new EgressClient(this.control, this.useServerProxy);
  }

  async createSandbox(request: CreateSandboxRequest): Promise<SandboxInfo> {
    return toSandboxInfo(await this.control.createSandbox(request));
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    return toSandboxInfo(await this.control.getSandbox(sandboxId));
  }

  async listSandboxes(filter: ListSandboxesFilter = {}): Promise<SandboxInfo[]> {
    const raw = await this.control.listSandboxes({
      ...(filter.state !== undefined ? { state: nativeStateOf(filter.state) } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
    });
    return raw.map(toSandboxInfo);
  }

  deleteSandbox(sandboxId: string): Promise<void> {
    return this.control.deleteSandbox(sandboxId);
  }

  pauseSandbox(sandboxId: string): Promise<void> {
    return this.control.pauseSandbox(sandboxId);
  }

  resumeSandbox(sandboxId: string): Promise<void> {
    return this.control.resumeSandbox(sandboxId);
  }

  async createSnapshot(sandboxId: string): Promise<SnapshotInfo> {
    return toSnapshotInfo(await this.control.createSnapshot(sandboxId));
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotInfo> {
    return toSnapshotInfo(await this.control.getSnapshot(snapshotId));
  }

  getEndpoint(sandboxId: string, port: number, useServerProxy = this.useServerProxy) {
    return this.control.getEndpoint(sandboxId, port, useServerProxy);
  }

  getDiagnosticLogs(sandboxId: string) {
    return this.control.getDiagnosticLogs(sandboxId);
  }

  getDiagnosticEvents(sandboxId: string) {
    return this.control.getDiagnosticEvents(sandboxId);
  }

  /**
   * Resolve `execd`'s address once (each lookup can return a different ephemeral proxy port),
   * then probe it until it answers.
   *
   * OpenSandbox reports a sandbox `Running` before `execd` inside it is accepting connections,
   * and on a loaded host the gap is long: a fork taken while its parent ran a real Chrome
   * session needed about 35 seconds to reach `Running` and then burned the old 11 second
   * readiness budget (issue #32). The probe starts fast and backs off to `delayMs`, since
   * `execd` is usually ready within one tick.
   */
  async connectExec(
    sandboxId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExecChannel> {
    const { signal } = options;
    signal?.throwIfAborted();
    const ep = await this.control.getEndpoint(sandboxId, EXECD_PORT, this.useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const token = ep.headers?.["X-EXECD-ACCESS-TOKEN"] ?? "";
    const client = new ExecClient({ baseUrl, accessToken: token });

    let delay = Math.min(100, this.delayMs);
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      signal?.throwIfAborted();
      try {
        await client.listContexts();
        return withLineEndingRepair(client);
      } catch (err) {
        if (attempt === this.retries) {
          const attempts = attempt + 1;
          const waitedMs = Date.now() - startedAt;
          throw new AlineoError(
            "EXEC_NOT_READY",
            `execd not ready for sandbox ${sandboxId} after ${attempts} attempts over ` +
              `${(waitedMs / 1000).toFixed(0)}s`,
            { cause: err, details: { sandboxId, attempts, waitedMs } },
          );
        }
        await abortableDelay(delay, signal);
        delay = Math.min(delay * 1.5, this.delayMs);
      }
    }
    throw new Error("unreachable");
  }

  async connectPty(sandboxId: string): Promise<PtyChannel> {
    const ep = await this.control.getEndpoint(sandboxId, EXECD_PORT, this.useServerProxy);
    const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
    const token = ep.headers?.["X-EXECD-ACCESS-TOKEN"] ?? "";
    return new PtyClient({ baseUrl, accessToken: token });
  }
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
