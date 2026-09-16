-- Phase 1N: the reporting implementation derives calendar-day bucket
-- boundaries from timestamptz values. Pin its execution setting so those
-- casts stay UTC regardless of the invoking connection's session timezone.
alter function public.get_management_reporting_aggregate_implementation(uuid, timestamptz, timestamptz)
  set timezone = 'UTC';
