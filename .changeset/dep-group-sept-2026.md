---
---

Bump nine dev dependencies as a group: `vitest` 5.0.0, `@changesets/cli` 3.0.2,
`@cloudflare/workers-types` 5.x, `oxfmt` 0.67, `tsdown` 0.23.0, `bun-types` and `@types/bun`
1.4.2, `eslint-config-next` 16.3.4, and `@earendil-works/pi-coding-agent` 0.85.1.

Two members of the original group are held back and tracked separately: `@flue/runtime` 2.x
needs an adapter change (`createSessionEnv` → `createSandbox`) that breaks the peer range, and
`typescript` 7 crashes `astro check` until `@astrojs/language-server` supports it.

No source changes and no published output changes, so this needs no release.
