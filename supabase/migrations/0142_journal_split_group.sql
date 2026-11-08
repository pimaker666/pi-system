-- 日记账拆分批次：同一笔业务拆成多条分类明细时，用 split_group_id 归组
alter table public.finance_journal_entries
  add column if not exists split_group_id uuid;

create index if not exists finance_journal_entries_split_group_idx
  on public.finance_journal_entries (split_group_id)
  where split_group_id is not null;
