# CLI Reference (`alineo-cli`)

Run via `bunx alineo-cli <command>` or `alineo <command>` after global install.

| Command | What it does |
|---|---|
| `alineo init` | Start OpenSandbox in Docker, write `alineo.config.json` |
| `alineo agents` | List running agent sessions (ledger + live control-plane) |
| `alineo spawn <spec>` | Load a fresh agent sandbox from a spec file |
| `alineo prompt <id> <msg>` | Resume an agent and send one prompt |
| `alineo fork <name> <spec>` | Attach to a live sandbox and spawn a child agent |
| `alineo kill <id>` | Close a sandbox by ID |
| `alineo logs <name>` | Print ledger events for a session |
| `alineo add <url>` | Fetch and save an agent spec locally |
| `alineo list` | List saved agent specs |
| `alineo remove <name>` | Delete a saved agent spec |

#### Config files

| File | Location | Purpose |
|---|---|---|
| `alineo.config.json` | Project root | `serverUrl`, `useServerProxy`, `adapterPath`, `defaults.resources` |
| `~/.config/alineo/server.toml` | Global | OpenSandbox server config (written by `alineo init`) |
