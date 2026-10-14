import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  platform: "node",
  clean: true,
  deps: { neverBundle: ["@alineo-labs/errors", "@alineo-labs/logger", "@alineo-labs/provider"] },
});
