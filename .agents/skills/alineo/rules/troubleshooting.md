# Troubleshooting & Resources

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Server exits immediately with `DOCKER::INITIALIZATION_ERROR` | Docker Desktop socket not exposed inside the container | Ensure Docker Desktop is running; mount `/var/run/docker.sock` (not the Windows pipe) |
| `alineo init` times out with "did not become healthy within 60s" | Container crashes before health endpoint is ready | Check `docker logs alineo-opensandbox` — almost always a socket or config issue |
| `CommandError` with exit code 1 | A command run via `agent.bash()`/`agent.sandbox.exec()` failed inside the container | Check `.stderr` on the error object |
| `Alineo.resume()` fails to find the sandbox | `sandboxId` not in the adapter's ledger | Verify you're using the same adapter (same DB path) as the original `Alineo.start()`/`spawn()` |
| Sandbox creation fails underneath an agent spec | `resources` omitted or the server rejects CPU/memory limits | Always set `resources: { cpu, memory }` in the agent spec |
| `bun test` hangs after all tests pass | Unclosed DB handles or timers keep the event loop alive | `await db.close()` in `afterEach`; use `:memory:` in tests to avoid file handles |
| `SQLITE_CANTOPEN` on nested path | `bun:sqlite` doesn't mkdir parents | Constructor now calls `mkdirSync(dirname(path), { recursive: true })` |
| `alineo start`/`spawn`/`prompt` doesn't seem to touch a run you created via alineod's HTTP API | They're unrelated code paths | `start`/`spawn`/`prompt`/`steer` call `Alineo` directly; only alineod's own routes (`POST /runs`, etc.) act on alineod-tracked runs. See [CLI Reference § alineod](cli.md#alineod-the-swarm-daemon). |
| `alineo init` starts OpenSandbox fine but hangs/fails waiting for alineod | Bad/private GHCR image pull, or a stale `alineo-alineod` container from a previous run holding port 4600 | `docker logs alineo-alineod`; `docker ps -a --filter name=alineo-alineod` — remove a dead one with `docker rm -f alineo-alineod` and re-run `init` |
| A run through alineod stalls or an agent's turn comes back empty/garbled, but sandbox mechanics (start/spawn/pause/resume/steer) all look fine | Known free-tier NVIDIA NIM model flakiness — stalls or bad output on some turns, unrelated to alineod/SDK code | Not a bug to chase; see `apps/alineod/README.md`'s "Known issues". Prefer one `cat file1 file2` bash call over several separate `read`-tool calls in a spec's prompt — fewer turn boundaries, fewer chances to stall (see `cookbooks/swarm-code-review/index.ts`'s editor prompt for the pattern) |
| A run reports `success` but the agent produced nothing, or a turn comes back empty | An upstream model-API error (overload/503/404/timeout) ended the turn early, or a reasoning model streamed nothing past the 180 s inactivity timeout | Read the transcript, not just the status. Pin a model that streams promptly (`nemotron-3-super-120b-a12b` on NVIDIA; `lightning` is ~100 s/request) and re-measure with `apps/alineod/scripts/probe-models.ts` |
| A sandbox with `networkPolicy`/`credentialProxy` fails with "Egress sidecar did not become ready within 30s ... Connection refused" | The OpenSandbox server container probed the sidecar at its own `127.0.0.1` | Re-run `alineo init` (sets `host_ip = "host.docker.internal"` and `--add-host`, recreates the container). Egress options are also rejected under the gVisor runtime |
| An agent is `blocked` and nothing is happening | `onFailure: "ask"`/`"retry"` ran out, or `maxConsecutiveFailures` tripped | `POST /agents/:id/prompt` (optionally with corrective text) or `.../stop`; MCP `agent_prompt` / `agent_stop` |
| An agent came back after a container loss but has no memory of the conversation | The spec doesn't set `checkpoint: true`, so there was no turn checkpoint to restore | Set `checkpoint: true`. Files outside `/root` are never in a checkpoint |
| A docs/skill snippet fails with an unknown field or command | A stale name: `cli`→`harness`, `cliVersion`→`harnessVersion`, `Alineo.load`→`start`, **alineo fork**→`spawn`, **alineo kill**→`stop`, flat `exec_start`→`exec.started` | Check `packages/schema/src/agent-spec.ts` / `renames.ts` / `alineo --help` |
| `docker pull ghcr.io/drejt/alineod` fails for someone else | The GHCR package may be private (first push after a version bump can require a manual visibility flip) | Check `ghcr.io/drejt/alineod` package settings on GitHub; make it public |

## Resources

- OpenSandbox API reference: `https://deepwiki.com/opensandbox-group/OpenSandbox/`
- Pi agent CLI / RPC: `https://deepwiki.com/earendil-works/pi/`
- Architecture overview: `CLAUDE.md` at the repo root
- Durability contract: `/docs/alineod/concepts/durability-contract`
