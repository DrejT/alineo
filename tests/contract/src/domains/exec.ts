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
        expect(r.killed).toBe(true);
        expect(r.timedOut).toBe(true);
        expect(r.durationMs).toBeGreaterThanOrEqual(1500);
      });
    });

    test("a command that kills itself is not reported as a timeout", async () => {
      await withSandbox(binding, "exec-self-kill", async (sb) => {
        const r = await sb.exec("kill -9 $$", { timeoutMs: 60_000, strict: false });
        // The wrapper's inner shell dies, so execd sees exit status 137 (128 + 9), not a signal.
        // Either way it did not run out its limit.
        expect(r.exitCode).not.toBe(0);
        expect(r.timedOut).not.toBe(true);
      });
    });

    test("an AbortSignal ends the call, and the command is interrupted", async () => {
      await withSandbox(binding, "exec-abort", async (sb) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1000);

        const started = Date.now();
        const err = await Promise.resolve(
          sb.exec("sleep 60", { signal: controller.signal, strict: false }),
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("AbortError");
        expect(Date.now() - started).toBeLessThan(15_000);

        // The sandbox is still usable, and the sleep is gone.
        const after = await sb.exec("pgrep -f 'sleep 60' >/dev/null && echo running || echo gone", {
          strict: false,
        });
        expect(after.stdout.trim()).toBe("gone");
      });
    });

    test("an already-aborted signal rejects before anything runs", async () => {
      await withSandbox(binding, "exec-pre-aborted", async (sb) => {
        const controller = new AbortController();
        controller.abort();
        const err = await Promise.resolve(
          sb.exec("echo should-not-run", { signal: controller.signal }),
        ).catch((e: unknown) => e);
        expect((err as Error).name).toBe("AbortError");
      });
    });
  });
}
