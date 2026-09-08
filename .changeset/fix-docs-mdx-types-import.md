---
---

Docs site only: drop the `import type { MDXComponents } from "mdx/types"` in
`src/lib/mdx-components.tsx` (added in #246). `@types/mdx` isn't in `apps/docs`'s
dependency tree, so `next build`'s type check couldn't resolve it on a clean
install and the docs deploy failed. The inferred type is fine.
