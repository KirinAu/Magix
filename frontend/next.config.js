/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    const backendBase = process.env.INTERNAL_API_BASE_URL || "http://localhost:3001";
    return [
      {
        source: "/libs/:path*",
        destination: `${backendBase}/libs/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
