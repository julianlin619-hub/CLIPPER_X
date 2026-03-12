import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "500mb",
    },
  },
  httpAgentOptions: {
    keepAlive: true,
  },
  allowedDevOrigins: ["julians-mac-mini.tail8538b4.ts.net"],
};

export default nextConfig;
