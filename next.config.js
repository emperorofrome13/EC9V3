/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  distDir: process.env.EC9V3_NEXT_DIST_DIR || '.next',
}

module.exports = nextConfig
