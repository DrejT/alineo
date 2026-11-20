import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `bun run build` writes to ../dist, which the control-plane server serves.
// `bun run dev` proxies the API to the server on :4600.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4600", "/health": "http://localhost:4600" },
  },
});
