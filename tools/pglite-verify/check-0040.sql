\pset pager off
select
  (select is_nullable
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_orders'
      and column_name = 'exchange_rate_to_cny')            as rate_nullable,
  (select count(*) from pg_proc
    where proname = 'business_order_accepts_entry_edits')  as gate_fn,
  (select count(*) from public.business_orders)            as orders,
  (select count(*) from public.business_orders
    where exchange_rate_to_cny is null)                    as null_rate,
  (select count(*) from public.business_orders
    where total_cny is null)                               as null_total_cny;

select payment_status, count(*)
from public.business_orders
group by payment_status
order by payment_status;

with expected as (
  select bo.id,
         bo.payment_status as stored,
         case
           when bo.total_amount <= 0 then 'fully_paid'
           when coalesce(bo.total_sales_amount, 0) + coalesce(pay.amount, 0) <= 0 then 'unpaid'
           when coalesce(bo.total_sales_amount, 0) + coalesce(pay.amount, 0) < bo.total_amount
             then 'partially_paid'
           else 'fully_paid'
         end as computed
  from public.business_orders bo
  left join lateral (
    select sum(a.amount) as amount
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = bo.id and a.voided_at is null and t.voided_at is null
  ) pay on true
)
select count(*) as payment_status_mismatch
from expected
where stored is distinct from computed;

select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where proname in (
  'business_order_accepts_entry_edits',
  'business_refresh_order_payment_status',
  'get_business_order_settlement_summary',
  'get_business_order_edit_constraints',
  'create_business_order_v4',
  'update_business_order_v4'
)
order by proname, args;
