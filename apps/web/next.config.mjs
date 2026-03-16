/** @type {import('next').NextConfig} */
const defaultApiOrigin = process.env.NODE_ENV === "development"
  ? "http://localhost:3000"
  : "https://api.fieldtrack.meowsician.tech";

const apiOrigin = process.env.API_DOMAIN
  ? (process.env.API_DOMAIN.startsWith("http://") || process.env.API_DOMAIN.startsWith("https://")
    ? process.env.API_DOMAIN
    : `https://${process.env.API_DOMAIN}`)
  : defaultApiOrigin;

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
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
