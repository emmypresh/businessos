import { createClient } from "@/lib/supabase/server";

export default async function SupabaseTestPage() {
  const supabase = await createClient();

  const { error } = await supabase.auth.getUser();

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">
        BusinessOS Supabase Test
      </h1>

      <p className="mt-4">
        {error
          ? "Supabase connection works. No authenticated user exists yet."
          : "Supabase connected successfully."}
      </p>
    </main>
  );
}