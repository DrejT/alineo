# alineod — the swarm control daemon (prototype).
#
# Build from the REPO ROOT (it needs the whole monorepo to build the SDK it depends on):
#   docker build -f apps/alineod/Dockerfile -t alineod .
#
# Run (reaching an OpenSandbox on the host):
#   docker run --rm -p 4600:4600 \
#     --add-host host.docker.internal:host-gateway \
#     -e ALINEO_SERVER_URL=http://host.docker.internal:8080 \
#     -e NVIDIA_API_KEY=nvapi-... \
#     -v alineod-data:/data \
#     alineod
#
# The container talks to OpenSandbox over HTTP; it does NOT need the Docker socket
# (OpenSandbox owns container creation). In server-proxy mode, OpenSandbox's own
# `eip` must be routable from this container — see apps/alineod/README.md.

# ---- build: install + build the workspace packages alineod imports ----
FROM oven/bun:1 AS build
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile \
 && bun run build

# ---- runtime ----
FROM oven/bun:1
WORKDIR /data

# Only what the daemon actually needs at runtime: the root deps, the built
# packages, and the app itself. (apps/docs, examples/, tests/ etc. are dropped.)
COPY --from=build /app/node_modules      /app/node_modules
COPY --from=build /app/package.json      /app/bun.lock /app/
COPY --from=build /app/packages          /app/packages
COPY --from=build /app/apps/alineod      /app/apps/alineod

COPY apps/alineod/docker-entrypoint.sh   /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R bun:bun /data

ENV ALINEOD_PORT=4600 \
    ALINEOD_DB_PATH=/data/alineod.db \
    ALINEOD_SDK_LEDGER_PATH=/data/alineod-sdk-ledger.db \
    ALINEOD_WORK_DIR=/data/work \
    ALINEO_SERVER_URL=http://host.docker.internal:8080 \
    ALINEO_USE_SERVER_PROXY=true

USER bun
VOLUME /data
EXPOSE 4600

# The entrypoint writes /data/alineo.config.json from the ALINEO_* env, then execs the CMD.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "/app/apps/alineod/server.ts"]
