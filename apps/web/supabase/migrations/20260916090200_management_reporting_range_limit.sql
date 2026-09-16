-- Bound direct authenticated RPC use as well as the 30-day UI call. The
-- first Phase 1N migration is already present in local upgrade databases,
-- so retain its tested implementation behind an uncallable reader-owned
-- function and expose a narrow validating wrapper.
alter function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz)
  rename to get_management_reporting_aggregate_implementation;

revoke all on function public.get_management_reporting_aggregate_implementation(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_management_reporting_aggregate(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_business_id is null or p_from is null or p_to is null or p_from >= p_to
     or p_to - p_from > interval '366 days' then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;
  return public.get_management_reporting_aggregate_implementation(p_business_id, p_from, p_to);
end;
$$;

grant create on schema public to private_management_reports_reader;
alter function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz)
  owner to private_management_reports_reader;
revoke create on schema public from private_management_reports_reader;
revoke all on function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz)
  from public, anon, service_role;
grant execute on function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz)
  to authenticated;
