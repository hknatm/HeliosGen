import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

let cloudClient: SupabaseClient | undefined;
let localClient: SupabaseClient | undefined;

function createLocalClient(): SupabaseClient {
  if (localClient) return localClient;

  const noSession = { data: { session: null } };
  const noUser = { data: { user: null } };
  const subscription = { unsubscribe() {} };

  localClient = {
    auth: {
      getSession: async () => noSession,
      getUser: async () => noUser,
      onAuthStateChange: () => ({ data: { subscription } }),
      signOut: async () => ({ error: null }),
      setSession: async () => noSession,
      signInWithPassword: async () => ({ ...noSession, error: new Error("Authentication is disabled in local mode.") }),
      signUp: async () => ({ ...noSession, error: new Error("Authentication is disabled in local mode.") }),
      resetPasswordForEmail: async () => ({ data: {}, error: new Error("Authentication is disabled in local mode.") }),
      updateUser: async () => ({ ...noUser, error: new Error("Authentication is disabled in local mode.") }),
    },
  } as unknown as SupabaseClient;

  return localClient;
}

export function createClient(): SupabaseClient {
  if (IS_LOCAL_MODE) return createLocalClient();
  if (!cloudClient) {
    cloudClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return cloudClient;
}
