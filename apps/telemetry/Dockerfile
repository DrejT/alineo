# Standalone by design, and this keeps it that way: the build context is `apps/telemetry`
# alone, not the monorepo root. This app has no workspace dependencies — see `db.ts`'s note on
# why its event interface is duplicated rather than imported — so nothing outside this
# directory is needed to build or run it, and the image cannot quietly grow one.
FROM oven/bun:1.3.9-alpine

WORKDIR /app

# No `bun install`: package.json lists only bun-types and typescript, both build-time only.
# Copying it anyway keeps `bun` from walking up looking for one, and records the app's identity
# in the image.
COPY package.json ./
COPY config.ts db.ts server.ts ./
COPY routes ./routes
COPY migrate-command-names.ts ./

# The database lives on a mount, not in the image layer — see docker-compose.yml. Created here
# so the path exists even if someone runs the image with no mount at all, in which case the
# data is ephemeral and that is at least obvious rather than a crash.
RUN mkdir -p /app/data
ENV TELEMETRY_DB_PATH=/app/data/telemetry.db
ENV PORT=3002

EXPOSE 3002

# `/health` is a plain 200 from Bun.serve with no database access, so this proves the process
# is listening, not that the database is writable. Compose restarts on failure either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/health || exit 1

CMD ["bun", "server.ts"]
