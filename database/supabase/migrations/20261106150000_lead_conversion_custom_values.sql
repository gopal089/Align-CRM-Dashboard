-- When a lead is converted, its custom field values carry over to the contact
-- wherever the contact has an active field with the same name and type.
-- Lead and contact fields are separate definitions (different IDs), so the
-- match is by name and type; dropdown values must exist in the contact field.
create function private.copy_lead_custom_values() returns trigger language plpgsql security definer set search_path='' as $$
declare carried jsonb;
begin
 if new.converted_contact_id is null or old.converted_contact_id is not null or new.custom_values='{}'::jsonb then return new; end if;
 select coalesce(jsonb_object_agg(cd.id::text,v.value),'{}'::jsonb) into carried
 from jsonb_each(new.custom_values) v
 join public.custom_field_definitions ld on ld.org_id=new.org_id and ld.entity='leads' and ld.id::text=v.key
 join public.custom_field_definitions cd on cd.org_id=new.org_id and cd.entity='contacts' and cd.archived_at is null
  and lower(trim(cd.name))=lower(trim(ld.name)) and cd.field_type=ld.field_type
 where jsonb_typeof(v.value)<>'null'
  and (cd.field_type<>'dropdown' or (v.value#>>'{}')=any(cd.options));
 if carried='{}'::jsonb then return new; end if;
 begin
  -- Values already on the contact win; only empty fields are filled.
  update public.contacts c set custom_values=carried||c.custom_values
  where c.org_id=new.org_id and c.id=new.converted_contact_id;
 exception when others then
  -- Copying is a convenience and must never block a conversion.
  raise warning 'Custom values not copied to contact %: %',new.converted_contact_id,sqlerrm;
 end;
 return new;
end $$;
revoke all on function private.copy_lead_custom_values() from public,anon,authenticated;
create trigger copy_lead_custom_values after update of converted_contact_id on public.leads
 for each row execute function private.copy_lead_custom_values();
