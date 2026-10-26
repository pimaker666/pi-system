-- 0116 每日订单个人标记
--
-- 背景：台账需要快速找回关注的若干订单。标记是「个人视图」——每个账号只看、
-- 只改自己的标记，不影响订单数据与他人视图；被标记订单在台账整行浅蓝高亮，
-- 并可通过「只看我标记的订单」筛选。
--
-- 权限：
--   * 只能读写 user_id = auth.uid() 的行；
--   * 新增标记还要求当前账号已审批且 can_view_business_order(order_id)，
--     避免给无权查看的订单留下标记。
-- 订单删除时标记通过外键级联清理；订单作废/关闭不影响标记本身。

begin;

create table if not exists public.business_order_marks (
  order_id uuid not null references public.business_orders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (order_id, user_id)
);

create index if not exists idx_business_order_marks_user
  on public.business_order_marks (user_id, created_at desc);

alter table public.business_order_marks enable row level security;

revoke all on table public.business_order_marks from public, anon;
grant select, insert, delete on table public.business_order_marks to authenticated;

drop policy if exists "business_order_marks_select" on public.business_order_marks;
create policy "business_order_marks_select" on public.business_order_marks
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_approved_user());

drop policy if exists "business_order_marks_insert" on public.business_order_marks;
create policy "business_order_marks_insert" on public.business_order_marks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_approved_user()
    and public.can_view_business_order(order_id)
  );

drop policy if exists "business_order_marks_delete" on public.business_order_marks;
create policy "business_order_marks_delete" on public.business_order_marks
  for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_approved_user());

commit;
