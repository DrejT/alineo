/**
 * Optional authentication for the alineod HTTP API.
 *
 * Off by default: `createApp()` with no options asks for no credential and behaves as it always
 * has. A deployer who exposes alineod to other people passes `authenticate`, a function that maps a
 * request to a `Principal` (or `null` to refuse it). alineo ships the hook and one simple
 * implementation (`tokenAuthenticate`, a single shared secret). Key storage, rotation and
 * per-tenant policy belong to the deployer.
 *
 * The hook runs in `onRequest`, which Elysia applies to every route, including routes mounted
 * through `.use(plugin)`. A `onBeforeHandle` on the parent would not: Elysia hooks are local by
 * default. `GET /health` is the one exemption, so a load balancer can probe without a credential.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { getLogger } from "@alineo-labs/logger";
import type { Limits } from "./limits";

/** Who is calling. `tenantId` names the owner of the runs this caller creates and may read. */
export interface Principal {
  tenantId: string;
}

/**
 * Map a request to a principal, or `null` to refuse it with a 401. May be async. A function that
 * throws is treated as a refusal: the caller learns nothing about why.
 */
export type Authenticate = (request: Request) => Principal | null | Promise<Principal | null>;

/** The tenant that `tokenAuthenticate` assigns every caller. */
export const DEFAULT_TENANT = "default";

/** What the access plugin learned about one request. Read by the route layer, never by a client. */
interface RequestContext {
  principal: Principal | null;
  /** Env names a spec may interpolate, or `null` for no restriction. */
  specEnvAllow: readonly string[] | null;
  /** Per-tenant limits and the kill switch, or `null` for none. */
  limits: Limits | null;
}

const contexts = new WeakMap<Request, RequestContext>();

/** The principal the hook returned for this request, or `null` when no hook is set. */
export function principalOf(request: Request): Principal | null {
  return contexts.get(request)?.principal ?? null;
}

/** The limits in force for this request, or `null` when there are none. */
export function limitsOf(request: Request): Limits | null {
  return contexts.get(request)?.limits ?? null;
}

/** The env-name allowlist in force for this request, or `null` when specs are unrestricted. */
export function specEnvAllowOf(request: Request): readonly string[] | null {
  return contexts.get(request)?.specEnvAllow ?? null;
}

const sha256 = (value: string) => new Uint8Array(createHash("sha256").update(value).digest());

/**
 * A single shared secret, compared in constant time. Every caller who holds the token is the one
 * `default` tenant, so this is authentication and not isolation: it suits one trusted user, or
 * several who are meant to see each other's runs.
 */
export function tokenAuthenticate(token: string): Authenticate {
  if (token.length === 0) throw new Error("tokenAuthenticate needs a non-empty token");
  const expected = sha256(token);
  return (request) => {
    const header = request.headers.get("authorization");
    if (header === null) return null;
    if (!/^Bearer\s+\S/i.test(header)) return null;
    const supplied = header.replace(/^Bearer\s+/i, "");
    // Hash first so the compared buffers always have the same length.
    return timingSafeEqual(sha256(supplied), expected) ? { tenantId: DEFAULT_TENANT } : null;
  };
}

function unauthenticated(): Response {
  return Response.json(
    { error: "authentication required", code: "UNAUTHENTICATED" },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

export interface AccessOptions {
  /** Refuse any request this function does not accept. */
  authenticate?: Authenticate;
  /**
   * The env names a spec may interpolate with `${NAME}` in `AgentSpec.env`. An entry is an exact
   * name or a prefix ending in `*`. Unset means no restriction. `[]` means none: a spec may then
   * carry only literal values.
   *
   * Why it exists: alineod resolves `${NAME}` from its own environment, so without a list any
   * caller can write `${A_SECRET_ALINEOD_HOLDS}` into a spec and read it inside its sandbox.
   */
  specEnvAllow?: readonly string[];
  /** Per-tenant limits and the kill switch. See `limits.ts`. Unset means none. */
  limits?: Limits;
}

/** An Elysia plugin that applies `AccessOptions` to every request. */
export function authPlugin(options: AccessOptions) {
  const { authenticate, specEnvAllow = null, limits = null } = options;
  return new Elysia({ name: "alineod-auth" }).onRequest(async ({ request }) => {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return;
    let principal: Principal | null = null;
    if (authenticate) {
      try {
        principal = await authenticate(request);
      } catch {
        return unauthenticated();
      }
      if (principal === null) return unauthenticated();
      // A colon in a tenant id would let two tenants' memory scopes collide (`a:b` + `x` and `a` +
      // `b:x` both read `a:b:x`). That is a bug in the deployer's authenticate function, so say so.
      if (principal.tenantId === "" || principal.tenantId.includes(":")) {
        getLogger("alineod").error(
          "authenticate returned a tenant id that is empty or has a colon",
        );
        return unauthenticated();
      }
    }
    contexts.set(request, { principal, specEnvAllow, limits });
    return;
  });
}
