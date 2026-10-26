-- 0113 近期活跃订单与客户列表索引
--
-- 背景：财务每日订单台账与业务提成页都以
--   where voided_at is null order by order_date desc, created_at desc, id desc
-- 读取最近订单，现有索引只有单列 order_date desc 或无 created_at 的复合索引，
-- 订单量增长后排序需要额外 sort。客户列表以 created_at desc 排序并过滤 deleted_at is null。
-- 方案：各补一条部分索引，条件与页面过滤完全一致；索引列顺序与页面排序一致，
-- 使排序可直接走索引。使用 concurrently + if not exists，避免锁表且可重复执行
-- （psql 逐条自动提交，不在事务块中执行）。

create index concurrently if not exists idx_business_orders_active_recent
  on public.business_orders (order_date desc, created_at desc, id desc)
  where voided_at is null;

create index concurrently if not exists idx_customers_active_recent
  on public.customers (created_at desc)
  where deleted_at is null;
