-- Global RBAC catalog: roles, permissions, and the role -> permission
-- mapping. These are system-defined reference tables, not per-tenant
-- custom roles, and not writable by application users — only migrations
-- (running as the table owner) change this catalog in Phase 1. Row data
-- ships with this migration so every environment (local, staging,
-- production) gets identical seed rows.

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

-- The primary key already indexes (role_id, permission_id) with role_id
-- leading, so "all permissions for a role" is covered. "all roles that
-- carry a given permission" is not, hence the extra index below.
create index role_permissions_permission_id_idx on public.role_permissions (permission_id);

-- Row Level Security ---------------------------------------------------
--
-- Reference data: readable by any authenticated user (so the app can
-- render role/permission names), never writable by `authenticated` at
-- all. No INSERT/UPDATE/DELETE policy is defined for any of these three
-- tables, so those operations are denied by default for that role.
--
-- RLS policies alone are not enough: recent Supabase projects no longer
-- auto-expose newly created tables to the `anon`/`authenticated`/
-- `service_role` Postgres roles (config.toml's `api.auto_expose_new_tables`
-- default), so without an explicit GRANT every query from those roles
-- fails with "permission denied" before RLS is ever evaluated. GRANT
-- controls whether a role may attempt an operation at all; RLS then
-- controls which rows it sees. Only SELECT is granted here — this is
-- read-only reference data for both roles.

alter table public.roles enable row level security;
alter table public.roles force row level security;
create policy roles_select on public.roles
  for select
  to authenticated
  using (true);

alter table public.permissions enable row level security;
alter table public.permissions force row level security;
create policy permissions_select on public.permissions
  for select
  to authenticated
  using (true);

alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;
create policy role_permissions_select on public.role_permissions
  for select
  to authenticated
  using (true);

grant select on public.roles, public.permissions, public.role_permissions
  to authenticated, service_role;

-- Seed data ----------------------------------------------------------------
--
-- The seven BusinessOS roles. Names are uppercase, fixed identifiers that
-- application code and future migrations match against by string — treat
-- them as part of the schema contract, not display text (`description` is
-- the human-readable copy).

insert into public.roles (name, description) values
  ('OWNER',      'Full control over the business, including deleting it, managing members, and reassigning ownership. Every business has at least one.'),
  ('ADMIN',      'Manages the business and its members, short of deleting the business.'),
  ('MANAGER',    'Manages staff and day-to-day operations, without control over business settings or billing.'),
  ('SALES',      'Operates the sales workflow: quotes, orders, and customers.'),
  ('INVENTORY',  'Operates the inventory workflow: stock, products, and warehouses.'),
  ('ACCOUNTANT', 'Operates the accounting workflow: invoices, payments, and financial reports.'),
  ('VIEWER',     'Read-only access across the business, with no write permissions.')
on conflict (name) do nothing;

-- Minimal Phase 1 permission set. This is deliberately small: it only
-- covers the business/membership plumbing this migration set introduces.
-- Domain modules (sales, inventory, accounting, ...) add their own
-- permission keys and role_permissions rows in their own migrations rather
-- than being anticipated here.
insert into public.permissions (key, description) values
  ('business.manage', 'Update business details such as name, slug, and status.'),
  ('business.delete', 'Delete the business.'),
  ('members.manage',  'Invite, remove, or change the role of business members.')
on conflict (key) do nothing;

-- OWNER: every Phase 1 permission.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'OWNER'
on conflict do nothing;

-- ADMIN: everything except deleting the business.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ADMIN'
  and p.key <> 'business.delete'
on conflict do nothing;

-- MANAGER: can manage staff, not business identity or billing.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'members.manage'
where r.name = 'MANAGER'
on conflict do nothing;

-- SALES, INVENTORY, ACCOUNTANT, and VIEWER get no Phase 1 permissions.
-- Their baseline access (seeing the business they belong to and its
-- member roster) comes from membership itself, not from this table; their
-- domain-specific permissions arrive with their respective feature
-- migrations.
