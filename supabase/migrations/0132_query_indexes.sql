-- 0132 读取路径索引补齐
-- 只补当前查询排序/过滤真正用到、且现有索引覆盖不到的列；数据量还小，普通建索引即可。
-- 不能用 create index concurrently：迁移 runner 按单事务执行。

begin;

-- 日记账读取按 entry_date, created_at, id 全表分页排序（fetchJournalData）。
create index if not exists idx_finance_journal_entries_date_created
  on public.finance_journal_entries (entry_date, created_at, id);

-- 提成结清明细按 submitted_at 倒序取最新；加角标也走同一张表。
create index if not exists idx_boc_clearances_submitted_at
  on public.finance_business_order_item_commission_clearances (submitted_at desc);

-- 已结算归档按 period, settled_at 倒序分页，选中年月后按 period 等值过滤。
create index if not exists idx_finance_settlements_period_settled
  on public.finance_business_order_item_settlements (period desc, settled_at desc);

commit;

notify pgrst, 'reload schema';
