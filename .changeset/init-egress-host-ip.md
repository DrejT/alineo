---
"alineo-cli": patch
"alineo-mcp": patch
---

`alineo init` now sets up the OpenSandbox server so a sandbox with a `networkPolicy` or
`credentialProxy` can start.

Before, a sandbox with a `networkPolicy` failed with `Egress sidecar did not become ready within
30s … Connection refused` although the sidecar was healthy. The server runs in a container and, with
no `[docker].host_ip`, probed the sidecar at its own `127.0.0.1`. `init` now writes
`host_ip = "host.docker.internal"` and starts the container with
`--add-host host.docker.internal:host-gateway`. A `server.toml` from an earlier `init` gets the
line added, and the OpenSandbox container is recreated to match (its snapshot db is in a bind
mount, so nothing is lost).

`init` also pulls `opensandbox/server:latest` when it creates the container. `docker run` reuses an
image already on disk, however old, and an old `latest` can mismatch the pinned egress image.

The docs now say that `networkPolicy` and `credentialProxy` are rejected by a server using the
gVisor runtime.
