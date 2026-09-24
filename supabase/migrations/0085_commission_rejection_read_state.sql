-- 0085 提成结清驳回已读状态

begin;

alter table public.finance_business_order_item_commission_clearances
  add column if not exists rejected_read_at timestamptz;

commit;
