-- 0118_finance_journal.sql
-- 财务日记账：按银行账户登记收入/支出，按分类统计钱花在哪里，实时查看账户余额。
-- 设计原则：
--   1. 金额三件套沿用 0016 模板：多币种原值 + 登记汇率 + CNY 折算（numeric(18,4)）。
--   2. 余额不落逐行累计，由 security_invoker 视图实时计算（期初 + 收入 − 支出，排除作废）。
--   3. 仅财务/管理员可见可维护；作废保留痕迹，不做物理删除入口。
--   4. v1 独立登记，不关联订单/转账，单号通过备注记录。
--   5. 支持银行流水导入：招行 CSV 上传、中行对账单粘贴文本，关键词规则自动建议分类，
--      同账户+日期+金额+摘要撞车仅软警告（不建唯一约束，同名同日同额多笔属正常）。

begin;

-- -----------------------------------------------------------------------------
-- 1. 银行账户
-- -----------------------------------------------------------------------------
create table if not exists public.finance_journal_accounts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  currency        public.currency_code not null default 'CNY',
  initial_balance numeric(18,4) not null default 0
    check (initial_balance >= -999999999999 and initial_balance <= 999999999999),
  is_active       boolean not null default true,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint finance_journal_accounts_name_check check (char_length(btrim(name)) between 1 and 100),
  constraint finance_journal_accounts_name_unique unique (name)
);

comment on table public.finance_journal_accounts is '财务日记账银行账户，期初余额为开账时的实际余额';
comment on column public.finance_journal_accounts.initial_balance is '开账期初余额，原币口径；之后余额 = 期初 + 收入 − 支出（实时计算）';
comment on column public.finance_journal_accounts.is_active is 'false 表示停用，不再出现在下拉选项中';

-- -----------------------------------------------------------------------------
-- 2. 收支分类（预置种子，可增删改排序）
-- -----------------------------------------------------------------------------
create table if not exists public.finance_journal_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        public.finance_transaction_type not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint finance_journal_categories_name_check check (char_length(btrim(name)) between 1 and 100),
  constraint finance_journal_categories_name_unique unique (name)
);

comment on table public.finance_journal_categories is '日记账收支分类，kind=income 收入 / expense 支出';

-- 种子分类对齐财务手工账体系：性质单一维度，店铺由分录 shop 字段表达。
insert into public.finance_journal_categories (name, kind, sort_order) values
  ('货款',       'income', 1),
  ('国际站提现', 'income', 2),
  ('工厂转入',   'income', 3),
  ('投资款',     'income', 4),
  ('往来款',     'income', 5),
  ('银行利息',   'income', 6),
  ('其他收入',   'income', 7),
  ('工资',       'expense', 1),
  ('社保',       'expense', 2),
  ('房租、物业', 'expense', 3),
  ('水电',       'expense', 4),
  ('办公费',     'expense', 5),
  ('平台充值',   'expense', 6),
  ('运费',       'expense', 7),
  ('报销',       'expense', 8),
  ('样品',       'expense', 9),
  ('软件平台费', 'expense', 10),
  ('银行手续费', 'expense', 11),
  ('税费',       'expense', 12),
  ('往来款支出', 'expense', 13),
  ('其他支出',   'expense', 14)
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- 2b. 导入关键词规则：导入银行流水时按摘要关键词自动建议分类或店铺（财务可增删改）。
--     命中多条时取 keyword 最长的一条；大小写不敏感（lower 匹配）。
-- -----------------------------------------------------------------------------
create table if not exists public.finance_journal_import_rules (
  id          uuid primary key default gen_random_uuid(),
  keyword     text not null,
  category_id uuid references public.finance_journal_categories(id) on delete cascade,
  shop        text,
  created_at  timestamptz not null default now(),
  constraint finance_journal_import_rules_keyword_check
    check (char_length(btrim(keyword)) between 1 and 100),
  constraint finance_journal_import_rules_keyword_unique unique (keyword),
  constraint finance_journal_import_rules_target_check
    check (category_id is not null or shop is not null)
);

comment on table public.finance_journal_import_rules is '流水导入关键词→分类/店铺匹配规则，导入时按最长关键词命中建议分类或店铺';
comment on column public.finance_journal_import_rules.shop is '店铺建议值，仅命中此规则且无分类时带出，如 国际站/1688';

insert into public.finance_journal_import_rules (keyword, category_id, shop)
select r.keyword, c.id, r.shop
from (values
  ('工资',   '工资',     null),
  ('社保',   '社保',     null),
  ('租金',   '房租、物业', null),
  ('房租',   '房租、物业', null),
  ('水电',   '水电',     null),
  ('手续费', '银行手续费', null),
  ('结息',   '银行利息', null),
  ('报销',   '报销',     null),
  ('物流费', '运费',     null),
  ('运费',   '运费',     null),
  ('直通车', '平台充值', null),
  ('缴税',   '税费',     null),
  ('国际站', null,       '国际站'),
  ('1688',   null,       '1688')
) as r(keyword, category_name, shop)
left join public.finance_journal_categories c on c.name = r.category_name
on conflict (keyword) do nothing;

-- -----------------------------------------------------------------------------
-- 3. 日记账分录
-- -----------------------------------------------------------------------------
create table if not exists public.finance_journal_entries (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.finance_journal_accounts(id) on delete restrict,
  category_id          uuid not null references public.finance_journal_categories(id) on delete restrict,
  entry_date           date not null,
  kind                 public.finance_transaction_type not null,
  amount_original      numeric(18,4) not null check (amount_original > 0),
  currency             public.currency_code not null,
  exchange_rate_to_cny numeric(18,8) not null check (exchange_rate_to_cny > 0),
  amount_cny           numeric(18,4) generated always as (
    round(amount_original * exchange_rate_to_cny, 4)
  ) stored,
  summary              text not null,
  counterparty         text,
  reference_no         text,
  reimbursee           text,
  shop                 text,
  remark               text,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  voided_at            timestamptz,
  voided_by            uuid references public.profiles(id) on delete set null,
  void_reason          text,
  constraint finance_journal_entries_cny_rate check (currency <> 'CNY' or exchange_rate_to_cny = 1),
  constraint finance_journal_entries_void_pair check (
    (voided_at is null and voided_by is null)
    or (voided_at is not null and voided_by is not null)
  ),
  constraint finance_journal_entries_summary_check check (char_length(btrim(summary)) between 1 and 500)
);

comment on table public.finance_journal_entries is '财务日记账分录，作废保留 voided_* 痕迹不物理删除';
comment on column public.finance_journal_entries.summary is '摘要，必填，如「支付 10 月供应商货款」';
comment on column public.finance_journal_entries.counterparty is '收/付款人，可选';
comment on column public.finance_journal_entries.reference_no is '银行流水号/凭证号，可选，导入时自动带入';
comment on column public.finance_journal_entries.reimbursee is '报销人，可选，用于按人统计报销';
comment on column public.finance_journal_entries.shop is '店铺/项目，可选，如 国际站/1688/社媒/办公室，用于按店铺归集费用';
comment on column public.finance_journal_entries.remark is '备注，可写订单号/PI 号等参考信息';

-- -----------------------------------------------------------------------------
-- 4. 索引：覆盖账户/分类/日期筛选与 RLS 过滤列
-- -----------------------------------------------------------------------------
create index if not exists idx_finance_journal_entries_account_date
  on public.finance_journal_entries (account_id, entry_date desc);
create index if not exists idx_finance_journal_entries_kind_date
  on public.finance_journal_entries (kind, entry_date desc);
create index if not exists idx_finance_journal_entries_category
  on public.finance_journal_entries (category_id);
create index if not exists idx_finance_journal_entries_created_by
  on public.finance_journal_entries (created_by);
create index if not exists idx_finance_journal_accounts_is_active
  on public.finance_journal_accounts (is_active);
create index if not exists idx_finance_journal_categories_kind_sort
  on public.finance_journal_categories (kind, sort_order);

-- -----------------------------------------------------------------------------
-- 5. updated_at
-- -----------------------------------------------------------------------------
drop trigger if exists trg_finance_journal_accounts_touch on public.finance_journal_accounts;
create trigger trg_finance_journal_accounts_touch
  before update on public.finance_journal_accounts
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_journal_categories_touch on public.finance_journal_categories;
create trigger trg_finance_journal_categories_touch
  before update on public.finance_journal_categories
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_journal_entries_touch on public.finance_journal_entries;
create trigger trg_finance_journal_entries_touch
  before update on public.finance_journal_entries
  for each row execute function public.touch_updated_at();

-- 分类必须与收支类型一致，防止把支出记到收入分类下污染统计。
create or replace function public.finance_journal_entry_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.finance_journal_categories
    where id = new.category_id and kind = new.kind
  ) then
    raise exception 'Category kind does not match entry kind';
  end if;
  if tg_op = 'UPDATE' and old.voided_at is not null then
    raise exception 'Voided journal entry cannot be modified';
  end if;
  return new;
end;
$$;

revoke all on function public.finance_journal_entry_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_journal_entry_guard() to authenticated;

drop trigger if exists trg_finance_journal_entries_guard on public.finance_journal_entries;
create trigger trg_finance_journal_entries_guard
  before insert or update on public.finance_journal_entries
  for each row execute function public.finance_journal_entry_guard();

-- -----------------------------------------------------------------------------
-- 6. RLS：仅财务/管理员可见可维护
-- -----------------------------------------------------------------------------
alter table public.finance_journal_accounts enable row level security;
alter table public.finance_journal_categories enable row level security;
alter table public.finance_journal_entries enable row level security;
alter table public.finance_journal_import_rules enable row level security;

grant select, insert, update, delete on public.finance_journal_accounts to authenticated;
grant select, insert, update, delete on public.finance_journal_categories to authenticated;
grant select, insert, update, delete on public.finance_journal_entries to authenticated;
grant select, insert, update, delete on public.finance_journal_import_rules to authenticated;

drop policy if exists "finance_journal_accounts_select" on public.finance_journal_accounts;
create policy "finance_journal_accounts_select" on public.finance_journal_accounts
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_accounts_insert" on public.finance_journal_accounts;
create policy "finance_journal_accounts_insert" on public.finance_journal_accounts
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and created_by = (select auth.uid())
  );

drop policy if exists "finance_journal_accounts_update" on public.finance_journal_accounts;
create policy "finance_journal_accounts_update" on public.finance_journal_accounts
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_accounts_delete" on public.finance_journal_accounts;
create policy "finance_journal_accounts_delete" on public.finance_journal_accounts
  for delete to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_categories_select" on public.finance_journal_categories;
create policy "finance_journal_categories_select" on public.finance_journal_categories
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_categories_insert" on public.finance_journal_categories;
create policy "finance_journal_categories_insert" on public.finance_journal_categories
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_categories_update" on public.finance_journal_categories;
create policy "finance_journal_categories_update" on public.finance_journal_categories
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_categories_delete" on public.finance_journal_categories;
create policy "finance_journal_categories_delete" on public.finance_journal_categories
  for delete to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_import_rules_select" on public.finance_journal_import_rules;
create policy "finance_journal_import_rules_select" on public.finance_journal_import_rules
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_import_rules_insert" on public.finance_journal_import_rules;
create policy "finance_journal_import_rules_insert" on public.finance_journal_import_rules
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_import_rules_update" on public.finance_journal_import_rules;
create policy "finance_journal_import_rules_update" on public.finance_journal_import_rules
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_import_rules_delete" on public.finance_journal_import_rules;
create policy "finance_journal_import_rules_delete" on public.finance_journal_import_rules
  for delete to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_entries_select" on public.finance_journal_entries;
create policy "finance_journal_entries_select" on public.finance_journal_entries
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_journal_entries_insert" on public.finance_journal_entries;
create policy "finance_journal_entries_insert" on public.finance_journal_entries
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and created_by = (select auth.uid())
  );

drop policy if exists "finance_journal_entries_update" on public.finance_journal_entries;
create policy "finance_journal_entries_update" on public.finance_journal_entries
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_journal_entries_delete" on public.finance_journal_entries;
create policy "finance_journal_entries_delete" on public.finance_journal_entries
  for delete to authenticated
  using (public.is_finance_or_admin());

-- -----------------------------------------------------------------------------
-- 7. 账户余额视图：security_invoker 保留底层表 RLS，仅财务/管理员可读。
--    余额 = 期初 + 收入 − 支出（原币口径，排除作废）；另附 CNY 折算流水合计。
-- -----------------------------------------------------------------------------
create or replace view public.finance_journal_account_balances
with (security_invoker = true) as
select
  a.id as account_id,
  a.name,
  a.currency,
  a.initial_balance,
  coalesce(sum(e.amount_original) filter (where e.kind = 'income'), 0)  as total_income,
  coalesce(sum(e.amount_original) filter (where e.kind = 'expense'), 0) as total_expense,
  a.initial_balance
    + coalesce(sum(e.amount_original) filter (where e.kind = 'income'), 0)
    - coalesce(sum(e.amount_original) filter (where e.kind = 'expense'), 0) as balance,
  coalesce(sum(e.amount_cny) filter (where e.kind = 'income'), 0)  as total_income_cny,
  coalesce(sum(e.amount_cny) filter (where e.kind = 'expense'), 0) as total_expense_cny
from public.finance_journal_accounts a
left join public.finance_journal_entries e
  on e.account_id = a.id
 and e.voided_at is null
group by a.id, a.name, a.currency, a.initial_balance;

comment on view public.finance_journal_account_balances is '日记账账户实时余额（期初+收入-支出，排除作废），security_invoker 保留 RLS';

revoke all on public.finance_journal_account_balances from public, anon, authenticated;
grant select on public.finance_journal_account_balances to authenticated;

commit;
