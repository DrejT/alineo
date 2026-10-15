import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    outDir: "dist",
    platform: "node",
    clean: false,
    deps: {
      neverBundle: [
        "@alineo-labs/core",
        "@alineo-labs/logger",
        "@alineo-labs/sandbox",
        "@alineo-labs/sqlite",
      ],
    },
  },
  // The in-sandbox bridge and the Pi permission-gate extension. Each is one self-contained
  // file that runs in the sandbox with plain `node`, outside any package, so nothing may stay
  // external. `adapters/pi.ts` reads them at runtime from beside `index.mjs` (or from `dist/`
  // when running from `src/`). Nothing cleans `dist` here: the `build` script empties it first,
  // because the three configs run in parallel and a clean in one would race the others.
  {
    entry: { "pi-bridge": "src/bridge/pi-bridge.ts" },
    format: ["cjs"],
    platform: "node",
    outDir: "dist",
    clean: false,
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
  {
    entry: { "pi-permission-gate": "src/bridge/pi-permission-gate.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist",
    clean: false,
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
]);
