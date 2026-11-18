-- 运营提成规则放开「按发货分类」条件。
-- 运营提成按订单聚合，因此该条件表示「订单内存在该发货分类的产品行」；
-- 累计定制订单数仍只对业务线开放（业务线逐产品行判断，运营线为订单级）。
alter table public.finance_commission_rules
  drop constraint if exists finance_commission_rules_line_scope_valid;

alter table public.finance_commission_rules
  add constraint finance_commission_rules_line_scope_valid
  check (line = 'business' or custom_order_count_max is null);

alter table public.finance_commission_rules
  drop constraint if exists finance_commission_rules_shipping_category_valid;

alter table public.finance_commission_rules
  add constraint finance_commission_rules_shipping_category_valid
  check (
    shipping_category is null
    or shipping_category in ('stock', 'purchase', 'custom', 'sample', 'custom_sample')
  );

comment on column public.finance_commission_rules.shipping_category is
  '发货分类条件：业务线按产品行匹配；运营线按订单（订单含该类产品行即命中）匹配。';
