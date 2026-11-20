# Control plane dashboard (ui/): the Bun server in ui/server plus the React app in ui/web.
# Sandboxes are real OpenSandbox containers, so this image needs a reachable OpenSandbox server.
#
# Built from the monorepo root so the workspace packages (@alineo-labs/sandbox, sqlite, ...)
# resolve through their built dist/ output, the same way apps/sandbox/Dockerfile does it.
#
#   docker compose -f ui/docker-compose.yml up -d --build
#
# docker-compose.yml uses bridge networking with host.docker.internal mapped to the host gateway,
# like apps/alineod. Host networking breaks exec where that name resolves to ::1 (see the compose file).

FROM oven/bun:1.3.14

WORKDIR /app

# bun needs every workspace's package.json present to resolve the root "workspaces" globs,
# so copy the whole tree instead of cherry-picking a dependency chain.
COPY package.json bun.lock ./
COPY scripts scripts
COPY packages packages
COPY examples examples
COPY cookbooks cookbooks
COPY tests tests
COPY tools tools
COPY apps apps
COPY ui ui

# apps/telemetry/node_modules is a symlink committed to git. It points at an absolute path on one
# developer's machine, and `bun install` fails on it (ELOOP). Remove it here, not in the repo.
RUN rm -f apps/telemetry/node_modules

RUN bun install --frozen-lockfile

# dist/ for every workspace package the server imports through its ESM `exports.import` condition.
RUN bun run build

# ui/web is a standalone Vite app (not a workspace member) with its own lockfile.
# It builds to ui/dist, which the server serves.
WORKDIR /app/ui/web
RUN bun install --frozen-lockfile && bun run build

WORKDIR /app/ui

# Safe defaults for a container: keep data on a volume, and never create the seeded `test` user
# (it has a password and a session token that are written in the source).
ENV PORT=4610 \
    ALINEO_UI_DATA_DIR=/data \
    ALINEO_UI_NO_TEST_USER=1
VOLUME /data
EXPOSE 4610

CMD ["bun", "server/index.ts"]
