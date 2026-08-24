import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("interactive exec: shell state survives checkpoint + resume via stdin replay", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "512Mi" },
    name: "interactive-exec-test",
  });

  let resumed: Awaited<ReturnType<typeof client.resume>> | undefined;

  try {
    const shell = sb.exec("bash", { interactive: true });

    shell.write("export SECRET=42\n");
    shell.write("mkdir -p /tmp/work && cd /tmp/work\n");
    shell.write("echo state-before-checkpoint > marker.txt\n");
    shell.write("echo setup-done\n");

    // Give the shell a moment to actually run the setup before snapshotting it.
    await new Promise((r) => setTimeout(r, 1500));

    await sb.checkpoint("mid-session");

    resumed = await client.resume(sb.sandboxId);

    // Same call site, same program order -> same seq -> the resume path picks up
    // the still-open interactive session and replays its recorded stdin for real
    // against the freshly restored filesystem before handing control back live.
    const shell2 = resumed.exec("bash", { interactive: true });

    // One atomic command — bash substitutes $(pwd)/$(cat ...)/$SECRET itself and
    // emits the fully-resolved string as a single piece of output, immune to
    // transport-level interleaving across separate writes.
    shell2.write('echo "DIAG_START:$(pwd)|$(cat marker.txt 2>&1)|$SECRET:DIAG_END"\n');
    await new Promise((r) => setTimeout(r, 1000));
    shell2.write("exit\n");

    const result = await shell2;

    const match = result.stdout.match(/DIAG_START:(.*?):DIAG_END/s);
    expect(match).not.toBeNull();
    const [pwdVal, fileVal, secretVal] = match![1]
      .split("|")
      .map((s) => s.replace(/\r/g, "").trim());

    expect(pwdVal).toBe("/tmp/work");
    expect(fileVal).toBe("state-before-checkpoint");
    expect(secretVal).toBe("42");
    expect(result.exitCode).toBe(0);
  } finally {
    await sb.close();
    await resumed?.close();
  }
}, 90_000);
