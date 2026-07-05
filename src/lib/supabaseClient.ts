import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
