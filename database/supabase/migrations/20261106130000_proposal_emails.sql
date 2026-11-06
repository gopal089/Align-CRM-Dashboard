-- Proposal emails with link-based view tracking.
-- A send stores a snapshot of the proposal, so the client sees exactly what was
-- sent even if the pitch is edited later. The link token is never stored: only
-- its SHA-256 hash, in a private table no API role can read.

create table public.proposal_sends (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 pitch_id uuid not null,
 sent_by uuid not null references public.profiles(id) on delete cascade,
 recipient_email text not null check(length(recipient_email)<=254 and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 recipient_name text not null default '' check(length(recipient_name)<=200),
 subject text not null check(length(trim(subject)) between 1 and 200 and subject !~ '[\r\n]'),
 message text not null default '' check(length(message)<=5000),
 content jsonb not null check(jsonb_typeof(content)='object'),
 status text not null default 'sending' check(status in ('sending','sent','failed')),
 error text check(length(error)<=500),
 provider_id text check(length(provider_id)<=200),
 expires_at timestamptz not null default now()+interval '30 days',
 revoked_at timestamptz,
 view_count integer not null default 0 check(view_count>=0),
 first_viewed_at timestamptz,
 last_viewed_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(org_id,pitch_id) references public.pitches(org_id,id) on delete cascade
);
create index proposal_sends_pitch on public.proposal_sends(org_id,pitch_id,created_at desc);
create index proposal_sends_daily on public.proposal_sends(org_id,created_at);

create table private.proposal_links (
 send_id uuid primary key references public.proposal_sends(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$')
);

create table public.proposal_views (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 send_id uuid not null references public.proposal_sends(id) on delete cascade,
 viewed_at timestamptz not null default now(),
 -- A coarse label such as "Mobile" or "Desktop"; no IP address or full browser string.
 device text not null default '' check(length(device)<=40)
);
create index proposal_views_send on public.proposal_views(send_id,viewed_at desc);

alter table public.proposal_sends enable row level security;
alter table public.proposal_views enable row level security;
alter table private.proposal_links enable row level security;
-- Members read their workspace's history; every write goes through the functions below.
create policy proposal_sends_read on public.proposal_sends for select to authenticated using ((select private.member_role(org_id)) is not null);
create policy proposal_views_read on public.proposal_views for select to authenticated using ((select private.member_role(org_id)) is not null);
revoke insert,update,delete on public.proposal_sends,public.proposal_views from anon,authenticated;
grant select on public.proposal_sends,public.proposal_views to authenticated;
revoke all on private.proposal_links from anon,authenticated;
-- Same rule as every other table: an unverified or idle session reads nothing.
create policy account_security on public.proposal_sends as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));
create policy account_security on public.proposal_views as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));
create policy account_security on private.proposal_links as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));

-- "Viewed" was reserved until tracking existed. It may now be set, but only by
-- the tracking function below, and editing an already viewed pitch still works.
do $$ declare body text; changed text; begin
 select prosrc into body from pg_proc where oid='private.validate_record()'::regprocedure;
 changed:=replace(body,
  'if new.status=''Viewed'' then raise exception ''View tracking is not configured''; end if;',
  'if new.status=''Viewed'' and (TG_OP=''INSERT'' or old.status is distinct from ''Viewed'') and coalesce(current_setting(''align.proposal_tracking'',true),'''')<>''on'' then raise exception ''Viewed is set automatically when the client opens the proposal''; end if;');
 if changed=body then raise exception 'validate_record no longer contains the Viewed guard'; end if;
 execute 'create or replace function private.validate_record() returns trigger language plpgsql security invoker set search_path='''' as '||quote_literal(changed);
end $$;

-- Called by the proposal-email function with the sender's own session, so the
-- usual session, role and ownership rules decide who may send.
create function public.proposal_begin(pitch uuid, to_email text, to_name text, title text, body text, link_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); p public.pitches; o public.organizations; s public.proposal_sends; who public.profiles; customer text;
begin
 if u is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 select * into p from public.pitches where id=pitch;
 if p.id is null or private.member_role(p.org_id) is null then raise exception 'Proposal not found'; end if;
 if not (p.owner_id=u or private.manage(p.org_id)) then raise exception 'Only the proposal owner or a manager can send it'; end if;
 if p.archived_at is not null then raise exception 'Restore this proposal before sending it'; end if;
 if p.status in ('Accepted','Rejected','Expired') then raise exception 'This proposal is closed. Duplicate it to send a new version'; end if;
 if coalesce(link_hash,'') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid proposal link'; end if;
 to_email:=lower(trim(coalesce(to_email,'')));
 if length(to_email)>254 or to_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid recipient email'; end if;
 title:=trim(coalesce(title,''));
 if length(title) not between 1 and 200 or title ~ '[\r\n]' then raise exception 'Enter a subject of up to 200 characters on one line'; end if;
 if length(coalesce(to_name,''))>200 or length(coalesce(body,''))>5000 then raise exception 'Name or message is too long'; end if;
 perform pg_advisory_xact_lock(hashtextextended('proposal-send:'||p.org_id::text,0));
 if (select count(*) from public.proposal_sends where org_id=p.org_id and created_at>statement_timestamp()-interval '1 day')>=50 then raise exception 'This workspace has sent 50 proposals in the last day. Try again tomorrow'; end if;
 select * into o from public.organizations where id=p.org_id;
 select * into who from public.profiles where id=u;
 customer:=coalesce(
  (select name from public.companies where org_id=p.org_id and id=p.company_id),
  (select name from public.contacts where org_id=p.org_id and id=p.contact_id),
  (select name from public.leads where org_id=p.org_id and id=p.lead_id),'');
 insert into public.proposal_sends(org_id,pitch_id,sent_by,recipient_email,recipient_name,subject,message,content)
 values(p.org_id,p.id,u,to_email,trim(coalesce(to_name,'')),title,coalesce(body,''),jsonb_build_object(
  'org',jsonb_build_object('name',o.name,'website',o.website,'currency',o.currency,'timezone',o.timezone),
  'pitch',jsonb_build_object('name',p.name,'objective',p.objective,'problem',p.problem,'solution',p.solution,'scope',p.scope,'pricing',p.pricing,'amount',p.amount,'terms',p.terms,'created_at',p.created_at),
  'sections',coalesce((select jsonb_agg(jsonb_build_object('title',x.title,'content',x.content) order by x.position) from public.pitch_sections x where x.org_id=p.org_id and x.pitch_id=p.id),'[]'::jsonb),
  'customer',customer,
  'sender',who.name))
 returning * into s;
 insert into private.proposal_links(send_id,token_hash) values(s.id,link_hash);
 return jsonb_build_object('id',s.id,'org_name',o.name,'sender',who.name,'reply_to',who.email,'expires_at',s.expires_at,'to_email',s.recipient_email,'to_name',s.recipient_name,'subject',s.subject,'message',s.message);
end $$;

-- Records the email provider's answer. Only the member who started the send can finish it.
create function public.proposal_finish(send uuid, delivered boolean, provider text default null, failure text default null) returns void language plpgsql security definer set search_path='' as $$
declare s public.proposal_sends;
begin
 if auth.uid() is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 select * into s from public.proposal_sends where id=send for update;
 if s.id is null or s.sent_by<>auth.uid() or s.status<>'sending' then raise exception 'Unknown proposal send'; end if;
 update public.proposal_sends set
  status=case when delivered then 'sent' else 'failed' end,
  provider_id=left(provider,200),
  error=case when delivered then null else left(coalesce(nullif(failure,''),'Email could not be sent'),500) end
 where id=send;
 if delivered then
  update public.pitches set status='Sent' where org_id=s.org_id and id=s.pitch_id and status in ('Draft','Ready to Send');
 end if;
end $$;

-- The sender or a manager can withdraw a link; the client then sees a notice instead of the proposal.
create function public.proposal_revoke(send uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.proposal_sends;
begin
 if auth.uid() is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 select * into s from public.proposal_sends where id=send for update;
 if s.id is null or private.member_role(s.org_id) is null or not (s.sent_by=auth.uid() or private.manage(s.org_id)) then raise exception 'Unknown proposal send'; end if;
 update public.proposal_sends set revoked_at=coalesce(revoked_at,statement_timestamp()) where id=send;
end $$;

-- Opened by the client through the public page. Only the server can call it,
-- after rate limiting, and only someone holding the link can produce the hash.
create function public.proposal_open(link_hash text, device text default '', viewer uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.proposal_sends; internal boolean; last_counted timestamptz;
begin
 if coalesce(link_hash,'') !~ '^[a-f0-9]{64}$' then raise exception 'This proposal link is not valid'; end if;
 select ps.* into s from private.proposal_links l join public.proposal_sends ps on ps.id=l.send_id where l.token_hash=link_hash for update of ps;
 if s.id is null or s.status<>'sent' then raise exception 'This proposal link is not valid'; end if;
 if s.revoked_at is not null then raise exception 'This proposal link was withdrawn by the sender'; end if;
 if s.expires_at<=statement_timestamp() then raise exception 'This proposal link has expired'; end if;
 -- Someone signed in to this workspace is checking the link, not the client.
 internal:=viewer is not null and exists(select 1 from public.memberships m where m.org_id=s.org_id and m.user_id=viewer and m.active);
 if not internal then
  select max(viewed_at) into last_counted from public.proposal_views where send_id=s.id;
  -- Reloading within 30 minutes is the same visit, not a new view.
  if last_counted is null or last_counted<statement_timestamp()-interval '30 minutes' then
   insert into public.proposal_views(org_id,send_id,device) values(s.org_id,s.id,left(coalesce(device,''),40));
   update public.proposal_sends set view_count=view_count+1,first_viewed_at=coalesce(first_viewed_at,statement_timestamp()),last_viewed_at=statement_timestamp() where id=s.id;
  else
   update public.proposal_sends set last_viewed_at=statement_timestamp() where id=s.id;
  end if;
  if exists(select 1 from public.pitches where org_id=s.org_id and id=s.pitch_id and status='Sent') then
   -- The status history records who changed a pitch. No one is signed in here,
   -- so the automatic change is attributed to the member who sent the link.
   perform set_config('align.proposal_tracking','on',true);
   perform set_config('request.jwt.claim.sub',s.sent_by::text,true);
   update public.pitches set status='Viewed' where org_id=s.org_id and id=s.pitch_id and status='Sent';
   perform set_config('request.jwt.claim.sub','',true);
   perform set_config('align.proposal_tracking','',true);
  end if;
 end if;
 return jsonb_build_object('content',s.content,'to_name',s.recipient_name,'sent_at',s.created_at,'expires_at',s.expires_at,
  'reply_to',(select email from public.profiles where id=s.sent_by),'internal',internal);
end $$;

revoke all on function public.proposal_begin(uuid,text,text,text,text,text),public.proposal_finish(uuid,boolean,text,text),public.proposal_revoke(uuid),public.proposal_open(text,text,uuid) from public,anon,authenticated;
grant execute on function public.proposal_begin(uuid,text,text,text,text,text),public.proposal_finish(uuid,boolean,text,text),public.proposal_revoke(uuid) to authenticated;
grant execute on function public.proposal_open(text,text,uuid) to service_role;

-- Dashboards count "Viewed" separately; "Sent" keeps meaning exactly Sent. The
-- count is joined on as its own object because the main summary object is
-- already close to PostgreSQL's 100-argument limit.
do $$ declare body text; changed text; begin
 select prosrc into body from pg_proc where oid='public.crm_summary(uuid,timestamptz,timestamptz)'::regprocedure;
 changed:=replace(body,
  E'select jsonb_build_object(\n''leads''',
  E'select jsonb_build_object(''pitchViewed'',(select count(*) from p where status=''Viewed'')) || jsonb_build_object(\n''leads''');
 if changed=body then raise exception 'crm_summary no longer has the expected shape'; end if;
 execute $f$create or replace function public.crm_summary(o uuid, start_at timestamptz default '1970-01-01', end_at timestamptz default '2100-01-01') returns jsonb language sql stable security invoker set search_path='' as $f$||quote_literal(changed);
end $$;
