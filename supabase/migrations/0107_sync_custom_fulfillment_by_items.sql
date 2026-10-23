-- 0107 订单履约类型与明细发货分类对齐
--
-- 业务背景：
--   1. 财务建单表单此前把新订单 fulfillment_type 写死为 'custom'，订单里全是
--      普通产品的客户也被计入「定制订单数」，进而影响按定制单数匹配的提点阶梯
--      （客户列表与提成共用 get_customer_order_stats 的 custom_order_count）。
--   2. 统一口径：明细中存在发货分类为「定制」(custom) 的行，订单才算定制单；
--      与每日订单导入的推导规则一致（business-daily-import）。
--   3. 存量：一次性把无定制明细行的在途订单改回 stock。作废单不修——
--      protect_business_order_closure 禁止编辑作废单，且统计口径（get_customer_order_stats）
--      本就排除作废单，作废单上的旧标记无业务影响。
--   4. 未来：明细触发器保证任何写入路径（建单/编辑/追加/删行）后履约类型与明细一致，
--      不再依赖各调用方自觉传参。
--
-- 幂等性：update 天然可重入；create or replace function + drop if exists + create trigger 可重复执行。

begin;

-- -----------------------------------------------------------------------------
-- 1. 存量修正：无定制发货分类明细的订单统一为现货单（排除作废单，见文件头说明）
-- -----------------------------------------------------------------------------
update public.business_orders o
set fulfillment_type = 'stock'::public.business_fulfillment_type
where o.fulfillment_type = 'custom'::public.business_fulfillment_type
  and o.voided_at is null
  and not exists (
    select 1 from public.business_order_items i
    where i.order_id = o.id
      and i.daily_shipping_category = 'custom'
  );

-- -----------------------------------------------------------------------------
-- 2. 触发器：明细增删改后同步订单履约类型
-- -----------------------------------------------------------------------------
create or replace function public.sync_business_order_fulfillment_type()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  update public.business_orders o
  set fulfillment_type = case
    when exists (
      select 1 from public.business_order_items i
      where i.order_id = v_order_id
        and i.daily_shipping_category = 'custom'
    ) then 'custom'::public.business_fulfillment_type
    else 'stock'::public.business_fulfillment_type
  end
  where o.id = v_order_id;
  return null;
end;
$$;

drop trigger if exists trg_business_order_items_sync_fulfillment
  on public.business_order_items;

create trigger trg_business_order_items_sync_fulfillment
after insert or update of daily_shipping_category or delete
on public.business_order_items
for each row execute function public.sync_business_order_fulfillment_type();

comment on function public.sync_business_order_fulfillment_type is
  '明细行写入后同步订单 fulfillment_type：存在 daily_shipping_category=custom 的行即定制单，否则现货单（0107 口径）';

commit;
