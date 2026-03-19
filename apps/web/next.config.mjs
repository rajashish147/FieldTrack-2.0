/** @type {import('next').NextConfig} */

// Validate API origin - fail fast if invalid
function validateApiOrigin(origin) {
  if (!origin || typeof origin !== 'string') {
    throw new Error('API_DOMAIN must be a valid string');
  }
  
  // Must be a valid URL or relative path
  if (!origin.startsWith('http://') && !origin.startsWith('https://') && !origin.startsWith('/')) {
    throw new Error(`Invalid API_DOMAIN: ${origin}. Must start with http://, https://, or /`);
  }
  
  return origin;
}

const defaultApiOrigin = process.env.NODE_ENV === "development"
  ? "http://localhost:3000"
  : (() => {
      const url = process.env.NEXT_PUBLIC_API_URL;
      if (!url) {
        throw new Error(
          "NEXT_PUBLIC_API_URL is required in production.\n" +
          "Set it to your API base URL (e.g. https://api.getfieldtrack.app).\n" +
          "For local development, set NODE_ENV=development or set the variable explicitly."
        );
      }
      return url;
    })();

const apiOrigin = process.env.API_DOMAIN
  ? (process.env.API_DOMAIN.startsWith("http://") || process.env.API_DOMAIN.startsWith("https://")
    ? validateApiOrigin(process.env.API_DOMAIN)
    : validateApiOrigin(`https://${process.env.API_DOMAIN}`))
  : defaultApiOrigin;

const nextConfig = {
  transpilePackages: ["mapbox-gl", "@fieldtrack/types"],
  images: {
    domains: [],
    // Mitigate GHSA-3x4c-7xq6-9pq8 (unbounded Next.js image disk cache growth).
    // Limit format variants and enforce TTL so stale image cache entries expire.
    // Full fix: upgrade to next@>=16.1.7 when breaking changes are reviewed.
    formats: ["image/webp"],
    minimumCacheTTL: 3600,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${apiOrigin} https://*.supabase.co; frame-ancestors 'self';`,
          },
        ],
      },
    ];
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
