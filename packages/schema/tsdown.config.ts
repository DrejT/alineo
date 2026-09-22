import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries, not one. `types` carries shapes with no Zod in the graph, so a package like
  // `@alineo-labs/core` — which has no validator dependency and wants none — can take the
  // envelope's type under `import type` and have it erase at compile time. The root entry adds
  // the Zod schemas for everything that validates at a boundary.
  entry: ["src/index.ts", "src/types.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  platform: "node",
  clean: true,
});
