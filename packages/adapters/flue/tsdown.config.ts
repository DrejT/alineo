import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  platform: "node",
  clean: true,
  deps: { neverBundle: ["@flue/runtime", "@alineo-labs/sandbox"] },
});
