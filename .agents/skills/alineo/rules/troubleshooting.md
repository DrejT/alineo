# Troubleshooting & Resources

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Server exits immediately with `DOCKER::INITIALIZATION_ERROR` | Docker Desktop socket not exposed inside the container | Ensure Docker Desktop is running; mount `/var/run/docker.sock` (not the Windows pipe) |
| `alineo init` times out with "did not become healthy within 60s" | Container crashes before health endpoint is ready | Check `docker logs alineo-opensandbox` — almost always a socket or config issue |
| `CommandError` with exit code 1 | A command run via `agent.bash()`/`agent.sandbox.exec()` failed inside the container | Check `.stderr` on the error object |
| `Alineo.resume()` fails to find the sandbox | `sandboxId` not in the adapter's ledger | Verify you're using the same adapter (same DB path) as the original `Alineo.load()`/`spawn()` |
| Sandbox creation fails underneath an agent spec | `resources` omitted or the server rejects CPU/memory limits | Always set `resources: { cpu, memory }` in the agent spec |
| `bun test` hangs after all tests pass | Unclosed DB handles or timers keep the event loop alive | `await db.close()` in `afterEach`; use `:memory:` in tests to avoid file handles |
| `SQLITE_CANTOPEN` on nested path | `bun:sqlite` doesn't mkdir parents | Constructor now calls `mkdirSync(dirname(path), { recursive: true })` |

## Resources

- OpenSandbox API reference: `https://deepwiki.com/opensandbox-group/OpenSandbox/`
- Pi agent CLI / RPC: `https://deepwiki.com/earendil-works/pi/`
- Architecture overview: `CLAUDE.md` at the repo root
