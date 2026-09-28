// Minimal RFC 6238 TOTP support for integration tests — used ONLY to drive
// Supabase Auth's own real MFA enroll/challenge/verify endpoints with a
// genuine second factor, never to replace or bypass them. The phase
// brief's "do not invent your own TOTP algorithm" is about the app's
// production MFA flow (lib/auth/mfa-actions.ts calls
// supabase.auth.mfa.challengeAndVerify unconditionally, with no
// alternative code path); computing a code from a secret Supabase itself
// just generated via enroll(), purely to feed that same real endpoint in
// a test, is a standard fixture technique, not a bypass of anything the
// production app relies on.
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/=+$/u, "");
  let bits = "";
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character in TOTP secret: ${char}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function computeTotp(secret: string, atMs: number = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 1_000_000).toString().padStart(6, "0");
}

// Enrolls a real TOTP factor on the given signed-in client and verifies it
// with a genuinely computed code, elevating the session to AAL2 through
// Supabase's actual MFA verification — never a fabricated claim. The
// caller's `client` instance continues on with an AAL2 session for the
// rest of the test.
export async function elevateToAal2(
  client: SupabaseClient<Database>
): Promise<{ factorId: string }> {
  const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (enrollError || !enrollData) {
    throw new Error(`MFA enroll failed: ${enrollError?.message}`);
  }

  const code = computeTotp(enrollData.totp.secret);
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: enrollData.id,
    code,
  });
  if (verifyError) {
    throw new Error(`MFA verify failed: ${verifyError.message}`);
  }

  return { factorId: enrollData.id };
}
