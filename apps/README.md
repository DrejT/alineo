# apps

Deployable sites for alineo, separate from the publishable SDK packages in `packages/`.

| App                    | Description                                                                                          | Stack              | Deploy                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| [`docs`](docs)         | Documentation site ([docs.alineo.tech](https://docs.alineo.tech))                                    | Next.js + Fumadocs | Cloudflare Pages (`alineo-docs`)   |
| [`registry`](registry) | Curated `AgentSpec` examples for `alineo add` ([registry.alineo.tech](https://registry.alineo.tech)) | Astro              | Cloudflare Pages (`drej-registry`) |

## Commands

Each app is run from its own directory:

```bash
cd apps/<app> && bun run dev      # start dev server
cd apps/<app> && bun run build    # production build
cd apps/<app> && bun run deploy   # build + wrangler pages deploy
```

## Registry structure

`apps/registry/public/agents/*.json` holds the example `AgentSpec` files served at `registry.alineo.tech/agents/*.json`. The JSON Schema for `AgentSpec` lives at `apps/registry/public/spec/agent.json`, served at `registry.alineo.tech/spec/agent.json`.
