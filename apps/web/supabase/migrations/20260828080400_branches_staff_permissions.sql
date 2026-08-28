-- Phase 1F permission catalog additions.
--
-- Five keys: branches.view/manage and staff.view/manage/invite. No
-- branches.delete (branches are never hard-deleted), no staff.remove (no
-- membership-removal RPC exists in Phase 1F — suspend is the only
-- lifecycle-management action, matching "avoid physical membership
-- deletion" from the approved plan), no custom-role/permission-editor keys
-- (no such capability exists to gate).

insert into public.permissions (key, description) values
  ('branches.view',   'View business branches.'),
  ('branches.manage', 'Create, edit, and (de)activate business branches.'),
  ('staff.view',      'View business members and their branch assignments.'),
  ('staff.manage',    'Change member roles, branch assignments, and suspend/reactivate members.'),
  ('staff.invite',    'Create, view, and revoke business invitations.')
on conflict (key) do nothing;

-- OWNER, ADMIN: full operational access — the entire point of the two
-- management-tier roles.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN')
  and p.key in ('branches.view', 'branches.manage', 'staff.view', 'staff.manage', 'staff.invite')
on conflict do nothing;

-- MANAGER: can see branches and staff, cannot restructure either.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'MANAGER'
  and p.key in ('branches.view', 'staff.view')
on conflict do nothing;

-- ACCOUNTANT: same read-only staff/branch visibility as MANAGER, matching
-- their existing conservative read-visibility treatment elsewhere
-- (customers.view/sales.view without manage/create).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key in ('branches.view', 'staff.view')
on conflict do nothing;

-- SALES, INVENTORY, VIEWER: branch visibility only (every operational
-- member needs to resolve "which branches exist" at minimum), no staff
-- visibility or management at all.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('SALES', 'INVENTORY', 'VIEWER')
  and p.key = 'branches.view'
on conflict do nothing;
