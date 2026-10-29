-- Application session enforcement complements Supabase Auth; never mutate auth tables.
create table private.security_accounts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 factor_id uuid, pending_factor_id uuid, enabled_at timestamptz,
 backup_hashes text[] not null default '{}'
);
create table private.security_sessions (
 session_id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(), last_active timestamptz not null default now(),
 verified_at timestamptz, revoked_at timestamptz
);
create index security_sessions_user_idx on private.security_sessions(user_id);
create table private.security_attempts (
 bucket text primary key, started_at timestamptz not null, attempts integer not null
);
alter table private.security_accounts enable row level security;
alter table private.security_sessions enable row level security;
alter table private.security_attempts enable row level security;
revoke all on private.security_accounts,private.security_sessions,private.security_attempts from public,anon,authenticated;

create function private.security_session_ok() returns boolean language sql stable security definer set search_path='' as $$
 select exists (
  select 1 from private.security_sessions s
  join auth.sessions n on n.id=s.session_id and n.user_id=s.user_id
  left join private.security_accounts a on a.user_id=s.user_id
  where s.user_id=(select auth.uid())
   and s.session_id=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid
   and s.revoked_at is null and s.last_active>statement_timestamp()-interval '30 minutes'
   and (n.not_after is null or n.not_after>statement_timestamp())
   and (a.enabled_at is null or s.verified_at>=a.enabled_at)
 )
$$;
revoke all on function private.security_session_ok() from public;
grant execute on function private.security_session_ok() to authenticated;
create function public.security_session_ok() returns boolean language sql stable security invoker set search_path='' as $$
 select private.security_session_ok()
$$;
revoke all on function public.security_session_ok() from public,anon;
grant execute on function public.security_session_ok() to authenticated;

-- An additional restrictive policy cannot be bypassed by permissive business policies.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' and rowsecurity loop
  execute format('create policy account_security on public.%I as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()))',t.tablename);
 end loop;
end $$;
create or replace function private.member_role(o uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.memberships where org_id=o and user_id=(select auth.uid()) and active and private.security_session_ok()
$$;
-- Guard security-definer paths that do not use member_role/RLS.
create or replace function private.platform_billing_access() returns boolean language sql stable security definer set search_path='' as $$
 select private.security_session_ok() and exists(select 1 from private.platform_billing_admins where user_id=(select auth.uid()))
$$;
create or replace function private.create_workspace(n text, person text) returns uuid language plpgsql security definer set search_path='' as $$
declare o uuid; begin
 if not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
 if exists(select 1 from public.memberships where user_id=auth.uid()) then raise exception 'You already belong to a workspace'; end if;
 insert into public.profiles(id,name,email) values(auth.uid(),trim(person),(select email from auth.users where id=auth.uid())) on conflict(id) do nothing;
 insert into public.organizations(name) values(trim(n)) returning id into o;
 insert into public.memberships(org_id,user_id,role) values(o,auth.uid(),'Administrator');
 return o;
end $$;

-- Separate committed RPC: rejected attempts must not roll back the rate-limit counter.
create function public.security_rate_limit(b text, max_attempts integer) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; begin
 if length(b)>200 or max_attempts not between 1 and 100 then raise exception 'Invalid rate limit'; end if;
 insert into private.security_attempts values(b,statement_timestamp(),1)
 on conflict(bucket) do update set
 attempts=case when security_attempts.started_at<statement_timestamp()-interval '15 minutes' then 1 else security_attempts.attempts+1 end,
 started_at=case when security_attempts.started_at<statement_timestamp()-interval '15 minutes' then statement_timestamp() else security_attempts.started_at end
 returning attempts into n;
 delete from private.security_attempts where started_at<statement_timestamp()-interval '1 day';
 return n<=max_attempts;
end $$;

create function public.security_service(action text,u uuid,sid uuid,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.security_sessions; a private.security_accounts; target uuid; consumed boolean; begin
 if not exists(select 1 from auth.sessions where id=sid and user_id=u and (not_after is null or not_after>statement_timestamp())) then raise exception 'Session expired. Sign in again'; end if;
 -- Serialize account changes, backup-code consumption and revocation.
 perform pg_advisory_xact_lock(hashtext(u::text));
 insert into private.security_accounts(user_id) values(u) on conflict do nothing;
 select * into a from private.security_accounts where user_id=u for update;
 if action='register' then
  insert into private.security_sessions(session_id,user_id) values(sid,u) on conflict do nothing;
 end if;
 select * into s from private.security_sessions where session_id=sid and user_id=u for update;
 if s.session_id is null or s.revoked_at is not null or s.last_active<=statement_timestamp()-interval '30 minutes' then raise exception 'Session expired. Sign in again'; end if;
 if action in ('register','status') then
  return jsonb_build_object('enabled',a.enabled_at is not null,'needs_code',a.enabled_at is not null and (s.verified_at is null or s.verified_at<a.enabled_at),'factor_id',a.factor_id,'pending_factor_id',a.pending_factor_id,'expires_at',s.last_active+interval '30 minutes','session_id',sid);
 end if;
 if action='verify' then
  if a.enabled_at is null or (payload->>'factor_id')::uuid is distinct from a.factor_id then raise exception 'Invalid factor'; end if;
  update private.security_sessions set verified_at=statement_timestamp(),last_active=statement_timestamp() where session_id=sid;
 elsif action='backup' then
  consumed:=a.enabled_at is not null and payload->>'hash'=any(a.backup_hashes);
  if consumed is not true then return jsonb_build_object('valid',false); end if;
  update private.security_accounts set backup_hashes=array_remove(backup_hashes,payload->>'hash') where user_id=u;
  update private.security_sessions set verified_at=statement_timestamp(),last_active=statement_timestamp() where session_id=sid;
  return jsonb_build_object('valid',true);
 else
  if a.enabled_at is not null and (s.verified_at is null or s.verified_at<a.enabled_at) then raise exception 'Two-step verification required'; end if;
  if action='touch' then
   update private.security_sessions set last_active=statement_timestamp() where session_id=sid;
   return jsonb_build_object('expires_at',statement_timestamp()+interval '30 minutes');
  elsif action='pending' then
   if a.enabled_at is not null then raise exception '2FA is already enabled'; end if;
   update private.security_accounts set pending_factor_id=(payload->>'factor_id')::uuid where user_id=u;
  elsif action='enable' then
   if a.pending_factor_id is null or a.enabled_at is not null or (payload->>'factor_id')::uuid is distinct from a.pending_factor_id then raise exception 'Setup has changed. Start again'; end if;
   update private.security_accounts set factor_id=pending_factor_id,pending_factor_id=null,enabled_at=statement_timestamp(),backup_hashes=array(select jsonb_array_elements_text(payload->'hashes')) where user_id=u;
   update private.security_sessions set verified_at=statement_timestamp() where session_id=sid;
  elsif action='disable' then
   if a.enabled_at is null or a.factor_id is distinct from (payload->>'factor_id')::uuid then raise exception 'Setup has changed. Retry'; end if;
   update private.security_accounts set factor_id=null,enabled_at=null,pending_factor_id=null,backup_hashes='{}' where user_id=u;
   update private.security_sessions set revoked_at=statement_timestamp() where user_id=u and session_id<>sid;
  elsif action='codes' then
   if a.enabled_at is null or a.factor_id is distinct from (payload->>'factor_id')::uuid then raise exception 'Setup has changed. Retry'; end if;
   update private.security_accounts set backup_hashes=array(select jsonb_array_elements_text(payload->'hashes')) where user_id=u;
  elsif action='revoke' then
   target:=(payload->>'session_id')::uuid;
   update private.security_sessions set revoked_at=statement_timestamp() where user_id=u and session_id=target;
  elsif action='revoke_others' then
   update private.security_sessions set revoked_at=statement_timestamp() where user_id=u and session_id<>sid;
  elsif action='sessions' then
   return coalesce((select jsonb_agg(jsonb_build_object('id',x.session_id,'current',x.session_id=sid,'device',left(coalesce(n.user_agent,'Unknown device'),250),'ip',host(n.ip),'last_active',x.last_active,'created_at',x.created_at) order by x.last_active desc) from private.security_sessions x join auth.sessions n on n.id=x.session_id and n.user_id=x.user_id where x.user_id=u and x.revoked_at is null and x.last_active>statement_timestamp()-interval '30 minutes' and (n.not_after is null or n.not_after>statement_timestamp())),'[]');
  else raise exception 'Unknown security action'; end if;
 end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.security_rate_limit(text,integer),public.security_service(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.security_rate_limit(text,integer),public.security_service(text,uuid,uuid,jsonb) to service_role;
