-- Phase 1O-E remediation (Codex finding, MEDIUM): get_platform_support_summary's
-- recent_whatsapp_failures counted one row per business that has at least
-- one recent WhatsApp failure (an "affected businesses" count), even though
-- the UI label and the sibling list_platform_business_diagnostics RPC both
-- treat it as the actual number of failed WhatsApp messages in the last 7
-- days. Forward-fixes the aggregation to sum the real per-business failure
-- counts (stats.recent_whatsapp_failures) instead of counting flag rows.
-- No other diagnostic count (businesses_requiring_attention, warnings,
-- info) changes, and authorization/AAL2/SECURITY DEFINER hygiene is
-- unchanged.
create or replace function public.get_platform_support_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  with stats as (
    select
      b.id as business_id,
      exists (
        select 1 from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = b.id and r.name = 'OWNER' and bm.status = 'active'
      ) as has_owner,
      (select count(*) from public.business_branches bb
        where bb.business_id = b.id and bb.status = 'ACTIVE') as active_branch_count,
      (select count(*) from public.business_members bm2
        where bm2.business_id = b.id and bm2.status = 'active') as active_member_count,
      bs.status as sub_status,
      bs.trial_ends_at,
      sp.code as plan_code,
      (select count(*) from public.whatsapp_messages wm
        where wm.business_id = b.id and wm.status = 'FAILED'
          and wm.failed_at > now() - interval '7 days') as recent_whatsapp_failures
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    left join public.subscription_plans sp on sp.id = bs.plan_id
    where b.status <> 'archived'
  ),
  flags as (
    select business_id, 'WARNING'::text as severity from stats where not has_owner
    union all
    select business_id, 'WARNING' from stats where active_branch_count = 0
    union all
    select business_id, 'WARNING' from stats where active_member_count = 0
    union all
    select business_id, 'WARNING' from stats where sub_status is null
    union all
    select business_id, 'WARNING' from stats where sub_status is not null and plan_code is null
    union all
    select business_id, 'WARNING' from stats where sub_status = 'TRIALING' and trial_ends_at < now()
    union all
    select business_id, 'INFO' from stats where recent_whatsapp_failures > 0
  )
  select jsonb_build_object(
    'businesses_requiring_attention', (select count(distinct business_id) from flags),
    'warnings', (select count(*) from flags where severity = 'WARNING'),
    'info', (select count(*) from flags where severity = 'INFO'),
    'recent_whatsapp_failures', (select coalesce(sum(stats.recent_whatsapp_failures), 0) from stats)
  ) into v_result;

  return v_result;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.get_platform_support_summary() owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.get_platform_support_summary() from public, anon;
grant execute on function public.get_platform_support_summary() to authenticated;
