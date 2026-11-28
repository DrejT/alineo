# hosted-mcp

Serve `alineo-mcp` over HTTP to more than one person. Each person has their own key, and each sees only
their own runs, agents and memory.

```text
alice ─┐                                       ┌─ tenant "alice"
       ├─ alineo-mcp --http ── alineod ────────┤
bob ───┘   (forwards each caller's key)        └─ tenant "bob"
```

There are two files, one for each side:

- **`serve.ts`** is the operator's side. It starts alineod with `startDaemon()` and an `authenticate`
  function that maps a key to a tenant, an env allowlist and per-tenant limits. Then it serves
  `alineo-mcp` over streamable HTTP in front of alineod. The MCP holds no credential: it forwards each
  caller's `Authorization` header, and alineod decides who the caller is.
- **`index.ts`** is the users' side. Alice and Bob connect as two MCP clients. Alice starts a run, and
  Bob tries to see it.

What `index.ts` checks:

1. A request to the MCP with no key gets `401`.
2. Alice validates a spec with `spec_add`. This server keeps no specs, so she passes the returned spec on.
3. Alice starts a run with `run_start`.
4. Bob's `run_list` does not show her run. Her run id and agent id are `404` to him, the same as an id
   that does not exist.
5. Alice reads her agent's answer with `result_get`.
6. Alice lists her run and closes it with `run_stop`.

## Setup

```bash
bunx alineo-cli init                 # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build         # from the repo root
bun run --cwd packages/mcp build     # serve.ts imports alineo-mcp's built server
```

Start the server in its own terminal, with your NVIDIA key (free at
[build.nvidia.com](https://build.nvidia.com)) in **its** environment:

```bash
cd cookbooks/hosted-mcp
NVIDIA_API_KEY=nvapi-... bun run serve
```

alineod listens on `:4601` and the MCP on `http://127.0.0.1:4700/mcp`. `ALINEOD_PORT` and `MCP_PORT`
change them. The demo keys are `alice-demo-key` and `bob-demo-key`. Set
`TEAM_KEYS=alice=<key>,bob=<key>` to choose your own, and pass the same keys to `index.ts` as
`ALICE_KEY` and `BOB_KEY`.

## Run

```bash
bun start
```

A run takes one to two minutes: one sandbox and one short model turn.

## Point a chat client at it

Any MCP client that speaks streamable HTTP can use the server. For Claude Code:

```bash
claude mcp add --transport http alineo http://127.0.0.1:4700/mcp \
  --header "Authorization: Bearer alice-demo-key"
```

## Before you serve it to strangers

This recipe is for a team you trust. The spec passes the model key as a plain env value, so each
agent can read the key inside its sandbox. That is acceptable for your own team. For people you do
not trust, read [Keep secrets out of specs](https://docs.alineo.tech/docs/alineod/deployment#keep-secrets-out-of-specs)
and [Network isolation is part of the security model](https://docs.alineo.tech/docs/alineod/deployment#network-isolation-is-part-of-the-security-model)
first. Put TLS in front of both ports, and keep alineod's port private to the MCP.
