import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    const backendBase = process.env.INTERNAL_API_BASE_URL || "http://backend:8080";
    return [
      {
        source: "/libs/:path*",
        destination: `${backendBase}/libs/:path*`,
      },
    ];
  },
};

export default nextConfig;
