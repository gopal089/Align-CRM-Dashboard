-- Internal billing state has no client policies. Retained previews end at the exact deadline.
alter table private.billing_purge_context enable row level security;
alter table private.platform_billing_admins enable row level security;
create or replace function public.billing_retained_records(o uuid, kind text, page integer default 1) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; lim integer; excess bigint; deadline timestamptz; begin
 if auth.uid() is null or private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 if kind not in ('contacts','leads','companies') then raise exception 'Unsupported customer record type'; end if;
 deadline:=private.billing_deadline(o);
 if deadline is null or statement_timestamp()>=deadline then return '[]'::jsonb; end if;
 lim:=private.billing_limit(o,kind); excess:=greatest(private.billing_count(o,kind)-lim,0);
 if greatest(page-1,0)*25>=excess then return '[]'::jsonb; end if;
 execute format('select coalesce(jsonb_agg(x),''[]''::jsonb) from (select id,name,created_at from public.%I where org_id=$1 order by created_at desc,billing_order desc,id desc limit $2 offset $3)x',kind)
 into result using o,least(25,excess-greatest(page-1,0)*25),greatest(page-1,0)*25;
 return result;
end $$;
