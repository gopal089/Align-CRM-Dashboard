-- Enforce failed-password limits inside Auth, including direct /auth/v1/token calls.
-- Configure Auth's password_verification_attempt hook to this private function.
-- Returned error JSON commits prior counters; raising would roll them back.
grant usage on schema private to supabase_auth_admin;
grant select,insert,update on private.security_attempts to supabase_auth_admin;
create policy native_password_counter on private.security_attempts
 for all to supabase_auth_admin
 using (bucket like 'native-login:%') with check (bucket like 'native-login:%');

create function private.security_password_attempt(event jsonb) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare
 user_id uuid := (event->>'user_id')::uuid;
 valid boolean := (event->>'valid')::boolean;
 key text;
 counter private.security_attempts;
begin
 if user_id is null or valid is null then
  return jsonb_build_object('error',jsonb_build_object('http_code',400,'message','Invalid verification event'));
 end if;
 key := 'native-login:' || user_id::text;
 perform pg_advisory_xact_lock(hashtext(user_id::text));
 insert into private.security_attempts(bucket,started_at,attempts)
  values(key,statement_timestamp(),0) on conflict do nothing;
 select * into counter from private.security_attempts where bucket=key for update;
 if counter.started_at <= statement_timestamp()-interval '15 minutes' then
  update private.security_attempts set started_at=statement_timestamp(),attempts=0 where bucket=key;
  counter.attempts := 0;
 end if;
 if counter.attempts >= 10 then
  return jsonb_build_object('error',jsonb_build_object('http_code',429,'message','Too many password attempts. Try again in 15 minutes.'));
 end if;
 if valid then
  update private.security_attempts set attempts=0,started_at=statement_timestamp() where bucket=key;
 else
  update private.security_attempts set attempts=attempts+1 where bucket=key;
 end if;
 return jsonb_build_object('decision','continue');
end
$$;
revoke all on function private.security_password_attempt(jsonb) from public,anon,authenticated,service_role;
grant execute on function private.security_password_attempt(jsonb) to supabase_auth_admin;
