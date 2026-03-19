/**
 * url.ts — URL normalisation utilities for FieldTrack 2.0.
 *
 * These utilities operate on plain strings and carry no external dependencies,
 * which keeps them safe to import from config/env.ts at module-load time
 * without creating circular references.
 *
 * Separation of concerns:
 *   url.ts            — normalises developer/operator-supplied config URLs.
 *   url-validator.ts  — validates user-supplied webhook URLs against SSRF threats.
 *
 * Keep both files focused on their own concern; do not merge them.
 */

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Strip trailing slash(es) from a URL string.
 *
 * Environment variables for base URLs are frequently set with a trailing slash
 * by operators who are used to writing directory-style paths.  Leaving the
 * slash in place causes silent double-slash bugs whenever a path segment is
 * concatenated:
 *
 *   // Without normalisation ❌
 *   const base = "https://api.fieldtrack.com/"; // operator supplied
 *   const url  = `${base}/v1/users`;            // → "…com//v1/users"
 *
 *   // With normalisation ✅
 *   const base = normalizeUrl("https://api.fieldtrack.com/"); // → "…com"
 *   const url  = `${base}/v1/users`;                         // → "…com/v1/users"
 *
 * The function is idempotent and handles any number of trailing slashes.
 * It never modifies path segments that happen to contain slashes in the
 * middle of the URL (the regex anchors to the end of the string).
 *
 * @param url - A raw URL string, typically sourced from an environment variable.
 * @returns   The same URL with all trailing slashes removed.
 *
 * @example
 *   normalizeUrl("https://api.fieldtrack.com")    // → "https://api.fieldtrack.com"
 *   normalizeUrl("https://api.fieldtrack.com/")   // → "https://api.fieldtrack.com"
 *   normalizeUrl("https://api.fieldtrack.com///") // → "https://api.fieldtrack.com"
 *   normalizeUrl("http://localhost:3000/")         // → "http://localhost:3000"
 */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
