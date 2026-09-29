-- Phase 1Q-B, part 4 — audits a manual SKU edit on an EXISTING product.
--
-- products.sku is updated via a plain RLS-governed UPDATE (products_update
-- policy, 20260826080000_create_products.sql), not an RPC — there is no
-- SECURITY DEFINER mutation boundary for this specific edit to instrument
-- the way create_product's own INSERT already is. A narrowly-scoped
-- AFTER UPDATE OF sku trigger is the correct tool here (per
-- private.record_audit_event's own header comment: triggers were rejected
-- as the PRIMARY audit mechanism, but explicitly left open for "a specific
-- table where a trigger genuinely is the right tool... a defense-in-depth
-- backstop" — this is exactly that case, not a workaround).
--
-- Fires ONLY when sku actually changes (OLD.sku IS DISTINCT FROM NEW.sku)
-- — a no-op UPDATE (re-saving the same value, or an UPDATE touching only
-- other columns that Postgres still routes through this "OF sku" trigger
-- because the statement's SET list happened to name sku) never writes an
-- event. Never fires on INSERT (create_product's own INSERT already
-- records product.created with its own sku_generated metadata — see
-- 20261010080100_product_sku_generation.sql; this trigger is UPDATE-only,
-- so no double-logging is possible for the creation path).
--
-- SECURITY DEFINER, owned by private_product_creator (which already holds
-- EXECUTE on private.record_audit_event and private.current_verified_email
-- — see 20260902100000_instrument_core_audit_events.sql): required
-- because the firing UPDATE itself runs as `authenticated`, which has no
-- EXECUTE grant on record_audit_event at all. The actor is still the REAL
-- caller, not the function owner — private.current_uid() reads the
-- session's own auth.uid(), which SECURITY DEFINER does not change.
create or replace function private.audit_product_sku_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid;
  v_actor_email text;
begin
  if new.sku is not distinct from old.sku then
    return new;
  end if;

  v_uid := private.current_uid();
  v_actor_email := private.current_verified_email();

  perform private.record_audit_event(
    new.business_id, 'USER', v_uid, 'product.sku_changed', 'INVENTORY',
    null, v_actor_email, null,
    'product', new.id, new.name, 'SUCCESS',
    jsonb_build_object('old_sku', old.sku, 'new_sku', new.sku)
  );

  return new;
end;
$$;

revoke all on function private.audit_product_sku_change() from public;
grant create on schema private to private_product_creator;
alter function private.audit_product_sku_change() owner to private_product_creator;
revoke create on schema private from private_product_creator;

create trigger products_audit_sku_change
  after update of sku on public.products
  for each row
  execute function private.audit_product_sku_change();
