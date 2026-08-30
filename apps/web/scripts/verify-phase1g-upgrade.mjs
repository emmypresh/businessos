#!/usr/bin/env node
// Phase 1G, Medium 1 + ACL-environment-normalization — REAL upgrade-path
// verification.
//
// Medium 1 was specifically an UPGRADE bug: a pre-existing (Phase 1F)
// secondary branch with a valid, maximum-length (100-character) name broke
// when the Phase 1G migrations ran against it, because the naive
// `branch.name || ' Store'` derivation could exceed
// inventory_locations.name's own 100-character bound. A fresh
// `supabase db reset` alone can never exercise this: it applies every
// migration to an EMPTY database, so the "pre-existing long-named branch"
// state the bug depends on never exists at the moment the Phase 1G
// migrations run.
//
// Codex adversarial review Phase 1G round 2 (ACL environment
// micro-review): this same "upgrade onto pre-existing state" harness is
// also the only way to prove the NEW explicit EXECUTE-ACL normalization in
// 20260829080200_branch_aware_inventory_movements.sql actually converges
// regardless of starting condition. A fresh `db reset` alone can only ever
// observe ONE starting ACL — whatever this particular environment's own
// Supabase CLI/Postgres bootstrap happens to produce for create_product/
// record_inventory_movement (empirically confirmed to differ between CLI
// 2.115.0 and 2.116.0) — so it can never, by itself, prove the migration
// FIXES a broad starting grant rather than merely happening to already be
// narrow. This script now deliberately forces the WORST-CASE starting
// condition (service_role explicitly, directly GRANTed EXECUTE on both
// functions — strictly broader than anything either observed CLI version
// produces) before Phase 1G's migrations run, so a pass here is proof the
// normalization is unconditional, not incidental.
//
// This script performs a REAL, reproducible upgrade:
//   1. Temporarily moves the six Phase 1G migration files out of
//      supabase/migrations/.
//   2. `supabase db reset` — brings the local database to the frozen
//      Phase 1F baseline only (no Phase 1G schema at all).
//   3. Creates a real business and a real secondary branch with a valid,
//      maximum-length (100-character) name through the ACTUAL, unmodified
//      Phase 1F `create_business_branch` RPC — a genuine "legitimate
//      pre-1G secondary long-name branch", not a raw-SQL fixture.
//   4. Deliberately GRANTs EXECUTE on create_product/record_inventory_movement
//      to service_role directly — simulating (and deliberately exceeding)
//      the broadest starting ACL any observed environment has produced,
//      test-only, never part of a production migration.
//   5. Restores the six Phase 1G migration files.
//   6. `supabase migration up --local` — applies ONLY the newly-restored,
//      still-pending Phase 1G migrations to THIS SAME, now
//      data-populated, deliberately-broad-ACL database (never a fresh
//      reset, which would destroy both the pre-existing branch data and
//      the simulated broad ACL this script depends on).
//   7. Asserts the Medium 1 upgrade succeeded: the long-named branch now
//      has a canonical inventory_locations row, with a valid (<=100
//      character) name, the correct branch_id/business_id, and
//      is_branch_default.
//   8. Proves the FUTURE-branch path too: creates a second, differently-
//      named maximum-length branch AFTER the Phase 1G migrations are live,
//      and asserts it also gets a valid canonical location.
//   9. Asserts the ACL normalization succeeded: service_role is DENIED
//      EXECUTE on both create_product and record_inventory_movement
//      DESPITE the deliberate broad grant forced in step 4, authenticated
//      remains ALLOWED, and PUBLIC/anon remain DENIED — proof the
//      migration's own explicit REVOKE/GRANT converges from the
//      worst-case starting state, not merely from an already-narrow one
//      (that "already narrow" / clean-start case is covered continuously
//      by branch-aware-acl.test.ts's own permanent catalog + behavioral
//      tests, which run against every ordinary `db reset`).
//
// Usage: node scripts/verify-phase1g-upgrade.mjs
// (run manually/standalone — this is NOT part of `pnpm test:integration`,
// since it repeatedly resets/mutates the local database's migration state
// in a way no other test in this suite should run concurrently with.)
//
// What remains manual: this script targets the LOCAL Supabase stack only
// (refuses to run against anything else — see the URL check below) and
// must be run with the local stack up (`supabase start`). It is not wired
// into CI; a human (or Codex) runs it on demand to independently reproduce
// the upgrade. It always finishes by restoring every migration file to
// its normal location and running one final full `supabase db reset`, so
// the local database is left in its ordinary, fully-migrated state
// afterward regardless of whether the verification passed or failed.
import { config } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const STASH_DIR = path.resolve(process.cwd(), ".phase1g-upgrade-stash");
const PHASE_1G_FILES = [
  "20260829075900_ensure_member_branch_access.sql",
  "20260829080000_branch_aware_inventory_locations.sql",
  "20260829080100_branch_aware_sales.sql",
  "20260829080200_branch_aware_inventory_movements.sql",
  "20260829080300_branch_aware_expenses.sql",
  "20260829080400_branch_aware_financial_summary.sql",
];

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
}

function stashPhase1G() {
  fs.mkdirSync(STASH_DIR, { recursive: true });
  for (const f of PHASE_1G_FILES) {
    const src = path.join(MIGRATIONS_DIR, f);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(STASH_DIR, f));
  }
}

function restorePhase1G() {
  for (const f of PHASE_1G_FILES) {
    const stashed = path.join(STASH_DIR, f);
    if (fs.existsSync(stashed)) fs.renameSync(stashed, path.join(MIGRATIONS_DIR, f));
  }
  if (fs.existsSync(STASH_DIR)) fs.rmdirSync(STASH_DIR);
}

function assertLocal(url) {
  const { hostname, protocol } = new URL(url);
  if (protocol !== "http:" || !["127.0.0.1", "localhost"].includes(hostname)) {
    throw new Error(`Refusing to run against a non-local Supabase URL: ${url}`);
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_TEST_SECRET_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!url || !publishableKey || !secretKey || !dbUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_TEST_SECRET_KEY, and DATABASE_URL must all be set in .env.test.local");
  }
  assertLocal(url);
  if (!/127\.0\.0\.1|localhost/.test(dbUrl)) {
    throw new Error(`Refusing to run against a non-local DATABASE_URL: ${dbUrl}`);
  }

  const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `phase1g-upgrade-${suffix}@example.test`;
  const password = "Password1234";

  let userId;
  let businessId;
  let legacyLongBranchId;
  const legacyLongName = "X".repeat(100); // maximum valid Phase 1F branch name

  console.log("=== Phase 1G Medium 1 — real upgrade-path verification ===");

  stashPhase1G();
  try {
    console.log("\n--- Step 1: reset to the frozen Phase 1F baseline (no Phase 1G migrations present) ---");
    run("supabase db reset");

    console.log("\n--- Step 2: create a real Phase 1F business + a real, maximum-length secondary branch ---");
    const { data: user, error: createUserError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createUserError || !user.user) throw new Error(`createUser failed: ${createUserError?.message}`);
    userId = user.user.id;

    const client = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

    const { data: business, error: businessError } = await client.rpc("create_business", {
      p_name: "Phase1G Upgrade Test Co",
      p_slug: `phase1g-upgrade-${suffix}`,
    });
    if (businessError || !business) throw new Error(`create_business failed: ${businessError?.message}`);
    businessId = business.id;

    const { data: branchId, error: branchError } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: legacyLongName,
    });
    if (branchError || !branchId) throw new Error(`create_business_branch (legacy, pre-1G) failed: ${branchError?.message}`);
    legacyLongBranchId = branchId;
    console.log(`Created legacy Phase 1F business ${businessId} with a 100-character secondary branch ${legacyLongBranchId}.`);

    console.log("\n--- Step 3: deliberately force a BROAD starting ACL (test-only) — GRANT EXECUTE on create_product/record_inventory_movement to service_role, simulating the worst observed bootstrap environment ---");
    const bootstrapSql = postgres(dbUrl, { max: 1 });
    try {
      await bootstrapSql`grant execute on function public.create_product(
        uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
      ) to service_role`;
      await bootstrapSql`grant execute on function public.record_inventory_movement(
        uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
      ) to service_role`;
      console.log("Simulated broad grant applied: service_role now has EXECUTE on both Phase 1C functions, pre-Phase-1G.");
    } finally {
      await bootstrapSql.end();
    }
  } finally {
    console.log("\n--- Step 4: restore the six Phase 1G migration files ---");
    restorePhase1G();
  }

  console.log("\n--- Step 5: apply the (now-pending) Phase 1G migrations to THIS SAME, data-populated, deliberately-broad-ACL database ---");
  run("supabase migration up --local");

  console.log("\n--- Step 6: assert the upgrade succeeded ---");
  const sql = postgres(dbUrl, { max: 1 });
  let failures = [];
  try {
    const [legacyLocation] = await sql`
      select id, business_id, branch_id, is_branch_default, status, length(name) as name_len, name
      from public.inventory_locations
      where branch_id = ${legacyLongBranchId} and business_id = ${businessId}
    `;
    if (!legacyLocation) {
      failures.push("No canonical inventory_locations row was created for the pre-existing, maximum-length secondary branch — the upgrade migration failed silently or rolled back.");
    } else {
      if (legacyLocation.name_len > 100) failures.push(`Canonical location name is ${legacyLocation.name_len} characters (> 100) — the exact Medium 1 defect.`);
      if (!legacyLocation.is_branch_default) failures.push("Canonical location is not flagged is_branch_default = true.");
      if (legacyLocation.status !== "active") failures.push(`Canonical location status is "${legacyLocation.status}", expected "active".`);
      if (legacyLocation.business_id !== businessId) failures.push("Canonical location business_id does not match.");
      console.log(`Historical upgrade: canonical location "${legacyLocation.name}" (${legacyLocation.name_len} chars) created for the pre-existing long-named branch.`);
    }

    // Step 6: prove the FUTURE-branch path too, now that Phase 1G is live.
    const anon = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    const { error: signInError2 } = await anon.auth.signInWithPassword({ email, password });
    if (signInError2) throw new Error(`post-upgrade sign-in failed: ${signInError2.message}`);

    const futureLongName = "Y".repeat(100);
    const { data: futureBranchId, error: futureBranchError } = await anon.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: futureLongName,
    });
    if (futureBranchError || !futureBranchId) {
      failures.push(`Future branch creation with a maximum-length name failed post-upgrade: ${futureBranchError?.message}`);
    } else {
      const [futureLocation] = await sql`
        select id, business_id, branch_id, is_branch_default, status, length(name) as name_len, name
        from public.inventory_locations
        where branch_id = ${futureBranchId} and business_id = ${businessId}
      `;
      if (!futureLocation) {
        failures.push("No canonical inventory_locations row was created for the post-upgrade, maximum-length future branch.");
      } else {
        if (futureLocation.name_len > 100) failures.push(`Future branch's canonical location name is ${futureLocation.name_len} characters (> 100).`);
        if (!futureLocation.is_branch_default) failures.push("Future branch's canonical location is not flagged is_branch_default = true.");
        console.log(`Future creation: canonical location "${futureLocation.name}" (${futureLocation.name_len} chars) created for the post-upgrade long-named branch.`);
      }
    }

    // Step 9: assert the ACL normalization converged, DESPITE the
    // deliberately broad service_role grant forced in step 3.
    console.log("\n--- Step 9: assert service_role EXECUTE was normalized away, despite the deliberately broad pre-existing grant ---");
    for (const fnName of ["create_product", "record_inventory_movement"]) {
      const rows = await sql`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = ${fnName} and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      console.log(`${fnName} EXECUTE grantees after Phase 1G: ${grantees.join(", ")}`);
      if (grantees.includes("service_role")) {
        failures.push(`${fnName} still has service_role EXECUTE after Phase 1G's migration ran — the ACL normalization did NOT converge from the deliberately broad starting grant.`);
      }
      if (grantees.includes("PUBLIC")) failures.push(`${fnName} has a PUBLIC EXECUTE grant — expected denied.`);
      if (grantees.includes("anon")) failures.push(`${fnName} has an anon EXECUTE grant — expected denied.`);
      if (!grantees.includes("authenticated")) failures.push(`${fnName} is missing the required authenticated EXECUTE grant.`);
    }
  } finally {
    await sql.end();
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }

  if (failures.length > 0) {
    console.error("\n=== UPGRADE VERIFICATION FAILED ===");
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\n=== UPGRADE VERIFICATION PASSED ===");
    console.log("A pre-existing, maximum-length (100-character) Phase 1F secondary branch upgraded cleanly, a post-upgrade maximum-length branch creates cleanly too, and the ACL normalization converged to authenticated-only despite a deliberately broad pre-existing service_role grant.");
  }
}

main()
  .catch((err) => {
    console.error("\n=== UPGRADE VERIFICATION ERRORED ===");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Always restore the migration files (in case Step 1's own try/finally
    // didn't run — e.g. an error before it) and always leave the local
    // database in its normal, fully-migrated state afterward, regardless
    // of pass/fail/error above.
    restorePhase1G();
    try {
      run("supabase db reset");
    } catch (e) {
      console.error("Final cleanup `supabase db reset` failed — the local database may be left in a non-standard state. Run `supabase db reset` manually.", e);
    }
  });
