import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * IMPORTANT:
 * Backend repositories must use supabaseServiceClient.
 * supabaseAnonClient is reserved for frontend access only.
 *
 * supabaseAnonClient — uses the ANON key. RLS is enforced by default.
 * Frontend clients only. Not used in backend repository queries.
 *
 * supabaseServiceClient — uses the SERVICE ROLE key. Bypasses RLS.
 * Required for all backend repository queries. Tenant isolation is
 * enforced in application code via enforceTenant() instead of RLS.
 *
 * Architecture:
 *   Frontend → supabaseAnonClient (RLS enforced)
 *   Backend  → supabaseServiceClient (RLS bypassed, enforceTenant() applied)
 *
 * Both clients are created lazily on first access so that importing this
 * module does not trigger env validation or network activity.
 */

let _anonClient: SupabaseClient | undefined;
let _serviceClient: SupabaseClient | undefined;

export const supabaseAnonClient: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    if (!_anonClient) {
      _anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    }
    return Reflect.get(_anonClient, prop, receiver);
  },
});

export const supabaseServiceClient: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    if (!_serviceClient) {
      _serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    }
    return Reflect.get(_serviceClient, prop, receiver);
  },
});
