-- 0123_leave_requests.sql
-- 员工请假：员工本人提交，财务/管理员审批；批准后由应用层自动把对应考勤格写入考勤表
-- （事假○ / 病假☆ / 年假调休●，仅写空白格，不覆盖财务已标记内容）。
-- 状态机：pending → approved/rejected（仅财务/管理员）；本人可撤回 pending。
-- 考勤表不存在时由应用层按月份自动创建。

begin;

create table if not exists public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  applicant_id  uuid not null references public.profiles(id) on delete restrict,
  leave_type    text not null check (leave_type in ('personal', 'sick', 'vacation')),
  start_date    date not null,
  end_date      date not null,
  day_part      text not null default 'full' check (day_part in ('full', 'morning', 'afternoon')),
  reason        text,
  status        text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reject_reason text,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint leave_requests_date_check check (end_date >= start_date),
  constraint leave_requests_reason_check
    check (reason is null or char_length(btrim(reason)) between 1 and 500),
  constraint leave_requests_reject_reason_check
    check (reject_reason is null or char_length(btrim(reject_reason)) between 1 and 500),
  constraint leave_requests_review_pair check (
    (status = 'approved' and reviewed_by is not null and reviewed_at is not null
      and reject_reason is null)
    or (status = 'rejected' and reviewed_by is not null and reviewed_at is not null
      and reject_reason is not null)
    or (status = 'pending' and reviewed_by is null and reviewed_at is null
      and reject_reason is null)
  )
);

comment on table public.leave_requests is '员工请假单：pending 待审批 / approved 已批准（考勤已联动） / rejected 已驳回';
comment on column public.leave_requests.leave_type is '请假类型：personal 事假(○) / sick 病假(☆) / vacation 年假调休(●)';
comment on column public.leave_requests.day_part is '时段：full 全天 / morning 仅上午 / afternoon 仅下午';

create index if not exists idx_leave_requests_applicant
  on public.leave_requests (applicant_id, created_at desc);
create index if not exists idx_leave_requests_status
  on public.leave_requests (status, created_at desc);

drop trigger if exists trg_leave_requests_touch on public.leave_requests;
create trigger trg_leave_requests_touch
  before update on public.leave_requests
  for each row execute function public.touch_updated_at();

-- 守卫：提交=本人 pending；审批 pending→approved/rejected 仅财务/管理员（驳回必填原因）；
-- 改内容仅限本人 pending；删除（撤回）仅限本人 pending。
create or replace function public.leave_request_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.applicant_id is distinct from auth.uid() then
      raise exception 'Leave applicant must be the current user';
    end if;
    if new.status <> 'pending'
       or new.reviewed_by is not null or new.reviewed_at is not null
       or new.reject_reason is not null then
      raise exception 'New leave request must start as pending';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'pending' or old.applicant_id is distinct from auth.uid() then
      raise exception 'Only the applicant can withdraw a pending leave request';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.status is distinct from new.status then
    if not (
      (old.status = 'pending' and new.status in ('approved', 'rejected'))
    ) then
      raise exception 'Invalid leave request status transition';
    end if;
    if not public.is_finance_or_admin() then
      raise exception 'Only finance or admin can review leave requests';
    end if;
    if new.status = 'rejected'
       and (new.reject_reason is null or char_length(btrim(new.reject_reason)) = 0) then
      raise exception 'Reject reason is required';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  else
    if old.status <> 'pending' then
      raise exception 'Reviewed leave request cannot be modified';
    end if;
    if auth.uid() is distinct from old.applicant_id then
      raise exception 'Only the applicant can edit a leave request';
    end if;
    if new.applicant_id is distinct from old.applicant_id then
      raise exception 'Leave applicant cannot be changed';
    end if;
    if new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at
       or new.reject_reason is distinct from old.reject_reason then
      raise exception 'Review fields cannot be modified directly';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.leave_request_guard() from public, anon, authenticated, service_role;
grant execute on function public.leave_request_guard() to authenticated;

drop trigger if exists trg_leave_requests_guard on public.leave_requests;
create trigger trg_leave_requests_guard
  before insert or update or delete on public.leave_requests
  for each row execute function public.leave_request_guard();

alter table public.leave_requests enable row level security;

grant select, insert, update, delete on public.leave_requests to authenticated;

drop policy if exists "leave_requests_select" on public.leave_requests;
create policy "leave_requests_select" on public.leave_requests
  for select to authenticated
  using (applicant_id = auth.uid() or public.is_finance_or_admin());

drop policy if exists "leave_requests_insert" on public.leave_requests;
create policy "leave_requests_insert" on public.leave_requests
  for insert to authenticated
  with check (applicant_id = auth.uid());

drop policy if exists "leave_requests_update" on public.leave_requests;
create policy "leave_requests_update" on public.leave_requests
  for update to authenticated
  using (applicant_id = auth.uid() or public.is_finance_or_admin())
  with check (applicant_id = auth.uid() or public.is_finance_or_admin());

drop policy if exists "leave_requests_delete" on public.leave_requests;
create policy "leave_requests_delete" on public.leave_requests
  for delete to authenticated
  using (applicant_id = auth.uid() and status = 'pending');

commit;
