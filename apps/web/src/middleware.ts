import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";

/**
 * Auth + role middleware.
 * Runs on every matched route and:
 *  1. Redirects unauthenticated users to /login.
 *  2. Enforces role-based access for /admin routes — ADMIN role required.
 *     Employees attempting to access /admin are redirected to /sessions.
 *
 * Public routes (no auth required):
 *   /login, /_next/*, /favicon.ico, static assets
 *
 * Role-protected routes:
 *   /admin/** → requires role = "ADMIN" in user_metadata
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  if (!supabaseUrl || !supabaseAnonKey) {
    // Supabase not configured — allow through so env errors surface normally
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Refresh the session (also rotates the cookie if needed)
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { pathname } = request.nextUrl;

  // Already on the login page — don't redirect in a loop
  if (pathname.startsWith("/login")) {
    // If user is already authenticated, send them to the right landing page
    if (session) {
      return NextResponse.redirect(new URL("/sessions", request.url));
    }
    return response;
  }

  // Unauthenticated — redirect to login
  if (!session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-based protection for /admin routes.
  // The role is stored in user_metadata (set by the backend when creating users).
  // This prevents non-admin users from ever rendering admin pages — not just from
  // reaching the API. The API enforces role independently at every endpoint.
  if (pathname.startsWith("/admin")) {
    const role = session.user?.user_metadata?.role as string | undefined;
    if (role !== "ADMIN") {
      // Redirect employees and unknown roles away from admin pages.
      return NextResponse.redirect(new URL("/sessions", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT:
     *  - _next/static  (static files)
     *  - _next/image   (image optimisation)
     *  - favicon.ico
     *  - public assets (png, jpg, svg, etc.)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|css|js)).*)",
  ],
};
