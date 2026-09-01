-- Phase 1I permission catalog additions.
--
-- Two keys: returns.view/returns.manage. Minimal by design, matching
-- every prior phase's own precedent (no returns.void — there is no void
-- workflow in Phase 1I at all; see sale_returns' own single-status
-- design). returns.manage does NOT imply returns.view, and vice versa —
-- checked independently everywhere, exactly like every other Phase
-- 1C-1H permission pair (customers.manage does not imply sales.create,
-- invoices.manage does not imply payments.record, etc.).
--
-- IMPORTANT (per this phase's own product brief): returns.manage must
-- NEVER silently require an unrelated permission such as sales.create,
-- inventory.adjust, or branches.manage. create_sale_return's own
-- authorization is exactly ONE check — private.has_permission(business_id,
-- 'returns.manage') — plus the caller's own branch-operational access to
-- the SALE's branch (private.has_branch_access, never a separate
-- permission). There is no dependency on any Phase 1C/1D/1G permission at
-- all; this migration introduces no new grant to any OTHER permission
-- key, and no other migration's own role/grant is touched.
--
-- ROLE MATRIX — mirrors sales.create's/customers.manage's own
-- OWNER/ADMIN/MANAGER/SALES-operational, ACCOUNTANT-view-only,
-- VIEWER-view-only precedent exactly (20260826090600_customers_sales_permissions.sql),
-- with one deliberate addition: INVENTORY also receives returns.view.
-- Unlike sales/customers (INVENTORY's domain is stock, not the sales
-- floor, and Phase 1D sales/customers are of no operational concern to
-- them), a return with restock=true is itself a real, first-class
-- inventory event — its own SALE_RETURN ledger movement is created by
-- create_sale_return, and INVENTORY already holds inventory.view for
-- exactly this kind of stock-history visibility. Granting returns.view
-- here lets that role see WHY a given restock movement happened (which
-- return it came from), without granting any operational authority over
-- returns/refunds themselves (returns.manage is deliberately withheld).
insert into public.permissions (key, description) values
  ('returns.view',   'View sale returns and refund history.'),
  ('returns.manage', 'Record sale returns and refunds.')
on conflict (key) do nothing;

-- OWNER, ADMIN, MANAGER, SALES: full operational access — the entire
-- point of the SALES role, and standard management-tier access for the
-- other three, exactly matching their existing sales.create/
-- customers.manage-tier treatment.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES')
  and p.key in ('returns.view', 'returns.manage')
on conflict do nothing;

-- ACCOUNTANT: full read visibility for financial reconciliation
-- (refund_amount/refund_method history), deliberately WITHOUT
-- returns.manage — they don't operate the sales floor or process
-- returns, mirroring their existing sales.view-without-sales.create
-- treatment exactly.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key = 'returns.view'
on conflict do nothing;

-- INVENTORY: view-only, for stock-history context on restock movements —
-- see this file's own header comment for the full reasoning. Deliberately
-- WITHOUT returns.manage: processing a return/refund is a sales-floor
-- operational activity, not a stock-management one.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'INVENTORY'
  and p.key = 'returns.view'
on conflict do nothing;

-- VIEWER: read-only, matching their existing generic conservative
-- treatment elsewhere.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'VIEWER'
  and p.key = 'returns.view'
on conflict do nothing;
