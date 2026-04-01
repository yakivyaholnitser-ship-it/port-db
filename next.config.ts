import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb", // ⬅️ увеличиваем лимит тела запроса
    },
  },
};

export default nextConfig;
