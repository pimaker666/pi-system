const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003'

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create table public.profiles (
      id uuid primary key,
      role text not null,
      status text not null,
      chinese_name text,
      full_name text,
      created_at timestamptz not null default now()
    );
    insert into profiles (id, role, status, chinese_name, full_name) values
      ('${FINANCE}', 'finance', 'approved', '财务', 'Finance'),
      ('${SALES}', 'sales', 'approved', '张三', 'Zhang San'),
      ('${OTHER}', 'sales', 'approved', '李四', 'Li Si');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    grant usage on schema public to authenticated, anon;
    grant execute on function public.is_finance_or_admin() to authenticated, anon;

    create table public.leave_requests (
      id uuid primary key default gen_random_uuid(),
      applicant_id uuid not null references public.profiles(id),
      leave_type text not null check (leave_type in ('personal', 'sick', 'vacation')),
      start_date date not null,
      end_date date not null,
      day_part text not null default 'full' check (day_part in ('full', 'morning', 'afternoon')),
      reason text,
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
      reject_reason text,
      reviewed_by uuid references public.profiles(id),
      reviewed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint leave_requests_date_check check (end_date >= start_date),
      constraint leave_requests_review_pair check (
        (status = 'approved' and reviewed_by is not null and reviewed_at is not null and reject_reason is null)
        or (status = 'rejected' and reviewed_by is not null and reviewed_at is not null and reject_reason is not null)
        or (status = 'pending' and reviewed_by is null and reviewed_at is null and reject_reason is null)
      )
    );

    create or replace function public.leave_request_guard()
    returns trigger language plpgsql security definer set search_path = public as $$
    begin
      if tg_op = 'INSERT' then
        if new.applicant_id is distinct from auth.uid() then
          raise exception 'Leave applicant must be the current user';
        end if;
        return new;
      end if;
      if old.status is distinct from new.status then
        if not (old.status = 'pending' and new.status in ('approved', 'rejected')) then
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
      end if;
      return new;
    end;
    $$;
    create trigger trg_leave_requests_guard
      before insert or update on public.leave_requests
      for each row execute function public.leave_request_guard();

    create table public.attendance_sheets (
      id uuid primary key default gen_random_uuid(),
      month date not null unique,
      note text,
      created_by uuid references public.profiles(id),
      created_at timestamptz not null default now(),
      constraint attendance_sheets_month_check check (month = date_trunc('month', month)::date)
    );

    create table public.attendance_members (
      id uuid primary key default gen_random_uuid(),
      sheet_id uuid not null references public.attendance_sheets(id) on delete cascade,
      profile_id uuid references public.profiles(id) on delete cascade,
      name text not null check (char_length(btrim(name)) between 1 and 50),
      sort_order int not null default 0,
      constraint attendance_members_profile_unique unique (sheet_id, profile_id)
    );

    create table public.attendance_entries (
      id uuid primary key default gen_random_uuid(),
      sheet_id uuid not null references public.attendance_sheets(id) on delete cascade,
      member_id uuid not null references public.attendance_members(id) on delete cascade,
      day int not null check (day between 1 and 31),
      morning text not null default ''
        check (morning in ('', '√', '●', '○', '☆', '△', '×', '※', '◇', '◆', '▲')),
      afternoon text not null default ''
        check (afternoon in ('', '√', '●', '○', '☆', '△', '×', '※', '◇', '◆', '▲')),
      profile_id uuid,
      constraint attendance_entries_unique_member unique (sheet_id, member_id, day)
    );

    grant all on all tables in schema public to authenticated;
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0136_leave_review_rpc.sql'),
    'utf8',
  )
  await db.exec(migration)
  // 幂等：再跑一遍不报错
  await db.exec(migration)

  const as = async (uid, fn) => {
    if (uid) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    } else {
      await db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  const createRequest = async (uid, fields) =>
    (
      await db.query(
        `insert into public.leave_requests
           (applicant_id, leave_type, start_date, end_date, day_part, reason)
         values ('${uid}', '${fields.leave_type}', '${fields.start_date}', '${fields.end_date}',
                 '${fields.day_part}', '事由')
         returning id`,
      )
    ).rows[0].id

  const review = (uid, requestId, approve, reason) =>
    as(uid, () =>
      db.query(
        `select public.review_leave_request('${requestId}', ${approve}, ${
          reason == null ? 'null' : `'${reason}'`
        }) as result`,
      ),
    )

  // ---------- 1. 驳回：原因必填，且不写考勤 ----------
  const rejectId = await as(SALES, () =>
    createRequest(SALES, {
      leave_type: 'personal',
      start_date: '2027-01-05',
      end_date: '2027-01-06',
      day_part: 'full',
    }),
  )
  await assert.rejects(
    () => review(FINANCE, rejectId, false, '   '),
    /驳回必须填写原因/,
    '驳回必须填写原因',
  )
  const rejected = await review(FINANCE, rejectId, false, '人手不足')
  assert.equal(rejected.rows[0].result.written_days, 0)
  assert.equal(rejected.rows[0].result.created_sheets, 0)
  const rejectedRow = (
    await db.query(
      `select status, reject_reason, reviewed_by from public.leave_requests where id = '${rejectId}'`,
    )
  ).rows[0]
  assert.deepEqual(rejectedRow, {
    status: 'rejected',
    reject_reason: '人手不足',
    reviewed_by: FINANCE,
  })
  assert.equal(
    (await db.query(`select count(*)::int c from public.attendance_sheets where month = '2027-01-01'`)).rows[0].c,
    0,
    '驳回不应创建考勤表',
  )

  // ---------- 2. 批准跨月请假：自动建表、建花名册、逐日写符号 ----------
  const crossMonthId = await as(SALES, () =>
    createRequest(SALES, {
      leave_type: 'sick',
      start_date: '2027-02-27',
      end_date: '2027-03-02',
      day_part: 'full',
    }),
  )
  const crossMonth = await review(FINANCE, crossMonthId, true, null)
  assert.deepEqual(crossMonth.rows[0].result, {
    written_days: 4,
    skipped_cells: 0,
    created_sheets: 2,
  })
  const approvedRow = (
    await db.query(
      `select status, reject_reason, reviewed_by from public.leave_requests where id = '${crossMonthId}'`,
    )
  ).rows[0]
  assert.deepEqual(approvedRow, { status: 'approved', reject_reason: null, reviewed_by: FINANCE })

  const sheets = (
    await db.query(`select month::text m from public.attendance_sheets order by month`)
  ).rows.map((row) => row.m)
  assert.deepEqual(sheets, ['2027-02-01', '2027-03-01'], '按月份自动创建考勤表')

  const entries = (
    await db.query(
      `select s.month::text m, e.day, e.morning, e.afternoon, m.name
       from public.attendance_entries e
       join public.attendance_sheets s on s.id = e.sheet_id
       join public.attendance_members m on m.id = e.member_id
       order by s.month, e.day`,
    )
  ).rows
  assert.deepEqual(
    entries.map((row) => [row.m, row.day, row.morning, row.afternoon, row.name]),
    [
      ['2027-02-01', 27, '☆', '☆', '张三'],
      ['2027-02-01', 28, '☆', '☆', '张三'],
      ['2027-03-01', 1, '☆', '☆', '张三'],
      ['2027-03-01', 2, '☆', '☆', '张三'],
    ],
    '请假符号按日期写入对应月份',
  )

  await assert.rejects(
    () => review(FINANCE, crossMonthId, true, null),
    /已审批/,
    '已审批的请假单不能重复审批',
  )

  // ---------- 3. 只写空白格：已有标记不覆盖并计入跳过 ----------
  const halfDayId = await as(SALES, () =>
    createRequest(SALES, {
      leave_type: 'vacation',
      start_date: '2027-02-10',
      end_date: '2027-02-11',
      day_part: 'morning',
    }),
  )
  const febSheet = (
    await db.query(`select id from public.attendance_sheets where month = '2027-02-01'`)
  ).rows[0].id
  const febMember = (
    await db.query(
      `select id from public.attendance_members where sheet_id = '${febSheet}' and profile_id = '${SALES}'`,
    )
  ).rows[0].id
  await db.query(
    `insert into public.attendance_entries (sheet_id, member_id, day, morning, afternoon)
     values ('${febSheet}', '${febMember}', 10, '√', '×')`,
  )

  const halfDay = await review(FINANCE, halfDayId, true, null)
  assert.deepEqual(halfDay.rows[0].result, {
    written_days: 2,
    skipped_cells: 1,
    created_sheets: 0,
  })
  const untouched = (
    await db.query(
      `select morning, afternoon from public.attendance_entries
       where sheet_id = '${febSheet}' and member_id = '${febMember}' and day = 10`,
    )
  ).rows[0]
  assert.deepEqual(untouched, { morning: '√', afternoon: '×' }, '已有标记不被覆盖')
  const writtenHalf = (
    await db.query(
      `select morning, afternoon from public.attendance_entries
       where sheet_id = '${febSheet}' and member_id = '${febMember}' and day = 11`,
    )
  ).rows[0]
  assert.deepEqual(writtenHalf, { morning: '●', afternoon: '' }, '仅上午写入符号')

  // ---------- 4. 非财务/管理员不能调用 ----------
  const guardId = await as(OTHER, () =>
    createRequest(OTHER, {
      leave_type: 'personal',
      start_date: '2027-04-01',
      end_date: '2027-04-01',
      day_part: 'full',
    }),
  )
  await assert.rejects(
    () => review(OTHER, guardId, true, null),
    /仅财务或管理员/,
    '非财务/管理员不能审批',
  )
  assert.equal(
    (
      await db.query(
        `select status from public.leave_requests where id = '${guardId}'`,
      )
    ).rows[0].status,
    'pending',
    '越权审批不改变状态',
  )

  console.log('✓ 0136 请假审批与考勤联动事务演练通过')
}

main().catch((error) => {
  console.error('✗ 0136 演练失败：', error.message)
  process.exit(1)
})
