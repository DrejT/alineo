/**
 * `src/engine/sdk.ts` is the one place alineod creates, restarts or reconnects an `Alineo`.
 *
 * It exists because handing an agent its memory (and the shared ledger adapter) was a convention
 * each call site had to remember — and forgetting it compiles, runs, and yields an agent with no
 * memory and nothing to say so. Moving the convention into the only functions that exist closes
 * that off only while nothing goes around them; this is the check that nothing does, in the same
 * spirit as `scripts/check-vocabulary.ts`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC })].map((f) =>
  f.replaceAll("\\", "/"),
);

/**
 * Source with comments and string contents removed, so prose and log text that name
 * `Alineo.start()` (a comment, a log line, a SQL comment) don't count as a call.
 */
function code(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test("the scan actually sees the source tree", () => {
  // A guard that reads nothing always passes.
  expect(files.length).toBeGreaterThan(20);
  expect(files).toContain("engine/sdk.ts");
});

test("no module but engine/sdk.ts constructs an agent through the SDK directly", () => {
  const offenders = files
    .filter((f) => f !== "engine/sdk.ts")
    .filter((f) => /\bAlineo\.(start|resume|reattach|attach|load)\s*\(/.test(code(f)));
  expect(offenders).toEqual([]);
});

test("nothing but engine/sdk.ts reaches for the memory options or the SDK adapter to build an agent", () => {
  const offenders = files
    .filter((f) => !["engine/sdk.ts", "engine/memory.ts", "engine/registry.ts"].includes(f))
    .filter((f) => /\bmemoryOptions\s*\(/.test(code(f)));
  expect(offenders).toEqual([]);
});

test("engine/sdk.ts does attach both, on every constructor it exposes", () => {
  const sdk = code("engine/sdk.ts");
  for (const fn of ["start", "resume", "reattach"]) {
    const call = new RegExp(`Alineo\\.${fn}\\([^;]*adapter: sdkAdapter[^;]*memoryOptions\\(\\)`);
    expect(sdk).toMatch(call);
  }
});
