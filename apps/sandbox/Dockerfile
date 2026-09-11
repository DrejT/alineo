# Sandbox API (apps/sandbox/server) — the Bun backend behind sandbox.alineo.tech's
# dashboard and the docs playground. Built from the monorepo root so workspace deps
# (alineo, @alineo-labs/{core,sandbox,sqlite}) resolve via their `exports.import`
# dist/ build output, same as CI's "Build all packages" step.
#
# Build from the repo root:
#   docker build -f apps/sandbox/Dockerfile -t alineo-sandbox-api .
#
# Run (host networking so the default OPENSANDBOX_URL=http://127.0.0.1:8080 and
# USE_SERVER_PROXY=true reach the host's OpenSandbox container unchanged):
#   docker run -d --name sandbox-api --network host --restart unless-stopped \
#     -v $(pwd)/apps/sandbox/data:/app/apps/sandbox/data \
#     -v $(pwd)/apps/sandbox/agents:/app/apps/sandbox/agents \
#     --env-file apps/sandbox/.env \
#     alineo-sandbox-api

FROM oven/bun:1.3.14

WORKDIR /app

# Install deps first for layer caching — bun needs every workspace's package.json
# present to resolve the root "workspaces" globs, so copy the whole tree rather
# than trying to cherry-pick just apps/sandbox's dependency chain.
COPY package.json bun.lock ./
COPY scripts scripts
COPY packages packages
COPY examples examples
COPY cookbooks cookbooks
COPY tests/integration tests/integration
COPY apps apps

RUN bun install --frozen-lockfile

# Builds dist/ for every publishable package (alineo, @alineo-labs/*) that
# apps/sandbox imports via its ESM `exports.import` condition.
RUN bun run build

WORKDIR /app/apps/sandbox

EXPOSE 3000

CMD ["bun", "server/index.ts"]
