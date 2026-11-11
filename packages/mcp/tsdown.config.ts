import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/lib.ts"],
  format: ["esm"],
  dts: { entry: ["src/lib.ts"] },
  outDir: "dist",
  platform: "node",
  clean: true,
  deps: {
    neverBundle: ["alineo", "@alineo-labs/errors", "@modelcontextprotocol/server"],
  },
});
