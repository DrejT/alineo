# @alineo-labs/registry

Curated `AgentSpec` examples for `bunx alineo-cli add`, deployed to [registry.drej.dev](https://registry.drej.dev).

This is not a required central service — `alineo add` accepts any URL that returns an `AgentSpec` JSON object (GitHub raw file, Gist, your own server). This site just hosts a small, searchable set of starter specs plus the schema they conform to.

## Structure

```
public/
  agents/*.json    — example AgentSpec files, served at /agents/<name>.json
  spec/agent.json  — the AgentSpec JSON Schema, served at /spec/agent.json
src/
  pages/index.astro   — reads public/agents/*.json at build time, renders a searchable list + JSON preview
  components/Nav.astro
  layouts/Base.astro
  styles/global.css
```

Adding a new example: drop an `AgentSpec` JSON file into `public/agents/`, matching the schema at `public/spec/agent.json` — the index page picks it up automatically on next build.

## Commands

```bash
bun run dev      # astro dev
bun run build    # astro build -> dist/
bun run preview  # preview the production build locally
bun run deploy   # build + wrangler pages deploy (project: drej-registry)
```
