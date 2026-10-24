-- Keep privilege-bearing implementations outside the exposed API schema.
alter function public.billing_status(uuid) set schema private;
alter function public.billing_record_permissions(uuid,text,uuid[]) set schema private;
alter function public.billing_assert_export(uuid,text) set schema private;
alter function public.billing_retained_records(uuid,text,integer) set schema private;
alter function public.set_member_active(uuid,uuid,boolean) set schema private;
alter function public.platform_billing_access() set schema private;
alter function public.platform_billing_report(timestamptz,timestamptz) set schema private;

create function public.billing_status(o uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select private.billing_status(o) $$;
create function public.billing_record_permissions(o uuid,kind text,ids uuid[]) returns jsonb language sql stable security invoker set search_path='' as $$ select private.billing_record_permissions(o,kind,ids) $$;
create function public.billing_assert_export(o uuid,kind text default 'workspace') returns void language sql stable security invoker set search_path='' as $$ select private.billing_assert_export(o,kind) $$;
create function public.billing_retained_records(o uuid,kind text,page integer default 1) returns jsonb language sql stable security invoker set search_path='' as $$ select private.billing_retained_records(o,kind,page) $$;
create function public.set_member_active(o uuid,member_id uuid,enabled boolean) returns void language sql security invoker set search_path='' as $$ select private.set_member_active(o,member_id,enabled) $$;
create function public.platform_billing_access() returns boolean language sql stable security invoker set search_path='' as $$ select private.platform_billing_access() $$;
create function public.platform_billing_report(start_at timestamptz,end_at timestamptz) returns jsonb language sql stable security invoker set search_path='' as $$ select private.platform_billing_report(start_at,end_at) $$;

revoke all on function public.billing_status(uuid),public.billing_record_permissions(uuid,text,uuid[]),public.billing_assert_export(uuid,text),public.billing_retained_records(uuid,text,integer),public.set_member_active(uuid,uuid,boolean),public.platform_billing_access(),public.platform_billing_report(timestamptz,timestamptz) from public,anon;
grant execute on function public.billing_status(uuid),public.billing_record_permissions(uuid,text,uuid[]),public.billing_assert_export(uuid,text),public.billing_retained_records(uuid,text,integer),public.set_member_active(uuid,uuid,boolean),public.platform_billing_access(),public.platform_billing_report(timestamptz,timestamptz) to authenticated;
