-- Follow-up for already-upgraded local databases: the Phase 1N reader
-- filters completed sales by status, so this exact source column belongs in
-- its narrow grant. Fresh installs receive it in 20260916090000 as well.
grant select (status) on public.sales to private_management_reports_reader;
