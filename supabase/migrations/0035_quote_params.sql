-- 报价系统参数覆盖表：后台可编辑的 JSON 覆盖值，报价引擎以「DB 覆盖优先、代码常量兜底」合并。
-- 每品类一行；overrides 结构与 src/lib/quote/data.ts 中对应品类对象一致，只需包含要改的键。

create table if not exists public.quote_params (
  category    text primary key check (category in ('mask', 'cotton', 'oil', 'cream', 'eyemask', 'globals')),
  overrides   jsonb not null default '{}'::jsonb,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

comment on table public.quote_params is '报价参数覆盖：JSON 结构与 lib/quote/data.ts 品类对象一致，深合并后覆盖代码默认值';
comment on column public.quote_params.category is '品类 id：mask/cotton/oil/cream/eyemask，globals 行存全局值（FX_DEFAULT / PLATE_COLOR_PRICE）';

alter table public.quote_params enable row level security;

drop policy if exists "quote_params_select_all" on public.quote_params;
create policy "quote_params_select_all" on public.quote_params
  for select using (auth.role() = 'authenticated');

drop policy if exists "quote_params_admin_write" on public.quote_params;
create policy "quote_params_admin_write" on public.quote_params
  for all using (public.is_admin()) with check (public.is_admin());
