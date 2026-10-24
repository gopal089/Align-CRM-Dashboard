-- Workspace subscriptions. Prices are paise; CRM record currency remains independent.
create table public.subscription_plans (
 code text primary key check(code in ('free','starter','business')),
 name text not null, monthly_price integer not null check(monthly_price>=0),
 currency text not null default 'INR' check(currency='INR'), limits jsonb not null
);
insert into public.subscription_plans(code,name,monthly_price,limits) values
 ('free','Free',0,'{"memberships":3,"contacts":100,"leads":200,"companies":50,"deals":50,"pitch_templates":3}'),
 ('starter','Starter',199900,'{"memberships":10,"contacts":5000,"leads":10000,"companies":2000,"deals":2000,"pitch_templates":25}'),
 ('business','Business',500000,'{"memberships":50,"contacts":50000,"leads":100000,"companies":20000,"deals":null,"pitch_templates":null}');
create table public.organization_subscriptions (
 org_id uuid primary key references public.organizations(id) on delete cascade,
 paid_plan_code text not null default 'free' references public.subscription_plans(code),
 paid_until timestamptz, last_period_start timestamptz, limits_reduced_at timestamptz,
 provider_subscription_id text unique, provider_status text not null default 'unconfigured',
 cancel_at_period_end boolean not null default false,
 scheduled_plan_code text references public.subscription_plans(code), scheduled_change_at timestamptz,
 last_verified_at timestamptz, last_payment_id text,
 checkout_reservation uuid, checkout_started_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.billing_events (
 event_id text primary key, org_id uuid not null references public.organizations(id) on delete cascade,
 event_type text not null, processed_at timestamptz not null default now()
);
create table public.billing_receipts (
 payment_id text primary key, org_id uuid not null references public.organizations(id) on delete cascade,
 subscription_id text not null, invoice_id text not null unique,
 plan_code text not null references public.subscription_plans(code), amount integer not null check(amount>0),
 currency text not null check(currency='INR'), period_start timestamptz not null, period_end timestamptz not null,
 paid_at timestamptz not null, invoice_url text,
 received_at timestamptz not null default now(), check(period_end>period_start)
);
create index billing_events_org_idx on public.billing_events(org_id,processed_at desc);
create index billing_receipts_org_idx on public.billing_receipts(org_id,period_end desc);
create index billing_receipts_plan_idx on public.billing_receipts(plan_code);
create index subscriptions_plan_idx on public.organization_subscriptions(paid_plan_code);
create index subscriptions_scheduled_plan_idx on public.organization_subscriptions(scheduled_plan_code);
create table private.billing_purge_context (transaction_id bigint primary key, org_id uuid not null);
create table private.platform_billing_admins (user_id uuid primary key references auth.users(id) on delete cascade);
create table public.billing_retention_log (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 kind text not null, deleted_count integer not null check(deleted_count>0),
 deadline timestamptz not null, processed_at timestamptz not null default now()
);
create index billing_retention_log_org_idx on public.billing_retention_log(org_id,processed_at desc);
alter table public.memberships add column active boolean not null default true;
create or replace function private.member_role(o uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.memberships where org_id=o and user_id=(select auth.uid()) and active
$$;
do $$ declare t text; begin
 foreach t in array array['subscription_plans','organization_subscriptions','billing_events','billing_receipts','billing_retention_log'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create policy plans_read on public.subscription_plans for select to authenticated using (true);
create policy subscription_read on public.organization_subscriptions for select to authenticated using ((select private.member_role(org_id))='Administrator');
create policy events_read on public.billing_events for select to authenticated using ((select private.member_role(org_id))='Administrator');
create policy receipts_read on public.billing_receipts for select to authenticated using ((select private.member_role(org_id))='Administrator');
create policy retention_log_read on public.billing_retention_log for select to authenticated using ((select private.member_role(org_id))='Administrator');
insert into public.organization_subscriptions(org_id) select id from public.organizations;
create function private.init_billing() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into public.organization_subscriptions(org_id) values(new.id); return new; end $$;
create trigger init_billing after insert on public.organizations for each row execute function private.init_billing();

create function private.billing_plan(o uuid) returns text language sql stable security definer set search_path='' as $$
 select case when paid_until>statement_timestamp() then paid_plan_code else 'free' end
 from public.organization_subscriptions where org_id=o
$$;
create function private.billing_limit(o uuid, kind text) returns integer language sql stable security definer set search_path='' as $$
 select (limits->>kind)::integer from public.subscription_plans where code=coalesce(private.billing_plan(o),'free')
$$;
create function private.billing_deadline(o uuid) returns timestamptz language sql stable security definer set search_path='' as $$
 select (case when paid_until<=statement_timestamp() then paid_until else limits_reduced_at end)+interval '7 days'
 from public.organization_subscriptions where org_id=o
$$;
create function private.billing_is_purging(o uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.billing_purge_context where transaction_id=txid_current() and org_id=o)
$$;
create function private.billing_count(o uuid, kind text) returns bigint language plpgsql stable security definer set search_path='' as $$
declare n bigint; begin
 if kind not in ('memberships','contacts','leads','companies','deals','pitch_templates') then return 0; end if;
 execute format('select count(*) from public.%I where org_id=$1%s',kind,
 case when kind='memberships' then ' and active' when kind='deals' then ' and outcome=''open'' and archived_at is null' else '' end) into n using o;
 return n;
end $$;
do $$ declare t text; begin
 foreach t in array array['companies','contacts','leads'] loop
 execute format('alter table public.%I add column billing_order bigint generated always as identity',t);
 end loop;
end $$;
create function private.billing_preserved(o uuid, kind text, record_id uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare lim integer; n bigint; begin
 if kind not in ('contacts','leads','companies') or private.billing_deadline(o) is null then return false; end if;
 lim:=private.billing_limit(o,kind);
 if lim is null then return false; end if;
 execute format('select count(*) from public.%1$I r join public.%1$I target on target.id=$2 and target.org_id=$1 where r.org_id=$1 and (r.created_at,r.billing_order,r.id)<=(target.created_at,target.billing_order,target.id)',kind) into n using o,record_id;
 return n>lim;
end $$;
create function private.billing_readable(o uuid, kind text, record_id uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare deadline timestamptz; begin
 if private.member_role(o) is null then return false; end if;
 deadline:=private.billing_deadline(o);
 if deadline is null or statement_timestamp()<deadline then return true; end if;
 return not private.billing_preserved(o,kind,record_id);
end
$$;
do $$ declare t text; begin
 foreach t in array array['companies','contacts','leads'] loop
 execute format('create index %I on public.%I(org_id,created_at,billing_order,id)',t||'_billing_order',t);
 execute format('drop policy org_read on public.%I',t);
 execute format('create policy org_read on public.%I for select to authenticated using (private.billing_readable(org_id,%L,id))',t,t);
 end loop;
end $$;

-- All quota changes use the same workspace lock: concurrent saves cannot oversubscribe.
create function private.enforce_billing_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare o uuid; lim integer; n bigint; counts_before boolean; counts_after boolean; begin
 o:=case when TG_OP='DELETE' then old.org_id else new.org_id end;
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 if private.billing_is_purging(o) then return case when TG_OP='DELETE' then old else new end; end if;
 if TG_TABLE_NAME in ('companies','contacts','leads') then
  if TG_OP='UPDATE' and new.billing_order<>old.billing_order then raise exception 'Record creation order cannot be changed'; end if;
 end if;
 if TG_OP<>'INSERT' and private.billing_preserved(o,TG_TABLE_NAME,old.id) then
  raise exception 'Just upgrade your plan to edit or export.';
 end if;
 if TG_OP='DELETE' then return old; end if;
 if TG_OP='INSERT' then new.created_at:=clock_timestamp(); end if;
 counts_after:=true; counts_before:=TG_OP='UPDATE';
 if TG_TABLE_NAME='deals' then
  counts_after:=new.outcome='open' and new.archived_at is null;
  if TG_OP='UPDATE' then counts_before:=old.outcome='open' and old.archived_at is null; end if;
 elsif TG_TABLE_NAME='memberships' then
  if TG_OP='UPDATE' and old.active and old.role='Administrator' and (not new.active or new.role<>'Administrator') and (select count(*) from public.memberships where org_id=o and active and role='Administrator')<=1 then raise exception 'Keep at least one active administrator'; end if;
  counts_after:=new.active;
  if TG_OP='UPDATE' then counts_before:=old.active; end if;
 end if;
 if counts_after and not counts_before then
  lim:=private.billing_limit(o,TG_TABLE_NAME); n:=private.billing_count(o,TG_TABLE_NAME);
  if lim is not null and n>=lim then raise exception 'Plan limit reached for %: % of %. Upgrade your plan to add more.',TG_TABLE_NAME,n,lim; end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['companies','contacts','leads','deals','pitch_templates','memberships'] loop
 -- Name sorts after validate_record, so the configured deal outcome is already normalized.
 execute format('create trigger zz_billing_quota before insert or update or delete on public.%I for each row execute function private.enforce_billing_quota()',t);
 end loop;
end $$;

create function public.billing_status(o uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.organization_subscriptions; p public.subscription_plans; usage jsonb='{}'; k text; lim integer; n bigint; excess integer; begin
 if auth.uid() is null or private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 select * into s from public.organization_subscriptions where org_id=o;
 select * into p from public.subscription_plans where code=private.billing_plan(o);
 foreach k in array array['memberships','contacts','leads','companies','deals','pitch_templates'] loop
  lim:=(p.limits->>k)::integer; n:=private.billing_count(o,k);
  excess:=case when lim is null then 0 else greatest(n-lim,0) end;
  usage:=usage||jsonb_build_object(k,jsonb_build_object('used',n,'limit',lim,'excess',excess));
 end loop;
 return jsonb_build_object('plan',to_jsonb(p),'paid_plan',s.paid_plan_code,'paid_until',s.paid_until,
  'status',s.provider_status,'cancel_at_period_end',s.cancel_at_period_end,'scheduled_plan',s.scheduled_plan_code,
  'scheduled_change_at',s.scheduled_change_at,'usage',usage,'retention_deadline',private.billing_deadline(o),
  'server_time',statement_timestamp(),'renewal_warning',s.paid_until>statement_timestamp() and s.paid_until<=statement_timestamp()+interval '7 days');
end $$;
create function public.billing_record_permissions(o uuid, kind text, ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r uuid; result jsonb='{}'; preserved boolean; begin
 if auth.uid() is null or private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 if cardinality(ids)>500 then raise exception 'At most 500 records per request'; end if;
 foreach r in array ids loop
  preserved:=private.billing_preserved(o,kind,r);
  result:=result||jsonb_build_object(r,jsonb_build_object('preserved',preserved,'delete_at',case when preserved then private.billing_deadline(o) else null end));
 end loop;
 return result;
end $$;
create function public.billing_assert_export(o uuid, kind text default 'workspace') returns void language plpgsql stable security definer set search_path='' as $$
declare k text; lim integer; begin
 if auth.uid() is null or private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 if private.billing_deadline(o) is null then return; end if;
 foreach k in array array['companies','contacts','leads'] loop
  if kind='workspace' or kind=k then
   lim:=private.billing_limit(o,k);
   if lim is not null and private.billing_count(o,k)>lim then raise exception 'Just upgrade your plan to edit or export.'; end if;
  end if;
 end loop;
end $$;
create function public.billing_retained_records(o uuid, kind text, page integer default 1) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; lim integer; begin
 if auth.uid() is null or private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 if kind not in ('contacts','leads','companies') then raise exception 'Unsupported customer record type'; end if;
 if private.billing_deadline(o) is null then return '[]'::jsonb; end if;
 lim:=private.billing_limit(o,kind);
 execute format('select coalesce(jsonb_agg(x),''[]''::jsonb) from (select id,name,created_at from public.%I where org_id=$1 order by created_at desc,billing_order desc,id desc limit 25 offset $2)x',kind)
 into result using o,greatest(page-1,0)*25;
 -- Only expose the newest excess records; retained pagination never includes the kept partition.
 if greatest(page-1,0)*25>=greatest(private.billing_count(o,kind)-lim,0) then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(v) from jsonb_array_elements(result) with ordinality a(v,i) where i<=greatest(private.billing_count(o,kind)-lim,0)-greatest(page-1,0)*25),'[]'::jsonb);
end $$;
create function public.set_member_active(o uuid, member_id uuid, enabled boolean) returns void language plpgsql security definer set search_path='' as $$
declare m public.memberships; begin
 if auth.uid() is null or private.member_role(o) is distinct from 'Administrator' then raise exception 'Administrator access required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 select * into m from public.memberships where org_id=o and id=member_id for update;
 if m.id is null then raise exception 'Member unavailable'; end if;
 if not enabled and m.active and m.role='Administrator' and (select count(*) from public.memberships where org_id=o and active and role='Administrator')<=1 then raise exception 'Keep at least one active administrator'; end if;
 update public.memberships set active=enabled where id=m.id;
end $$;

-- Purge authority is server-only and rechecks the current plan under the workspace lock.
-- A recent successful provider reconciliation is required before deleting paid-workspace data.
create function private.process_billing_retention(o uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.organization_subscriptions; k text; lim integer; victims uuid[]; n integer; result jsonb='{}'; deadline timestamptz; begin
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 select * into s from public.organization_subscriptions where org_id=o for update;
 deadline:=private.billing_deadline(o);
 if deadline is null or statement_timestamp()<deadline or s.last_verified_at is null or s.last_verified_at<statement_timestamp()-interval '10 minutes' then return result; end if;
 insert into private.billing_purge_context values(txid_current(),o);
 foreach k in array array['leads','contacts','companies'] loop
  lim:=private.billing_limit(o,k);
  execute format('select array_agg(id) from(select id from public.%I where org_id=$1 order by created_at asc,billing_order asc,id asc offset $2)x',k) into victims using o,lim;
  if cardinality(victims)>0 then
   -- Preserve deals, pitches, tasks, activities and payments; detach only their customer links.
   if k='leads' then
    update public.deals set lead_id=null where org_id=o and lead_id=any(victims);
    update public.pitches set lead_id=null where org_id=o and lead_id=any(victims);
   elsif k='contacts' then
    update public.leads set converted_contact_id=null where org_id=o and converted_contact_id=any(victims);
    update public.deals set contact_id=null where org_id=o and contact_id=any(victims);
    update public.pitches set contact_id=null where org_id=o and contact_id=any(victims);
   else
    update public.contacts set company_id=null where org_id=o and company_id=any(victims);
    update public.deals set company_id=null where org_id=o and company_id=any(victims);
    update public.pitches set company_id=null where org_id=o and company_id=any(victims);
   end if;
   execute format('delete from public.%I where org_id=$1 and id=any($2)',k) using o,victims;
   get diagnostics n=row_count;
   insert into public.billing_retention_log(org_id,kind,deleted_count,deadline) values(o,k,n,deadline);
   result:=result||jsonb_build_object(k,n);
  end if;
 end loop;
 delete from private.billing_purge_context where transaction_id=txid_current();
 return result;
end $$;
-- Narrow exception for the internal retention job when detaching a converted contact.
do $$ declare body text; begin
 select prosrc into body from pg_proc where oid='private.validate_record()'::regprocedure;
 body:=replace(body,'if TG_TABLE_NAME=''leads'' then','if TG_TABLE_NAME=''leads'' and not private.billing_is_purging(new.org_id) then');
 body:=replace(body,'if new.status=''Converted'' and (new.converted_contact_id is null or new.converted_deal_id is null) then','if new.status=''Converted'' and ((new.converted_contact_id is null and (TG_OP=''INSERT'' or old.status<>''Converted'' or old.converted_contact_id is not null)) or new.converted_deal_id is null) then');
 execute 'create or replace function private.validate_record() returns trigger language plpgsql security invoker set search_path='''' as '||quote_literal(body);
end $$;

create function public.billing_process_retention(o uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.process_billing_retention(o) $$;
create function public.billing_reserve_checkout(o uuid, reservation uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 update public.organization_subscriptions set checkout_reservation=reservation,checkout_started_at=statement_timestamp()
 where org_id=o and checkout_reservation is null and (paid_until is null or paid_until<=statement_timestamp());
 return found;
end $$;
create function public.billing_finish_checkout(o uuid, reservation uuid, sub_id text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 if sub_id !~ '^sub_[A-Za-z0-9]+$' then raise exception 'Invalid provider subscription ID'; end if;
 update public.organization_subscriptions set provider_subscription_id=sub_id,provider_status='created',checkout_reservation=null,checkout_started_at=null,cancel_at_period_end=false
 where org_id=o and checkout_reservation=reservation;
 if not found then raise exception 'Checkout reservation mismatch'; end if;
end $$;
create function public.billing_release_checkout(o uuid, reservation uuid) returns void language sql security definer set search_path='' as $$
 update public.organization_subscriptions set checkout_reservation=null,checkout_started_at=null where org_id=o and checkout_reservation=reservation
$$;
create function public.billing_validate_job_token(token text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare expected text; begin
 if token is null or length(token)<64 or length(token)>128 or to_regclass('vault.decrypted_secrets') is null then return false; end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where name=''align_billing_job_token'' limit 1' into expected;
 return coalesce(token=expected,false);
end $$;
create function public.billing_apply_receipt(o uuid, sub_id text, state jsonb, receipt jsonb default null, event_id text default null, event_type text default 'sync') returns void language plpgsql security definer set search_path='' as $$
declare s public.organization_subscriptions; p public.subscription_plans; start_time timestamptz; end_time timestamptz; begin
 perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0));
 select * into s from public.organization_subscriptions where org_id=o for update;
 if s.provider_subscription_id is distinct from sub_id then raise exception 'Subscription does not belong to this workspace'; end if;
 if receipt is not null then
  select * into p from public.subscription_plans where code=receipt->>'plan_code' and monthly_price>0;
  start_time:=(receipt->>'period_start')::timestamptz; end_time:=(receipt->>'period_end')::timestamptz;
  if p.code is null or receipt->>'currency'<>'INR' or (receipt->>'amount')::integer<p.monthly_price or start_time is null or end_time is null or end_time<=start_time or start_time>statement_timestamp()+interval '5 minutes' then raise exception 'Invalid paid billing period'; end if;
  insert into public.billing_receipts(payment_id,org_id,subscription_id,invoice_id,plan_code,amount,currency,period_start,period_end,paid_at,invoice_url)
   values(receipt->>'payment_id',o,sub_id,receipt->>'invoice_id',p.code,(receipt->>'amount')::integer,'INR',start_time,end_time,(receipt->>'paid_at')::timestamptz,case when receipt->>'invoice_url' ~ '^https://rzp\.io/' then receipt->>'invoice_url' else null end) on conflict do nothing;
  -- Never let a replayed older receipt extend access, change a newer plan, or reset retention.
  if found and end_time>coalesce(s.paid_until,'1970-01-01') then
   update public.organization_subscriptions set limits_reduced_at=case when p.monthly_price<(select monthly_price from public.subscription_plans where code=s.paid_plan_code) then start_time else null end,paid_plan_code=p.code,paid_until=end_time,last_period_start=start_time,last_payment_id=receipt->>'payment_id',scheduled_plan_code=null,scheduled_change_at=null where org_id=o;
  end if;
 end if;
 update public.organization_subscriptions set provider_status=coalesce(state->>'status',provider_status),last_verified_at=statement_timestamp() where org_id=o;
 if event_id is not null then
  insert into public.billing_events values(event_id,o,event_type,statement_timestamp()) on conflict do nothing;
 end if;
end $$;

create function public.platform_billing_access() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from private.platform_billing_admins where user_id=(select auth.uid()))
$$;
create function public.platform_billing_report(start_at timestamptz, end_at timestamptz) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.platform_billing_access() then raise exception 'Platform billing owner access required'; end if;
 if end_at<=start_at then raise exception 'Choose a valid reporting period'; end if;
 return jsonb_build_object(
  'currency','INR','trials_enabled',false,
  'active_subscriptions',(select count(*) from public.organization_subscriptions where paid_until>statement_timestamp() and paid_plan_code<>'free'),
  'mrr',(select coalesce(sum(p.monthly_price),0) from public.organization_subscriptions s join public.subscription_plans p on p.code=s.paid_plan_code where s.paid_until>statement_timestamp()),
  'collected',(select coalesce(sum(amount),0) from public.billing_receipts where paid_at>=start_at and paid_at<end_at),
  'scheduled_cancellations',(select count(*) from public.organization_subscriptions where cancel_at_period_end and paid_until>statement_timestamp()),
  'failed_renewals',(select count(*) from public.organization_subscriptions where paid_until<=statement_timestamp() and provider_status in ('pending','halted') and not cancel_at_period_end),
  'events',coalesce((select jsonb_agg(x) from(select event_type,count(*) count from public.billing_events where processed_at>=start_at and processed_at<end_at group by event_type)x),'[]'::jsonb)
 );
end $$;
revoke all on function public.platform_billing_access(),public.platform_billing_report(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.platform_billing_access(),public.platform_billing_report(timestamptz,timestamptz) to authenticated;

revoke all on all functions in schema private from public,anon;
grant execute on function private.billing_readable(uuid,text,uuid),private.billing_is_purging(uuid) to authenticated;
revoke all on function public.billing_status(uuid),public.billing_record_permissions(uuid,text,uuid[]),public.billing_assert_export(uuid,text),public.billing_retained_records(uuid,text,integer),public.set_member_active(uuid,uuid,boolean),public.billing_process_retention(uuid),public.billing_apply_receipt(uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.billing_status(uuid),public.billing_record_permissions(uuid,text,uuid[]),public.billing_assert_export(uuid,text),public.billing_retained_records(uuid,text,integer),public.set_member_active(uuid,uuid,boolean) to authenticated;
revoke all on function public.billing_reserve_checkout(uuid,uuid),public.billing_finish_checkout(uuid,uuid,text),public.billing_release_checkout(uuid,uuid),public.billing_validate_job_token(text) from public,anon,authenticated;
do $$ begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant usage on schema private to service_role;
  grant all on public.organization_subscriptions,public.billing_events,public.billing_receipts,public.billing_retention_log to service_role;
  grant select on public.subscription_plans,public.memberships to service_role;
  grant execute on function private.process_billing_retention(uuid),public.billing_process_retention(uuid),public.billing_apply_receipt(uuid,text,jsonb,jsonb,text,text) to service_role;
  grant execute on function public.billing_reserve_checkout(uuid,uuid),public.billing_finish_checkout(uuid,uuid,text),public.billing_release_checkout(uuid,uuid),public.billing_validate_job_token(text) to service_role;
 end if;
end $$;
