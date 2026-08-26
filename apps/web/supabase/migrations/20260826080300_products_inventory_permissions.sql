-- Phase 1C permission catalog additions.
--
-- Conservative by design: inventory.adjust is withheld from SALES,
-- ACCOUNTANT, and VIEWER. inventory.view_cost is a distinct permission
-- from inventory.view/products.view, withheld from SALES and VIEWER —
-- SALES because revealing margins to a sales-facing role is a common,
-- real SME sensitivity; VIEWER as the conservative default for a broad,
-- generic read-only role. Enforced at the database boundary (see
-- acl_and_default_privileges_pass.sql's column-privilege revoke and the
-- public.get_product_cost/get_movement_unit_cost accessor functions), not
-- application-layer alone.

insert into public.permissions (key, description) values
  ('products.view',       'View the product catalog.'),
  ('products.manage',     'Create, edit, and archive products.'),
  ('inventory.view',      'View stock balances, ledger, and movement history.'),
  ('inventory.view_cost', 'View product cost price and movement unit cost.'),
  ('inventory.adjust',    'Create manual stock movements (opening stock, adjustments).')
on conflict (key) do nothing;

-- OWNER, ADMIN, MANAGER, INVENTORY: every Phase 1C permission.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'INVENTORY')
  and p.key in ('products.view', 'products.manage', 'inventory.view', 'inventory.view_cost', 'inventory.adjust')
on conflict do nothing;

-- ACCOUNTANT: full read visibility including cost, no manage/adjust.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key in ('products.view', 'inventory.view', 'inventory.view_cost')
on conflict do nothing;

-- SALES, VIEWER: catalog/stock visibility only — no cost, no manage/adjust.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('SALES', 'VIEWER')
  and p.key in ('products.view', 'inventory.view')
on conflict do nothing;
