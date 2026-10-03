import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  server: { port: 4321 },
  // The toolbar's own keyboard shortcuts intercept keystrokes meant for the live terminal
  // (xterm) on sandbox detail pages — off for this app rather than fought around.
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: process.env.ALINEOD_URL ?? "http://127.0.0.1:4600",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          ws: true,
        },
      },
    },
  },
});
