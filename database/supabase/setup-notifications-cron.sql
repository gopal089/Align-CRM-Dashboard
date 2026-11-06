-- Run once per project as the database owner, after deploying align-notifications.
-- The follow-up rules themselves are scheduled by migration 20261106140000; this
-- script only schedules the sender that delivers the queued emails.
-- First store the deployed function URL in Vault as align_notifications_function_url:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/align-notifications','align_notifications_function_url','Align notification sender URL');
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.secrets where name='align_notifications_function_url') then
  raise exception 'Create the align_notifications_function_url Vault secret before scheduling the sender';
 end if;
 -- A random credential that only the database and the sender know.
 if not exists(select 1 from vault.secrets where name='align_notifications_job_token') then
  perform vault.create_secret(gen_random_uuid()::text||gen_random_uuid()::text,'align_notifications_job_token','Private Align notification sender credential');
 end if;
 if exists(select 1 from cron.job where jobname='align-notification-sender') then
  perform cron.unschedule('align-notification-sender');
 end if;
end $$;
select cron.schedule('align-notification-sender','*/10 * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='align_notifications_function_url' limit 1),
  headers:=jsonb_build_object('Content-Type','application/json','x-align-notifications-job',(select decrypted_secret from vault.decrypted_secrets where name='align_notifications_job_token' limit 1)),
  body:='{"action":"send"}'::jsonb,
  timeout_milliseconds:=60000
 );
$job$);
select jobname,schedule,active from cron.job where jobname in ('align-follow-ups','align-notification-sender');
