-- Leads import. Leads and contacts now share one import engine, so both get
-- exactly the same staging, review, duplicate, permission, quota and retry
-- rules. The engine is generated from the contacts import with only the
-- record-type specific steps moved into the helpers below.

alter table private.contact_import_jobs add column entity text not null default 'contacts' check(entity in ('contacts','leads'));
create index leads_import_email on public.leads(org_id,private.import_email(email)) where coalesce(email,'')<>'';
create index leads_import_phone on public.leads(org_id,private.import_phone(phone)) where coalesce(phone,'')<>'';
-- Same workspace lock as contacts, so edits cannot race an import's duplicate check.
create trigger aa_lead_import_lock before insert or update or delete on public.leads for each row execute function private.contact_import_lock();

create function private.import_lead_value(o uuid,p jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb; f public.custom_field_definitions; value text; result jsonb=p; pick text;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>20000 then raise exception 'Invalid mapped lead'; end if;
 for k,v in select * from jsonb_each(p) loop
  if k not in ('name','company_name','email','phone','source','status','priority','notes','custom_values') then raise exception 'Unsupported lead field'; end if;
  if k<>'custom_values' then
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
 -- Choice fields accept any capitalisation and are stored as Align spells them.
 -- A missing source is filled in only when a new lead is created.
 if p ? 'source' then
  select s into pick from public.organizations org,unnest(org.lead_sources) s where org.id=o and lower(s)=lower(trim(p->>'source')) limit 1;
  if pick is null then raise exception 'Unknown lead source; use one listed in Settings → Lead sources'; end if;
  result=jsonb_set(result,'{source}',to_jsonb(pick));
 end if;
 if p ? 'status' then
  pick=null;
  select s into pick from unnest(array['New','Contacted','Qualified','Lost']) s where lower(s)=lower(trim(p->>'status'));
  if pick is null then raise exception 'Status must be New, Contacted, Qualified or Lost'; end if;
  result=jsonb_set(result,'{status}',to_jsonb(pick));
 end if;
 if p ? 'priority' then
  pick=null;
  select s into pick from unnest(array['Low','Medium','High']) s where lower(s)=lower(trim(p->>'priority'));
  if pick is null then raise exception 'Priority must be Low, Medium or High'; end if;
  result=jsonb_set(result,'{priority}',to_jsonb(pick));
 end if;
 if p ? 'custom_values' then
  if jsonb_typeof(p->'custom_values') is distinct from 'object' then raise exception 'Invalid custom values'; end if;
  for k,v in select * from jsonb_each(p->'custom_values') loop
   select * into f from public.custom_field_definitions where org_id=o and entity='leads' and id::text=k and archived_at is null;
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

create function private.import_value(o uuid,kind text,p jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if kind='leads' then return private.import_lead_value(o,p); end if;
 return private.import_contact_value(o,p);
end $$;

create function private.import_matches(o uuid,kind text,mail text,tel text) returns uuid[] language plpgsql stable security invoker set search_path='' as $$
declare ids uuid[];
begin
 if kind='leads' then
  select coalesce(array_agg(c.id),'{}') into ids from public.leads c where c.org_id=o and ((mail<>'' and private.import_email(c.email)=mail) or (tel<>'' and private.import_phone(c.phone)=tel));
 else
  select coalesce(array_agg(c.id),'{}') into ids from public.contacts c where c.org_id=o and ((mail<>'' and private.import_email(c.email)=mail) or (tel<>'' and private.import_phone(c.phone)=tel));
 end if;
 return ids;
end $$;

-- The same checks the contacts import made inline, for either record type.
create function private.import_check_target(o uuid,kind text,target uuid,u uuid,mode text) returns void language plpgsql security invoker set search_path='' as $$
declare archived timestamptz; owner uuid; word text=case when kind='leads' then 'lead' else 'contact' end;
begin
 if kind='leads' then
  if mode='batch' then select archived_at,owner_id into archived,owner from public.leads where org_id=o and id=target for update;
  else select archived_at,owner_id into archived,owner from public.leads where org_id=o and id=target; end if;
 else
  if mode='batch' then select archived_at,owner_id into archived,owner from public.contacts where org_id=o and id=target for update;
  else select archived_at,owner_id into archived,owner from public.contacts where org_id=o and id=target; end if;
 end if;
 if mode='review' then
  if found and (not private.billing_readable(o,kind,target) or private.billing_preserved(o,kind,target) or archived is not null or (owner<>u and not private.manage(o))) then
   raise exception 'Matching % is not editable by your account or plan',word;
  end if;
 else
  if not found or not private.billing_readable(o,kind,target) or archived is not null or (owner<>u and not private.manage(o)) then
   raise exception 'Matching % is not editable by your account',word;
  end if;
  if private.billing_preserved(o,kind,target) then raise exception 'Just upgrade your plan to edit or export.'; end if;
 end if;
end $$;

-- Writes one reviewed row. Empty or unmapped cells never erase existing values.
create function private.import_write(o uuid,kind text,target uuid,u uuid,value jsonb,is_new boolean) returns void language plpgsql security invoker set search_path='' as $$
declare c public.contacts; l public.leads; fallback text;
begin
 if kind='leads' then
  if is_new then
   select case when 'Manual'=any(lead_sources) then 'Manual' else lead_sources[1] end into fallback from public.organizations where id=o;
   insert into public.leads(id,org_id,owner_id,name,company_name,email,phone,source,status,priority,notes,custom_values)
   values(target,o,u,value->>'name',coalesce(value->>'company_name',''),value->>'email',coalesce(value->>'phone',''),coalesce(value->>'source',fallback),
    coalesce(value->>'status','New'),coalesce(value->>'priority','Medium'),coalesce(value->>'notes',''),coalesce(value->'custom_values','{}'));
  else
   select * into l from public.leads where org_id=o and id=target;
   update public.leads set name=value->>'name',company_name=coalesce(value->>'company_name',l.company_name),email=coalesce(value->>'email',l.email),
    phone=coalesce(value->>'phone',l.phone),source=coalesce(value->>'source',l.source),status=coalesce(value->>'status',l.status),
    priority=coalesce(value->>'priority',l.priority),notes=coalesce(value->>'notes',l.notes),custom_values=l.custom_values||coalesce(value->'custom_values','{}')
   where org_id=o and id=target and (owner_id=u or private.manage(o));
   if not found then raise exception 'Lead ownership changed'; end if;
  end if;
 else
  if is_new then
   insert into public.contacts(id,org_id,owner_id,name,email,phone,job_title,tags,notes,custom_values) values(target,o,u,value->>'name',value->>'email',coalesce(value->>'phone',''),coalesce(value->>'job_title',''),coalesce(array(select jsonb_array_elements_text(value->'tags')),'{}'),coalesce(value->>'notes',''),coalesce(value->'custom_values','{}'));
  else
   select * into c from public.contacts where org_id=o and id=target;
   update public.contacts set name=value->>'name',email=coalesce(value->>'email',c.email),phone=coalesce(value->>'phone',c.phone),job_title=coalesce(value->>'job_title',c.job_title),tags=case when value ? 'tags' then array(select jsonb_array_elements_text(value->'tags')) else c.tags end,notes=coalesce(value->>'notes',c.notes),custom_values=c.custom_values||coalesce(value->'custom_values','{}') where org_id=o and id=target and (owner_id=u or private.manage(o));
   if not found then raise exception 'Contact ownership changed'; end if;
  end if;
 end if;
end $$;
revoke all on function private.import_lead_value(uuid,jsonb),private.import_value(uuid,text,jsonb),private.import_matches(uuid,text,text,text),
 private.import_check_target(uuid,text,uuid,uuid,text),private.import_write(uuid,text,uuid,uuid,jsonb,boolean) from public,anon,authenticated;

-- The shared engine (generated from the contacts import; see the header).
create function private.record_import(o uuid, kind text, operation text, j uuid, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.contact_import_jobs; r private.contact_import_rows; oldrow private.contact_import_rows;
 u uuid=auth.uid(); member text; item jsonb; value jsonb; rownum integer; n integer; bytes integer; offset_row integer;
 ids uuid[]; prior_ids uuid[]; candidate uuid; existing public.contacts; outcome text; message text; summary jsonb;
begin
 if u is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 member=private.member_role(o); if member is null then raise exception 'Workspace access required'; end if;
 if coalesce(kind,'') not in ('contacts','leads') then raise exception 'Unsupported import type'; end if;
 if coalesce(operation,'') not in ('create','list','append','seal','review','status','confirm','batch','cancel') or p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>98304 then raise exception 'Invalid import request (maximum 96 KB)'; end if;
 if operation='create' then
  perform pg_advisory_xact_lock(hashtextextended('contact-import:'||o::text,0));
  -- Only imports still in progress count toward the limit, so a finished
  -- import no longer blocks the next one for 24 hours.
  if (select count(*) from private.contact_import_jobs where org_id=o and expires_at>statement_timestamp() and state not in ('complete','cancelled'))>=3 then raise exception 'This workspace already has three imports in progress; finish or cancel one first'; end if;
  -- Finished imports keep their error reports, but only the newest three per
  -- workspace survive a new import, so temporary rows cannot pile up.
  delete from private.contact_import_jobs where id in (select id from private.contact_import_jobs where org_id=o and state in ('complete','cancelled') order by created_at desc offset 3);
  if length(p->>'file_name') not between 1 and 200 or jsonb_typeof(p->'headers') is distinct from 'array' or jsonb_array_length(p->'headers') not between 1 and 100 or exists(select 1 from jsonb_array_elements(p->'headers') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>2000) then raise exception 'Invalid file metadata'; end if;
  if jsonb_typeof(p->'file_meta') is distinct from 'object' or coalesce(p->'file_meta'->>'sha256','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(p->'file_meta'->'mapping') is distinct from 'array' or jsonb_array_length(p->'file_meta'->'mapping')>100 or length(coalesce(p->'file_meta'->>'sheet',''))>2000 then raise exception 'Invalid resume metadata'; end if;
  if (p->>'rows')::integer not between 1 and 10000 or coalesce(p->>'policy','') not in ('skip','update') then raise exception 'Choose up to 10,000 rows and Skip or Update existing'; end if;
  insert into private.contact_import_jobs(org_id,owner_id,entity,file_name,headers,file_meta,expected_rows,duplicate_policy) values(o,u,kind,p->>'file_name',p->'headers',p->'file_meta',(p->>'rows')::integer,p->>'policy') returning * into job;
  return to_jsonb(job);
 end if;
 if operation='list' then
  return coalesce((select jsonb_agg(x) from(select id,file_name,state,created_at,expires_at from private.contact_import_jobs where org_id=o and owner_id=u and entity=kind and expires_at>statement_timestamp() order by created_at desc limit 10)x),'[]');
 end if;
 -- Global lock order is workspace billing lock, then import job, then contact.
 if operation in ('review','batch') then perform pg_advisory_xact_lock(hashtextextended('billing:'||o::text,0)); end if;
 select * into job from private.contact_import_jobs where id=j and org_id=o and owner_id=u and entity=kind and expires_at>statement_timestamp() for update;
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
     value=private.import_value(o,kind,r.payload);
     ids=private.import_matches(o,kind,r.email,r.phone);
     select coalesce(array_agg(distinct target_id),'{}') into prior_ids from private.contact_import_rows where job_id=j and row_no<r.row_no and action in ('insert','update') and ((r.email<>'' and email=r.email) or (r.phone<>'' and phone=r.phone));
     select coalesce(array_agg(distinct x),'{}') into ids from unnest(ids||prior_ids) x;
     outcome='insert';candidate=r.new_id;message='';
     if cardinality(ids)>0 then
      if job.duplicate_policy='skip' then outcome='skip';candidate=null;message='Duplicate email/phone in the workspace or file';
      else
       if cardinality(ids)<>1 then raise exception 'Multiple % match; choose Skip or correct the file',kind; end if;
       outcome='update';candidate=ids[1];
       perform private.import_check_target(o,kind,candidate,u,'review');
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
     value=private.import_value(o,kind,r.payload);
     ids=private.import_matches(o,kind,r.email,r.phone);
     if r.action='insert' then
      if cardinality(ids)<>0 then raise exception 'Duplicates changed since preview; start a new preview'; end if;
      perform private.import_write(o,kind,r.target_id,u,value,true);
      outcome='imported';message='';
     else
      if cardinality(ids)<>1 or ids[1]<>r.target_id then raise exception 'Duplicate target changed since preview; start a new preview'; end if;
      perform private.import_check_target(o,kind,r.target_id,u,'batch');
      perform private.import_write(o,kind,r.target_id,u,value,false);
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

revoke all on function private.record_import(uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.record_import(uuid,text,text,uuid,jsonb) to authenticated;
-- Contacts keep their existing entry point, now routed through the engine.
create or replace function private.contact_import(o uuid, operation text, j uuid, p jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.record_import(o,'contacts',operation,j,p)$$;
create function public.lead_import(o uuid,operation text,j uuid default null,p jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select private.record_import(o,'leads',operation,j,p)$$;
revoke all on function public.lead_import(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.lead_import(uuid,text,uuid,jsonb) to authenticated;
