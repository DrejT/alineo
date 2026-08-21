import { Sandbox } from "@alineo-labs/sandbox";
import { workflow } from "@alineo-labs/workflow";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("retry, when, and forEach all execute correctly", async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const { stdout } = await workflow(client)
    .sandbox(
      {
        image: "ubuntu:22.04",
        resources: { cpu: "500m", memory: "512Mi" },
        name: "control-flow-test",
      },
      (sb) => {
        sb.retry(
          5,
          (sb) => {
            sb.exec(
              'COUNT=$(cat /tmp/attempt 2>/dev/null || echo 0); COUNT=$((COUNT+1)); echo $COUNT > /tmp/attempt; echo "[retry] attempt $COUNT"; [ $COUNT -ge 3 ] && echo "[retry] succeeded" || { echo "[retry] failing"; exit 1; }',
            );
          },
          { delayMs: 200, backoff: "exponential" },
        );

        sb.exec("test -f /etc/hostname", { strict: false });
        sb.when(
          (ctx) => ctx.exitCode === 0,
          (sb) => {
            sb.exec('echo "[when] /etc/hostname exists"');
          },
          (sb) => {
            sb.exec('echo "[when] /etc/hostname missing"');
          },
        );

        sb.forEach(["alpha.txt", "beta.txt", "gamma.txt"], (sb, item) => {
          sb.exec(`echo "[loop] writing /tmp/${item}" && echo hello > /tmp/${item}`);
        });

        sb.exec("ls /tmp/*.txt && echo '[verify] all files present'");
      },
    )
    .result();

  expect(stdout).toContain("[retry] succeeded");
  expect(stdout).toContain("[when] /etc/hostname exists");
  expect(stdout).toContain("[loop] writing /tmp/alpha.txt");
  expect(stdout).toContain("[loop] writing /tmp/beta.txt");
  expect(stdout).toContain("[loop] writing /tmp/gamma.txt");
  expect(stdout).toContain("[verify] all files present");
}, 60_000);
