---
---

`apps/sandbox` only, no publishable package changes: add the `Dockerfile` (+ root
`.dockerignore`) used to build and deploy the sandbox API as a container, matching what's
now actually running in production. Builds from the repo root so workspace deps (`alineo`,
`@alineo-labs/{core,sandbox,sqlite}`) resolve via their `exports.import` dist/ build output,
same as CI's "Build all packages" step.
