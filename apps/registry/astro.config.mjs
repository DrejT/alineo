import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  site: "https://registry.alineo.tech",
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
