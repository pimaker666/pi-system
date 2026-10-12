-- 0101: 允许「先收款、后补绑客户」的订单补绑客户。
-- 背景：0028 的 protect_business_order_allocation_invariants 在存在有效分摊后
-- 一律禁止更改 customer_id，导致未绑客户状态下登记了订单作用域转账
-- （transfer.customer_id 为空）的订单永远无法补绑客户。
-- 放宽规则：仅当旧客户为空且新客户非空（补绑）时，检查该订单所有有效分摊的
-- 转账客户：为空（订单作用域转账）或等于新客户即放行；存在其他客户的转账则
-- 抛新错误，防止「A 客户的钱摊到 B 客户订单上」。
-- 其余客户变更（换绑、解绑）与币种、总额保护维持原拦截条件，
-- 0099 客户回收站的 app.customer_purge 解绑旁路原样保留。

create or replace function public.protect_business_order_allocation_invariants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_paid numeric;
  v_mismatched bigint;
begin
  if coalesce(current_setting('app.customer_purge', true), '') = 'true'
     and old.customer_id is not null
     and new.customer_id is null
     and new.currency is not distinct from old.currency
     and new.total_amount is not distinct from old.total_amount then
    return new;
  end if;

  select coalesce(sum(a.amount), 0) into v_paid
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = old.id
    and a.voided_at is null
    and t.voided_at is null;

  if new.customer_id is distinct from old.customer_id then
    if old.customer_id is null and new.customer_id is not null then
      select count(*) into v_mismatched
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = old.id
        and a.voided_at is null
        and t.voided_at is null
        and t.customer_id is not null
        and t.customer_id is distinct from new.customer_id;
      if v_mismatched > 0 then
        raise exception 'Cannot bind customer different from allocation transfer customer';
      end if;
    elsif v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2) then
      raise exception 'Cannot change customer after payment allocation or completion';
    end if;
  end if;

  if (v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2))
     and new.currency is distinct from old.currency then
    raise exception 'Cannot change currency after payment allocation or completion';
  end if;
  if v_paid > new.total_amount then
    raise exception 'Order total cannot be less than active payment allocations';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_allocation_invariants()
  from public, anon, authenticated, service_role;
