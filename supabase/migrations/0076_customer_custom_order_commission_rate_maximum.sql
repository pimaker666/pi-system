-- 0076 定制订单数提点改为上限阶梯
-- 客户累计定制订单数不超过规则单数时适用，取满足条件的最低上限。

begin;

alter table public.finance_customer_custom_order_commission_rates
  rename column minimum_custom_order_count to maximum_custom_order_count;

alter table public.finance_customer_custom_order_commission_rates
  rename constraint finance_customer_custom_order_commission_rates_minimum_check
  to finance_customer_custom_order_commission_rates_maximum_check;

comment on table public.finance_customer_custom_order_commission_rates is
  '按客户累计定制订单数上限设置的产品提点；取不低于当前订单数的最低上限。优先级低于客户标记，高于发货分类默认。';

comment on column public.finance_customer_custom_order_commission_rates.maximum_custom_order_count is
  '适用该产品提点的客户累计定制订单数上限。';

commit;
