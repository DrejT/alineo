import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  outDir: "dist",
  platform: "node",
  clean: true,
  deps: {
    neverBundle: [
      "alineo",
      "@alineo-labs/sandbox",
      "@alineo-labs/sqlite",
      "@alineo-labs/opensandbox",
      "@opentui/core",
    ],
  },
});
