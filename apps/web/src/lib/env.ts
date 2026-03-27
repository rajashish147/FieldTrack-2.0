import { z } from "zod";

const EnvSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z
    .string()
    .min(1, { message: "NEXT_PUBLIC_API_BASE_URL is required. Do not use the deprecated NEXT_PUBLIC_API_URL." })
    .refine(
      (v) => v.startsWith("/") || z.string().url().safeParse(v).success,
      { message: "NEXT_PUBLIC_API_BASE_URL must be a valid absolute URL or the proxy path /api/proxy." }
    ),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url({ message: "NEXT_PUBLIC_SUPABASE_URL must be a valid URL" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, { message: "NEXT_PUBLIC_SUPABASE_ANON_KEY is required" }),
  NEXT_PUBLIC_MAPBOX_TOKEN: z.string().min(1, { message: "NEXT_PUBLIC_MAPBOX_TOKEN is required" }),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  // Hard fail: only NEXT_PUBLIC_API_BASE_URL is accepted.
  // The legacy NEXT_PUBLIC_API_URL fallback has been removed.
  // Update your Vercel project settings if you still have the old variable name.
  if (!process.env.NEXT_PUBLIC_API_BASE_URL) {
    const message =
      "[FieldTrack] NEXT_PUBLIC_API_BASE_URL is required. " +
      "Do not use the deprecated NEXT_PUBLIC_API_URL. " +
      "Set NEXT_PUBLIC_API_BASE_URL in your Vercel project settings or .env.local.";
    if (typeof window === "undefined") {
      throw new Error(message);
    } else {
      console.error(message);
    }
  }

  const result = EnvSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
  });

  if (!result.success) {
    const message =
      "[FieldTrack] Invalid environment variables:\n" +
      result.error.issues
        .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
        .join("\n") +
      "\nCopy .env.example to .env.local and fill in the values.";

    if (typeof window === "undefined") {
      // Server / build — fail fast so a broken deploy is caught immediately
      throw new Error(message);
    } else {
      // Browser — warn loudly but don't crash the UI
      console.error(message);
    }
  }

  // Return whatever we have; missing fields fall back to "" in the browser
  return (result.success ? result.data : {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "",
  }) as Env;
}

/**
 * Validated, typed environment variables.
 * Frozen at module load — mutations are silently ignored in non-strict JS
 * and throw in strict mode, preventing accidental runtime overrides.
 * Throws at build/server time if any required variable is missing or invalid.
 */
export const env: Readonly<Env> = Object.freeze(parseEnv());

/**
 * Build-time / startup validation.
 * Throws if NEXT_PUBLIC_API_BASE_URL is missing or not an absolute URL (or proxy path).
 * Call this from Providers so a misconfigured deploy fails loudly on first render.
 */
export function validateEnv(): void {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;

  if (!url) {
    throw new Error(
      "[FieldTrack] Missing NEXT_PUBLIC_API_BASE_URL. " +
      "Set it in Vercel project settings or .env.local."
    );
  }

  // In proxy mode the value is a path like /api/proxy — that is intentional.
  // In all other cases it must be an absolute HTTP(S) URL.
  const isProxyPath = url.startsWith("/");
  if (!isProxyPath && !url.startsWith("http")) {
    throw new Error(
      `[FieldTrack] NEXT_PUBLIC_API_BASE_URL must be an absolute URL (https://...) ` +
      `or the proxy path /api/proxy. Got: "${url}"`
    );
  }
}
