-- Calendar integration.
-- 1. A private subscribe link (iCalendar feed) of a member's open tasks.
-- 2. Google Calendar, both ways: open tasks with due dates become all-day
--    events in the member's own calendar; meetings in that calendar whose
--    guests include a lead or contact become Meeting activities in Align.
-- Each member connects their own calendar, per workspace. Google refresh
-- tokens are kept in Supabase Vault. Every function a signed-in member can
-- call is a thin public wrapper over a private one, like the rest of the API.

create table private.calendar_feeds (
 org_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 last_used_at timestamptz,
 primary key(org_id,user_id)
);
create table private.calendar_oauth_states (
 state_hash text primary key check(state_hash ~ '^[a-f0-9]{64}$'),
 org_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 return_to text not null check(return_to ~ '^https?://[^/?#]+$'),
 expires_at timestamptz not null default now()+interval '10 minutes'
);
create table private.calendar_connections (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 google_email text not null default '' check(length(google_email)<=254),
 secret_id uuid,
 -- Only for the isolated test database, which has no Vault (see below).
 test_refresh_token text,
 sync_token text check(length(sync_token)<=2000),
 status text not null default 'active' check(status in ('active','reconnect')),
 last_error text check(length(last_error)<=500),
 last_synced_at timestamptz,
 created_at timestamptz not null default now(),
 unique(org_id,user_id)
);
create table private.calendar_task_events (
 connection_id uuid not null references private.calendar_connections(id) on delete cascade,
 task_id uuid not null,
 fingerprint text not null,
 synced_at timestamptz not null default now(),
 primary key(connection_id,task_id)
);
create table private.calendar_event_activities (
 connection_id uuid not null references private.calendar_connections(id) on delete cascade,
 event_id text not null check(length(event_id)<=1024),
 activity_id uuid not null,
 primary key(connection_id,event_id)
);
do $$ declare t text; begin
 foreach t in array array['calendar_feeds','calendar_oauth_states','calendar_connections','calendar_task_events','calendar_event_activities'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('revoke all on private.%I from anon,authenticated',t);
  execute format('create policy account_security on private.%I as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()))',t);
 end loop;
end $$;

-- Helpers -------------------------------------------------------------------
create function private.calendar_hash(token text) returns text language sql immutable set search_path='' as
$$select encode(sha256(convert_to(token,'UTF8')),'hex')$$;
-- Google event IDs may use 0-9 and a-v, so a task ID (hex) maps to a fixed
-- event ID. Creating the same task twice can never make two events.
create function private.calendar_event_id(task uuid) returns text language sql immutable set search_path='' as
$$select 'align'||replace(task::text,'-','')$$;
create function private.calendar_member(o uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 if private.member_role(o) is null then raise exception 'Workspace access required'; end if;
 return auth.uid();
end $$;

-- Signed-in member: status, subscribe link, starting a Google connection ----
create function private.calendar_status(o uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=private.calendar_member(o);
begin
 return jsonb_build_object(
  'feed',(select jsonb_build_object('created_at',created_at,'last_used_at',last_used_at) from private.calendar_feeds where org_id=o and user_id=u),
  'google',(select jsonb_build_object('email',google_email,'status',status,'last_error',last_error,'last_synced_at',last_synced_at,'connected_at',created_at) from private.calendar_connections where org_id=o and user_id=u));
end $$;
-- Returns the new token once; only its hash is kept, and the old link stops working.
create function private.calendar_new_feed(o uuid) returns text language plpgsql security definer set search_path='' as $$
declare u uuid:=private.calendar_member(o); token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
begin
 insert into private.calendar_feeds(org_id,user_id,token_hash) values(o,u,private.calendar_hash(token))
 on conflict(org_id,user_id) do update set token_hash=excluded.token_hash,created_at=now(),last_used_at=null;
 return token;
end $$;
create function private.calendar_remove_feed(o uuid) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=private.calendar_member(o);
begin delete from private.calendar_feeds where org_id=o and user_id=u; end $$;
create function private.calendar_begin_connect(o uuid, state_hash text, return_to text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=private.calendar_member(o);
begin
 if coalesce(state_hash,'') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid connection request'; end if;
 delete from private.calendar_oauth_states where expires_at<now() or (org_id=o and user_id=u);
 insert into private.calendar_oauth_states(state_hash,org_id,user_id,return_to) values(state_hash,o,u,return_to);
end $$;

create function public.calendar_status(o uuid) returns jsonb language sql security invoker set search_path='' as $$select private.calendar_status(o)$$;
create function public.calendar_new_feed(o uuid) returns text language sql security invoker set search_path='' as $$select private.calendar_new_feed(o)$$;
create function public.calendar_remove_feed(o uuid) returns void language sql security invoker set search_path='' as $$select private.calendar_remove_feed(o)$$;
create function public.calendar_begin_connect(o uuid, state_hash text, return_to text) returns void language sql security invoker set search_path='' as $$select private.calendar_begin_connect(o,state_hash,return_to)$$;

-- Server only: the feed --------------------------------------------------------
create function public.calendar_feed(link_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare f private.calendar_feeds; o public.organizations; today date;
begin
 select * into f from private.calendar_feeds where token_hash=link_hash;
 if f.user_id is null or not exists(select 1 from public.memberships m where m.org_id=f.org_id and m.user_id=f.user_id and m.active) then raise exception 'This calendar link is not valid'; end if;
 select * into o from public.organizations where id=f.org_id;
 today:=(now() at time zone o.timezone)::date;
 update private.calendar_feeds set last_used_at=now() where org_id=f.org_id and user_id=f.user_id;
 return jsonb_build_object('org',o.name,'timezone',o.timezone,'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'due',t.due_date,'priority',t.priority,'description',t.description,'updated_at',t.updated_at) order by t.due_date)
  from (select * from public.tasks t where t.org_id=f.org_id and t.owner_id=f.user_id and t.archived_at is null and t.status<>'Completed' and t.due_date between today-30 and today+365 order by t.due_date limit 500) t),'[]'::jsonb));
end $$;

-- Server only: Google connection lifecycle --------------------------------------
create function public.calendar_take_state(state_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.calendar_oauth_states;
begin
 delete from private.calendar_oauth_states where calendar_oauth_states.state_hash=calendar_take_state.state_hash returning * into s;
 if s.state_hash is null or s.expires_at<now() then raise exception 'This connection request expired. Start again from Settings'; end if;
 return jsonb_build_object('org_id',s.org_id,'user_id',s.user_id,'return_to',s.return_to);
end $$;
create function public.calendar_save_connection(o uuid, u uuid, email text, refresh_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare c private.calendar_connections; sid uuid;
begin
 if not exists(select 1 from public.memberships m where m.org_id=o and m.user_id=u and m.active) then raise exception 'Workspace access required'; end if;
 if coalesce(refresh_token,'')='' then raise exception 'Google did not grant offline access. Start again from Settings'; end if;
 select * into c from private.calendar_connections where org_id=o and user_id=u for update;
 if to_regclass('vault.secrets') is not null then
  if c.secret_id is not null then
   execute 'select vault.update_secret($1,$2)' using c.secret_id,refresh_token;
   sid:=c.secret_id;
  else
   execute 'select vault.create_secret($1,$2,$3)' into sid using refresh_token,'align_calendar_'||gen_random_uuid(),'Google Calendar refresh token';
  end if;
 elsif coalesce(current_setting('align.calendar_test_tokens',true),'')<>'on' then
  raise exception 'Supabase Vault is required to store calendar credentials';
 end if;
 insert into private.calendar_connections(org_id,user_id,google_email,secret_id,test_refresh_token,status,last_error)
 values(o,u,left(coalesce(email,''),254),sid,case when sid is null then refresh_token end,'active',null)
 on conflict(org_id,user_id) do update set google_email=excluded.google_email,secret_id=excluded.secret_id,test_refresh_token=excluded.test_refresh_token,status='active',last_error=null
 returning * into c;
 return c.id;
end $$;
create function public.calendar_connections_due(max_rows integer default 20) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'org_id',c.org_id,'user_id',c.user_id,'email',c.google_email,'sync_token',c.sync_token) order by c.last_synced_at nulls first),'[]'::jsonb)
 from (select c.* from private.calendar_connections c
  join public.memberships m on m.org_id=c.org_id and m.user_id=c.user_id and m.active
  where c.status='active' order by c.last_synced_at nulls first limit greatest(1,least(max_rows,50))) c
$$;
create function public.calendar_connection(o uuid, u uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('id',c.id,'org_id',c.org_id,'user_id',c.user_id,'email',c.google_email,'sync_token',c.sync_token)
 from private.calendar_connections c where c.org_id=o and c.user_id=u
$$;
create function public.calendar_refresh_token(conn uuid) returns text language plpgsql security definer set search_path='' as $$
declare c private.calendar_connections; token text;
begin
 select * into c from private.calendar_connections where id=conn;
 if c.secret_id is not null then
  execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into token using c.secret_id;
  return token;
 end if;
 return c.test_refresh_token;
end $$;
create function public.calendar_finish(conn uuid, new_sync_token text default null, failure text default null, reconnect boolean default false) returns void language sql security definer set search_path='' as $$
 update private.calendar_connections set
  sync_token=case when reconnect then null else coalesce(new_sync_token,sync_token) end,
  status=case when reconnect then 'reconnect' else status end,
  last_error=left(failure,500),
  last_synced_at=case when failure is null then now() else last_synced_at end
 where id=conn
$$;
create function public.calendar_reset_sync(conn uuid) returns void language sql security definer set search_path='' as $$
 update private.calendar_connections set sync_token=null where id=conn
$$;
-- Removes the connection and its Vault secret; returns what the server needs to
-- tidy Google: the refresh token and the events Align created.
create function public.calendar_detach(o uuid, u uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.calendar_connections; token text; events jsonb;
begin
 select * into c from private.calendar_connections where org_id=o and user_id=u for update;
 if c.id is null then return null; end if;
 token:=public.calendar_refresh_token(c.id);
 select coalesce(jsonb_agg(private.calendar_event_id(task_id)),'[]'::jsonb) into events from private.calendar_task_events where connection_id=c.id;
 delete from private.calendar_connections where id=c.id;
 if c.secret_id is not null then execute 'delete from vault.secrets where id=$1' using c.secret_id; end if;
 return jsonb_build_object('refresh_token',token,'events',events);
end $$;

-- Server only: Align -> Google ---------------------------------------------------
-- What should be in the calendar, compared with what Align last put there.
create function public.calendar_plan(conn uuid, max_ops integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.calendar_connections; o public.organizations; today date; result jsonb;
begin
 select * into c from private.calendar_connections where id=conn;
 select * into o from public.organizations where id=c.org_id;
 today:=(now() at time zone o.timezone)::date;
 with wanted as (
  select t.id,t.name,t.due_date,t.priority,t.description,
   md5(concat_ws('|',t.name,t.due_date,t.priority,t.description)) fp
  from public.tasks t
  where t.org_id=c.org_id and t.owner_id=c.user_id and t.archived_at is null and t.status<>'Completed'
   and t.due_date between today-30 and today+365
 ), upserts as (
  select w.* from wanted w left join private.calendar_task_events e on e.connection_id=conn and e.task_id=w.id
  where e.task_id is null or e.fingerprint<>w.fp order by w.due_date limit greatest(1,least(max_ops,200))
 ), removals as (
  select e.task_id from private.calendar_task_events e
  where e.connection_id=conn and not exists(select 1 from wanted w where w.id=e.task_id) limit greatest(1,least(max_ops,200))
 )
 select jsonb_build_object(
  'org',o.name,
  'upsert',coalesce((select jsonb_agg(jsonb_build_object('task',u.id,'event_id',private.calendar_event_id(u.id),'name',u.name,'due',u.due_date,'priority',u.priority,'description',u.description,'fingerprint',u.fp)) from upserts u),'[]'::jsonb),
  'remove',coalesce((select jsonb_agg(jsonb_build_object('task',r.task_id,'event_id',private.calendar_event_id(r.task_id))) from removals r),'[]'::jsonb))
 into result;
 return result;
end $$;
create function public.calendar_record_push(conn uuid, done jsonb) returns void language plpgsql security definer set search_path='' as $$
declare x jsonb;
begin
 for x in select * from jsonb_array_elements(coalesce(done,'[]'::jsonb)) loop
  if (x->>'removed')::boolean then
   delete from private.calendar_task_events where connection_id=conn and task_id=(x->>'task')::uuid;
  else
   insert into private.calendar_task_events(connection_id,task_id,fingerprint) values(conn,(x->>'task')::uuid,x->>'fingerprint')
   on conflict(connection_id,task_id) do update set fingerprint=excluded.fingerprint,synced_at=now();
  end if;
 end loop;
end $$;

-- Server only: Google -> Align ----------------------------------------------------
-- A meeting is brought in only when a guest's email belongs to a lead or
-- contact in the workspace. Everything else in the calendar is ignored.
create function public.calendar_apply_event(conn uuid, ev jsonb) returns text language plpgsql security definer set search_path='' as $$
declare c private.calendar_connections; existing uuid; guests text[]; ct public.contacts; ld public.leads; starts timestamptz; title text; notes text;
begin
 select * into c from private.calendar_connections where id=conn;
 if c.id is null or not exists(select 1 from public.memberships m where m.org_id=c.org_id and m.user_id=c.user_id and m.active) then return 'ignored'; end if;
 if coalesce((ev->>'align')::boolean,false) then return 'ignored'; end if;
 select activity_id into existing from private.calendar_event_activities where connection_id=conn and event_id=ev->>'id';
 if ev->>'status'='cancelled' then
  if existing is null then return 'ignored'; end if;
  update public.activities set archived_at=coalesce(archived_at,now()) where org_id=c.org_id and id=existing;
  return 'archived';
 end if;
 starts:=nullif(ev->>'start','')::timestamptz;
 if starts is null then return 'ignored'; end if;
 select coalesce(array_agg(distinct lower(trim(g))),'{}') into guests
 from jsonb_array_elements_text(coalesce(ev->'guests','[]'::jsonb)) g where lower(trim(g))<>lower(c.google_email);
 select * into ct from public.contacts where org_id=c.org_id and archived_at is null and email=any(guests) order by created_at limit 1;
 if ct.id is null then
  select * into ld from public.leads where org_id=c.org_id and archived_at is null and email=any(guests) order by created_at limit 1;
 end if;
 if ct.id is null and ld.id is null and existing is null then return 'ignored'; end if;
 title:=left(coalesce(nullif(trim(ev->>'summary'),''),'Meeting'),200);
 notes:=left(coalesce(ev->>'description',''),3000)||case when coalesce(ev->>'description','')='' then '' else E'\n\n' end||'From Google Calendar';
 if existing is not null then
  update public.activities set name=title,description=notes,occurred_at=starts,
   contact_id=coalesce(ct.id,contact_id),company_id=coalesce(ct.company_id,company_id),lead_id=coalesce(ld.id,lead_id),archived_at=null
  where org_id=c.org_id and id=existing;
  return 'updated';
 end if;
 insert into public.activities(org_id,owner_id,name,type,description,occurred_at,contact_id,company_id,lead_id)
 values(c.org_id,c.user_id,title,'Meeting',notes,starts,ct.id,ct.company_id,ld.id) returning id into existing;
 insert into private.calendar_event_activities(connection_id,event_id,activity_id) values(conn,ev->>'id',existing);
 return 'created';
end $$;

-- Scheduler credential, same pattern as billing and notifications.
create function public.calendar_validate_job_token(token text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare expected text; begin
 if token is null or length(token)<64 or length(token)>128 or to_regclass('vault.decrypted_secrets') is null then return false; end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where name=''align_calendar_job_token'' limit 1' into expected;
 return coalesce(token=expected,false);
end $$;

-- Permissions ---------------------------------------------------------------
revoke all on function private.calendar_hash(text),private.calendar_event_id(uuid),private.calendar_member(uuid),
 private.calendar_status(uuid),private.calendar_new_feed(uuid),private.calendar_remove_feed(uuid),private.calendar_begin_connect(uuid,text,text) from public,anon;
grant execute on function private.calendar_hash(text),private.calendar_event_id(uuid),private.calendar_member(uuid),
 private.calendar_status(uuid),private.calendar_new_feed(uuid),private.calendar_remove_feed(uuid),private.calendar_begin_connect(uuid,text,text) to authenticated;
revoke all on function public.calendar_status(uuid),public.calendar_new_feed(uuid),public.calendar_remove_feed(uuid),public.calendar_begin_connect(uuid,text,text) from public,anon;
grant execute on function public.calendar_status(uuid),public.calendar_new_feed(uuid),public.calendar_remove_feed(uuid),public.calendar_begin_connect(uuid,text,text) to authenticated;
revoke all on function public.calendar_feed(text),public.calendar_take_state(text),public.calendar_save_connection(uuid,uuid,text,text),
 public.calendar_connections_due(integer),public.calendar_connection(uuid,uuid),public.calendar_refresh_token(uuid),public.calendar_finish(uuid,text,text,boolean),
 public.calendar_reset_sync(uuid),public.calendar_detach(uuid,uuid),public.calendar_plan(uuid,integer),public.calendar_record_push(uuid,jsonb),
 public.calendar_apply_event(uuid,jsonb),public.calendar_validate_job_token(text) from public,anon,authenticated;
grant execute on function public.calendar_feed(text),public.calendar_take_state(text),public.calendar_save_connection(uuid,uuid,text,text),
 public.calendar_connections_due(integer),public.calendar_connection(uuid,uuid),public.calendar_refresh_token(uuid),public.calendar_finish(uuid,text,text,boolean),
 public.calendar_reset_sync(uuid),public.calendar_detach(uuid,uuid),public.calendar_plan(uuid,integer),public.calendar_record_push(uuid,jsonb),
 public.calendar_apply_event(uuid,jsonb),public.calendar_validate_job_token(text) to service_role;
