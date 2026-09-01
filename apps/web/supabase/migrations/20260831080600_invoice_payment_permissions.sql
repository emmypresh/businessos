-- Phase 1H permission catalog additions.
--
-- Four keys: invoices.view/manage, payments.view/record. Minimal by
-- design, matching every prior phase's own precedent (no invoices.void as
-- a separate key — voiding is gated on invoices.manage, the same
-- permission that creates an invoice in the first place, mirroring
-- expenses.manage's own single-permission gate over both create and void
-- — see void_expense_rpc.sql's own header comment).
--
-- ROLE MATRIX — deliberately narrower than a naive "mirror sales.create's
-- own OWNER/ADMIN/MANAGER/SALES/ACCOUNTANT-view precedent" would suggest,
-- for one concrete, mechanical reason, not a stylistic preference:
--
-- invoices.manage is granted to OWNER, ADMIN, MANAGER, and SALES only —
-- deliberately WITHOUT ACCOUNTANT, even though ACCOUNTANT already holds
-- customers.view/sales.view (read-only financial-oversight access) and
-- the review's own suggested matrix lists "ACCOUNTANT: view/manage
-- invoices". Reason: invoice CREATION is an operational activity gated on
-- branch access, and the application resolves its own branch picker
-- through the frozen, already-approved
-- public.get_business_branch_options RPC's "operations" scope
-- (supabase/migrations/20260830080000_branch_option_rpc.sql — Phase 1G,
-- explicitly not modifiable in Phase 1H), whose own authorization is
-- fixed to sales.create OR products.manage OR inventory.adjust. Granting
-- ACCOUNTANT invoices.manage without ALSO holding one of those three
-- would reproduce the exact "permission-split" defect Phase 1G's own
-- multi-round remediation existed to eliminate: an accountant could reach
-- the invoice-creation page (gated on invoices.manage) but get
-- insufficient_privilege from the branch picker it depends on. Rather
-- than fabricate an unrelated operational-permission grant to paper over
-- a mechanical RPC-scope mismatch, ACCOUNTANT's role here is deliberately
-- "views everything, records payments, does not raise invoices" — a
-- coherent SME division of labor (sales-floor roles raise invoices they
-- know the customer/products for; accountants reconcile and record what
-- comes in) that requires no new migration and no branch-option RPC
-- change at all. ACCOUNTANT still receives invoices.view, payments.view,
-- AND payments.record in full (payment recording has no branch picker at
-- all — see record_invoice_payment_rpc.sql's own header comment: the
-- payment's branch is always derived from the invoice, never chosen by
-- the caller).
--
-- invoices.view/payments.view are business-wide read permissions
-- (mirrors sales.view/reports.view's own precedent — never gated on
-- operational branch assignment), so VIEWER receiving both introduces no
-- equivalent risk.

insert into public.permissions (key, description) values
  ('invoices.view',   'View invoices and payment history.'),
  ('invoices.manage', 'Create and void invoices.'),
  ('payments.view',   'View invoice payment history.'),
  ('payments.record', 'Record payments against an invoice.')
on conflict (key) do nothing;

-- OWNER, ADMIN, MANAGER, SALES: full operational access — invoice
-- creation/voiding and payment recording, matching their existing
-- sales.create/customers.manage-tier access exactly.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES')
  and p.key in ('invoices.view', 'invoices.manage', 'payments.view', 'payments.record')
on conflict do nothing;

-- ACCOUNTANT: full read visibility plus payment recording, deliberately
-- WITHOUT invoices.manage — see this file's own header comment for the
-- full reasoning.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key in ('invoices.view', 'payments.view', 'payments.record')
on conflict do nothing;

-- VIEWER: read-only, matching their existing generic conservative
-- treatment elsewhere.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'VIEWER'
  and p.key in ('invoices.view', 'payments.view')
on conflict do nothing;

-- INVENTORY: no invoice/payment access at all — their domain is stock,
-- matching their existing complete exclusion from customers/sales access.
