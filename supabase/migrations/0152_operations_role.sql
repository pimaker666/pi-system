-- 0152: 新增运营角色（运营按店铺或订单归属拿提成）
-- 枚举值单独一次迁移添加，后续迁移才可在策略/查询里安全使用该字面量。

begin;

alter type public.user_role add value if not exists 'operations';

commit;
