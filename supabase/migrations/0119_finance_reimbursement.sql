-- 0119_finance_reimbursement.sql
-- 费用报销：全员可提交报销申请，管理员审批并确认报销完成，财务可见状态。
-- 设计原则：
--   1. 金额仅 CNY、不与记账金额联动：只做日常报销流程 + 财务日记账对账时核对明细。
--   2. 状态机：pending(待审批) → approved(已通过) → completed(已完成)；pending → rejected(已驳回)
--      → pending(本人修改后重新提交)。内容只允许 pending/rejected 且本人修改。
--   3. 可见范围：本人 + 财务/管理员（is_finance_or_admin）。
--   4. 凭证图存私有桶 finance-reimbursement-receipts，路径 {uid}/{uuid}.{ext}，按首级目录归属判断可见性。

begin;

-- -----------------------------------------------------------------------------
-- 1. 报销单
-- -----------------------------------------------------------------------------
create table if not exists public.finance_reimbursement_requests (
  id             uuid primary key default gen_random_uuid(),
  applicant_id   uuid not null references public.profiles(id) on delete restrict,
  expense_date   date not null,
  project_name   text,
  status         text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'completed')),
  reject_reason  text,
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewed_at    timestamptz,
  completed_by   uuid references public.profiles(id) on delete set null,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint finance_reimbursement_requests_project_name_check
    check (project_name is null or char_length(btrim(project_name)) between 1 and 200),
  constraint finance_reimbursement_requests_status_pair check (
    (status in ('pending', 'approved', 'completed') and reject_reason is null)
    or status = 'rejected'
  ),
  constraint finance_reimbursement_requests_review_pair check (
    (reviewed_at is null and reviewed_by is null)
    or (reviewed_at is not null and reviewed_by is not null)
    or status = 'pending'
  ),
  constraint finance_reimbursement_requests_complete_pair check (
    (completed_at is null and completed_by is null)
    or (completed_at is not null and completed_by is not null)
    or status <> 'completed'
  )
);

comment on table public.finance_reimbursement_requests is '费用报销单，金额仅CNY，不与记账联动；状态机见 finance_reimbursement_guard';
comment on column public.finance_reimbursement_requests.expense_date is '报销日期（模板口径，通常为月末）';
comment on column public.finance_reimbursement_requests.project_name is '项目名称，可选，如 国际站/1688/办公室';

-- -----------------------------------------------------------------------------
-- 2. 报销明细行：摘要 + 单价 × 数量 = 金额（模板版式），凭证图一张/行
-- -----------------------------------------------------------------------------
create table if not exists public.finance_reimbursement_items (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.finance_reimbursement_requests(id) on delete cascade,
  summary      text not null,
  unit_price   numeric(18,4) not null check (unit_price > 0 and unit_price <= 999999999999),
  quantity     numeric(18,4) not null check (quantity > 0 and quantity <= 999999999999),
  amount       numeric(18,4) generated always as (round(unit_price * quantity, 4)) stored,
  receipt_path text,
  sort_order   int not null default 0,
  constraint finance_reimbursement_items_summary_check
    check (char_length(btrim(summary)) between 1 and 500),
  constraint finance_reimbursement_items_receipt_path_check
    check (receipt_path is null or receipt_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$')
);

comment on table public.finance_reimbursement_items is '报销单明细行，金额=单价×数量（generated）；receipt_path 为私有桶内 object name';
comment on column public.finance_reimbursement_items.receipt_path is '凭证图：finance-reimbursement-receipts 桶内 {uid}/{uuid}.{ext}';

create index if not exists idx_finance_reimbursement_requests_applicant
  on public.finance_reimbursement_requests (applicant_id, created_at desc);
create index if not exists idx_finance_reimbursement_requests_status
  on public.finance_reimbursement_requests (status, created_at desc);
create index if not exists idx_finance_reimbursement_items_request
  on public.finance_reimbursement_items (request_id, sort_order);

-- -----------------------------------------------------------------------------
-- 3. updated_at
-- -----------------------------------------------------------------------------
drop trigger if exists trg_finance_reimbursement_requests_touch on public.finance_reimbursement_requests;
create trigger trg_finance_reimbursement_requests_touch
  before update on public.finance_reimbursement_requests
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4. 守卫函数
--    a) 报销单状态机 + 内容编辑限制（见文件头注释）。
--    b) 明细行：父单须为 pending/rejected 且本人，审批后明细锁定。
-- -----------------------------------------------------------------------------
create or replace function public.finance_reimbursement_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.applicant_id is distinct from auth.uid() then
      raise exception 'Reimbursement applicant must be the current user';
    end if;
    if new.status <> 'pending'
       or new.reviewed_by is not null or new.reviewed_at is not null
       or new.completed_by is not null or new.completed_at is not null
       or new.reject_reason is not null then
      raise exception 'New reimbursement must start as pending';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status is distinct from new.status then
    -- 合法流转：pending→approved/rejected；rejected→pending（本人重提）；approved→completed
    if not (
      (old.status = 'pending' and new.status in ('approved', 'rejected'))
      or (old.status = 'rejected' and new.status = 'pending')
      or (old.status = 'approved' and new.status = 'completed')
    ) then
      raise exception 'Invalid reimbursement status transition';
    end if;

    if not public.is_finance_or_admin() then
      -- 非财务/管理员仅允许本人把被驳回的单改回待审批
      if not (
        old.status = 'rejected' and new.status = 'pending'
        and new.applicant_id is not distinct from old.applicant_id
        and auth.uid() is not distinct from old.applicant_id
      ) then
        raise exception 'Only finance or admin can change reimbursement status';
      end if;
    end if;

    if old.status = 'pending' and new.status in ('approved', 'rejected') then
      if new.status = 'rejected'
         and (new.reject_reason is null or char_length(btrim(new.reject_reason)) = 0) then
        raise exception 'Reject reason is required';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
    if old.status = 'rejected' and new.status = 'pending' then
      new.reject_reason := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;
    if old.status = 'approved' and new.status = 'completed' then
      new.completed_by := auth.uid();
      new.completed_at := now();
    end if;
  else
    -- 非状态变更 = 改内容：仅 pending/rejected 且本人
    if old.status not in ('pending', 'rejected') then
      raise exception 'Approved or completed reimbursement cannot be modified';
    end if;
    if auth.uid() is distinct from old.applicant_id then
      raise exception 'Only the applicant can edit a reimbursement';
    end if;
    if new.applicant_id is distinct from old.applicant_id then
      raise exception 'Reimbursement applicant cannot be changed';
    end if;
    -- 状态不变时不得由申请人单方面改审批痕迹字段
    if new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at
       or new.completed_by is distinct from old.completed_by
       or new.completed_at is distinct from old.completed_at
       or new.reject_reason is distinct from old.reject_reason then
      raise exception 'Review fields cannot be modified directly';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.finance_reimbursement_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_reimbursement_guard() to authenticated;

drop trigger if exists trg_finance_reimbursement_requests_guard on public.finance_reimbursement_requests;
create trigger trg_finance_reimbursement_requests_guard
  before insert or update on public.finance_reimbursement_requests
  for each row execute function public.finance_reimbursement_guard();

create or replace function public.finance_reimbursement_item_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_status text;
  parent_applicant uuid;
begin
  select status, applicant_id into parent_status, parent_applicant
  from public.finance_reimbursement_requests
  where id = coalesce(new.request_id, old.request_id);

  -- 级联删除时父单已不存在；父单删除策略已限定本人 + pending/rejected，直接放行
  if not found then
    return coalesce(new, old);
  end if;
  if parent_status not in ('pending', 'rejected') then
    raise exception 'Reimbursement items are locked after approval';
  end if;
  if auth.uid() is distinct from parent_applicant then
    raise exception 'Only the applicant can edit reimbursement items';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.finance_reimbursement_item_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_reimbursement_item_guard() to authenticated;

drop trigger if exists trg_finance_reimbursement_items_guard on public.finance_reimbursement_items;
create trigger trg_finance_reimbursement_items_guard
  before insert or update or delete on public.finance_reimbursement_items
  for each row execute function public.finance_reimbursement_item_guard();

-- -----------------------------------------------------------------------------
-- 5. RLS：本人 + 财务/管理员可见；写操作限定本人（审批流转由守卫函数把关）
-- -----------------------------------------------------------------------------
alter table public.finance_reimbursement_requests enable row level security;
alter table public.finance_reimbursement_items enable row level security;

grant select, insert, update, delete on public.finance_reimbursement_requests to authenticated;
grant select, insert, update, delete on public.finance_reimbursement_items to authenticated;

drop policy if exists "finance_reimbursement_requests_select" on public.finance_reimbursement_requests;
create policy "finance_reimbursement_requests_select" on public.finance_reimbursement_requests
  for select to authenticated
  using (applicant_id = auth.uid() or public.is_finance_or_admin());

drop policy if exists "finance_reimbursement_requests_insert" on public.finance_reimbursement_requests;
create policy "finance_reimbursement_requests_insert" on public.finance_reimbursement_requests
  for insert to authenticated
  with check (applicant_id = auth.uid());

drop policy if exists "finance_reimbursement_requests_update" on public.finance_reimbursement_requests;
create policy "finance_reimbursement_requests_update" on public.finance_reimbursement_requests
  for update to authenticated
  using (applicant_id = auth.uid() or public.is_finance_or_admin())
  with check (applicant_id = auth.uid() or public.is_finance_or_admin());

-- 删除仅限本人的待审批/已驳回单（明细级联删除走 item_guard，同样限定 pending/rejected + 本人）
drop policy if exists "finance_reimbursement_requests_delete" on public.finance_reimbursement_requests;
create policy "finance_reimbursement_requests_delete" on public.finance_reimbursement_requests
  for delete to authenticated
  using (applicant_id = auth.uid() and status in ('pending', 'rejected'));

drop policy if exists "finance_reimbursement_items_select" on public.finance_reimbursement_items;
create policy "finance_reimbursement_items_select" on public.finance_reimbursement_items
  for select to authenticated
  using (
    exists (
      select 1 from public.finance_reimbursement_requests r
      where r.id = request_id
        and (r.applicant_id = auth.uid() or public.is_finance_or_admin())
    )
  );

drop policy if exists "finance_reimbursement_items_insert" on public.finance_reimbursement_items;
create policy "finance_reimbursement_items_insert" on public.finance_reimbursement_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.finance_reimbursement_requests r
      where r.id = request_id
        and r.applicant_id = auth.uid()
        and r.status in ('pending', 'rejected')
    )
  );

drop policy if exists "finance_reimbursement_items_update" on public.finance_reimbursement_items;
create policy "finance_reimbursement_items_update" on public.finance_reimbursement_items
  for update to authenticated
  using (
    exists (
      select 1 from public.finance_reimbursement_requests r
      where r.id = request_id
        and r.applicant_id = auth.uid()
        and r.status in ('pending', 'rejected')
    )
  )
  with check (
    exists (
      select 1 from public.finance_reimbursement_requests r
      where r.id = request_id
        and r.applicant_id = auth.uid()
        and r.status in ('pending', 'rejected')
    )
  );

drop policy if exists "finance_reimbursement_items_delete" on public.finance_reimbursement_items;
create policy "finance_reimbursement_items_delete" on public.finance_reimbursement_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.finance_reimbursement_requests r
      where r.id = request_id
        and r.applicant_id = auth.uid()
        and r.status in ('pending', 'rejected')
    )
  );

-- -----------------------------------------------------------------------------
-- 6. 凭证图私有桶：路径 {uid}/{uuid}.{ext}，首级目录即归属人
-- -----------------------------------------------------------------------------
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'finance-reimbursement-receipts',
  'finance-reimbursement-receipts',
  false,
  20971520,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "finance_reimbursement_receipts_insert" on storage.objects;
create policy "finance_reimbursement_receipts_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'finance-reimbursement-receipts'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  );

drop policy if exists "finance_reimbursement_receipts_select" on storage.objects;
create policy "finance_reimbursement_receipts_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'finance-reimbursement-receipts'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_finance_or_admin()
    )
  );

-- 本人可删自己的凭证对象：编辑换图/删除单据时做对象级清理
drop policy if exists "finance_reimbursement_receipts_delete" on storage.objects;
create policy "finance_reimbursement_receipts_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'finance-reimbursement-receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
