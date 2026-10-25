-- Run once as the project database owner after deploying crm-billing.
-- The worker reconciles Razorpay before it can permanently delete expired excess data.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.secrets where name='align_billing_job_token') then
  perform vault.create_secret(gen_random_uuid()::text||gen_random_uuid()::text,'align_billing_job_token','Private Align subscription maintenance credential');
 end if;
end $$;
select cron.schedule('align-subscription-maintenance','*/5 * * * *',$job$
 select net.http_post(
  url:='https://pojrnwxvudxgmdrgqfhg.supabase.co/functions/v1/crm-billing',
  headers:=jsonb_build_object('Content-Type','application/json','x-align-billing-job',(select decrypted_secret from vault.decrypted_secrets where name='align_billing_job_token' limit 1)),
  body:='{"action":"maintenance"}'::jsonb,
  timeout_milliseconds:=20000
 );
$job$);
select jobname,schedule,active from cron.job where jobname='align-subscription-maintenance';
