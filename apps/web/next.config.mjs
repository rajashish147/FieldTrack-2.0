/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["mapbox-gl", "@fieldtrack/types"],
  images: {
    domains: [],
  },
  async rewrites() {
    // Always expose a server-side proxy to avoid CORS issues on any deployment.
    // Set NEXT_PUBLIC_API_URL=/api/proxy in Vercel (or any non-localhost deploy)
    // so browser requests are same-origin and never trigger CORS preflight.
    return [
      {
        source: "/api/proxy/:path*",
        destination: "https://fieldtrack.meowsician.tech/:path*",
      },
    ];
  },
};

export default nextConfig;
