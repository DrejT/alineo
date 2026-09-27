import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries, not one. `types` carries shapes with no Zod in the graph, so a package like
  // `@alineo-labs/core` — which has no validator dependency and wants none — can take the
  // envelope's type under `import type` and have it erase at compile time. The root entry adds
  // the Zod schemas for everything that validates at a boundary.
  // A third entry for alineod's wire contract, rather than 25 more names on the root. Its
  // `AgentSpec` would collide with `agent-spec.ts`'s, and a consumer that only wants the
  // vocabulary has no business importing a daemon's request bodies.
  entry: ["src/index.ts", "src/types.ts", "src/alineod.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  platform: "node",
  clean: true,
});
