/** @type {import('next').NextConfig} */

// NEXT_PUBLIC_API_BASE_URL controls how the browser reaches the backend.
//
// Mode A — Direct (recommended for Vercel):
//   NEXT_PUBLIC_API_BASE_URL=https://api.getfieldtrack.app
//   Browser calls the API directly; no server-side proxy is involved.
//
// Mode B — Server-side proxy (avoids CORS, hides API origin from browser):
//   NEXT_PUBLIC_API_BASE_URL=/api/proxy
//   API_DESTINATION_URL=https://api.getfieldtrack.app   ← server-only, never baked into JS
//   Browser calls /api/proxy/:path*, Next.js rewrites to API_DESTINATION_URL/:path*.
//   API_DESTINATION_URL MUST be set when using proxy mode or the rewrite has no destination.
//
// CI placeholder builds may use NEXT_PUBLIC_API_BASE_URL=/api/proxy without
// API_DESTINATION_URL — this is fine because no real requests are made during `next build`.

const NEXT_PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const API_DESTINATION_URL = process.env.API_DESTINATION_URL ?? "";

const apiIsFullUrl = /^https?:\/\//.test(NEXT_PUBLIC_API_BASE_URL);
const destinationIsFullUrl = /^https?:\/\//.test(API_DESTINATION_URL);

// In direct mode, extract the origin from NEXT_PUBLIC_API_BASE_URL.
// In proxy mode, extract it from API_DESTINATION_URL (server-only var).
// Used for CSP and as the rewrite destination.
const apiOrigin = apiIsFullUrl
  ? new URL(NEXT_PUBLIC_API_BASE_URL).origin
  : destinationIsFullUrl
    ? new URL(API_DESTINATION_URL).origin
    : "";

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
    const connectSources = [
      "'self'",
      "https://*.supabase.co",      // Supabase auth, realtime, storage
      "https://*.tiles.mapbox.com", // Mapbox raster / vector tiles
      "https://api.mapbox.com",     // Mapbox geocoding, directions, styles
      "https://events.mapbox.com",  // Mapbox telemetry
    ];
    // Only add the API origin when it is a full URL — same-origin requests
    // (/api/proxy path) are already covered by 'self' above.
    // In proxy mode, apiOrigin is derived from API_DESTINATION_URL (server-only) so
    // it is NOT embedded in the client bundle, but it IS the rewrite destination.
    if (apiOrigin) {
      connectSources.push(apiOrigin);
    }

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              // blob: required for Mapbox GL sprite / image atlas
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              // Mapbox GL v3 spawns blob: Web Workers for tile decoding
              "worker-src blob:",
              "child-src blob:",
              `connect-src ${connectSources.join(" ")}`,
              "frame-ancestors 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
  async rewrites() {
    // The /api/proxy rewrite forwards browser requests to the real backend.
    //
    // In direct mode (NEXT_PUBLIC_API_BASE_URL = full URL):
    //   apiOrigin is derived from that URL — rewrite is available as a convenience
    //   but the client calls the API directly and never hits /api/proxy.
    //
    // In proxy mode (NEXT_PUBLIC_API_BASE_URL = /api/proxy):
    //   apiOrigin is derived from API_DESTINATION_URL — the rewrite is REQUIRED
    //   because the browser sends every request to /api/proxy/:path*.
    //   Without it, Next.js returns a 404 HTML page and all JSON parsing fails.
    //
    // When no destination is resolvable (e.g. CI placeholder builds) the rewrite
    // is skipped — this is safe because no real requests are made during `next build`.
    if (!apiOrigin) return [];
    return [
      {
        source: "/api/proxy/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
