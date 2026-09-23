-- Phase 1Q-0B-0B FINAL LOW-FINDING FOLLOW-UP (post-Codex review).
--
-- LOW FINDING 1: private.is_timezone_valid_for_country(text, text)
-- (20260923090200_create_business_rpc_boundary_hardening.sql) was granted
-- EXECUTE to `authenticated` for one reason only: businesses_timezone_
-- country_check ran that helper as part of a table CHECK, and a CHECK
-- constraint executes under the writing role's own privileges — so any
-- authenticated PostgREST UPDATE of businesses.timezone required
-- `authenticated` to be able to invoke it. That contradicts the intended
-- private-helper posture (every other helper beside it in that migration
-- is granted ONLY to private_business_creator). The helper itself is pure
-- and leaks nothing, but the correct fix is to stop requiring
-- `authenticated` to execute a private helper at all: replace the CHECK's
-- call to the helper with an inline, deterministic CASE expression that
-- carries the exact same nine-pairing rule directly in the constraint, so
-- Postgres evaluates it without invoking any function requiring its own
-- separate grant.
--
-- The RPC boundary (create_business, private_business_creator-owned) is
-- untouched — it keeps calling private.is_timezone_valid_for_country
-- directly as plpgsql, which needs no grant beyond the function's owning
-- role already carrying it implicitly.

-- ---------------------------------------------------------------------
-- 1. Replace businesses_timezone_country_check with an inline CASE,
--    dropping and recreating (constraints cannot be ALTERed in place).
--    Existing rows are unaffected: the predicate is byte-for-byte the
--    same rule private.is_timezone_valid_for_country already enforced,
--    so every row that satisfied the old CHECK still satisfies the new
--    one.
-- ---------------------------------------------------------------------
alter table public.businesses
  drop constraint businesses_timezone_country_check;

alter table public.businesses
  add constraint businesses_timezone_country_check
    check (
      case country_code
        when 'NG' then timezone = 'Africa/Lagos'
        when 'GH' then timezone = 'Africa/Accra'
        when 'KE' then timezone = 'Africa/Nairobi'
        when 'ZA' then timezone = 'Africa/Johannesburg'
        when 'GB' then timezone = 'Europe/London'
        when 'US' then timezone in (
          'America/New_York',
          'America/Chicago',
          'America/Denver',
          'America/Los_Angeles'
        )
        else false
      end
    );

-- ---------------------------------------------------------------------
-- 2. Now that no `authenticated` write path needs to invoke the helper,
--    revoke its EXECUTE grant from `authenticated`. private_business_
--    creator keeps EXECUTE (create_business, owned by that role, still
--    calls it directly as an RPC-boundary validation). public/anon were
--    never granted it and remain unchanged.
-- ---------------------------------------------------------------------
revoke execute on function private.is_timezone_valid_for_country(text, text) from authenticated;
