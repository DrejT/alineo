---
---

Bump `vitest` to 4.1.11 across every package that pins it — `core`, `opensandbox`, `workflow`,
`memory`, and `sdks/typescript` — closing the path-traversal / arbitrary-file-read advisory in
`@vitest/mocker` affecting 2.1.0–4.1.10. `vitest` is a devDependency, so published output is
unchanged and no release is needed.
