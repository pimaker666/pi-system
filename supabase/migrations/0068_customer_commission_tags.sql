-- 0068 客户标记提点定义
-- 业务提成页新增「按客户标记设置提成」：管理员维护一套预定义标记，每个标记 =
-- 颜色（复用 customers.tag_color 十六进制）+ 含义（label）+ 产品提点（百分数）。
-- 客户在客户库里选定某个标记颜色后，其订单在提成计算时按该标记的产品提点。
-- 产品提点优先级：产品明细行手动覆盖 > 客户标记 > 发货分类默认 > 0。
-- 权限：所有已审批用户可读（用于展示颜色+含义图例）；仅管理员可增删改标记定义。

begin;

create table if not exists public.finance_customer_commission_tags (
  tag_color text primary key
    constraint finance_customer_commission_tag_color_check check (tag_color ~ '^#[0-9A-Fa-f]{6}$'),
  label text not null
    constraint finance_customer_commission_tag_label_check check (btrim(label) <> ''),
  product_commission_rate numeric(7, 4) not null default 0
    constraint finance_customer_commission_tag_rate_check
      check (product_commission_rate >= 0 and product_commission_rate <= 100),
  sort_order integer not null default 0,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.finance_customer_commission_tags is
  '客户标记提点定义（颜色+含义+产品提点百分数）。客户库按颜色选用；提成计算优先级：手动逐行 > 客户标记 > 发货分类默认。';

drop trigger if exists trg_finance_customer_commission_tags_touch
  on public.finance_customer_commission_tags;
create trigger trg_finance_customer_commission_tags_touch
  before update on public.finance_customer_commission_tags
  for each row execute function public.touch_updated_at();

alter table public.finance_customer_commission_tags enable row level security;

revoke all on table public.finance_customer_commission_tags
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_customer_commission_tags to authenticated, service_role;

drop policy if exists "customer_commission_tags_select"
  on public.finance_customer_commission_tags;
create policy "customer_commission_tags_select"
  on public.finance_customer_commission_tags
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "customer_commission_tags_insert"
  on public.finance_customer_commission_tags;
create policy "customer_commission_tags_insert"
  on public.finance_customer_commission_tags
  for insert to authenticated
  with check (public.is_admin() and updated_by = (select auth.uid()));

drop policy if exists "customer_commission_tags_update"
  on public.finance_customer_commission_tags;
create policy "customer_commission_tags_update"
  on public.finance_customer_commission_tags
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin() and updated_by = (select auth.uid()));

drop policy if exists "customer_commission_tags_delete"
  on public.finance_customer_commission_tags;
create policy "customer_commission_tags_delete"
  on public.finance_customer_commission_tags
  for delete to authenticated
  using (public.is_admin());

commit;
