#!/bin/sh
set -e

# The alineo SDK reads `alineo.config.json` from the current working directory (WORKDIR /data,
# a volume). Generate it from the ALINEO_* env so the image needs no baked-in config.
: "${ALINEO_SERVER_URL:=http://host.docker.internal:8080}"
: "${ALINEO_USE_SERVER_PROXY:=true}"
: "${ALINEO_API_KEY:=}"

cat > /data/alineo.config.json <<EOF
{
  "serverUrl": "${ALINEO_SERVER_URL}",
  "useServerProxy": ${ALINEO_USE_SERVER_PROXY},
  "apiKey": "${ALINEO_API_KEY}",
  "adapterPath": "/data/sdk-anchor.db",
  "agentsDir": "/data/agents",
  "defaults": { "resources": { "cpu": "1000m", "memory": "1Gi" } }
}
EOF

mkdir -p /data/work /data/agents

echo "[alineod] serverUrl=${ALINEO_SERVER_URL} useServerProxy=${ALINEO_USE_SERVER_PROXY}"
exec "$@"
