-- 0135 数值上限与结清审计字段加固
-- 1) 提点/运费提点与发货分类默认提点在数据库侧限制 0–100：此前只有 Server Action 校验，
--    持登录态直接写 PostgREST 可写入 >100 的提点。
-- 2) 工资明细金额列禁止负数（底薪档案 0129 已有同类约束，工资行此前没有）。
-- 3) 业务员更新结清记录时只能把本人订单的 pending 改为 confirmed/rejected，
--    不能再顺带篡改结清月份、提交人或确认人（会直接影响某月提成归属）。

begin;

alter table public.finance_business_order_item_commissions
  drop constraint if exists finance_business_order_item_commission_valid;
alter table public.finance_business_order_item_commissions
  add constraint finance_business_order_item_commission_valid
  check (commission_rate >= 0 and commission_rate <= 100);

alter table public.finance_business_order_commissions
  drop constraint if exists finance_business_order_commission_valid;
alter table public.finance_business_order_commissions
  add constraint finance_business_order_commission_valid
  check (
    freight_cost >= 0
    and freight_commission_rate >= 0
    and freight_commission_rate <= 100
  );

alter table public.finance_commission_category_rates
  drop constraint if exists finance_commission_category_rate_valid;
alter table public.finance_commission_category_rates
  add constraint finance_commission_category_rate_valid
  check (product_commission_rate >= 0 and product_commission_rate <= 100);

alter table public.payroll_items
  drop constraint if exists payroll_items_amounts_nonnegative;
alter table public.payroll_items
  add constraint payroll_items_amounts_nonnegative
  check (
    base_salary >= 0
    and commission >= 0
    and bonus >= 0
    and attendance_deduction >= 0
    and other_deduction >= 0
    and social_insurance >= 0
    and housing_fund >= 0
    and tax >= 0
  );

create or replace function public.commission_clearance_actor_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;
  -- 无登录身份（service_role、迁移脚本）不在此处限制，仍由 RLS 与触发器锁负责。
  if auth.uid() is null then
    return new;
  end if;
  if public.is_finance_or_admin() then
    return new;
  end if;

  if old.status <> 'pending'
     or new.status not in ('confirmed', 'rejected') then
    raise exception 'Salesperson can only confirm or reject pending clearances';
  end if;

  if new.business_order_item_id is distinct from old.business_order_item_id
     or new.period is distinct from old.period
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'Only finance or admin can change clearance period or submitter';
  end if;

  if new.status = 'confirmed' and new.confirmed_by is distinct from auth.uid() then
    raise exception 'confirmed_by must be the acting salesperson';
  end if;
  if new.status = 'rejected' and new.confirmed_by is not null then
    raise exception 'Rejected clearance cannot set confirmed_by';
  end if;

  return new;
end;
$$;

revoke all on function public.commission_clearance_actor_guard()
  from public, anon, authenticated, service_role;
grant execute on function public.commission_clearance_actor_guard() to authenticated;

drop trigger if exists trg_finance_business_order_item_commission_clearances_actor
  on public.finance_business_order_item_commission_clearances;
create trigger trg_finance_business_order_item_commission_clearances_actor
  before update on public.finance_business_order_item_commission_clearances
  for each row execute function public.commission_clearance_actor_guard();

commit;
