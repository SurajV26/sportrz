import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow build verification without sharing generated files with a dev server.
  distDir: process.env.SPORTRZ_BUILD_DIR || ".next",
  images: {
    remotePatterns: [
      { hostname: "files.sportrz.com" },
      { hostname: "res.cloudinary.com" },
    ],
  },
};

export default nextConfig;
