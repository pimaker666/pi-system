-- 0049: 性能索引补丁
-- 为高频查询但缺少索引的列补建索引，避免全表扫描。

-- 收款分摊：按 order_id 查分摊明细、按 transfer_id 查转账关联
create index if not exists idx_bopa_order_id
  on public.business_order_payment_allocations (order_id);

create index if not exists idx_bopa_transfer_id
  on public.business_order_payment_allocations (transfer_id);

-- 每日订单台账：按日期、店铺、状态、业务员筛选
create index if not exists idx_fdo_order_date
  on public.finance_daily_orders (order_date);

create index if not exists idx_fdo_shop_id
  on public.finance_daily_orders (shop_id);

create index if not exists idx_fdo_status
  on public.finance_daily_orders (status);

create index if not exists idx_fdo_salesperson_id
  on public.finance_daily_orders (salesperson_id);

-- 客户：按创建人、分组筛选
create index if not exists idx_customers_created_by
  on public.customers (created_by);

create index if not exists idx_customers_group_id
  on public.customers (group_id);

-- PI 表单：按状态筛选（列表只显示未作废）
create index if not exists idx_pi_status
  on public.proforma_invoices (status);
