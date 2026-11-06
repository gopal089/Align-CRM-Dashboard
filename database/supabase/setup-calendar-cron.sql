-- Run once per project as the database owner, after deploying calendar-google.
-- Schedules the Google Calendar sync every 10 minutes with a private credential.
-- First store the function URL in Vault as align_calendar_function_url:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/calendar-google','align_calendar_function_url','Align calendar sync URL');
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.secrets where name='align_calendar_function_url') then
  raise exception 'Create the align_calendar_function_url Vault secret before scheduling calendar sync';
 end if;
 if not exists(select 1 from vault.secrets where name='align_calendar_job_token') then
  perform vault.create_secret(gen_random_uuid()::text||gen_random_uuid()::text,'align_calendar_job_token','Private Align calendar sync credential');
 end if;
 if exists(select 1 from cron.job where jobname='align-calendar-sync') then
  perform cron.unschedule('align-calendar-sync');
 end if;
end $$;
select cron.schedule('align-calendar-sync','*/10 * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='align_calendar_function_url' limit 1),
  headers:=jsonb_build_object('Content-Type','application/json','x-align-calendar-job',(select decrypted_secret from vault.decrypted_secrets where name='align_calendar_job_token' limit 1)),
  body:='{"action":"sync"}'::jsonb,
  timeout_milliseconds:=120000
 );
$job$);
select jobname,schedule,active from cron.job where jobname='align-calendar-sync';
