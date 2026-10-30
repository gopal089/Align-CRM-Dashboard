-- Workspace custom fields and saved views. Existing record IDs and values are retained.
create table public.custom_field_definitions (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 entity text not null check(entity in ('leads','contacts')),
 name text not null check(length(trim(name)) between 1 and 80),
 field_type text not null check(field_type in ('text','number','date','dropdown','boolean')),
 options text[] not null default '{}', archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(org_id,entity,id)
);
create unique index custom_fields_name on public.custom_field_definitions(org_id,entity,lower(trim(name)));
create index custom_fields_org on public.custom_field_definitions(org_id,entity,created_at,id);
alter table public.leads add column custom_values jsonb not null default '{}'::jsonb;
alter table public.contacts add column custom_values jsonb not null default '{}'::jsonb;

create table public.saved_views (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
 entity text not null check(entity in ('leads','contacts')),
 name text not null check(length(trim(name)) between 1 and 80),
 visibility text not null default 'personal' check(visibility in ('personal','shared')),
 configuration jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index saved_views_personal_name on public.saved_views(org_id,entity,owner_id,lower(trim(name))) where visibility='personal';
create unique index saved_views_shared_name on public.saved_views(org_id,entity,lower(trim(name))) where visibility='shared';
create index saved_views_org on public.saved_views(org_id,entity,visibility,owner_id);

alter table public.custom_field_definitions enable row level security;
alter table public.saved_views enable row level security;
revoke all on public.custom_field_definitions,public.saved_views from public,anon,authenticated;
grant select,insert,update on public.custom_field_definitions to authenticated;
grant select,insert,update,delete on public.saved_views to authenticated;
create policy fields_read on public.custom_field_definitions for select to authenticated using ((select private.member_role(org_id)) is not null);
create policy fields_create on public.custom_field_definitions for insert to authenticated with check ((select private.member_role(org_id))='Administrator');
create policy fields_edit on public.custom_field_definitions for update to authenticated using ((select private.member_role(org_id))='Administrator') with check ((select private.member_role(org_id))='Administrator');
create policy views_read on public.saved_views for select to authenticated using ((select private.member_role(org_id)) is not null and (visibility='shared' or owner_id=(select auth.uid())));
create policy views_create on public.saved_views for insert to authenticated with check ((select private.member_role(org_id)) is not null and owner_id=(select auth.uid()) and (visibility='personal' or (select private.member_role(org_id))='Administrator'));
create policy views_edit on public.saved_views for update to authenticated using ((select private.member_role(org_id)) is not null and ((visibility='personal' and owner_id=(select auth.uid())) or (visibility='shared' and (select private.member_role(org_id))='Administrator'))) with check ((select private.member_role(org_id)) is not null and ((visibility='personal' and owner_id=(select auth.uid())) or (visibility='shared' and (select private.member_role(org_id))='Administrator')));
create policy views_delete on public.saved_views for delete to authenticated using ((select private.member_role(org_id)) is not null and ((visibility='personal' and owner_id=(select auth.uid())) or (visibility='shared' and (select private.member_role(org_id))='Administrator')));
-- The earlier MFA migration covers tables present at that time, not future tables.
create policy account_security on public.custom_field_definitions as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));
create policy account_security on public.saved_views as restrictive for all to authenticated using ((select private.security_session_ok())) with check ((select private.security_session_ok()));

create function private.validate_custom_field() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if private.member_role(new.org_id) is distinct from 'Administrator' then raise exception 'Administrator access required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('custom-fields:'||new.org_id::text,0));
 if TG_OP='UPDATE' then
  if new.id<>old.id or new.org_id<>old.org_id or new.entity<>old.entity or new.field_type<>old.field_type or new.created_at<>old.created_at then raise exception 'Field identity and type cannot be changed; archive and create a new field'; end if;
  if not(old.options <@ new.options) then raise exception 'Existing dropdown options must be retained; append new options instead'; end if;
 end if;
 new.name=trim(new.name); new.updated_at=now();
 if cardinality(new.options)>50 or exists(select 1 from unnest(new.options) x where x is null or length(trim(x)) not between 1 and 80 or x<>trim(x)) or cardinality(new.options)<>(select count(distinct x) from unnest(new.options) x) then raise exception 'Use up to 50 distinct nonempty dropdown options'; end if;
 if (new.field_type='dropdown' and cardinality(new.options)=0) or (new.field_type<>'dropdown' and cardinality(new.options)>0) then raise exception 'Only dropdown fields require options'; end if;
 if new.archived_at is null and (select count(*) from public.custom_field_definitions where org_id=new.org_id and entity=new.entity and archived_at is null and id<>new.id)>=50 then raise exception 'Maximum 50 active custom fields per record type'; end if;
 return new;
end $$;
revoke all on function private.validate_custom_field() from public,anon,authenticated;
create trigger validate_custom_field before insert or update on public.custom_field_definitions for each row execute function private.validate_custom_field();

create function private.validate_custom_values() returns trigger language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb; f public.custom_field_definitions; old_values jsonb='{}';
begin
 if TG_OP='UPDATE' then
  if new.custom_values=old.custom_values then return new; end if;
  old_values=old.custom_values;
 end if;
 -- Serialize value changes with field archival and option changes in this workspace.
 perform pg_advisory_xact_lock(hashtextextended('custom-fields:'||new.org_id::text,0));
 if jsonb_typeof(new.custom_values) is distinct from 'object' or octet_length(new.custom_values::text)>50000 then raise exception 'Custom values must be an object of at most 50 KB'; end if;
 if TG_OP='UPDATE' and exists(select 1 from public.custom_field_definitions d where d.org_id=new.org_id and d.entity=TG_TABLE_NAME and d.archived_at is not null and old_values ? d.id::text and (new.custom_values->d.id::text) is distinct from (old_values->d.id::text)) then raise exception 'Archived field values must be preserved'; end if;
 for k,v in select * from jsonb_each(new.custom_values) loop
  select * into f from public.custom_field_definitions where org_id=new.org_id and entity=TG_TABLE_NAME and id::text=k;
  if not found then raise exception 'Unknown custom field for this workspace and record type'; end if;
  if f.archived_at is not null then
   if TG_OP='INSERT' or v is distinct from old_values->k then raise exception 'Archived fields cannot be edited'; end if;
   continue;
  end if;
  if jsonb_typeof(v)='null' then continue; end if;
  if f.field_type in ('text','date','dropdown') and jsonb_typeof(v)<>'string' then raise exception 'Custom field % requires text',f.name; end if;
  if f.field_type='text' and length(v#>>'{}')>2000 then raise exception 'Custom text exceeds 2000 characters'; end if;
  if f.field_type='number' and (jsonb_typeof(v)<>'number' or abs((v#>>'{}')::numeric)>1000000000000000) then raise exception 'Custom number is invalid or outside the supported range'; end if;
  if f.field_type='boolean' and jsonb_typeof(v)<>'boolean' then raise exception 'Custom yes/no field requires a boolean'; end if;
  if f.field_type='date' then
   if (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' or to_char((v#>>'{}')::date,'YYYY-MM-DD')<>v#>>'{}' then raise exception 'Custom date must be a valid YYYY-MM-DD date'; end if;
  end if;
  if f.field_type='dropdown' and not((v#>>'{}')=any(f.options)) then raise exception 'Unknown custom dropdown option'; end if;
 end loop;
 return new;
end $$;
revoke all on function private.validate_custom_values() from public,anon,authenticated;
create trigger validate_custom_values before insert or update on public.leads for each row execute function private.validate_custom_values();
create trigger validate_custom_values before insert or update on public.contacts for each row execute function private.validate_custom_values();

create function private.validate_saved_view() returns trigger language plpgsql security invoker set search_path='' as $$
declare cfg jsonb; params jsonb; columns jsonb; k text; v jsonb; ref text; filters jsonb; item jsonb; f public.custom_field_definitions; op text; val text; base_columns text[];
begin
 if private.member_role(new.org_id) is null then raise exception 'Workspace access required'; end if;
 if new.visibility='shared' and private.member_role(new.org_id)<>'Administrator' then raise exception 'Only administrators can manage shared views'; end if;
 if TG_OP='INSERT' and new.owner_id is distinct from auth.uid() then raise exception 'View owner must be the current user'; end if;
 if TG_OP='UPDATE' and (new.id<>old.id or new.org_id<>old.org_id or new.entity<>old.entity or new.owner_id<>old.owner_id or new.created_at<>old.created_at) then raise exception 'View identity and owner cannot be changed'; end if;
 perform pg_advisory_xact_lock(hashtextextended('saved-views:'||new.org_id::text||new.owner_id::text,0));
 if TG_OP='INSERT' and (select count(*) from public.saved_views where org_id=new.org_id and owner_id=new.owner_id)>=100 then raise exception 'Maximum 100 saved views per user and workspace'; end if;
 new.name=trim(new.name); new.updated_at=now(); cfg=new.configuration;
 if jsonb_typeof(cfg) is distinct from 'object' or octet_length(cfg::text)>50000 or (cfg->>'version') is distinct from '1' or exists(select 1 from jsonb_object_keys(cfg) x where x not in ('version','params','columns')) then raise exception 'Invalid saved view configuration'; end if;
 params=cfg->'params'; columns=cfg->'columns';
 if jsonb_typeof(params) is distinct from 'object' or jsonb_typeof(columns) is distinct from 'array' then raise exception 'Views require parameters and visible columns'; end if;
 if jsonb_array_length(columns) not between 1 and 60 or not(columns @> '["name"]') or (select count(distinct x) from jsonb_array_elements(columns) x)<>jsonb_array_length(columns) then raise exception 'Choose unique visible columns including Name'; end if;
 base_columns=case when new.entity='leads' then array['name','company_name','email','phone','source','status','priority','owner_id','created_at','updated_at'] else array['name','email','phone','job_title','company_id','owner_id','created_at','updated_at','tags'] end;
 for k,v in select * from jsonb_each(params) loop
  if k not in ('q','archived','status','owner_id','source','priority','company_id','qualified','tag','month','since','until','sort','direction','cf') or jsonb_typeof(v)<>'string' or length(v#>>'{}')>12000 then raise exception 'Unsupported saved view parameter'; end if;
  if k='q' and length(v#>>'{}')>120 then raise exception 'Search is too long'; end if;
  if k='direction' and v#>>'{}' not in ('asc','desc') then raise exception 'Invalid sort direction'; end if;
  if k in ('archived','qualified') and v#>>'{}'<>'1' then raise exception 'Invalid saved view flag'; end if;
  if k in ('owner_id','company_id') and (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid saved view record identifier'; end if;
  if k='owner_id' and not exists(select 1 from public.memberships where org_id=new.org_id and user_id::text=v#>>'{}') then raise exception 'View owner filter must belong to this workspace'; end if;
  if k='company_id' and not exists(select 1 from public.companies where org_id=new.org_id and id::text=v#>>'{}') then raise exception 'View company filter must belong to this workspace'; end if;
  if k='month' and (v#>>'{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid view month'; end if;
  if k in ('since','until') then perform (v#>>'{}')::timestamptz; end if;
  if k='status' and (new.entity<>'leads' or v#>>'{}' not in ('New','Contacted','Qualified','Converted','Lost')) then raise exception 'Invalid lead status filter'; end if;
  if k='priority' and (new.entity<>'leads' or v#>>'{}' not in ('Low','Medium','High')) then raise exception 'Invalid lead priority filter'; end if;
  if k in ('tag','source') and length(v#>>'{}')>120 then raise exception 'View filter text is too long'; end if;
 end loop;
 for ref in select x#>>'{}' from jsonb_array_elements(columns) x union all select params->>'sort' where params ? 'sort' loop
  if ref=any(base_columns) then continue; end if;
  if ref !~ '^cf:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists(select 1 from public.custom_field_definitions where org_id=new.org_id and entity=new.entity and id::text=substring(ref from 4)) then raise exception 'Unknown column for this workspace and record type'; end if;
 end loop;
 if params ? 'cf' then
  filters=(params->>'cf')::jsonb;
  if jsonb_typeof(filters)<>'array' or jsonb_array_length(filters)>20 then raise exception 'Use at most 20 custom field filters'; end if;
  for item in select * from jsonb_array_elements(filters) loop
   if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) x where x not in ('field','op','value')) then raise exception 'Invalid custom field filter'; end if;
   select * into f from public.custom_field_definitions where org_id=new.org_id and entity=new.entity and id::text=item->>'field';
   if not found then raise exception 'Unknown filter field for this workspace and record type'; end if;
   op=item->>'op'; val=item->>'value';
   if op is null or op not in ('eq','contains','gte','lte','empty','not_empty') then raise exception 'Unsupported custom field operator'; end if;
   if op in ('empty','not_empty') then continue; end if;
   if jsonb_typeof(item->'value') is distinct from 'string' or length(val)>2000 then raise exception 'Invalid custom filter value'; end if;
   if op='contains' and f.field_type<>'text' then raise exception 'Contains requires a text field'; end if;
   if op in ('gte','lte') and f.field_type not in ('number','date') then raise exception 'Range filters require numbers or dates'; end if;
   if f.field_type='number' then
    if val !~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' or length(val)>80 or abs(val::numeric)>1000000000000000 then raise exception 'Invalid number filter'; end if;
   elsif f.field_type='boolean' and val not in ('true','false') then raise exception 'Invalid yes/no filter';
   elsif f.field_type='dropdown' and not(val=any(f.options)) then raise exception 'Invalid dropdown filter';
   elsif f.field_type='date' then
    if val !~ '^\d{4}-\d{2}-\d{2}$' or to_char(val::date,'YYYY-MM-DD')<>val then raise exception 'Invalid date filter'; end if;
   end if;
  end loop;
 end if;
 return new;
end $$;
revoke all on function private.validate_saved_view() from public,anon,authenticated;
create trigger validate_saved_view before insert or update on public.saved_views for each row execute function private.validate_saved_view();
