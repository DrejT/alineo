# apps

Deployable sites for alineo, separate from the publishable SDK packages in `packages/`.

| App                    | Description                                                                                    | Stack              | Deploy                             |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| [`docs`](docs)         | Documentation site ([docs.drej.dev](https://docs.drej.dev))                                    | Next.js + Fumadocs | Cloudflare Pages (`drej-docs`)     |
| [`registry`](registry) | Curated `AgentSpec` examples for `alineo add` ([registry.drej.dev](https://registry.drej.dev)) | Astro              | Cloudflare Pages (`drej-registry`) |

## Commands

Each app is run from its own directory:

```bash
cd apps/<app> && bun run dev      # start dev server
cd apps/<app> && bun run build    # production build
cd apps/<app> && bun run deploy   # build + wrangler pages deploy
```

## Registry structure

`apps/registry/public/agents/*.json` holds the example `AgentSpec` files served at `registry.drej.dev/agents/*.json`. The JSON Schema for `AgentSpec` lives at `apps/registry/public/spec/agent.json`, served at `registry.drej.dev/spec/agent.json`.
