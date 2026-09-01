-- Phase 1H: invoice voiding — the ONLY authorized path to move an
-- unpaid, payment-free invoice to VOID. Mirrors void_expense's own shape
-- exactly (20260827080400_void_expense_rpc.sql). Invoices are never
-- deleted and never un-voided; there is no other status transition this
-- (or any other) function performs.
--
-- Since Phase 1H has no DRAFT/edit workflow, VOID is the only
-- cancellation mechanism for a mistaken invoice — but only while it is
-- genuinely unpaid: the simplest safe rule (this phase's own explicit
-- product decision) is that ANY invoice with a payment recorded against
-- it, partial or full, can never be voided at all, not merely one that
-- is fully PAID. A correction to a partially-paid invoice is out of
-- Phase 1H's scope (no refund/credit-note mechanism exists yet).
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_invoice_voider's table grants as a quick fix    │
-- │ for some other function's privilege problem; give that function its  │
-- │ own dedicated minimal role instead — deliberately separate from      │
-- │ both private_invoice_writer and private_invoice_payment_writer.      │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invoice_voider') then
    create role private_invoice_voider noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invoice_voider to postgres;

grant usage on schema public to private_invoice_voider;
grant usage on schema private to private_invoice_voider;

-- SELECT narrowed to exactly what this function reads back; UPDATE
-- narrowed to exactly the three void-state columns it ever writes —
-- never amount_paid/total_amount/customer or branch snapshots/etc.
-- branch_id (Codex security audit, SEC-01) is read-only here — the
-- AUTHORITATIVE branch this invoice belongs to, used solely to check the
-- caller's own operational access to it; never written.
grant select (id, business_id, status, branch_id) on public.invoices to private_invoice_voider;
grant update (status, voided_at, voided_by) on public.invoices to private_invoice_voider;

-- Read-only existence check against invoice_payments — never a whole-row
-- SELECT, just enough to answer "does at least one payment exist for
-- this invoice".
grant select (invoice_id) on public.invoice_payments to private_invoice_voider;

grant execute on function private.current_uid() to private_invoice_voider;
grant execute on function private.has_permission(uuid, text) to private_invoice_voider;
-- Codex security audit, SEC-01 ("Cross-Branch Invoice Void IDOR"):
-- invoice voiding is branch-operational, exactly like invoice CREATION
-- (create_invoice's own identical has_branch_access check,
-- 20260831080200_create_invoice_creation_rpc.sql) — invoices.manage
-- alone authorizes voiding an invoice SOMEWHERE the caller operates,
-- never every branch of the business.
grant execute on function private.has_branch_access(uuid, uuid) to private_invoice_voider;

create or replace function public.void_invoice(
  p_business_id uuid,
  p_invoice_id  uuid
)
returns uuid  -- invoice_id ONLY, matching void_expense's own return shape.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_status    text;
  v_found_id  uuid;
  v_branch_id uuid;
  v_has_payment boolean;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_invoice_id is null then
    raise exception 'p_business_id and p_invoice_id are required' using errcode = '22023';
  end if;

  -- The caller's OWN permission — never inferred from anything about the
  -- target invoice, so this is safe to check before the target is even
  -- looked up.
  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Scoped directly in the WHERE clause (a foreign-tenant invoice is
  -- never loaded at all, not loaded-then-compared) and locked FOR UPDATE
  -- — a concurrent payment attempt and a concurrent void attempt against
  -- the SAME invoice serialize on this lock: whichever commits first
  -- determines the outcome the second one correctly re-evaluates against
  -- (a payment that lands first makes the subsequent void see
  -- INVOICE_HAS_PAYMENTS; a void that lands first makes the subsequent
  -- payment see INVOICE_VOID).
  select id, status, branch_id into v_found_id, v_status, v_branch_id
  from public.invoices
  where id = p_invoice_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;

  -- Codex security audit, SEC-01: the AUTHORITATIVE branch comes from the
  -- just-LOCKED invoice row itself — never a caller-supplied parameter
  -- (this function has no p_branch_id at all, so there is nothing for a
  -- forged branch id to even smuggle in through). A same-business invoice
  -- in a branch the caller cannot operationally access is treated
  -- IDENTICALLY to a nonexistent one — the SAME INVOICE_NOT_FOUND, never
  -- a distinguishable error — so a caller enumerating invoice ids can
  -- never learn "this id exists, just in a branch I can't reach" versus
  -- "this id doesn't exist at all." This check runs BEFORE the
  -- VOID/HAS_PAYMENTS status checks below so that an inaccessible
  -- invoice's status is never disclosed either. Mutation authority stays
  -- fully independent of any broader invoices.view/payments.view
  -- authority the caller may or may not separately hold.
  if not private.has_branch_access(p_business_id, v_branch_id) then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_status = 'VOID' then
    raise exception 'INVOICE_ALREADY_VOID' using errcode = '23514';
  end if;

  select exists (
    select 1 from public.invoice_payments where invoice_id = p_invoice_id
  ) into v_has_payment;

  if v_has_payment then
    -- Subsumes the PAID case too (a PAID invoice always has at least one
    -- payment) — a single, coherent rule rather than two separate checks
    -- that could drift apart.
    raise exception 'INVOICE_HAS_PAYMENTS' using errcode = '23514';
  end if;

  update public.invoices
  set status = 'VOID', voided_at = now(), voided_by = v_uid
  where id = p_invoice_id and business_id = p_business_id;

  return p_invoice_id;
end;
$$;

grant create on schema public to private_invoice_voider;
alter function public.void_invoice(uuid, uuid) owner to private_invoice_voider;
revoke create on schema public from private_invoice_voider;

revoke all on function public.void_invoice(uuid, uuid) from public, anon, service_role;
grant execute on function public.void_invoice(uuid, uuid) to authenticated;
