import { z } from "zod";

const EnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().refine(
    (v) => v.startsWith("/") || z.string().url().safeParse(v).success,
    { message: "NEXT_PUBLIC_API_URL must be a valid URL or a root-relative path (e.g. /api/proxy)" }
  ),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url({ message: "NEXT_PUBLIC_SUPABASE_URL must be a valid URL" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, { message: "NEXT_PUBLIC_SUPABASE_ANON_KEY is required" }),
  NEXT_PUBLIC_MAPBOX_TOKEN: z.string().min(1, { message: "NEXT_PUBLIC_MAPBOX_TOKEN is required" }),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const result = EnvSchema.safeParse({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
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
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "",
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "",
  }) as Env;
}

/**
 * Validated, typed environment variables.
 * Throws at build/server time if any required variable is missing or invalid.
 */
export const env: Env = parseEnv();

/**
 * Re-run validation explicitly (e.g. in Providers for a browser-side warning).
 * No-op if the env is valid.
 */
export function validateEnv(): void {
  parseEnv();
}
