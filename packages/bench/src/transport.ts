/**
 * `alineo init` writes `eip = http://host.docker.internal:8080` so the alineod container can reach
 * OpenSandbox. On Docker Desktop for Windows that name resolves to the LAN address from the host,
 * where the port is not published, so every execd call from a host-side script times out.
 *
 * Set BENCH_REWRITE_HOST=<name>=<replacement> (e.g. host.docker.internal=localhost) to rewrite the
 * host of outgoing requests. Bench-only: nothing about the server config changes.
 */
export function installHostRewrite(spec: string | undefined): void {
  if (!spec) return;
  const [from, to] = spec.split("=");
  if (!from || !to) throw new Error(`BENCH_REWRITE_HOST must look like "from=to", got "${spec}"`);
  const original = globalThis.fetch;
  const rewrite = (u: string): string => u.replace(`//${from}`, `//${to}`);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") return original(rewrite(input), init);
    if (input instanceof URL) return original(new URL(rewrite(input.href)), init);
    return original(new Request(rewrite(input.url), input), init);
  }) as typeof fetch;
}
