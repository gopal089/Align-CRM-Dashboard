-- Permanently delete a custom field: removes the field, the value it holds on
-- every lead or contact in the workspace, and any saved-view columns, sorting
-- or filters that use it. Administrators only. Archive remains the
-- reversible option; delete cannot be undone.
create function private.delete_custom_field(field uuid, dry_run boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); f public.custom_field_definitions; ref text; cleared integer:=0; views integer:=0;
 v public.saved_views; cfg jsonb; params jsonb; filters jsonb;
begin
 if u is null or not private.security_session_ok() then raise exception 'Verify your account or sign in again'; end if;
 select * into f from public.custom_field_definitions where id=field;
 if f.id is null or private.member_role(f.org_id) is null then raise exception 'Custom field not found'; end if;
 if private.member_role(f.org_id)<>'Administrator' then raise exception 'Only administrators can delete custom fields'; end if;
 ref:='cf:'||f.id::text;
 if dry_run then
  if f.entity='leads' then select count(*) into cleared from public.leads where org_id=f.org_id and custom_values ? f.id::text;
  else select count(*) into cleared from public.contacts where org_id=f.org_id and custom_values ? f.id::text; end if;
  select count(*) into views from public.saved_views where org_id=f.org_id and entity=f.entity and position(f.id::text in configuration::text)>0;
  return jsonb_build_object('name',f.name,'records',cleared,'views',views);
 end if;
 -- Same lock order as record writes and imports: billing, then custom fields.
 perform pg_advisory_xact_lock(hashtextextended('billing:'||f.org_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('custom-fields:'||f.org_id::text,0));
 if exists(select 1 from private.contact_import_jobs where org_id=f.org_id and entity=f.entity and expires_at>statement_timestamp() and state not in ('complete','cancelled')) then
  raise exception 'An import is in progress for %. Finish or cancel it, then delete the field.', initcap(f.entity);
 end if;
 -- Remove the definition first so the value checks no longer protect it.
 delete from public.custom_field_definitions where id=f.id;
 if f.entity='leads' then
  update public.leads set custom_values=custom_values-f.id::text where org_id=f.org_id and custom_values ? f.id::text;
 else
  update public.contacts set custom_values=custom_values-f.id::text where org_id=f.org_id and custom_values ? f.id::text;
 end if;
 get diagnostics cleared = row_count;
 for v in select * from public.saved_views where org_id=f.org_id and entity=f.entity and position(f.id::text in configuration::text)>0 for update loop
  cfg:=v.configuration; params:=coalesce(cfg->'params','{}');
  cfg:=jsonb_set(cfg,'{columns}',coalesce((select jsonb_agg(c) from jsonb_array_elements(cfg->'columns') c where c#>>'{}'<>ref),'["name"]'));
  if params->>'sort'=ref then params:=params-'sort'-'direction'; end if;
  if params ? 'cf' then
   begin
    filters:=(select jsonb_agg(x) from jsonb_array_elements((params->>'cf')::jsonb) x where x->>'field' is distinct from f.id::text);
    params:=case when filters is null then params-'cf' else jsonb_set(params,'{cf}',to_jsonb(filters::text)) end;
   exception when others then params:=params-'cf';
   end;
  end if;
  cfg:=jsonb_set(cfg,'{params}',params);
  -- A view that cannot be saved for an unrelated reason keeps its old setup;
  -- the app ignores columns of fields that no longer exist.
  begin
   update public.saved_views set configuration=cfg where id=v.id;
   views:=views+1;
  exception when others then null;
  end;
 end loop;
 return jsonb_build_object('name',f.name,'records',cleared,'views',views);
end $$;
revoke all on function private.delete_custom_field(uuid,boolean) from public,anon,authenticated;
grant execute on function private.delete_custom_field(uuid,boolean) to authenticated;

create function public.delete_custom_field(field uuid, dry_run boolean default false) returns jsonb language sql security invoker set search_path='' as $$
 select private.delete_custom_field(field, dry_run);
$$;
revoke all on function public.delete_custom_field(uuid,boolean) from public,anon,authenticated;
grant execute on function public.delete_custom_field(uuid,boolean) to authenticated;
