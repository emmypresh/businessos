-- Phase 1E permission catalog additions.
--
-- Minimal by design (matching customers_sales_permissions.sql's own
-- precedent): only the three keys Phase 1E's actually-implemented RPCs
-- and reporting function check. No expenses.delete (expenses are never
-- deleted), no expenses.approve (no approval workflow exists in Phase
-- 1E), no reports.manage/accounting.*/profit.* (no such capability
-- exists to gate).
--
-- OWNER, ADMIN, MANAGER, ACCOUNTANT all receive the identical full set —
-- unlike Phase 1D's split between "operate" and "view-only" roles, Phase
-- 1E draws no distinction among these four: every one of them may both
-- record expenses and view the financial overview. SALES, INVENTORY, and
-- VIEWER receive none of the three — expenses/reporting are deliberately
-- NOT implied by sales.view, customers.view, inventory.*, or plain
-- membership.

insert into public.permissions (key, description) values
  ('expenses.view',   'View expense records.'),
  ('expenses.manage', 'Create expense categories and post/void expenses.'),
  ('reports.view',    'View the financial summary overview.')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT')
  and p.key in ('expenses.view', 'expenses.manage', 'reports.view')
on conflict do nothing;

-- SALES, INVENTORY, VIEWER: no Phase 1E permissions at all.
