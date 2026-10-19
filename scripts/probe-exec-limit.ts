/**
 * Find the command size at which execd stops running a command.
 *
 *   bun scripts/probe-exec-limit.ts
 *
 * Posts raw `/command` bodies of growing size straight to execd, bypassing alineo's own size
 * guard, in two shapes: one long comment line, and a heredoc of 76-character lines like the
 * tarball steps `pack-local-package.ts` writes. A command ran if its `marker-ok` came back.
 * Needs a live OpenSandbox. Reads OPEN_SANDBOX_URL (default http://127.0.0.1:8080).
 */
import { OpenSandboxProvider } from "../packages/opensandbox/src/index";

const provider = new OpenSandboxProvider({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  useServerProxy: true,
});

const shapes: Record<string, (bytes: number) => string> = {
  "one comment line": (bytes) => `echo marker-ok\n#${"x".repeat(bytes)}`,
  "heredoc of 76-char lines": (bytes) =>
    `echo marker-ok\ncat > /tmp/probe.b64 <<'EOF'\n${`${"A".repeat(76)}\n`.repeat(Math.ceil(bytes / 77))}EOF`,
};

const out = (line: string) => process.stdout.write(`${line}\n`);

const sandbox = await provider.createSandbox({
  image: { uri: "debian:bookworm-slim" },
  resourceLimits: { cpu: "500m", memory: "256Mi" },
  entrypoint: ["tail", "-f", "/dev/null"],
  timeout: 300,
});
try {
  await provider.connectExec(sandbox.id);
  const ep = await provider.getEndpoint(sandbox.id, 44772, true);
  const url = ep.endpoint.startsWith("http") ? ep.endpoint : `http://${ep.endpoint}`;
  for (const [shape, make] of Object.entries(shapes)) {
    out(`\n== ${shape}`);
    for (const kb of [60, 90, 92, 96, 100, 110, 127, 129, 200]) {
      const command = make(kb * 1000);
      const res = await fetch(`${url}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ep.headers },
        body: JSON.stringify({ command }),
      });
      const text = await res.text();
      const ran = text.includes("marker-ok");
      const note = ran ? "" : text.slice(0, 200).replace(/\n/g, "\\n");
      out(
        `${String(kb).padStart(4)} KB  sent ${command.length} B  http ${res.status}  ran=${ran}  ${note}`,
      );
    }
  }
} finally {
  await provider.deleteSandbox(sandbox.id);
}
