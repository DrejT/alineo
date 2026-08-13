#!/usr/bin/env bun
// Usage: bun scripts/new-example.ts <name>
//
// Scaffolds examples/<name>/{package.json,index.ts,README.md} and a stub
// tests/integration/<name>.test.ts, matching the shape every existing example
// follows (see examples/hello-world/ as the canonical reference). Examples are
// deliberately single-file, copy-paste-able standalone demos — this generator
// exists to make adding one fast and consistent, not to make examples depend
// on a shared runtime package.

import { join } from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("Usage: bun scripts/new-example.ts <name>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Invalid name "${name}" — use lowercase letters, digits, and hyphens only.`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const exampleDir = join(root, "examples", name);

if (await Bun.file(join(exampleDir, "package.json")).exists()) {
  console.error(`examples/${name} already exists.`);
  process.exit(1);
}

const packageJson = {
  name: `alineo-example-${name}`,
  version: "0.0.1",
  private: true,
  scripts: { start: "bun index.ts" },
  dependencies: {
    "@alineo-labs/sqlite": "workspace:*",
    alineo: "workspace:*",
  },
};

const indexTs = `/**
 * Demonstrates ___.
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "${name}",
});

console.log(\`Sandbox ID: \${sb.sandboxId}\`);

try {
  await sb.exec('echo "hello from ${name}"').pipe(process.stdout);
} finally {
  await sb.close();
}
`;

const readmeMd = `# ${name}

TODO: one-line description of what this example demonstrates.

## Setup

\`\`\`bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
\`\`\`

## Run

\`\`\`bash
bun install
bun start
\`\`\`

## What it does

TODO.

## Notes

All examples default to \`useServerProxy: true\` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set \`USE_SERVER_PROXY=false\` to disable
(e.g. when using \`uvx opensandbox-server\` on the host).
`;

const testStub = `import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { test, expect } from "bun:test";

test("TODO: describe what this test verifies", async () => {
  const client = new Alineo({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
  });

  const sb = await client.sandbox({
    image: "ubuntu:22.04",
    resources: { cpu: "500m", memory: "256Mi" },
    name: "${name}-test",
  });

  try {
    const { stdout, exitCode } = await sb.exec('echo "hello from ${name}"');
    expect(stdout.trim()).toBe("hello from ${name}");
    expect(exitCode).toBe(0);
  } finally {
    await sb.close();
  }
}, 60_000);
`;

await Bun.write(join(exampleDir, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
await Bun.write(join(exampleDir, "index.ts"), indexTs);
await Bun.write(join(exampleDir, "README.md"), readmeMd);
await Bun.write(join(root, "tests", "integration", `${name}.test.ts`), testStub);

console.log(`Created examples/${name}/ (package.json, index.ts, README.md)`);
console.log(`Created tests/integration/${name}.test.ts`);
console.log(
  `\nNext: fill in the TODOs, run \`bun install\`, then \`bun examples/${name}/index.ts\`.`,
);
