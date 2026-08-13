import { ExecClient } from "@alineo-labs/opensandbox";
import type { ControlClient } from "@alineo-labs/opensandbox";
import { ExecConnectionError } from "../errors";

/**
 * Resolve an ExecClient for a sandbox. Calls getEndpoint once (each call
 * returns a different ephemeral proxy port) then polls listContexts until
 * execd is ready to accept connections.
 *
 * Defaults give ~80s of total patience (retries=45, capped at 2s/attempt), not the ~11s this
 * had before (retries=15, capped at 1s/attempt). Bumped after a live `alineo fork` failure
 * (issue #32): a child forked while its parent sandbox was busy running a real Chrome session
 * took ~35s just to reach `Running`, then immediately exhausted the old ~11s execd-readiness
 * budget before the exec daemon inside it had actually started accepting connections. An
 * isolated repro of the identical fork (same snapshot, but from an idle parent with no
 * concurrent browser load) reached execd-ready in under 400ms -- the parent's own host-resource
 * contention at fork time, not snapshot size, is what actually eats the budget. This can't be
 * fixed by scheduling around it from here, so it's addressed by simply affording much more
 * patience before giving up.
 */
export async function resolveExecClient(
  control: ControlClient,
  sandboxId: string,
  useServerProxy?: boolean,
  retries = 45,
  delayMs = 2_000,
): Promise<ExecClient> {
  const ep = await control.getEndpoint(sandboxId, 44772, useServerProxy);
  const baseUrl = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
  const token = ep.headers?.["X-EXECD-ACCESS-TOKEN"] ?? "";
  const client = new ExecClient({ baseUrl, accessToken: token });
  // Starts fast and backs off to delayMs — execd is usually ready well under one
  // fixed-interval tick, so a flat wait here was pure waste in the common case.
  let delay = Math.min(100, delayMs);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.listContexts();
      return client;
    } catch {
      if (attempt === retries) throw new ExecConnectionError(sandboxId);
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, delayMs);
    }
  }
  throw new Error("unreachable");
}
