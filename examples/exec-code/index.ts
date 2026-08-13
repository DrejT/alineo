/**
 * Demonstrates execCode() for running code in the sandbox interpreter.
 *
 * Two patterns shown:
 *   isolated  — each call gets its own context; variables don't carry over
 *   stateful  — calls sharing the same context see each other's variables
 *
 * Requires the opensandbox/code-interpreter image, which starts a Jupyter
 * kernel service via its built-in entrypoint script.
 */
import { Alineo, CodeLanguage } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sb = await client.sandbox({
  image: "opensandbox/code-interpreter",
  entrypoint: ["/opt/code-interpreter/code-interpreter.sh"],
  name: "exec-code",
  resources: { cpu: "500m", memory: "512Mi" },
});

console.log(`Sandbox ID: ${sb.sandboxId}\n`);

try {
  // Isolated — a fresh context per call; variables do not persist across calls
  const ctxA = await sb.createCodeContext(CodeLanguage.Python);
  const ctxB = await sb.createCodeContext(CodeLanguage.Python);

  await sb
    .execCode(
      [
        "import sys, math",
        'print(f"[isolated-a] Python {sys.version.split()[0]}")',
        'print(f"[isolated-a] pi = {math.pi:.6f}")',
      ].join("\n"),
      { context: ctxA },
    )
    .pipe(process.stdout);

  await sb
    .execCode(["import sys", 'print(f"[isolated-b] Python {sys.version.split()[0]}")'].join("\n"), {
      context: ctxB,
    })
    .pipe(process.stdout);

  // Stateful — variables persist across calls sharing the same context
  const ctx = await sb.createCodeContext(CodeLanguage.Python);

  await sb
    .execCode(
      ["data = [2**i for i in range(8)]", 'print(f"[stateful 1] data = {data}")'].join("\n"),
      { context: ctx },
    )
    .pipe(process.stdout);

  await sb
    .execCode(
      [
        "total = sum(data)",
        'print(f"[stateful 2] sum = {total}")',
        'print(f"[stateful 2] max = {max(data)}")',
      ].join("\n"),
      { context: ctx },
    )
    .pipe(process.stdout);
} finally {
  await sb.close();
}
