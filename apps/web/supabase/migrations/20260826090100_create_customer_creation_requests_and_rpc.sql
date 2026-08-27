-- Phase 1D: idempotent customer creation.
--
-- Learns directly from private.product_creation_requests
-- (create_product_rpc.sql): the arbiter of "who created this customer" is
-- a dedicated request-ledger row's INSERT ... ON CONFLICT DO NOTHING, never
-- a unique constraint on the customers table itself compared against that
-- table's current (later-editable) values. A retry of the exact original
-- request, even after the customer has since been edited, must resolve to
-- the SAME customer_id via the STORED original canonical payload — never
-- by re-deriving intent from the customer row's live state.

create table private.customer_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  -- Filled in once the winning claimant actually creates the customer, in
  -- the same transaction as the claim — never visible to another
  -- transaction in a half-populated state.
  customer_id       uuid references public.customers (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

-- Never exposed through the Data API: `private` is not in config.toml's
-- api.schemas, so this table is unreachable via PostgREST regardless of
-- GRANTs. RLS is enabled and forced anyway, with zero policies for any
-- client role — mirroring product_creation_requests' own treatment.
alter table private.customer_creation_requests enable row level security;
alter table private.customer_creation_requests force row level security;

revoke all on private.customer_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_customer_creator's table grants as a quick fix   │
-- │ for some other function's privilege problem; give that function its  │
-- │ own dedicated minimal role instead.                                  │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_customer_creator') then
    create role private_customer_creator noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_customer_creator to postgres;

grant usage on schema public to private_customer_creator;
grant usage on schema private to private_customer_creator;
-- Least-privilege pass (defense-in-depth for a BYPASSRLS role, applied
-- even though no exploit was found — this role never reads any customer
-- column back, it only inserts and returns the freshly-generated id via
-- RETURNING, which requires SELECT privilege on exactly that one column,
-- not the whole table).
grant insert on public.customers to private_customer_creator;
grant select (id) on public.customers to private_customer_creator;

-- The arbiter table itself: SELECT to load a conflicting/matching claim's
-- original request, INSERT to claim. UPDATE is narrowed to exactly the
-- one column ever written after the initial claim (customer_id) — never a
-- whole-row UPDATE grant.
grant select, insert on private.customer_creation_requests to private_customer_creator;
grant update (customer_id) on private.customer_creation_requests to private_customer_creator;

-- Explicit cross-role EXECUTE dependencies (SECURITY DEFINER does not
-- transitively grant EXECUTE on functions a function calls).
grant execute on function private.current_uid() to private_customer_creator;
grant execute on function private.has_permission(uuid, text) to private_customer_creator;

create or replace function public.create_customer(
  p_business_id  uuid,
  p_creation_key uuid,
  p_name         text,
  p_phone        text default null,
  p_email        text default null,
  p_address      text default null,
  p_notes        text default null
)
returns uuid  -- customer_id ONLY — never the full row, never a composite
              -- that could later leak an internal column simply because
              -- the table gained one.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_name               text;
  v_phone              text;
  v_email              text;
  v_address            text;
  v_notes              text;
  v_canonical_payload  jsonb;
  v_customer_id        uuid;
  v_stored_request     private.customer_creation_requests;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null then
    raise exception 'p_business_id and p_creation_key are required'
      using errcode = '22023';
  end if;

  -- business_id is validated, never trusted: this is what makes a forged
  -- business_id harmless.
  if not private.has_permission(p_business_id, 'customers.manage') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Normalize before both persistence and comparison — every field that
  -- participates in the canonical payload is derived from these
  -- normalized locals, never the raw parameters, so the stored request
  -- and any freshly-computed candidate for a retry are byte-identical
  -- when the caller's intent is identical.
  -- Every field is validated against the EXACT same rule the
  -- customers table's own CHECK constraints enforce (create_customers.sql),
  -- BEFORE the INSERT, so a malformed value never reaches the database's
  -- own constraint machinery — an unhandled CHECK violation returns the
  -- constraint name, the SQLSTATE, and the full attempted row (business
  -- id, generated customer id, created_by, timestamps, notes contents)
  -- through PostgREST, which is not an acceptable public error boundary
  -- for ordinary invalid input. The table CHECKs remain as a structural
  -- backstop for any OTHER writer (there is none today — customers has
  -- no INSERT policy for `authenticated` at all — but the backstop is
  -- cheap insurance against a future writer forgetting this validation).
  v_name := btrim(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'INVALID_CUSTOMER_NAME'
      using errcode = '22023';
  end if;

  v_phone := nullif(btrim(p_phone), '');
  if v_phone is not null and length(v_phone) not between 1 and 32 then
    raise exception 'INVALID_CUSTOMER_PHONE'
      using errcode = '22023';
  end if;

  v_email := nullif(btrim(p_email), '');
  if v_email is not null and (
    length(v_email) > 254
    or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception 'INVALID_CUSTOMER_EMAIL'
      using errcode = '22023';
  end if;

  v_address := nullif(btrim(p_address), '');
  if v_address is not null and length(v_address) > 500 then
    raise exception 'INVALID_CUSTOMER_ADDRESS'
      using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_CUSTOMER_NOTES'
      using errcode = '22023';
  end if;

  v_canonical_payload := jsonb_build_object(
    'name', v_name,
    'phone', v_phone,
    'email', v_email,
    'address', v_address,
    'notes', v_notes
  );

  -- Claim (business_id, creation_key) atomically. This INSERT is the SOLE
  -- arbiter of "who creates this customer" — not any constraint on the
  -- customers table itself. Two concurrent callers with the same key:
  -- exactly one INSERT here succeeds; Postgres blocks the other on the
  -- winner's row lock until the winner's transaction resolves, then
  -- re-evaluates the conflict against the final state — no
  -- check-then-insert race window.
  insert into private.customer_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if found then
    -- We won the claim: create the customer now.
    insert into public.customers (business_id, name, phone, email, address, notes, created_by)
    values (p_business_id, v_name, v_phone, v_email, v_address, v_notes, v_uid)
    returning id into v_customer_id;

    update private.customer_creation_requests
    set customer_id = v_customer_id
    where business_id = p_business_id and creation_key = p_creation_key;

    return v_customer_id;
  end if;

  -- We lost the claim (or it already existed from a prior call): load the
  -- WINNING/ORIGINAL request and compare against it — never against the
  -- customer row's current, possibly since-edited values. This is what
  -- makes a retry of the original request still recognized correctly even
  -- after the customer has been renamed/re-contacted in the meantime.
  select * into v_stored_request
  from private.customer_creation_requests
  where business_id = p_business_id and creation_key = p_creation_key;

  if v_stored_request.canonical_payload is distinct from v_canonical_payload then
    raise exception 'CUSTOMER_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
  end if;

  return v_stored_request.customer_id;
end;
$$;

grant create on schema public to private_customer_creator;
alter function public.create_customer(uuid, uuid, text, text, text, text, text)
  owner to private_customer_creator;
revoke create on schema public from private_customer_creator;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant — matching create_product's own precedent (no
-- concrete service_role actor calling this yet).
revoke all on function public.create_customer(uuid, uuid, text, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_customer(uuid, uuid, text, text, text, text, text)
  to authenticated;
