import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  site: "https://sandbox.alineo.tech",
  vite: {
    plugins: [tailwindcss()],
  },
});
