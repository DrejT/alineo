import { $ } from "bun";
import { existsSync } from "fs";

const info = (msg: string) => console.log(`\x1b[1;34m==>\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`\x1b[1;33m!!\x1b[0m ${msg}`);
const fail = (msg: string) => {
  console.error(`\x1b[1;31mERROR:\x1b[0m ${msg}`);
  process.exit(1);
};

async function checkCmd(cmd: string) {
  try {
    // Some commands like docker might not respond to --version properly if not installed,
    // but running them should throw if not found in PATH when using Bun's $
    await $`${cmd} --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  info("Checking prerequisites...");

  if (!(await checkCmd("bun"))) fail("Bun >= 1.3 is required. Install: https://bun.sh");

  // Get the actual version string for display
  const bunVer = (await $`bun --version`.text()).trim();
  info(`bun ${bunVer} found`);

  if (await checkCmd("docker")) {
    info("docker found");
  } else {
    warn("Docker not found — needed for 'bunx drejx init' (local OpenSandbox) and integration tests");
  }

  if (await checkCmd("uv")) {
    info("uv found");
  } else {
    warn("uv/uvx not found — alternative way to run OpenSandbox server. Install: https://github.com/astral-sh/uv");
  }

  info("Installing dependencies (bun install)...");
  await $`bun install`;

  info("Building workspace packages (examples run against dist/, not src/)...");
  await $`bun run build`;

  if (!existsSync(".env")) {
    info("Creating .env from template...");
    await Bun.write(
      ".env",
      `# OpenSandbox server used by examples and local dev.
# These defaults match \`bunx drejx init\` (Docker) and \`uvx opensandbox-server\` (manual).
# Leave as-is unless you're pointing at a remote/hosted OpenSandbox instance.
OPEN_SANDBOX_URL=http://localhost:8080
OPEN_SANDBOX_API_KEY=
`
    );
  } else {
    info(".env already exists, leaving it untouched");
  }

  info("Typechecking...");
  await $`bun run typecheck`;

  info("Running unit tests (no sandbox required)...");
  await $`bun run test`;

  info("Setup complete.");
  console.log(`
Next steps:
  1. Start a local OpenSandbox server (pick one):
       bunx drejx init          # Docker-based, recommended
       uvx opensandbox-server   # manual — needs ~/.sandbox.toml, see CLAUDE.md

  2. Run an example against it:
       bun examples/hello-world/index.ts

  3. Run integration tests (needs the server from step 1):
       bun run test:integration

See CONTRIBUTING.md and CLAUDE.md for details.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
