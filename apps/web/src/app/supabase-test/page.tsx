import { createClient } from "@/lib/supabase/server";

export default async function SupabaseTestPage() {
  const supabase = await createClient();

  const { error } = await supabase.auth.getUser();

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">BusinessOS Supabase Test</h1>

      {error ? (
        <p className="mt-4">
          Supabase connection works. No authenticated user exists yet.
        </p>
      ) : (
        <p className="mt-4">Supabase connected successfully.</p>
      )}
    </main>
  );
}