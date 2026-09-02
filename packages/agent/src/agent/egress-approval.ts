import { createServer, type Server } from "node:http";
import {
  LedgerEvent,
  type CredentialBinding,
  type CredentialSource,
  type SandboxHandle,
} from "@alineo-labs/core";

/**
 * Human-in-the-loop gate for a sandboxed agent's outbound network access.
 *
 * Credential env bindings marked `approval: "hold"` in `AgentSpec.env` start with their host
 * *denied* at the egress sidecar (the sandbox is `defaultAction: "allow"` with an explicit
 * `deny` rule per held host, so everything else — including the agent's own model traffic —
 * keeps working) and their credential **not registered in the vault at all** (the vault
 * refuses a binding whose host isn't allowed).
 *
 * The sidecar POSTs a fire-and-forget webhook when the sandbox is denied a DNS query. This
 * gate listens for that, calls the caller's handler, and on approval:
 *   1. flips the sidecar rule to `allow` for that host (`sb.egress.patch`), then
 *   2. registers the held credential(s) for it (`sb.credentials.set`) — so the credential
 *      literally does not exist inside the sandbox until a human approves.
 *
 * `allow-once` reverses both at the end of the turn; `allow-always` leaves them in place.
 * Enforcement is entirely out-of-process — a compromised in-sandbox agent cannot skip it.
 *
 * The listener binds `0.0.0.0` on an ephemeral port and is torn down with the agent.
 */

export type EgressDecision = "allow-once" | "allow-always" | "deny";

/** One egress attempt awaiting a decision. */
export interface EgressRequest {
  /** The hostname the agent's sandbox tried to reach. */
  host: string;
  /** Unix ms when the sidecar reported the denial. */
  since: number;
}

export type EgressRequestHandler = (
  req: EgressRequest,
) => EgressDecision | Promise<EgressDecision>;

/** A credential whose registration is gated behind egress approval for its host. */
export interface HeldCredential {
  name: string;
  value: string;
  binding: CredentialBinding;
  source?: CredentialSource;
}

/** The sidecar's deny-webhook body (`components/egress/pkg/events/webhook.go`). */
interface DenyWebhookBody {
  hostname?: string;
  sandboxId?: string;
}

const DEDUP_TTL_MS = 30_000;

export interface EgressApprovalGateOptions {
  /**
   * Credentials whose host starts denied. The gate allows the host and registers these on
   * approval. (Non-credential held hosts can be passed as `{ name, value: "", binding }` with
   * an empty value — the gate then only manages the egress rule.)
   */
  heldCredentials: HeldCredential[];
  handler: EgressRequestHandler;
  /**
   * Address the sandbox's egress sidecar can reach this host process at. Defaults to the
   * Docker default-bridge gateway (`172.17.0.1`), which an `alineo init` server's sidecars
   * can reach. Override for other topologies via `ALINEO_EGRESS_APPROVAL_HOST`.
   */
  webhookHost?: string;
}

export class EgressApprovalGate {
  private server: Server | undefined;
  private port = 0;
  private sandbox: SandboxHandle | undefined;
  private readonly handler: EgressRequestHandler;
  private readonly webhookHost: string;
  /** host → the held credentials bound to it. */
  private readonly byHost = new Map<string, HeldCredential[]>();
  /** Hosts still gated — dropped once permanently opened by `allow-always`. */
  private readonly held = new Set<string>();
  /** host → last time we raised a request for it (dedup; the webhook fires per DNS query). */
  private readonly seen = new Map<string, number>();
  /** Hosts with a decision currently in flight. */
  private readonly inFlight = new Set<string>();
  /** Hosts approved `allow-once` — reversed on `endTurn()`. */
  private readonly onceApproved = new Set<string>();

  constructor(opts: EgressApprovalGateOptions) {
    this.handler = opts.handler;
    this.webhookHost =
      opts.webhookHost ?? process.env.ALINEO_EGRESS_APPROVAL_HOST ?? "172.17.0.1";
    for (const held of opts.heldCredentials) {
      const host = normalizeHost(held.binding.host);
      this.held.add(host);
      const list = this.byHost.get(host);
      if (list) list.push(held);
      else this.byHost.set(host, [held]);
    }
  }

  /** Attach the sandbox whose egress this gate manages. Called once its handle exists. */
  bind(sandbox: SandboxHandle): void {
    this.sandbox = sandbox;
  }

  private sb(): SandboxHandle {
    if (!this.sandbox) throw new Error("EgressApprovalGate.bind() has not been called");
    return this.sandbox;
  }

  /** Start the listener. Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/egress-deny") {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        // Answer 200 immediately — the sidecar retries on non-2xx and fires per DNS query.
        res.writeHead(200).end("ok");
        let body: DenyWebhookBody | null = null;
        try {
          body = JSON.parse(raw) as DenyWebhookBody;
        } catch {
          return;
        }
        const host = body?.hostname ? normalizeHost(body.hostname) : undefined;
        if (host) void this.onDenied(host);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
    // Don't hold the event loop open on our own account — `close()`/`stop()` is the explicit
    // teardown; `unref` just means a leaked gate (e.g. `Alineo.load()` throwing after this
    // point) can't hang the process.
    server.unref();
    this.server = server;
  }

  /** Stop the listener. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The `OPENSANDBOX_EGRESS_DENY_WEBHOOK` value to put in the sandbox's env. */
  get webhookUrl(): string {
    if (!this.server) throw new Error("EgressApprovalGate.start() has not been called");
    return `http://${this.webhookHost}:${this.port}/egress-deny`;
  }

  /** Egress requests currently awaiting a decision. */
  pending(): EgressRequest[] {
    return [...this.inFlight].map((host) => ({ host, since: this.seen.get(host) ?? Date.now() }));
  }

  /**
   * Reverse every `allow-once` approval — remove its credential(s) and re-deny the host.
   * Call when an agent turn ends so a one-shot grant does not silently persist.
   */
  async endTurn(): Promise<void> {
    const toRevert = [...this.onceApproved].filter((h) => this.held.has(h));
    this.onceApproved.clear();
    for (const host of toRevert) {
      // Credential first (while the host is still allowed), then re-deny.
      for (const held of this.byHost.get(host) ?? []) {
        if (held.value !== "") await this.sb().credentials.remove(held.name).catch(() => {});
      }
      await this.sb().egress.patch([{ action: "deny", target: host }]);
    }
  }

  private async onDenied(host: string): Promise<void> {
    if (!this.held.has(host)) return; // not a gated host
    const now = Date.now();
    const last = this.seen.get(host);
    if (last !== undefined && now - last < DEDUP_TTL_MS) return;
    if (this.inFlight.has(host)) return;
    this.seen.set(host, now);
    this.inFlight.add(host);

    void this.sb().emit(LedgerEvent.PermissionRequested, -1, {
      requestId: `egress:${host}`,
      tool: "network",
      target: host,
    });

    let decision: EgressDecision = "deny";
    try {
      decision = await this.handler({ host, since: now });
    } catch {
      decision = "deny";
    }

    try {
      if (decision === "allow-once" || decision === "allow-always") {
        // Order matters: the vault refuses a binding whose host isn't allowed, so open the
        // egress rule first, then register the credential(s).
        await this.sb().egress.patch([{ action: "allow", target: host }]);
        for (const held of this.byHost.get(host) ?? []) {
          if (held.value !== "") {
            await this.sb().credentials.set(held.name, held.value, held.binding, held.source);
          }
        }
        if (decision === "allow-once") this.onceApproved.add(host);
        else this.held.delete(host);
      }
    } finally {
      this.inFlight.delete(host);
      void this.sb().emit(LedgerEvent.PermissionResolved, -1, {
        requestId: `egress:${host}`,
        decision: { kind: decision },
      });
    }
  }
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, "").toLowerCase();
}
