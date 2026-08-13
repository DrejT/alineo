/**
 * Demonstrates error handling patterns:
 *   Pattern A — non-strict exec: check exitCode in result
 *   Pattern B — strict exec (default): CommandError thrown on non-zero exit
 */
import { Alineo, CommandError, SandboxError, ExecConnectionError } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sbA = await client.sandbox({
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "error-handling-a",
});

console.log("=== Pattern A: non-strict exec with exitCode check ===");

try {
  const { exitCode } = await sbA.exec("exit 1", { strict: false });
  if (exitCode === 0) {
    await sbA.exec("echo success").pipe(process.stdout);
  } else {
    await sbA.exec("echo 'command failed, handled gracefully'").pipe(process.stdout);
  }
} finally {
  await sbA.close();
}

const sbB = await client.sandbox({
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "error-handling-b",
});

console.log("\n=== Pattern B: strict exec (default) — catch CommandError ===");

try {
  await sbB.exec("echo 'about to fail'").pipe(process.stdout);
  await sbB.exec("exit 42"); // throws CommandError (strict: true is the default)
  await sbB.exec("echo 'this line never runs'");
} catch (e) {
  if (e instanceof CommandError) {
    console.error(`CommandError: exit code ${e.exitCode} — "${e.command}"`);
  } else if (e instanceof SandboxError) {
    console.error(`SandboxError: ${e.message}`, e.sandboxId ? `(sandbox: ${e.sandboxId})` : "");
  } else if (e instanceof ExecConnectionError) {
    console.error(`ExecConnectionError: execd unreachable for sandbox ${e.sandboxId}`);
  } else {
    throw e;
  }
} finally {
  await sbB.close();
}
