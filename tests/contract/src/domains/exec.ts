import { describe, expect, test } from "bun:test";
import { CommandError } from "@alineo-labs/core";
import { errorCodeOf } from "@alineo-labs/errors";
import type { ProviderBinding } from "../binding";
import { withSandbox } from "../helpers";

export function execDomain(binding: ProviderBinding): void {
  describe(`${binding.name}: exec`, () => {
    test("returns stdout, stderr, and the exit code", async () => {
      await withSandbox(binding, "exec-basic", async (sb) => {
        const r = await sb.exec("echo out; echo err 1>&2; exit 3", { strict: false });
        expect(r.stdout.trim()).toBe("out");
        expect(r.stderr.trim()).toBe("err");
        expect(r.exitCode).toBe(3);
      });
    });

    test("a non-zero exit throws CommandError with COMMAND_FAILED by default", async () => {
      await withSandbox(binding, "exec-strict", async (sb) => {
        const err = await Promise.resolve(sb.exec("exit 7")).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CommandError);
        expect((err as CommandError).exitCode).toBe(7);
        expect(errorCodeOf(err)).toBe("COMMAND_FAILED");
      });
    });

    test("honours cwd and env", async () => {
      await withSandbox(binding, "exec-cwd-env", async (sb) => {
        await sb.exec("mkdir -p /tmp/contract-cwd");
        const r = await sb.exec('pwd; echo "$GREETING"', {
          cwd: "/tmp/contract-cwd",
          env: { GREETING: "hello" },
        });
        expect(r.stdout.trim().split("\n")).toEqual(["/tmp/contract-cwd", "hello"]);
      });
    });

    test("streams output in order", async () => {
      await withSandbox(binding, "exec-stream", async (sb) => {
        const chunks: string[] = [];
        for await (const chunk of sb.exec("for i in 1 2 3; do echo line$i; done").stdout()) {
          chunks.push(chunk);
        }
        expect(chunks.join("")).toBe("line1\nline2\nline3\n");
      });
    });

    test("a multi-line script runs every line", async () => {
      await withSandbox(binding, "exec-multiline", async (sb) => {
        const r = await sb.exec("echo one\necho two\necho three");
        expect(r.stdout.trim().split("\n")).toEqual(["one", "two", "three"]);
      });
    });

    // The core hands the command to `sh` through a pipe, so `sh` reads its script from stdin. A
    // command that reads stdin may then consume the rest of the script. If this fails, the
    // second line below is printed as text ("echo after") instead of being run ("after").
    test("a command that reads stdin does not swallow the rest of the script", async () => {
      await withSandbox(binding, "exec-stdin", async (sb) => {
        const r = await sb.exec("cat\necho after", { strict: false });
        expect(r.stdout.trim()).toBe("after");
      });
    });

    test("a long-running command is stopped by timeoutMs", async () => {
      await withSandbox(binding, "exec-timeout", async (sb) => {
        const started = Date.now();
        const r = await sb.exec("sleep 30", { timeoutMs: 2000, strict: false });
        expect(Date.now() - started).toBeLessThan(20_000);
        // A timed-out command did not succeed. The provider may report 124, 137, or -1.
        expect(r.exitCode).not.toBe(0);
      });
    });
  });
}
