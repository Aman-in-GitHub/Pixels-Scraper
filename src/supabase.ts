import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@supabase/supabase-js";

let supabase: SupabaseClient;

try {
  supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
} catch (error) {
  throw new Error(`Supabase client initialization failed: ${error}`);
}

export { supabase };
