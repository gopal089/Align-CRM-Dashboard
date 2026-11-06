-- Automated follow-ups for the team, plus email reminders.
-- A database job checks every hour; each workspace is processed once a day,
-- at 8 am in its own time zone. It only creates tasks and queues emails; a
-- separate sender (align-notifications) delivers the queue. Clients are never
-- emailed automatically.

-- 1. Proposal functions follow the same pattern as the rest of the API: the
--    privileged code lives in the private schema behind a thin public wrapper.
alter function public.proposal_begin(uuid,text,text,text,text,text) set schema private;
alter function public.proposal_finish(uuid,boolean,text,text) set schema private;
alter function public.proposal_revoke(uuid) set schema private;
create function public.proposal_begin(pitch uuid, to_email text, to_name text, title text, body text, link_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.proposal_begin(pitch,to_email,to_name,title,body,link_hash)$$;
create function public.proposal_finish(send uuid, delivered boolean, provider text default null, failure text default null) returns void language sql security invoker set search_path='' as $$select private.proposal_finish(send,delivered,provider,failure)$$;
create function public.proposal_revoke(send uuid) returns void language sql security invoker set search_path='' as $$select private.proposal_revoke(send)$$;
revoke all on function public.proposal_begin(uuid,text,text,text,text,text),public.proposal_finish(uuid,boolean,text,text),public.proposal_revoke(uuid) from public,anon;
grant execute on function public.proposal_begin(uuid,text,text,text,text,text),public.proposal_finish(uuid,boolean,text,text),public.proposal_revoke(uuid) to authenticated;

-- 2. Workspace settings, changed by administrators in Settings.
alter table public.organizations
 add column follow_up_enabled boolean not null default true,
 add column follow_up_lead_days integer not null default 3 check(follow_up_lead_days between 1 and 60),
 add column follow_up_proposal_days integer not null default 3 check(follow_up_proposal_days between 1 and 60);

-- 3. Automatic tasks remember which rule and record created them, so a record
--    never has two open follow-ups from the same rule.
alter table public.tasks
 add column auto_rule text check(auto_rule in ('lead_untouched','proposal_no_reply')),
 add column auto_source uuid,
 add constraint tasks_auto_pair check((auto_rule is null)=(auto_source is null));
create unique index tasks_one_open_follow_up on public.tasks(org_id,auto_rule,auto_source)
 where auto_rule is not null and status<>'Completed' and archived_at is null;
create index tasks_follow_up_source on public.tasks(org_id,auto_rule,auto_source) where auto_rule is not null;
create function private.guard_task_automation() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 -- Members cannot forge or detach these links; only the scheduled job sets them.
 if auth.uid() is not null and (
  (TG_OP='INSERT' and (new.auto_rule is not null or new.auto_source is not null)) or
  (TG_OP='UPDATE' and (new.auto_rule is distinct from old.auto_rule or new.auto_source is distinct from old.auto_source))) then
  raise exception 'Automatic follow-up links are managed by Align';
 end if;
 return new;
end $$;
create trigger guard_task_automation before insert or update on public.tasks for each row execute function private.guard_task_automation();

-- 4. Emails waiting to be sent, and a record of which day each workspace ran.
create table private.notification_outbox (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 kind text not null check(kind in ('follow_up_digest','plan_ending')),
 dedupe_key text not null unique check(length(dedupe_key)<=300),
 payload jsonb not null default '{}' check(jsonb_typeof(payload)='object'),
 status text not null default 'pending' check(status in ('pending','sent','failed')),
 attempts integer not null default 0 check(attempts between 0 and 5),
 claimed_at timestamptz, sent_at timestamptz,
 provider_id text check(length(provider_id)<=200),
 last_error text check(length(last_error)<=500),
 created_at timestamptz not null default now()
);
create index notification_outbox_pending on private.notification_outbox(created_at) where status='pending';
create table private.follow_up_runs (
 org_id uuid not null references public.organizations(id) on delete cascade,
 run_date date not null,
 created_tasks integer not null default 0,
 primary key(org_id,run_date)
);
alter table private.notification_outbox enable row level security;
alter table private.follow_up_runs enable row level security;
revoke all on private.notification_outbox,private.follow_up_runs from anon,authenticated;
create policy account_security on private.notification_outbox as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));
create policy account_security on private.follow_up_runs as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));

-- 5. The daily rules. "run_at" exists so tests can run the job at a chosen moment.
create function private.run_follow_ups(run_at timestamptz default statement_timestamp()) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.organizations; today date; lead_items jsonb; pitch_items jsonb; workspaces integer:=0; created integer:=0; reminders integer:=0;
begin
 -- Overlapping runs would only race on the same rows; the second one simply stops.
 if not pg_try_advisory_xact_lock(hashtextextended('align-follow-ups',0)) then return jsonb_build_object('skipped',true); end if;
 for o in select * from public.organizations loop
  today:=(run_at at time zone o.timezone)::date;
  continue when not o.follow_up_enabled
   or extract(hour from run_at at time zone o.timezone)<8
   or exists(select 1 from private.follow_up_runs r where r.org_id=o.id and r.run_date=today);

  -- Open leads with nothing logged (activity, edit or completed follow-up) for N days.
  with candidates as (
   select l.* from public.leads l
   join public.memberships m on m.org_id=l.org_id and m.user_id=l.owner_id and m.active
   where l.org_id=o.id and l.archived_at is null and l.status in ('New','Contacted','Qualified')
    and greatest(l.created_at,l.updated_at,
     coalesce((select max(a.occurred_at) from public.activities a where a.org_id=l.org_id and a.lead_id=l.id and a.archived_at is null),'-infinity'),
     coalesce((select max(t.completed_at) from public.tasks t where t.org_id=l.org_id and t.auto_rule='lead_untouched' and t.auto_source=l.id),'-infinity')
    )<=run_at-make_interval(days=>o.follow_up_lead_days)
    and not exists(select 1 from public.tasks t where t.org_id=l.org_id and t.auto_rule='lead_untouched' and t.auto_source=l.id and t.status<>'Completed' and t.archived_at is null)
   order by l.updated_at
   limit 200
  ), made as (
   insert into public.tasks(org_id,owner_id,name,description,due_date,priority,lead_id,auto_rule,auto_source)
   select c.org_id,c.owner_id,left('Follow up: '||c.name,200),
    'Nothing has been logged on this lead for '||o.follow_up_lead_days||' days. Created automatically by Align.',
    today,'Medium',c.id,'lead_untouched',c.id
   from candidates c
   on conflict do nothing
   returning id,owner_id,name
  )
  select coalesce(jsonb_agg(jsonb_build_object('task',id,'owner',owner_id,'name',name,'kind','lead')),'[]'::jsonb) into lead_items from made;

  -- Proposals the client opened N days ago that are still waiting for an answer.
  with candidates as (
   select p.* from public.pitches p
   join public.memberships m on m.org_id=p.org_id and m.user_id=p.owner_id and m.active
   where p.org_id=o.id and p.archived_at is null and p.status='Viewed'
    and (select min(s.first_viewed_at) from public.proposal_sends s where s.org_id=p.org_id and s.pitch_id=p.id)<=run_at-make_interval(days=>o.follow_up_proposal_days)
    and coalesce((select max(t.completed_at) from public.tasks t where t.org_id=p.org_id and t.auto_rule='proposal_no_reply' and t.auto_source=p.id),'-infinity')<=run_at-make_interval(days=>o.follow_up_proposal_days)
    and not exists(select 1 from public.tasks t where t.org_id=p.org_id and t.auto_rule='proposal_no_reply' and t.auto_source=p.id and t.status<>'Completed' and t.archived_at is null)
   order by p.updated_at
   limit 200
  ), made as (
   insert into public.tasks(org_id,owner_id,name,description,due_date,priority,lead_id,contact_id,company_id,deal_id,auto_rule,auto_source)
   select c.org_id,c.owner_id,left('Follow up on proposal: '||c.name,200),
    'The client opened this proposal at least '||o.follow_up_proposal_days||' days ago and has not answered yet. Created automatically by Align.',
    today,'High',c.lead_id,c.contact_id,c.company_id,c.deal_id,'proposal_no_reply',c.id
   from candidates c
   on conflict do nothing
   returning id,owner_id,name
  )
  select coalesce(jsonb_agg(jsonb_build_object('task',id,'owner',owner_id,'name',name,'kind','proposal')),'[]'::jsonb) into pitch_items from made;

  -- One digest per person per day, only for people who keep reminders on.
  insert into private.notification_outbox(org_id,user_id,kind,dedupe_key,payload)
  select o.id,(x->>'owner')::uuid,'follow_up_digest','digest:'||o.id||':'||(x->>'owner')||':'||today,
   jsonb_build_object('org_name',o.name,'date',today,'items',jsonb_agg(x-'owner'))
  from jsonb_array_elements(lead_items||pitch_items) x
  join public.profiles pr on pr.id=(x->>'owner')::uuid and pr.notifications
  group by x->>'owner'
  on conflict (dedupe_key) do nothing;

  insert into private.follow_up_runs(org_id,run_date,created_tasks) values(o.id,today,jsonb_array_length(lead_items||pitch_items));
  workspaces:=workspaces+1;
  created:=created+jsonb_array_length(lead_items||pitch_items);
 end loop;

 -- Administrators hear about a paid plan ending within 7 days, once per period.
 -- Same rule as the warning on the Billing page. Sent even with reminders off,
 -- because losing paid access affects the whole workspace.
 insert into private.notification_outbox(org_id,user_id,kind,dedupe_key,payload)
 select s.org_id,m.user_id,'plan_ending','plan-ending:'||s.org_id||':'||m.user_id||':'||to_char(s.paid_until at time zone 'UTC','YYYYMMDDHH24MISS'),
  jsonb_build_object('org_name',org.name,'plan',p.name,'paid_until',s.paid_until,'timezone',org.timezone,'cancelling',s.cancel_at_period_end)
 from public.organization_subscriptions s
 join public.organizations org on org.id=s.org_id
 join public.subscription_plans p on p.code=s.paid_plan_code
 join public.memberships m on m.org_id=s.org_id and m.role='Administrator' and m.active
 where s.paid_plan_code<>'free' and s.paid_until>run_at and s.paid_until<=run_at+interval '7 days'
 on conflict (dedupe_key) do nothing;
 get diagnostics reminders=row_count;

 delete from private.notification_outbox where created_at<run_at-interval '30 days';
 delete from private.follow_up_runs where run_date<(run_at-interval '60 days')::date;
 return jsonb_build_object('workspaces',workspaces,'tasks',created,'plan_reminders',reminders);
end $$;
revoke all on function private.run_follow_ups(timestamptz) from public,anon,authenticated;

-- 6. The sender's access. Only the align-notifications function, presenting the
--    random credential stored in Vault by setup-notifications-cron.sql, gets in.
create function public.notifications_validate_job_token(token text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare expected text; begin
 if token is null or length(token)<64 or length(token)>128 or to_regclass('vault.decrypted_secrets') is null then return false; end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where name=''align_notifications_job_token'' limit 1' into expected;
 return coalesce(token=expected,false);
end $$;

create function public.notifications_claim(batch integer default 25) returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb;
begin
 if batch is null or batch not between 1 and 50 then raise exception 'Invalid batch size'; end if;
 -- A claim lasts 10 minutes, so a crashed sender cannot strand an email.
 with picked as (
  select n.id from private.notification_outbox n
  where n.status='pending' and n.attempts<5 and (n.claimed_at is null or n.claimed_at<statement_timestamp()-interval '10 minutes')
  order by n.created_at limit batch for update skip locked
 ), claimed as (
  update private.notification_outbox n set attempts=n.attempts+1,claimed_at=statement_timestamp()
  from picked where n.id=picked.id
  returning n.id,n.kind,n.payload,n.user_id,n.created_at
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'payload',c.payload,'email',pr.email,'name',pr.name) order by c.created_at),'[]'::jsonb)
 into items from claimed c left join public.profiles pr on pr.id=c.user_id;
 return items;
end $$;

create function public.notifications_finish(item uuid, delivered boolean, provider text default null, failure text default null, permanent boolean default false) returns void language plpgsql security definer set search_path='' as $$
begin
 -- Temporary problems are retried on later runs, up to five attempts in all.
 update private.notification_outbox set
  status=case when delivered then 'sent' when permanent or attempts>=5 then 'failed' else 'pending' end,
  sent_at=case when delivered then statement_timestamp() end,
  provider_id=left(provider,200),
  last_error=case when delivered then null else left(coalesce(nullif(failure,''),'Email could not be sent'),500) end,
  claimed_at=case when delivered or permanent then claimed_at else null end
 where id=item and status='pending';
end $$;
revoke all on function public.notifications_validate_job_token(text),public.notifications_claim(integer),public.notifications_finish(uuid,boolean,text,text,boolean) from public,anon,authenticated;
grant execute on function public.notifications_validate_job_token(text),public.notifications_claim(integer),public.notifications_finish(uuid,boolean,text,text,boolean) to service_role;

-- 7. Check every hour. PGlite (used by the tests) has no pg_cron; hosted Supabase does.
do $$ begin
 if exists(select 1 from pg_available_extensions where name='pg_cron') then
  execute 'create extension if not exists pg_cron';
  if not exists(select 1 from cron.job where jobname='align-follow-ups') then
   perform cron.schedule('align-follow-ups','7 * * * *','select private.run_follow_ups()');
  end if;
 end if;
end $$;
