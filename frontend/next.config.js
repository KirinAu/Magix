/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/libs/:path*",
        destination: "http://localhost:3001/libs/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
