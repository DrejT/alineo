import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  outDir: "dist",
  platform: "node",
  clean: true,
  deps: {
    neverBundle: ["alineo", "@alineo-labs/errors", "@modelcontextprotocol/server"],
  },
});
