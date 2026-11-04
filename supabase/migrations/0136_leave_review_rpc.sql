-- 0136_leave_review_rpc.sql
-- 请假审批与考勤联动原子化：把「改请假单状态 + 建考勤表/花名册 + 写考勤格」
-- 收进一个数据库事务，避免审批已生效但考勤只写了一半。
-- 语义与原先应用层实现一致：仅财务/管理员；仅 pending 可审批；驳回必填原因；
-- 只写空白格，不覆盖财务已标记内容；缺表自动创建。

begin;

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
  v_morning text;
  v_afternoon text;
  v_touches_morning boolean;
  v_touches_afternoon boolean;
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

  v_symbol := case v_request.leave_type
    when 'personal' then '○'
    when 'sick' then '☆'
    when 'vacation' then '●'
  end;
  v_touches_morning := v_request.day_part <> 'afternoon';
  v_touches_afternoon := v_request.day_part <> 'morning';

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

    select morning, afternoon
    into v_existing_morning, v_existing_afternoon
    from public.attendance_entries
    where sheet_id = v_sheet_id
      and member_id = v_member_id
      and day = v_day_number;

    v_morning := case
      when v_touches_morning and coalesce(v_existing_morning, '') = '' then v_symbol
      else coalesce(v_existing_morning, '')
    end;
    v_afternoon := case
      when v_touches_afternoon and coalesce(v_existing_afternoon, '') = '' then v_symbol
      else coalesce(v_existing_afternoon, '')
    end;

    if v_morning = '' and v_afternoon = '' then
      v_skipped := v_skipped + case
        when v_touches_morning and v_touches_afternoon then 2
        else 1
      end;
      continue;
    end if;
    if v_touches_morning and coalesce(v_existing_morning, '') <> '' then
      v_skipped := v_skipped + 1;
    end if;
    if v_touches_afternoon and coalesce(v_existing_afternoon, '') <> '' then
      v_skipped := v_skipped + 1;
    end if;

    insert into public.attendance_entries (sheet_id, member_id, day, morning, afternoon)
    values (v_sheet_id, v_member_id, v_day_number, v_morning, v_afternoon)
    on conflict (sheet_id, member_id, day)
    do update set morning = excluded.morning, afternoon = excluded.afternoon;

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
