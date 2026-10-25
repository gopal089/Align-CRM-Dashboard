-- Align CRM. All monetary values use the organization's single currency.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 120),
 email text not null, notifications boolean not null default true,
 created_at timestamptz not null default now()
);
create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 120),
 currency text not null default 'USD' check(currency in ('USD','INR','EUR','GBP','CAD','AUD','SGD')),
 timezone text not null default 'Asia/Kolkata', website text default '',
 lead_sources text[] not null default array['Website','Referral','Campaign','Event','Manual'],
 pipeline_stages jsonb not null default '[{"name":"Discovery","probability":10,"outcome":"open"},{"name":"Qualified","probability":30,"outcome":"open"},{"name":"Proposal","probability":60,"outcome":"open"},{"name":"Negotiation","probability":80,"outcome":"open"},{"name":"Closed won","probability":100,"outcome":"won"},{"name":"Closed lost","probability":0,"outcome":"lost"}]',
 payment_tracking boolean not null default false,
 created_at timestamptz not null default now()
);
create table public.memberships (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 role text not null default 'Sales Representative' check(role in ('Administrator','Sales Manager','Sales Representative')),
 unique(org_id,user_id), created_at timestamptz not null default now()
);
create function private.member_role(o uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.memberships where org_id=o and user_id=(select auth.uid())
$$;
revoke all on function private.member_role(uuid) from public;
grant execute on function private.member_role(uuid) to authenticated;
create function private.manage(o uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(private.member_role(o) in ('Administrator','Sales Manager'),false)
$$;
revoke all on function private.manage(uuid) from public;
grant execute on function private.manage(uuid) to authenticated;

create table public.companies (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), website text default '', industry text default '', size text default '', location text default '', notes text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index companies_org_created on public.companies(org_id,created_at desc);
create index companies_owner on public.companies(org_id,owner_id);

create table public.contacts (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), email text, phone text default '', job_title text default '', company_id uuid, tags text[] default '{}', notes text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index contacts_org_created on public.contacts(org_id,created_at desc);
create index contacts_owner on public.contacts(org_id,owner_id);

create table public.leads (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), company_name text default '', email text, phone text default '', source text not null default 'Manual', status text not null default 'New' check(status in ('New','Contacted','Qualified','Converted','Lost')), priority text not null default 'Medium' check(priority in ('Low','Medium','High')), converted_contact_id uuid, converted_deal_id uuid, converted_at timestamptz, notes text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index leads_org_created on public.leads(org_id,created_at desc);
create index leads_owner on public.leads(org_id,owner_id);

create table public.deals (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), company_id uuid, contact_id uuid, lead_id uuid, amount numeric(14,2) not null default 0 check(amount>=0), stage text not null default 'Discovery', probability numeric(5,2) not null default 10 check(probability between 0 and 100), outcome text not null default 'open' check(outcome in ('open','won','lost')), expected_close_date date, closed_at timestamptz, notes text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index deals_org_created on public.deals(org_id,created_at desc);
create index deals_owner on public.deals(org_id,owner_id);

create table public.pitch_templates (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), sections jsonb not null default '[]' check(jsonb_typeof(sections)='array'), terms text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index pitch_templates_org_created on public.pitch_templates(org_id,created_at desc);
create index pitch_templates_owner on public.pitch_templates(org_id,owner_id);

create table public.pitches (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), lead_id uuid, contact_id uuid, company_id uuid, deal_id uuid, template_id uuid, objective text default '', problem text default '', solution text default '', scope text default '', pricing text default '', amount numeric(14,2) not null default 0 check(amount>=0), terms text default '', status text not null default 'Draft' check(status in ('Draft','Ready to Send','Sent','Viewed','Accepted','Rejected','Expired')), accepted_at timestamptz,
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index pitches_org_created on public.pitches(org_id,created_at desc);
create index pitches_owner on public.pitches(org_id,owner_id);

create table public.activities (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), type text not null default 'Note' check(type in ('Call','Meeting','Email','Note','Follow-up','Pitch update','Deal stage change')), description text default '', occurred_at timestamptz not null default now(), lead_id uuid, contact_id uuid, company_id uuid, deal_id uuid, pitch_id uuid,
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index activities_org_created on public.activities(org_id,created_at desc);
create index activities_owner on public.activities(org_id,owner_id);

create table public.tasks (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), description text default '', due_date date not null, priority text not null default 'Medium' check(priority in ('Low','Medium','High')), status text not null default 'Open' check(status in ('Open','In progress','Completed')), lead_id uuid, contact_id uuid, company_id uuid, deal_id uuid, completed_at timestamptz,
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index tasks_org_created on public.tasks(org_id,created_at desc);
create index tasks_owner on public.tasks(org_id,owner_id);

create table public.sales_targets (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null default 'Sales target', amount numeric(14,2) not null check(amount>0), period_start date not null, period_end date not null, team_target boolean not null default false, check(period_end>=period_start),
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index sales_targets_org_created on public.sales_targets(org_id,created_at desc);
create index sales_targets_owner on public.sales_targets(org_id,owner_id);

create table public.payments (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid(), name text not null check(length(trim(name)) between 1 and 200), deal_id uuid not null, amount numeric(14,2) not null check(amount>0), paid_at timestamptz not null default now(), reference text default '',
 archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,owner_id) references public.memberships(org_id,user_id)
);
create index payments_org_created on public.payments(org_id,created_at desc);
create index payments_owner on public.payments(org_id,owner_id);
alter table public.contacts add foreign key(org_id,company_id) references public.companies(org_id,id);
create index contacts_company_id_idx on public.contacts(org_id,company_id);
alter table public.leads add foreign key(org_id,converted_contact_id) references public.contacts(org_id,id);
create index leads_converted_contact_id_idx on public.leads(org_id,converted_contact_id);
alter table public.leads add foreign key(org_id,converted_deal_id) references public.deals(org_id,id);
create index leads_converted_deal_id_idx on public.leads(org_id,converted_deal_id);
alter table public.deals add foreign key(org_id,company_id) references public.companies(org_id,id);
create index deals_company_id_idx on public.deals(org_id,company_id);
alter table public.deals add foreign key(org_id,contact_id) references public.contacts(org_id,id);
create index deals_contact_id_idx on public.deals(org_id,contact_id);
alter table public.deals add foreign key(org_id,lead_id) references public.leads(org_id,id);
create index deals_lead_id_idx on public.deals(org_id,lead_id);
alter table public.pitches add foreign key(org_id,lead_id) references public.leads(org_id,id);
create index pitches_lead_id_idx on public.pitches(org_id,lead_id);
alter table public.pitches add foreign key(org_id,contact_id) references public.contacts(org_id,id);
create index pitches_contact_id_idx on public.pitches(org_id,contact_id);
alter table public.pitches add foreign key(org_id,company_id) references public.companies(org_id,id);
create index pitches_company_id_idx on public.pitches(org_id,company_id);
alter table public.pitches add foreign key(org_id,deal_id) references public.deals(org_id,id);
create index pitches_deal_id_idx on public.pitches(org_id,deal_id);
alter table public.pitches add foreign key(org_id,template_id) references public.pitch_templates(org_id,id);
create index pitches_template_id_idx on public.pitches(org_id,template_id);
alter table public.tasks add foreign key(org_id,lead_id) references public.leads(org_id,id) on delete set null (lead_id);
create index tasks_lead_id_idx on public.tasks(org_id,lead_id);
alter table public.tasks add foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete set null (contact_id);
create index tasks_contact_id_idx on public.tasks(org_id,contact_id);
alter table public.tasks add foreign key(org_id,company_id) references public.companies(org_id,id) on delete set null (company_id);
create index tasks_company_id_idx on public.tasks(org_id,company_id);
alter table public.tasks add foreign key(org_id,deal_id) references public.deals(org_id,id) on delete set null (deal_id);
create index tasks_deal_id_idx on public.tasks(org_id,deal_id);
alter table public.activities add foreign key(org_id,lead_id) references public.leads(org_id,id) on delete set null (lead_id);
create index activities_lead_id_idx on public.activities(org_id,lead_id);
alter table public.activities add foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete set null (contact_id);
create index activities_contact_id_idx on public.activities(org_id,contact_id);
alter table public.activities add foreign key(org_id,company_id) references public.companies(org_id,id) on delete set null (company_id);
create index activities_company_id_idx on public.activities(org_id,company_id);
alter table public.activities add foreign key(org_id,deal_id) references public.deals(org_id,id) on delete set null (deal_id);
create index activities_deal_id_idx on public.activities(org_id,deal_id);
alter table public.activities add foreign key(org_id,pitch_id) references public.pitches(org_id,id) on delete set null (pitch_id);
create index activities_pitch_id_idx on public.activities(org_id,pitch_id);
alter table public.payments add foreign key(org_id,deal_id) references public.deals(org_id,id);
create index payments_deal_id_idx on public.payments(org_id,deal_id);

create unique index companies_name_unique on public.companies(org_id,lower(trim(name)));
create unique index contacts_email_unique on public.contacts(org_id,lower(email)) where email is not null;
create unique index leads_email_unique on public.leads(org_id,lower(email)) where email is not null;
create index deals_stage_idx on public.deals(org_id,stage,expected_close_date);
create index tasks_due_idx on public.tasks(org_id,due_date) where status<>'Completed';
create table public.pitch_sections (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id),
 pitch_id uuid not null, title text not null check(length(trim(title))>0), content text not null default '', position int not null check(position>=0),
 foreign key(org_id,pitch_id) references public.pitches(org_id,id) on delete cascade,
 unique(pitch_id,position) deferrable initially deferred
);
create index pitch_sections_pitch_idx on public.pitch_sections(org_id,pitch_id);
create table public.deal_stage_history (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id), deal_id uuid not null,
 from_stage text, to_stage text not null, changed_at timestamptz not null default now(), changed_by uuid not null default auth.uid(),
 foreign key(org_id,deal_id) references public.deals(org_id,id) on delete cascade
);
create index deal_history_deal_idx on public.deal_stage_history(org_id,deal_id,changed_at);
create table public.pitch_status_history (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id), pitch_id uuid not null,
 from_status text, to_status text not null, changed_at timestamptz not null default now(), changed_by uuid not null default auth.uid(),
 foreign key(org_id,pitch_id) references public.pitches(org_id,id) on delete cascade
);
create index pitch_history_pitch_idx on public.pitch_status_history(org_id,pitch_id,changed_at);
-- Validate and audit in the database, regardless of which client writes a row.
create function private.validate_record() returns trigger language plpgsql security invoker set search_path='' as $$
declare cfg public.organizations; st jsonb;
begin
 if TG_OP='UPDATE' and (new.org_id<>old.org_id or new.id<>old.id or new.created_at<>old.created_at) then raise exception 'Record identity cannot be changed'; end if;
 new.updated_at=now();
 if TG_TABLE_NAME in ('contacts','leads') then
  new.email=nullif(lower(trim(new.email)),'');
  if new.email is not null and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email address'; end if;
 end if;
 select * into cfg from public.organizations where id=new.org_id;
 if TG_TABLE_NAME='leads' then
  if (TG_OP='INSERT' or new.source is distinct from old.source) and not(new.source=any(cfg.lead_sources)) then raise exception 'Unknown lead source'; end if;
  if TG_OP='INSERT' and (new.status='Converted' or new.converted_deal_id is not null or new.converted_contact_id is not null or new.converted_at is not null) then raise exception 'Use lead conversion'; end if;
  if TG_OP='UPDATE' and old.status='Converted' and (new.status<>old.status or new.converted_deal_id is distinct from old.converted_deal_id or new.converted_contact_id is distinct from old.converted_contact_id or new.converted_at is distinct from old.converted_at) then raise exception 'Conversion relationships cannot be changed'; end if;
  if new.status='Converted' and (new.converted_contact_id is null or new.converted_deal_id is null) then raise exception 'Use lead conversion to create related records'; end if;
 end if;
 if TG_TABLE_NAME='deals' then
  select v into st from jsonb_array_elements(cfg.pipeline_stages) v where v->>'name'=new.stage;
  if st is null then raise exception 'Unknown pipeline stage'; end if;
  new.outcome=st->>'outcome';
  if TG_OP='INSERT' or new.stage is distinct from old.stage then new.probability=(st->>'probability')::numeric; end if;
  if new.outcome='won' then new.probability=100; elsif new.outcome='lost' then new.probability=0; end if;
  if new.outcome<>'open' then
   if TG_OP='INSERT' or old.outcome='open' then new.closed_at=now(); else new.closed_at=old.closed_at; end if;
  else new.closed_at=null; end if;
 end if;
 if TG_TABLE_NAME='pitches' then
  if new.status='Viewed' then raise exception 'View tracking is not configured'; end if;
  if new.status='Accepted' then
   if TG_OP='INSERT' or old.status<>'Accepted' then new.accepted_at=now(); else new.accepted_at=old.accepted_at; end if;
  else new.accepted_at=null; end if;
 end if;
 if TG_TABLE_NAME='tasks' then
  if new.status='Completed' then new.completed_at=coalesce(new.completed_at,now()); else new.completed_at=null; end if;
 end if;
 if TG_TABLE_NAME='payments' and not cfg.payment_tracking then raise exception 'Enable manual payment tracking in Settings first'; end if;
 return new;
end $$;
create function private.audit_record() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_TABLE_NAME='deals' then
 if TG_OP='INSERT' or new.stage is distinct from old.stage then
  insert into public.deal_stage_history(org_id,deal_id,from_stage,to_stage) values(new.org_id,new.id,case when TG_OP='UPDATE' then old.stage else null end,new.stage);
  insert into public.activities(org_id,owner_id,name,type,description,deal_id,company_id,contact_id,lead_id) values(new.org_id,new.owner_id,'Deal stage updated','Deal stage change',new.stage,new.id,new.company_id,new.contact_id,new.lead_id);
 end if;
 end if;
 if TG_TABLE_NAME='pitches' then
 if TG_OP='INSERT' or new.status is distinct from old.status then
  insert into public.pitch_status_history(org_id,pitch_id,from_status,to_status) values(new.org_id,new.id,case when TG_OP='UPDATE' then old.status else null end,new.status);
  insert into public.activities(org_id,owner_id,name,type,description,pitch_id,company_id,contact_id,lead_id,deal_id) values(new.org_id,new.owner_id,'Pitch status updated','Pitch update',new.status,new.id,new.company_id,new.contact_id,new.lead_id,new.deal_id);
 end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['companies','contacts','leads','deals','pitches','pitch_templates','activities','tasks','sales_targets','payments'] loop
 execute format('create trigger validate_record before insert or update on public.%I for each row execute function private.validate_record()',t);
 end loop;
end $$;
create trigger audit_deal after insert or update on public.deals for each row execute function private.audit_record();
create trigger audit_pitch after insert or update on public.pitches for each row execute function private.audit_record();
create function private.validate_org() returns trigger language plpgsql security invoker set search_path='' as $$
declare st jsonb;
begin
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then raise exception 'Unknown time zone'; end if;
 if jsonb_typeof(new.pipeline_stages)<>'array' or jsonb_array_length(new.pipeline_stages)<3 then raise exception 'Pipeline needs open, won and lost stages'; end if;
 if exists(select 1 from jsonb_array_elements(new.pipeline_stages) v group by v->>'name' having count(*)>1) then raise exception 'Stage names must be unique'; end if;
 for st in select * from jsonb_array_elements(new.pipeline_stages) loop
  if coalesce(length(trim(st->>'name')),0)=0 or coalesce(st->>'outcome','') not in ('open','won','lost') or st->>'probability' is null or (st->>'probability')::numeric not between 0 and 100 then raise exception 'Invalid pipeline stage'; end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(new.pipeline_stages) v where v->>'outcome'='won') or not exists(select 1 from jsonb_array_elements(new.pipeline_stages) v where v->>'outcome'='lost') or not exists(select 1 from jsonb_array_elements(new.pipeline_stages) v where v->>'outcome'='open') then raise exception 'Pipeline requires open, won and lost outcomes'; end if;
 if exists(select 1 from public.deals d where d.org_id=new.id and not exists(select 1 from jsonb_array_elements(new.pipeline_stages) v where v->>'name'=d.stage and v->>'outcome'=d.outcome)) then raise exception 'Cannot remove or change the outcome of a stage used by deals'; end if;
 if new.currency<>old.currency and (exists(select 1 from public.deals where org_id=new.id) or exists(select 1 from public.pitches where org_id=new.id) or exists(select 1 from public.sales_targets where org_id=new.id) or exists(select 1 from public.payments where org_id=new.id)) then raise exception 'Currency is locked after monetary records exist; this prevents combining currencies'; end if;
 if cardinality(new.lead_sources)=0 or exists(select 1 from unnest(new.lead_sources) s where length(trim(s))=0) then raise exception 'Provide at least one lead source'; end if;
 return new;
end $$;
create trigger validate_org before update on public.organizations for each row execute function private.validate_org();
-- RLS: organization isolation, member roles, and representative ownership.
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
create policy org_read on public.organizations for select to authenticated using ((select private.member_role(id)) is not null);
create policy org_edit on public.organizations for update to authenticated using ((select private.member_role(id))='Administrator') with check ((select private.member_role(id))='Administrator');
create policy profiles_read on public.profiles for select to authenticated using (id=(select auth.uid()) or exists(select 1 from public.memberships m where m.user_id=profiles.id and private.member_role(m.org_id) is not null));
create policy profiles_edit on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));
create policy membership_read on public.memberships for select to authenticated using ((select private.member_role(org_id)) is not null);
-- Membership mutation is only possible through audited, restricted RPCs below.
do $$ declare t text; begin
 foreach t in array array['companies','contacts','leads','deals','pitches','pitch_templates','activities','tasks','sales_targets','payments'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy org_read on public.%I for select to authenticated using ((select private.member_role(org_id)) is not null)',t);
 if t='sales_targets' then
 execute format('create policy managed_insert on public.%I for insert to authenticated with check ((select private.manage(org_id)))',t);
 execute format('create policy managed_update on public.%I for update to authenticated using ((select private.manage(org_id))) with check ((select private.manage(org_id)))',t);
 execute format('create policy managed_delete on public.%I for delete to authenticated using ((select private.manage(org_id)))',t);
 else
 execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select private.member_role(org_id)) is not null and (owner_id=(select auth.uid()) or (select private.manage(org_id))))',t);
 execute format('create policy owner_update on public.%I for update to authenticated using (owner_id=(select auth.uid()) or (select private.manage(org_id))) with check (owner_id=(select auth.uid()) or (select private.manage(org_id)))',t);
 execute format('create policy managed_delete on public.%I for delete to authenticated using ((select private.manage(org_id)))',t);
 end if;
 end loop;
end $$;
alter table public.pitch_sections enable row level security;
create policy sections_read on public.pitch_sections for select to authenticated using ((select private.member_role(org_id)) is not null);
create policy sections_write on public.pitch_sections for all to authenticated using (exists(select 1 from public.pitches p where p.id=pitch_id and p.org_id=pitch_sections.org_id and (p.owner_id=(select auth.uid()) or private.manage(p.org_id)))) with check (exists(select 1 from public.pitches p where p.id=pitch_id and p.org_id=pitch_sections.org_id and (p.owner_id=(select auth.uid()) or private.manage(p.org_id))));
do $$ declare t text; fk text; parent text; begin
 foreach t in array array['deal_stage_history','pitch_status_history'] loop
 fk=case when t='deal_stage_history' then 'deal_id' else 'pitch_id' end;
 parent=case when t='deal_stage_history' then 'deals' else 'pitches' end;
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy history_read on public.%I for select to authenticated using ((select private.member_role(org_id)) is not null)',t);
 -- These inserts are needed by the invoker audit trigger, and are checked against the actual current parent state.
 execute format('create policy history_insert on public.%I for insert to authenticated with check (pg_trigger_depth()>0 and changed_by=(select auth.uid()) and exists(select 1 from public.%I p where p.id=%I and p.org_id=%I.org_id and (p.owner_id=(select auth.uid()) or private.manage(p.org_id))))',t,parent,fk,t);
 end loop;
end $$;
grant select,insert,update,delete on all tables in schema public to authenticated;
revoke insert,update,delete on public.memberships from authenticated;
revoke insert,delete on public.profiles from authenticated;
revoke insert,delete on public.organizations from authenticated;
revoke update,delete on public.deal_stage_history,public.pitch_status_history from authenticated;
-- Privileged helpers are private, explicitly granted, and check the current authenticated user.
create function private.create_workspace(n text, person text) returns uuid language plpgsql security definer set search_path='' as $$
declare o uuid; begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
 if exists(select 1 from public.memberships where user_id=auth.uid()) then raise exception 'You already belong to a workspace'; end if;
 insert into public.profiles(id,name,email) values(auth.uid(),trim(person),(select email from auth.users where id=auth.uid())) on conflict(id) do nothing;
 insert into public.organizations(name) values(trim(n)) returning id into o;
 insert into public.memberships(org_id,user_id,role) values(o,auth.uid(),'Administrator');
 return o;
end $$;
revoke all on function private.create_workspace(text,text) from public;
grant execute on function private.create_workspace(text,text) to authenticated;
create function public.create_workspace(n text, person text) returns uuid language sql security invoker set search_path='' as $$ select private.create_workspace(n,person) $$;
create function private.manage_member(o uuid, email_address text, member_role text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid; existing_member_role text; begin
 if auth.uid() is null or private.member_role(o) is distinct from 'Administrator' then raise exception 'Administrator access required'; end if;
 if member_role not in ('Administrator','Sales Manager','Sales Representative') then raise exception 'Invalid role'; end if;
 perform pg_advisory_xact_lock(hashtext(o::text));
 select id into u from auth.users where lower(email)=lower(trim(email_address));
 if u is null then raise exception 'This person must sign up first. No invitation email was sent.'; end if;
 select role into existing_member_role from public.memberships where org_id=o and user_id=u;
 if existing_member_role='Administrator' and member_role<>'Administrator' and (select count(*) from public.memberships where org_id=o and role='Administrator')<=1 then raise exception 'Keep at least one administrator'; end if;
 insert into public.profiles(id,name,email) values(u,split_part(email_address,'@',1),lower(email_address)) on conflict(id) do nothing;
 insert into public.memberships(org_id,user_id,role) values(o,u,member_role) on conflict(org_id,user_id) do update set role=excluded.role;
end $$;
revoke all on function private.manage_member(uuid,text,text) from public;
grant execute on function private.manage_member(uuid,text,text) to authenticated;
create function public.manage_member(o uuid, email_address text, member_role text) returns void language sql security invoker set search_path='' as $$ select private.manage_member(o,email_address,member_role) $$;
-- Atomic lead conversion. Locks the lead and reuses matching contacts and companies.
create function public.convert_lead(lead uuid, deal_amount numeric default 0) returns uuid language plpgsql security invoker set search_path='' as $$
declare l public.leads; co uuid; ct uuid; d uuid; first_stage text; begin
 select * into l from public.leads where id=lead for update;
 if l.id is null or (l.owner_id<>auth.uid() and not private.manage(l.org_id)) then raise exception 'Lead unavailable or access denied'; end if;
 if l.converted_deal_id is not null then return l.converted_deal_id; end if;
 if l.status<>'Qualified' or l.archived_at is not null then raise exception 'Qualify an active lead before conversion'; end if;
 if deal_amount<0 then raise exception 'Amount must be non-negative'; end if;
 if nullif(trim(l.company_name),'') is not null then
  perform pg_advisory_xact_lock(hashtext(l.org_id::text||lower(trim(l.company_name))));
  select id into co from public.companies where org_id=l.org_id and lower(trim(name))=lower(trim(l.company_name));
  if co is null then insert into public.companies(org_id,owner_id,name) values(l.org_id,l.owner_id,l.company_name) returning id into co; end if;
 end if;
 if l.email is not null then
  perform pg_advisory_xact_lock(hashtext(l.org_id::text||l.email));
  select id into ct from public.contacts where org_id=l.org_id and email=l.email;
 end if;
 if ct is null then insert into public.contacts(org_id,owner_id,name,email,phone,company_id) values(l.org_id,l.owner_id,l.name,l.email,l.phone,co) returning id into ct; end if;
 select v->>'name' into first_stage from public.organizations o,jsonb_array_elements(o.pipeline_stages) v where o.id=l.org_id and v->>'outcome'='open' limit 1;
 insert into public.deals(org_id,owner_id,name,amount,company_id,contact_id,lead_id,stage) values(l.org_id,l.owner_id,l.company_name||' — '||l.name,deal_amount,co,ct,l.id,first_stage) returning id into d;
 update public.leads set status='Converted',converted_at=now(),converted_contact_id=ct,converted_deal_id=d where id=l.id;
 return d;
end $$;
-- Atomic pitch and ordered sections save. Existing IDs are locked and permission checked.
create function public.save_pitch(payload jsonb, sections jsonb, record_id uuid default null) returns uuid language plpgsql security invoker set search_path='' as $$
declare p public.pitches; pid uuid; section jsonb; pos int=0; begin
 if record_id is null then
  insert into public.pitches(org_id,owner_id,name,lead_id,contact_id,company_id,deal_id,template_id,objective,problem,solution,scope,pricing,amount,terms,status)
  values((payload->>'org_id')::uuid,(payload->>'owner_id')::uuid,payload->>'name',nullif(payload->>'lead_id','')::uuid,nullif(payload->>'contact_id','')::uuid,nullif(payload->>'company_id','')::uuid,nullif(payload->>'deal_id','')::uuid,nullif(payload->>'template_id','')::uuid,payload->>'objective',payload->>'problem',payload->>'solution',payload->>'scope',payload->>'pricing',coalesce((payload->>'amount')::numeric,0),payload->>'terms',coalesce(payload->>'status','Draft')) returning id into pid;
 else
  select * into p from public.pitches where id=record_id for update;
  if p.id is null or (p.owner_id<>auth.uid() and not private.manage(p.org_id)) then raise exception 'Pitch unavailable or access denied'; end if;
  update public.pitches set name=payload->>'name',owner_id=(payload->>'owner_id')::uuid,lead_id=nullif(payload->>'lead_id','')::uuid,contact_id=nullif(payload->>'contact_id','')::uuid,company_id=nullif(payload->>'company_id','')::uuid,deal_id=nullif(payload->>'deal_id','')::uuid,template_id=nullif(payload->>'template_id','')::uuid,objective=payload->>'objective',problem=payload->>'problem',solution=payload->>'solution',scope=payload->>'scope',pricing=payload->>'pricing',amount=coalesce((payload->>'amount')::numeric,0),terms=payload->>'terms',status=payload->>'status' where id=record_id;
  pid=record_id;
  delete from public.pitch_sections where pitch_id=pid;
 end if;
 if jsonb_array_length(sections)>30 then raise exception 'Maximum 30 sections per proposal'; end if;
 for section in select * from jsonb_array_elements(sections) loop
  insert into public.pitch_sections(org_id,pitch_id,title,content,position) values((payload->>'org_id')::uuid,pid,section->>'title',coalesce(section->>'content',''),pos);
  pos=pos+1;
 end loop;
 return pid;
end $$;
create function public.pitch_to_deal(pitch uuid) returns uuid language plpgsql security invoker set search_path='' as $$
declare p public.pitches; d uuid; st text; begin
 select * into p from public.pitches where id=pitch for update;
 if p.id is null or (p.owner_id<>auth.uid() and not private.manage(p.org_id)) then raise exception 'Access denied'; end if;
 if p.status<>'Accepted' or p.archived_at is not null then raise exception 'Accept an active pitch first'; end if;
 if p.deal_id is not null then return p.deal_id; end if;
 select v->>'name' into st from public.organizations o,jsonb_array_elements(o.pipeline_stages) v where o.id=p.org_id and v->>'outcome'='open' limit 1;
 insert into public.deals(org_id,owner_id,name,company_id,contact_id,lead_id,amount,stage) values(p.org_id,p.owner_id,p.name,p.company_id,p.contact_id,p.lead_id,p.amount,st) returning id into d;
 update public.pitches set deal_id=d where id=p.id;
 return d;
end $$;
-- All reporting runs on the server under the caller's RLS permissions.
create function public.crm_summary(o uuid, start_at timestamptz default '1970-01-01', end_at timestamptz default '2100-01-01') returns jsonb language sql stable security invoker set search_path='' as $$
with l as(select * from public.leads where org_id=o and archived_at is null and created_at>=start_at and created_at<end_at),
d as(select * from public.deals where org_id=o and archived_at is null),
p as(select * from public.pitches where org_id=o and archived_at is null and created_at>=start_at and created_at<end_at),
w as(select * from d where outcome='won' and closed_at>=start_at and closed_at<end_at),
lost as(select * from d where outcome='lost' and closed_at>=start_at and closed_at<end_at),
monthly as(select to_char(closed_at at time zone (select timezone from public.organizations where id=o),'YYYY-MM') as month,sum(amount) value from w group by 1),
stages as(select stage,count(*) count,sum(amount) value,sum(amount*probability/100) weighted from d where outcome='open' group by stage),
sources as(select source,count(*) count from l group by source),
reps as(select m.user_id,pr.name,(select count(*) from l where owner_id=m.user_id) leads,(select count(*) from d where owner_id=m.user_id and created_at>=start_at and created_at<end_at) deals,(select count(*) from w where owner_id=m.user_id) won,(select count(*) from lost where owner_id=m.user_id) lost,(select coalesce(sum(amount),0) from w where owner_id=m.user_id) value,(select coalesce(sum(amount),0) from public.sales_targets t where t.org_id=o and not t.team_target and t.owner_id=m.user_id and t.archived_at is null and t.period_end>=(start_at at time zone (select timezone from public.organizations where id=o))::date and t.period_start<(end_at at time zone (select timezone from public.organizations where id=o))::date) target from public.memberships m join public.profiles pr on pr.id=m.user_id where m.org_id=o),
companies as(select coalesce(c.name,'Unassigned') name,sum(w.amount) value,count(*) count from w left join public.companies c on c.id=w.company_id group by c.name),
pt as(select coalesce(t.name,'No template') name,p.owner_id,count(*) total,count(*) filter(where p.status='Accepted') accepted from p left join public.pitch_templates t on t.id=p.template_id group by t.name,p.owner_id)
select jsonb_build_object(
'leads',(select count(*) from l),'qualified',(select count(*) from l where status in ('Qualified','Converted')),
'converted',(select count(*) from l where status='Converted'),'contacts',(select count(*) from public.contacts where org_id=o and archived_at is null and created_at>=start_at and created_at<end_at),
'openDeals',(select count(*) from d where outcome='open'),'pipeline',(select coalesce(sum(amount),0) from d where outcome='open'),
'weighted',(select coalesce(sum(amount*probability/100),0) from d where outcome='open'),'won',(select coalesce(sum(amount),0) from w),
'wonCount',(select count(*) from w),'lost',(select coalesce(sum(amount),0) from lost),'lostCount',(select count(*) from lost),
'avgDeal',(select coalesce(avg(amount),0) from w),'cycleDays',(select avg(extract(epoch from closed_at-created_at)/86400) from w),
'conversionDays',(select avg(extract(epoch from converted_at-created_at)/86400) from l where converted_at is not null),
'leadWon',(select count(*) from l where exists(select 1 from d where d.lead_id=l.id and d.outcome='won' and d.closed_at<end_at)),
'previousWon',(select coalesce(sum(amount),0) from d where outcome='won' and closed_at>=start_at-(end_at-start_at) and closed_at<start_at),
'collected',(select coalesce(sum(amount),0) from public.payments where org_id=o and archived_at is null and paid_at>=start_at and paid_at<end_at),
'periodDeals',(select count(*) from d where created_at>=start_at and created_at<end_at),
'overdueDeals',(select count(*) from d where outcome='open' and expected_close_date<(now() at time zone (select timezone from public.organizations where id=o))::date),
'stalledDeals',(select count(*) from d where outcome='open' and updated_at<now()-interval '30 days'),
'pitches',(select count(*) from p),'pitchDraft',(select count(*) from p where status='Draft'),'pitchSent',(select count(*) from p where status='Sent'),'pitchReady',(select count(*) from p where status='Ready to Send'),'pitchAccepted',(select count(*) from p where status='Accepted'),'pitchRejected',(select count(*) from p where status='Rejected'),'pitchExpired',(select count(*) from p where status='Expired'),
'pitchConverted',(select count(*) from p where deal_id is not null),'pitchDealValue',(select coalesce(sum(amount),0) from d where exists(select 1 from p where p.deal_id=d.id)),
'acceptanceDays',(select avg(extract(epoch from accepted_at-created_at)/86400) from p where accepted_at is not null),
'pitchByTemplate',coalesce((select jsonb_agg(pt) from pt),'[]'::jsonb),
'monthly',coalesce((select jsonb_agg(monthly order by month) from monthly),'[]'::jsonb),
'stages',coalesce((select jsonb_agg(stages) from stages),'[]'::jsonb),
'sources',coalesce((select jsonb_agg(sources) from sources),'[]'::jsonb),
'leadMonthly',coalesce((select jsonb_agg(x) from(select to_char(created_at at time zone (select timezone from public.organizations where id=o),'YYYY-MM') as month,count(*) value from l group by 1 order by 1)x),'[]'::jsonb),
'reps',coalesce((select jsonb_agg(reps) from reps),'[]'::jsonb),
'companies',coalesce((select jsonb_agg(companies) from companies),'[]'::jsonb),
'nextTasks',coalesce((select jsonb_agg(x) from(select id,name,due_date,priority from public.tasks where org_id=o and archived_at is null and status<>'Completed' order by due_date limit 5)x),'[]'::jsonb),
'recentDeals',coalesce((select jsonb_agg(x) from(select id,name,amount,stage,created_at from d order by created_at desc limit 5)x),'[]'::jsonb),
'attentionLeads',coalesce((select jsonb_agg(x) from(select id,name,priority,status from l where status='New' order by created_at limit 5)x),'[]'::jsonb),
'activities',coalesce((select jsonb_agg(x) from(select id,name,type,description,occurred_at from public.activities where org_id=o and archived_at is null and occurred_at>=start_at and occurred_at<end_at order by occurred_at desc limit 6)x),'[]'::jsonb),
'notifications',coalesce((select jsonb_agg(x) from(select id,name,due_date from public.tasks where org_id=o and owner_id=auth.uid() and archived_at is null and status<>'Completed' and due_date<=(now() at time zone (select timezone from public.organizations where id=o))::date order by due_date limit 20)x),'[]'::jsonb),
'personalTarget',(select coalesce(sum(amount),0) from public.sales_targets where org_id=o and owner_id=auth.uid() and not team_target and archived_at is null and period_end>=(start_at at time zone (select timezone from public.organizations where id=o))::date and period_start<(end_at at time zone (select timezone from public.organizations where id=o))::date),
'personalWon',(select coalesce(sum(amount),0) from w where owner_id=auth.uid()),
 'target',(select coalesce(sum(amount),0) from public.sales_targets where org_id=o and team_target and archived_at is null and period_end>=(start_at at time zone (select timezone from public.organizations where id=o))::date and period_start<(end_at at time zone (select timezone from public.organizations where id=o))::date)
)
where (select private.member_role(o)) is not null
$$;
create function public.global_search(o uuid, term text) returns table(id uuid,name text,kind text) language sql stable security invoker set search_path='' as $$
select * from (
 select id,name,'leads' kind from public.leads where org_id=o and archived_at is null and (name ilike '%'||term||'%' or email ilike '%'||term||'%' or company_name ilike '%'||term||'%' or phone ilike '%'||term||'%')
 union all select id,name,'contacts' from public.contacts where org_id=o and archived_at is null and (name ilike '%'||term||'%' or email ilike '%'||term||'%')
 union all select id,name,'companies' from public.companies where org_id=o and archived_at is null and name ilike '%'||term||'%'
 union all select id,name,'deals' from public.deals where org_id=o and archived_at is null and name ilike '%'||term||'%'
 union all select id,name,'pitch-desk' from public.pitches where org_id=o and archived_at is null and name ilike '%'||term||'%'
) s order by name limit 20
$$;
-- Public RPCs are invoker-only. Anonymous callers cannot execute any CRM RPC.
revoke all on all functions in schema public from public,anon;
grant execute on all functions in schema public to authenticated;
revoke all on all functions in schema private from public,anon;
grant execute on function private.member_role(uuid),private.manage(uuid),private.create_workspace(text,text),private.manage_member(uuid,text,text) to authenticated;
