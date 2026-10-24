-- User-approved Business subscription price: INR 4,999 per month (paise).
-- No existing paid subscriptions should be silently repriced during initial setup.
do $$ begin
 if exists(select 1 from public.billing_receipts where plan_code='business') then
  raise exception 'Review existing Business receipts before changing the billing catalog price';
 end if;
 update public.subscription_plans set monthly_price=499900 where code='business';
end $$;
