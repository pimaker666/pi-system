-- 0143_hourly_leave.sql
-- 小时假：公司每天上班 7.5 小时（上午 3.5 小时、下午 4 小时）。
-- 1) 请假单增加 hours：0.5 小时步进，仅限单日、上午最多 3.0 / 下午最多 3.5（半天及以上仍走按天请假）。
-- 2) 考勤格仍是 √ 出勤，另附该半天的请假小时数与类型，用于汇总「小时假」列与工资扣减。
-- 3) 工资表出勤天数改为两位小数，按 1h = 1/7.5 天扣减（保留半天 0.5 天的既有口径）。
-- 4) 审批 RPC 增加小时假写入分支：只写空白格或纯 √ 格，冲突时拒绝而非覆盖。

begin;

-- -----------------------------------------------------------------------------
-- 1. 请假单：小时数字段与约束
-- -----------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists hours numeric(4,1);

alter table public.leave_requests
  drop constraint if exists leave_requests_hours_check;
alter table public.leave_requests
  add constraint leave_requests_hours_check check (
    hours is null
    or (
      start_date = end_date
      and day_part in ('morning', 'afternoon')
      and hours in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5)
      and hours <= case day_part when 'morning' then 3.0 else 3.5 end
    )
  );

comment on column public.leave_requests.hours is
  '小时假时长（小时）；null = 按天/半天请假。0.5 步进，上午最多 3.0、下午最多 3.5';

-- -----------------------------------------------------------------------------
-- 2. 考勤格：半天小时假时长与类型
-- -----------------------------------------------------------------------------
alter table public.attendance_entries
  add column if not exists morning_leave_hours numeric(4,1) not null default 0,
  add column if not exists afternoon_leave_hours numeric(4,1) not null default 0,
  add column if not exists morning_leave_type text,
  add column if not exists afternoon_leave_type text;

alter table public.attendance_entries
  drop constraint if exists attendance_entries_morning_hourly_check,
  drop constraint if exists attendance_entries_afternoon_hourly_check;

alter table public.attendance_entries
  add constraint attendance_entries_morning_hourly_check check (
    morning_leave_hours >= 0
    and morning_leave_hours <= 3.0
    and morning_leave_hours * 2 = floor(morning_leave_hours * 2)
    and (
      (morning_leave_hours > 0
        and morning = '√'
        and morning_leave_type in ('personal', 'sick', 'vacation'))
      or (morning_leave_hours = 0 and morning_leave_type is null)
    )
  ),
  add constraint attendance_entries_afternoon_hourly_check check (
    afternoon_leave_hours >= 0
    and afternoon_leave_hours <= 3.5
    and afternoon_leave_hours * 2 = floor(afternoon_leave_hours * 2)
    and (
      (afternoon_leave_hours > 0
        and afternoon = '√'
        and afternoon_leave_type in ('personal', 'sick', 'vacation'))
      or (afternoon_leave_hours = 0 and afternoon_leave_type is null)
    )
  );

comment on column public.attendance_entries.morning_leave_hours is
  '上午小时假时长（小时）；>0 时 morning 必须为 √，下午同理';

-- -----------------------------------------------------------------------------
-- 3. 工资表：出勤天数支持两位小数
-- -----------------------------------------------------------------------------
alter table public.payroll_items
  alter column attendance_days type numeric(6,2);

-- -----------------------------------------------------------------------------
-- 4. 审批 RPC：增加小时假写入
-- -----------------------------------------------------------------------------
create or replace function public.review_leave_request(
  p_request_id uuid,
  p_approve boolean,
  p_reject_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_symbol text;
  v_day date;
  v_month_key date;
  v_current_month date := null;
  v_sheet_id uuid;
  v_member_id uuid;
  v_applicant_name text;
  v_next_sort int;
  v_day_number int;
  v_existing_morning text;
  v_existing_afternoon text;
  v_existing_morning_hours numeric;
  v_existing_afternoon_hours numeric;
  v_existing_morning_type text;
  v_existing_afternoon_type text;
  v_morning text;
  v_afternoon text;
  v_morning_hours numeric;
  v_afternoon_hours numeric;
  v_morning_type text;
  v_afternoon_type text;
  v_touches_morning boolean;
  v_touches_afternoon boolean;
  v_hourly boolean;
  v_cell_written boolean;
  v_offset int;
  v_written int := 0;
  v_skipped int := 0;
  v_created int := 0;
begin
  if v_actor is null or not public.is_finance_or_admin() then
    raise exception '仅财务或管理员可审批请假';
  end if;

  select * into v_request
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '请假单不存在';
  end if;
  if v_request.status <> 'pending' then
    raise exception '该请假单已审批，不能重复操作';
  end if;
  if not p_approve
     and (p_reject_reason is null or char_length(btrim(p_reject_reason)) = 0) then
    raise exception '驳回必须填写原因';
  end if;

  update public.leave_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reject_reason = case when p_approve then null else btrim(p_reject_reason) end
  where id = p_request_id;

  if not p_approve then
    return jsonb_build_object(
      'written_days', 0,
      'skipped_cells', 0,
      'created_sheets', 0
    );
  end if;

  v_hourly := v_request.hours is not null;
  v_symbol := case v_request.leave_type
    when 'personal' then '○'
    when 'sick' then '☆'
    when 'vacation' then '●'
  end;
  if v_hourly then
    -- 小时假只作用于当天申请的那个半天，考勤格保持 √（出勤）并附小时数
    v_touches_morning := v_request.day_part = 'morning';
    v_touches_afternoon := v_request.day_part = 'afternoon';
  else
    v_touches_morning := v_request.day_part <> 'afternoon';
    v_touches_afternoon := v_request.day_part <> 'morning';
  end if;

  -- 逐日处理：换月时按需建表、建花名册成员
  for v_offset in 0 .. (v_request.end_date - v_request.start_date) loop
    v_day := v_request.start_date + v_offset;
    v_month_key := date_trunc('month', v_day::timestamp)::date;

    if v_current_month is null or v_month_key <> v_current_month then
      v_current_month := v_month_key;

      select id into v_sheet_id
      from public.attendance_sheets
      where month = v_month_key;
      if not found then
        insert into public.attendance_sheets (month, note, created_by)
        values (v_month_key, '请假审批自动创建', v_actor)
        returning id into v_sheet_id;
        v_created := v_created + 1;
      end if;

      select id into v_member_id
      from public.attendance_members
      where sheet_id = v_sheet_id
        and profile_id = v_request.applicant_id;
      if not found then
        select coalesce(
                 nullif(btrim(p.chinese_name), ''),
                 nullif(btrim(p.full_name), ''),
                 '成员'
               )
        into v_applicant_name
        from public.profiles p
        where p.id = v_request.applicant_id;

        select count(*) + 1 into v_next_sort
        from public.attendance_members
        where sheet_id = v_sheet_id;

        insert into public.attendance_members (sheet_id, profile_id, name, sort_order)
        values (
          v_sheet_id,
          v_request.applicant_id,
          coalesce(v_applicant_name, '成员'),
          v_next_sort
        )
        returning id into v_member_id;
      end if;
    end if;

    v_day_number := extract(day from v_day)::int;
    v_existing_morning := '';
    v_existing_afternoon := '';
    v_existing_morning_hours := 0;
    v_existing_afternoon_hours := 0;
    v_existing_morning_type := null;
    v_existing_afternoon_type := null;

    select morning, afternoon, morning_leave_hours, afternoon_leave_hours,
           morning_leave_type, afternoon_leave_type
    into v_existing_morning, v_existing_afternoon, v_existing_morning_hours,
         v_existing_afternoon_hours, v_existing_morning_type, v_existing_afternoon_type
    from public.attendance_entries
    where sheet_id = v_sheet_id
      and member_id = v_member_id
      and day = v_day_number;

    v_morning := coalesce(v_existing_morning, '');
    v_afternoon := coalesce(v_existing_afternoon, '');
    v_morning_hours := coalesce(v_existing_morning_hours, 0);
    v_afternoon_hours := coalesce(v_existing_afternoon_hours, 0);
    v_morning_type := v_existing_morning_type;
    v_afternoon_type := v_existing_afternoon_type;
    v_cell_written := false;

    if v_hourly then
      if v_touches_morning then
        if coalesce(v_existing_morning, '') = ''
           or (v_existing_morning = '√' and coalesce(v_existing_morning_hours, 0) = 0) then
          v_morning := '√';
          v_morning_hours := v_request.hours;
          v_morning_type := v_request.leave_type;
          v_cell_written := true;
        elsif v_existing_morning = '√' then
          raise exception '该日期上午已有小时假记录，请先在考勤表清除后再审批';
        else
          v_skipped := v_skipped + 1;
        end if;
      end if;
      if v_touches_afternoon then
        if coalesce(v_existing_afternoon, '') = ''
           or (v_existing_afternoon = '√' and coalesce(v_existing_afternoon_hours, 0) = 0) then
          v_afternoon := '√';
          v_afternoon_hours := v_request.hours;
          v_afternoon_type := v_request.leave_type;
          v_cell_written := true;
        elsif v_existing_afternoon = '√' then
          raise exception '该日期下午已有小时假记录，请先在考勤表清除后再审批';
        else
          v_skipped := v_skipped + 1;
        end if;
      end if;
    else
      if v_touches_morning and coalesce(v_existing_morning, '') = '' then
        v_morning := v_symbol;
        v_morning_hours := 0;
        v_morning_type := null;
        v_cell_written := true;
      elsif v_touches_morning then
        v_skipped := v_skipped + 1;
      end if;
      if v_touches_afternoon and coalesce(v_existing_afternoon, '') = '' then
        v_afternoon := v_symbol;
        v_afternoon_hours := 0;
        v_afternoon_type := null;
        v_cell_written := true;
      elsif v_touches_afternoon then
        v_skipped := v_skipped + 1;
      end if;
    end if;

    if not v_cell_written then
      continue;
    end if;

    insert into public.attendance_entries (
      sheet_id, member_id, day, morning, afternoon,
      morning_leave_hours, afternoon_leave_hours,
      morning_leave_type, afternoon_leave_type
    )
    values (
      v_sheet_id, v_member_id, v_day_number, v_morning, v_afternoon,
      v_morning_hours, v_afternoon_hours,
      v_morning_type, v_afternoon_type
    )
    on conflict (sheet_id, member_id, day)
    do update set
      morning = excluded.morning,
      afternoon = excluded.afternoon,
      morning_leave_hours = excluded.morning_leave_hours,
      afternoon_leave_hours = excluded.afternoon_leave_hours,
      morning_leave_type = excluded.morning_leave_type,
      afternoon_leave_type = excluded.afternoon_leave_type;

    v_written := v_written + 1;
  end loop;

  return jsonb_build_object(
    'written_days', v_written,
    'skipped_cells', v_skipped,
    'created_sheets', v_created
  );
end;
$$;

revoke all on function public.review_leave_request(uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_leave_request(uuid, boolean, text)
  to authenticated;

commit;
