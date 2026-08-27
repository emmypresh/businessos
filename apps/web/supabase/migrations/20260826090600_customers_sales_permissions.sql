-- Phase 1D permission catalog additions.
--
-- Minimal by design (correction 16): only the four keys Phase 1D's
-- actually-implemented RPCs check. No sales.manage (no cancellation/draft
-- workflow exists in Phase 1D to gate), no sales.view_cost (no accessor
-- function exists yet — added only alongside a future reporting phase,
-- matching inventory.view_cost's own precedent of being introduced
-- together with its accessor functions, not speculatively ahead of them).

insert into public.permissions (key, description) values
  ('customers.view',   'View customer records and sale history.'),
  ('customers.manage', 'Create and edit customer records.'),
  ('sales.view',       'View sales and sale details.'),
  ('sales.create',     'Create completed sales, deducting stock.')
on conflict (key) do nothing;

-- OWNER, ADMIN, MANAGER, SALES: full operational access — the entire
-- point of the SALES role, and standard management-tier access for the
-- other three.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES')
  and p.key in ('customers.view', 'customers.manage', 'sales.view', 'sales.create')
on conflict do nothing;

-- ACCOUNTANT: full read visibility for financial reporting, no
-- create/manage — they don't operate the sales floor or edit customer
-- records, mirroring their existing inventory.view_cost-without-adjust
-- treatment.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key in ('customers.view', 'sales.view')
on conflict do nothing;

-- VIEWER: read-only, matching their existing generic conservative
-- treatment elsewhere.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'VIEWER'
  and p.key in ('customers.view', 'sales.view')
on conflict do nothing;

-- INVENTORY: no customers/sales access at all — their domain is stock,
-- not the sales floor, matching the explicitly stated expectation that
-- inventory visibility does not imply financial sale management.
