import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  reactCompiler: true,
  // Static export has no Image Optimization server. Serve images as-is — the docs are
  // mostly text, and blog assets (PNG covers, animated GIF demos) don't want reprocessing.
  images: { unoptimized: true },
};

export default withMDX(nextConfig);
