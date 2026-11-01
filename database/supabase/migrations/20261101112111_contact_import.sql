-- Contacts only. Raw files stay in the browser; temporary mapped/source rows expire.
create table private.contact_import_jobs (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade, file_name text not null,
 headers jsonb not null, file_meta jsonb not null, expected_rows integer not null check(expected_rows between 1 and 10000),
 duplicate_policy text not null check(duplicate_policy in ('skip','update')),
 state text not null default 'uploading' check(state in ('uploading','reviewing','ready','running','complete','cancelled')),
 staged_bytes integer not null default 0 check(staged_bytes between 0 and 16777216),
 confirmation uuid, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours'
);
create index contact_import_jobs_owner on private.contact_import_jobs(org_id,owner_id,created_at desc);
create index contact_import_jobs_expiry on private.contact_import_jobs(expires_at);
create table private.contact_import_rows (
 job_id uuid not null references private.contact_import_jobs(id) on delete cascade,
 row_no integer not null check(row_no between 2 and 10001), retry_id uuid not null default gen_random_uuid(),
 payload jsonb not null, source jsonb not null, client_error text not null default '',
 email text not null default '', phone text not null default '', new_id uuid not null default gen_random_uuid(),
 target_id uuid, action text check(action in ('insert','update','skip','error')), error text not null default '',
 result text check(result in ('imported','updated','skipped','failed')),
 primary key(job_id,row_no), unique(job_id,retry_id)
);
create index contact_import_rows_email on private.contact_import_rows(job_id,email,row_no) where email<>'';
create index contact_import_rows_phone on private.contact_import_rows(job_id,phone,row_no) where phone<>'';
create index contact_import_rows_pending on private.contact_import_rows(job_id,row_no) where result is null;
alter table private.contact_import_jobs enable row level security;
alter table private.contact_import_rows enable row level security;
revoke all on private.contact_import_jobs,private.contact_import_rows from public,anon,authenticated;
create policy import_owner on private.contact_import_jobs for select to authenticated using(owner_id=(select auth.uid()) and (select private.member_role(org_id)) is not null and expires_at>statement_timestamp());
create policy account_security on private.contact_import_jobs as restrictive for all to authenticated using((select private.security_session_ok())) with check((select private.security_session_ok()));
create policy import_row_owner on private.contact_import_rows for select to authenticated using(exists(select 1 from private.contact_import_jobs j where j.id=job_id and j.owner_id=(select auth.uid()) and private.member_role(j.org_id) is not null and j.expires_at>statement_timestamp()));
create policy account_security on private.contact_import_rows as restrictive for all to authenticated using((select private.security_session_ok())) with check((select private.security_session_ok()));

create function private.import_email(v text) returns text language sql immutable set search_path='' as $$select lower(trim(coalesce(v,'')))$$;
create function private.import_phone(v text) returns text language sql immutable set search_path='' as $$select case when trim(coalesce(v,'')) like '00%' then substring(regexp_replace(v,'[^0-9]','','g') from 3) else regexp_replace(coalesce(v,''),'[^0-9]','','g') end$$;
revoke all on function private.import_email(text),private.import_phone(text) from public,anon,authenticated;
grant execute on function private.import_email(text),private.import_phone(text) to authenticated,service_role;
create index contacts_import_email on public.contacts(org_id,private.import_email(email)) where coalesce(email,'')<>'';
create index contacts_import_phone on public.contacts(org_id,private.import_phone(phone)) where coalesce(phone,'')<>'';
-- Use the existing billing workspace lock, acquired before other contact triggers.
-- Ordinary edits and imports therefore cannot race the import's duplicate decision.
create function private.contact_import_lock() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('billing:'||(case when TG_OP='DELETE' then old.org_id else new.org_id end)::text,0));
 return case when TG_OP='DELETE' then old else new end;
end $$;
revoke all on function private.contact_import_lock() from public,anon,authenticated;
create trigger aa_contact_import_lock before insert or update or delete on public.contacts for each row execute function private.contact_import_lock();

create function private.import_contact_value(o uuid,p jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb; f public.custom_field_definitions; value text; result jsonb=p;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>20000 then raise exception 'Invalid mapped contact'; end if;
 for k,v in select * from jsonb_each(p) loop
  if k not in ('name','email','phone','job_title','tags','notes','custom_values') then raise exception 'Unsupported contact field'; end if;
  if k not in ('tags','custom_values') then
   if jsonb_typeof(v)<>'string' or length(v#>>'{}')>2000 or (v#>>'{}') ~ '^[[:space:][:cntrl:]]*[=@]' then raise exception 'Invalid text or formula-like value'; end if;
  end if;
 end loop;
 if length(trim(coalesce(p->>'name',''))) not between 1 and 200 then raise exception 'Name is required, up to 200 characters'; end if;
 result=jsonb_set(result,'{name}',to_jsonb(trim(p->>'name')));
 if p ? 'email' then
  value=private.import_email(p->>'email');
  if length(value)>254 or value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  result=jsonb_set(result,'{email}',to_jsonb(value));
 end if;
 if p ? 'phone' then
  value=private.import_phone(p->>'phone');
  if p->>'phone' !~ '^[+0-9() .-]+$' or value !~ '^[0-9]{7,15}$' then raise exception 'Phone requires 7 to 15 digits'; end if;
  result=jsonb_set(result,'{phone}',to_jsonb(value));
 end if;
 if p ? 'tags' and (jsonb_typeof(p->'tags')<>'array' or jsonb_array_length(p->'tags')>50 or exists(select 1 from jsonb_array_elements(p->'tags') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>80)) then raise exception 'Invalid tags'; end if;
 if p ? 'custom_values' then
  if jsonb_typeof(p->'custom_values') is distinct from 'object' then raise exception 'Invalid custom values'; end if;
  for k,v in select * from jsonb_each(p->'custom_values') loop
   select * into f from public.custom_field_definitions where org_id=o and entity='contacts' and id::text=k and archived_at is null;
   if not found then raise exception 'Custom field is unavailable or archived'; end if;
   value=v#>>'{}';
   if f.field_type in ('text','date','dropdown') and (jsonb_typeof(v)<>'string' or length(value)>2000 or value ~ '^[[:space:][:cntrl:]]*[=@]') then raise exception 'Invalid custom text'; end if;
   if f.field_type='number' and (jsonb_typeof(v)<>'number' or abs(value::numeric)>1000000000000000) then raise exception 'Invalid custom number'; end if;
   if f.field_type='boolean' and jsonb_typeof(v)<>'boolean' then raise exception 'Invalid custom yes/no'; end if;
   if f.field_type='dropdown' and not(value=any(f.options)) then raise exception 'Unknown dropdown option'; end if;
   if f.field_type='date' and (value !~ '^\d{4}-\d{2}-\d{2}$' or to_char(value::date,'YYYY-MM-DD')<>value) then raise exception 'Invalid custom date'; end if;
  end loop;
 end if;
 return result;
end $$;
revoke all on function private.import_contact_value(uuid,jsonb) from public,anon,authenticated;

-- Narrow privileged workflow: private staging has no client DML grants. The helper
-- checks native session/MFA, active membership, job ownership, row ownership,
-- billing visibility/preservation and explicit targets before every commit.
-- Existing record/custom-field/quota triggers remain enabled on contact writes.
create function private.contact_import(o uuid, operation text, j uuid, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.contact_import_jobs; r private.contact_import_rows; oldrow private.contact_import_rows;
 u uuid=auth.uid(); member text; item jsonb; value jsonb; rownum integer; n integer; bytes integer; offset_row integer;
 ids uuid[]; prior_ids uuid[]; candidate uuid; existing public.contacts; outcome text; message text; summary jsonb;
begin
 if u is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 member=private.member_role(o); if member is null then raise exception 'Workspace access required'; end if;
 if coalesce(operation,'') not in ('create','list','append','seal','review','status','confirm','batch','cancel') or p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>98304 then raise exception 'Invalid import request (maximum 96 KB)'; end if;
 if operation='create' then
  perform pg_advisory_xact_lock(hashtextextended('contact-import:'||o::text,0));
  if (select count(*) from private.contact_import_jobs where org_id=o and expires_at>statement_timestamp() and state<>'cancelled')>=3 then raise exception 'This workspace already has three recent imports; wait for expiry or cancel an old import'; end if;
  if length(p->>'file_name') not between 1 and 200 or jsonb_typeof(p->'headers') is distinct from 'array' or jsonb_array_length(p->'headers') not between 1 and 100 or exists(select 1 from jsonb_array_elements(p->'headers') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>2000) then raise exception 'Invalid file metadata'; end if;
  if jsonb_typeof(p->'file_meta') is distinct from 'object' or coalesce(p->'file_meta'->>'sha256','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(p->'file_meta'->'mapping') is distinct from 'array' or jsonb_array_length(p->'file_meta'->'mapping')>100 or length(coalesce(p->'file_meta'->>'sheet',''))>2000 then raise exception 'Invalid resume metadata'; end if;
  if (p->>'rows')::integer not between 1 and 10000 or coalesce(p->>'policy','') not in ('skip','update') then raise exception 'Choose up to 10,000 rows and Skip or Update existing'; end if;
  insert into private.contact_import_jobs(org_id,owner_id,file_name,headers,file_meta,expected_rows,duplicate_policy) values(o,u,p->>'file_name',p->'headers',p->'file_meta',(p->>'rows')::integer,p->>'policy') returning * into job;
  return to_jsonb(job);
 end if;
 if operation='list' then
  return coalesce((select jsonb_agg(x) from(select id,file_name,state,created_at,expires_at from private.contact_import_jobs where org_id=o and owner_id=u and expires_at>statement_timestamp() order by created_at desc limit 10)x),'[]');
 end if;
 -- Global lock order is workspace billing lock, then import job, then contact.
 if operation in ('review','batch') then perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0)); end if;
 select * into job from private.contact_import_jobs where id=j and org_id=o and owner_id=u and expires_at>statement_timestamp() for update;
 if not found then raise exception 'Import is unavailable, expired, or belongs to another user'; end if;
 if private.member_role(o) is null or not private.security_session_ok() then raise exception 'Workspace/session access changed'; end if;
 if operation='append' then
  if job.state<>'uploading' or jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows') not between 1 and 25 then raise exception 'Upload up to 25 rows per request'; end if;
  for item in select * from jsonb_array_elements(p->'rows') loop
   rownum=(item->>'row_no')::integer;
   if rownum not between 2 and job.expected_rows+1 or jsonb_typeof(item->'payload') is distinct from 'object' or jsonb_typeof(item->'source') is distinct from 'array' or jsonb_array_length(item->'source')>100 or exists(select 1 from jsonb_array_elements(item->'source') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>2000) or length(coalesce(item->>'client_error',''))>1000 then raise exception 'Invalid staged row'; end if;
   select * into oldrow from private.contact_import_rows where job_id=j and row_no=rownum;
   if found then
    if oldrow.payload<>item->'payload' or oldrow.source<>item->'source' or oldrow.client_error<>coalesce(item->>'client_error','') then raise exception 'Retry row differs from the original upload'; end if;
   else
    bytes=octet_length(item::text);job.staged_bytes=job.staged_bytes+bytes;
    if job.staged_bytes>16777216 then raise exception 'Mapped import exceeds 16 MB; split the file or select fewer columns'; end if;
    insert into private.contact_import_rows(job_id,row_no,payload,source,client_error,email,phone) values(j,rownum,item->'payload',item->'source',coalesce(item->>'client_error',''),private.import_email(item->'payload'->>'email'),private.import_phone(item->'payload'->>'phone'));
   end if;
  end loop;
  update private.contact_import_jobs set staged_bytes=job.staged_bytes where id=j;
 elsif operation='seal' then
  if job.state='uploading' then
   if (select count(*) from private.contact_import_rows where job_id=j)<>job.expected_rows then raise exception 'Upload is incomplete; resume the missing rows'; end if;
   update private.contact_import_jobs set state='reviewing' where id=j;
  elsif job.state not in ('reviewing','ready') then raise exception 'Import cannot be sealed now'; end if;
 elsif operation='review' then
  if job.state='reviewing' then
   for r in select * from private.contact_import_rows where job_id=j and action is null order by row_no limit 25 loop
    begin
     if r.client_error<>'' then raise exception '%',r.client_error; end if;
     if exists(select 1 from jsonb_array_elements_text(r.source) x where x ~ '^[[:space:][:cntrl:]]*[=@]' or (x ~ '^[[:space:][:cntrl:]]*[+-]' and x !~ '^[[:space:]]*[+-][0-9() .-]+[[:space:]]*$' and x !~ '^[[:space:]]*[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?[[:space:]]*$')) then raise exception 'Formula-like source cell; replace it with a plain value'; end if;
     value=private.import_contact_value(o,r.payload);
     select coalesce(array_agg(c.id),'{}') into ids from public.contacts c where c.org_id=o and ((r.email<>'' and private.import_email(c.email)=r.email) or (r.phone<>'' and private.import_phone(c.phone)=r.phone));
     select coalesce(array_agg(distinct target_id),'{}') into prior_ids from private.contact_import_rows where job_id=j and row_no<r.row_no and action in ('insert','update') and ((r.email<>'' and email=r.email) or (r.phone<>'' and phone=r.phone));
     select coalesce(array_agg(distinct x),'{}') into ids from unnest(ids||prior_ids) x;
     outcome='insert';candidate=r.new_id;message='';
     if cardinality(ids)>0 then
      if job.duplicate_policy='skip' then outcome='skip';candidate=null;message='Duplicate email/phone in the workspace or file';
      else
       if cardinality(ids)<>1 then raise exception 'Multiple contacts match; choose Skip or correct the file'; end if;
       outcome='update';candidate=ids[1];
       select * into existing from public.contacts where org_id=o and id=candidate;
       if found and (not private.billing_readable(o,'contacts',candidate) or private.billing_preserved(o,'contacts',candidate) or existing.archived_at is not null or (existing.owner_id<>u and not private.manage(o))) then raise exception 'Matching contact is not editable by your account or plan'; end if;
      end if;
     end if;
     update private.contact_import_rows set payload=value,action=outcome,target_id=candidate,error=message where job_id=j and row_no=r.row_no;
    exception when others then
     update private.contact_import_rows set action='error',target_id=null,error=left(SQLERRM,1000) where job_id=j and row_no=r.row_no;
    end;
   end loop;
   if not exists(select 1 from private.contact_import_rows where job_id=j and action is null) then update private.contact_import_jobs set state='ready',confirmation=gen_random_uuid() where id=j; end if;
  elsif job.state<>'ready' then raise exception 'Import cannot be reviewed now'; end if;
 elsif operation='confirm' then
  if job.state='ready' and (p->>'confirmation')::uuid=job.confirmation then update private.contact_import_jobs set state='running' where id=j;
  elsif job.state<>'running' then raise exception 'Review the complete preview before confirming'; end if;
 elsif operation='batch' then
  if job.state not in ('running','complete') or jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows') not between 1 and 25 then raise exception 'Confirm first and commit at most 25 explicit row targets'; end if;
  for item in select * from jsonb_array_elements(p->'rows') loop
   select * into r from private.contact_import_rows where job_id=j and retry_id=(item->>'retry_id')::uuid for update;
   if not found or (item->>'target_id')::uuid is distinct from r.target_id then raise exception 'Explicit import target does not match the reviewed row'; end if;
   if r.result is not null then continue; end if;
   if exists(select 1 from private.contact_import_rows where job_id=j and row_no<r.row_no and result is null) then raise exception 'Resume the earliest unfinished rows first'; end if;
   outcome='failed';message=r.error;
   begin
    if not private.security_session_ok() or private.member_role(o) is null then raise exception 'Workspace/session access changed'; end if;
    if r.action='error' then outcome='failed';
    elsif r.action='skip' then outcome='skipped';
    else
     value=private.import_contact_value(o,r.payload);
     select coalesce(array_agg(c.id),'{}') into ids from public.contacts c where c.org_id=o and ((r.email<>'' and private.import_email(c.email)=r.email) or (r.phone<>'' and private.import_phone(c.phone)=r.phone));
     if r.action='insert' then
      if cardinality(ids)<>0 then raise exception 'Duplicates changed since preview; start a new preview'; end if;
      insert into public.contacts(id,org_id,owner_id,name,email,phone,job_title,tags,notes,custom_values) values(r.target_id,o,u,value->>'name',value->>'email',coalesce(value->>'phone',''),coalesce(value->>'job_title',''),coalesce(array(select jsonb_array_elements_text(value->'tags')),'{}'),coalesce(value->>'notes',''),coalesce(value->'custom_values','{}'));
      outcome='imported';message='';
     else
      if cardinality(ids)<>1 or ids[1]<>r.target_id then raise exception 'Duplicate target changed since preview; start a new preview'; end if;
      select * into existing from public.contacts where org_id=o and id=r.target_id for update;
      if not found or not private.billing_readable(o,'contacts',r.target_id) or existing.archived_at is not null or (existing.owner_id<>u and not private.manage(o)) then raise exception 'Matching contact is not editable by your account'; end if;
      if private.billing_preserved(o,'contacts',r.target_id) then raise exception 'Just upgrade your plan to edit or export.'; end if;
      update public.contacts set name=value->>'name',email=coalesce(value->>'email',existing.email),phone=coalesce(value->>'phone',existing.phone),job_title=coalesce(value->>'job_title',existing.job_title),tags=case when value ? 'tags' then array(select jsonb_array_elements_text(value->'tags')) else existing.tags end,notes=coalesce(value->>'notes',existing.notes),custom_values=existing.custom_values||coalesce(value->'custom_values','{}') where org_id=o and id=r.target_id and (owner_id=u or private.manage(o));
      if not found then raise exception 'Contact ownership changed'; end if;
      outcome='updated';message='';
     end if;
    end if;
   exception when others then outcome='failed';message=left(SQLERRM,1000);
   end;
   update private.contact_import_rows set result=outcome,error=message where job_id=j and row_no=r.row_no;
  end loop;
  if not exists(select 1 from private.contact_import_rows where job_id=j and result is null) then update private.contact_import_jobs set state='complete' where id=j; end if;
 elsif operation='cancel' then
  delete from private.contact_import_rows where job_id=j;
  update private.contact_import_jobs set state='cancelled',staged_bytes=0 where id=j;
 elsif operation<>'status' then raise exception 'Unsupported operation';
 end if;
 select * into job from private.contact_import_jobs where id=j;
 offset_row=greatest(0,least(coalesce((p->>'offset')::integer,0),10000));
 select jsonb_build_object('imported',count(*) filter(where result in ('imported','updated')),'updated',count(*) filter(where result='updated'),'skipped',count(*) filter(where result='skipped'),'failed',count(*) filter(where result='failed'),'processed',count(*) filter(where result is not null),'staged',count(*),'reviewed',count(*) filter(where action is not null),'errors',count(*) filter(where action='error'),'duplicates',count(*) filter(where action in ('skip','update'))) into summary from private.contact_import_rows where job_id=j;
 return jsonb_build_object('job',to_jsonb(job),'counts',summary,'rows',coalesce((select jsonb_agg(x order by x.row_no) from(select row_no,retry_id,payload,source,action,target_id,error,result from private.contact_import_rows where job_id=j and (coalesce(p->>'filter','all')<>'pending' or result is null) and (coalesce(p->>'filter','all')<>'failed' or result='failed') order by row_no offset offset_row limit 25)x),'[]'));
end $$;
revoke all on function private.contact_import(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.contact_import(uuid,text,uuid,jsonb) to authenticated;
create function public.contact_import(o uuid,operation text,j uuid default null,p jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select private.contact_import(o,operation,j,p)$$;
revoke all on function public.contact_import(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.contact_import(uuid,text,uuid,jsonb) to authenticated;

create function private.cleanup_contact_imports() returns integer language plpgsql security definer set search_path='' as $$
declare n integer; begin delete from private.contact_import_jobs where expires_at<=statement_timestamp(); get diagnostics n=row_count;return n;end $$;
revoke all on function private.cleanup_contact_imports() from public,anon,authenticated;
-- Standalone temporary-data cleanup; does not replace or modify billing jobs.
-- PGlite has no pg_cron; Docker/hosted Supabase provide it.
do $$begin
 if exists(select 1 from pg_available_extensions where name='pg_cron') then
  execute 'create extension if not exists pg_cron';
  if not exists(select 1 from cron.job where jobname='align-contact-import-cleanup') then
   perform cron.schedule('align-contact-import-cleanup','17 * * * *','select private.cleanup_contact_imports()');
  end if;
 end if;
end $$;
