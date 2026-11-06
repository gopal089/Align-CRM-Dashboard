-- "Convert to contact" for any open lead, in one transaction.
-- The older convert_lead (contact + company + deal, Qualified leads only) stays
-- for compatibility; the app now uses convert_lead_to_contact.

-- 1. Contacts can record where they came from; conversion copies the lead's source.
alter table public.contacts add column source text not null default '' check(length(source)<=200);

-- 2. A converted lead must link to its contact; the deal is now optional.
do $$ declare body text; changed text; begin
 select prosrc into body from pg_proc where oid='private.validate_record()'::regprocedure;
 changed:=replace(body,' or new.converted_deal_id is null) then raise exception ''Use lead conversion',') then raise exception ''Use lead conversion');
 if changed=body then raise exception 'validate_record no longer has the expected conversion rule'; end if;
 execute 'create or replace function private.validate_record() returns trigger language plpgsql security invoker set search_path='''' as '||quote_literal(changed);
end $$;

-- 3. The conversion. Runs with elevated rights because any member who can see
--    a lead may convert it (a decision for this workspace), so every check
--    row-level security would make is made here explicitly.
create function private.convert_lead_to_contact(lead uuid, with_deal boolean default false, deal_amount numeric default 0) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); l public.leads; co uuid; ct uuid; d uuid; first_stage text; owner uuid;
begin
 if u is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 select * into l from public.leads where id=lead for update;
 -- Same visibility as reading leads: members of the lead's workspace only.
 if l.id is null or private.member_role(l.org_id) is null or not private.billing_readable(l.org_id,'leads',l.id) then raise exception 'Lead not found'; end if;
 if private.billing_preserved(l.org_id,'leads',l.id) then raise exception 'Just upgrade your plan to edit or export.'; end if;
 if l.status='Converted' or l.converted_contact_id is not null then raise exception 'This lead has already been converted'; end if;
 if l.archived_at is not null or l.status not in ('New','Contacted','Qualified') then raise exception 'Only open leads (New, Contacted or Qualified) can be converted'; end if;
 if coalesce(deal_amount,0)<0 then raise exception 'Amount must be non-negative'; end if;
 -- The new records keep the lead's owner, unless that person has left.
 owner:=case when exists(select 1 from public.memberships m where m.org_id=l.org_id and m.user_id=l.owner_id and m.active) then l.owner_id else u end;
 if l.email is not null then
  -- Same lock key as other conversions, so two at once cannot both pass the check.
  perform pg_advisory_xact_lock(hashtext(l.org_id::text||l.email));
  if exists(select 1 from public.contacts c where c.org_id=l.org_id and c.email=l.email) then
   raise exception 'A contact with the email % already exists. Open that contact instead of converting this lead.',l.email;
  end if;
 end if;
 if nullif(trim(l.company_name),'') is not null then
  perform pg_advisory_xact_lock(hashtext(l.org_id::text||lower(trim(l.company_name))));
  select id into co from public.companies where org_id=l.org_id and lower(trim(name))=lower(trim(l.company_name)) and archived_at is null order by created_at limit 1;
  if co is null then insert into public.companies(org_id,owner_id,name) values(l.org_id,owner,trim(l.company_name)) returning id into co; end if;
 end if;
 insert into public.contacts(org_id,owner_id,name,email,phone,company_id,source)
 values(l.org_id,owner,l.name,l.email,coalesce(l.phone,''),co,coalesce(l.source,'')) returning id into ct;
 if with_deal then
  select v->>'name' into first_stage from public.organizations o,jsonb_array_elements(o.pipeline_stages) v where o.id=l.org_id and v->>'outcome'='open' limit 1;
  insert into public.deals(org_id,owner_id,name,amount,company_id,contact_id,lead_id,stage)
  values(l.org_id,owner,left(coalesce(nullif(trim(l.company_name),'')||' — ','')||l.name,200),coalesce(deal_amount,0),co,ct,l.id,first_stage) returning id into d;
 end if;
 -- Marking the lead converted also copies matching custom field values to the
 -- contact (trigger from migration 20261106150000).
 update public.leads set status='Converted',converted_at=now(),converted_contact_id=ct,converted_deal_id=d where id=l.id;
 return jsonb_build_object('contact_id',ct,'deal_id',d,'company_id',co);
end $$;
revoke all on function private.convert_lead_to_contact(uuid,boolean,numeric) from public,anon;
grant execute on function private.convert_lead_to_contact(uuid,boolean,numeric) to authenticated;
create function public.convert_lead_to_contact(lead uuid, with_deal boolean default false, deal_amount numeric default 0) returns jsonb language sql security invoker set search_path='' as $$select private.convert_lead_to_contact(lead,with_deal,deal_amount)$$;
revoke all on function public.convert_lead_to_contact(uuid,boolean,numeric) from public,anon;
grant execute on function public.convert_lead_to_contact(uuid,boolean,numeric) to authenticated;
