#!/bin/sh
set -e

# Container-specific paths, passed as inline config rather than written to a file.
#
# `serverUrl`, `useServerProxy` and `apiKey` are deliberately NOT interpolated here:
# @alineo-labs/config-shared reads ALINEO_SERVER_URL / ALINEO_USE_SERVER_PROXY /
# ALINEO_API_KEY straight from the environment, and environment beats
# ALINEO_CONFIG_CONTENT, so they override the values below with no quoting involved.
# The previous version pasted ${ALINEO_USE_SERVER_PROXY} unquoted into JSON, where any
# value that wasn't literally `true`/`false` produced a broken config file.
: "${ALINEO_SERVER_URL:=http://host.docker.internal:8080}"
: "${ALINEO_USE_SERVER_PROXY:=true}"
export ALINEO_SERVER_URL ALINEO_USE_SERVER_PROXY

export ALINEO_CONFIG_CONTENT='{
  "adapterPath": "/data/sdk-anchor.db",
  "agentsDir": "/data/agents",
  "defaults": { "resources": { "cpu": "1000m", "memory": "1Gi" } }
}'

mkdir -p /data/work /data/agents

echo "[alineod] serverUrl=${ALINEO_SERVER_URL} useServerProxy=${ALINEO_USE_SERVER_PROXY}"
exec "$@"
