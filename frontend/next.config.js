/** @type {import('next').NextConfig} */
const nextConfig = {
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

module.exports = nextConfig;
