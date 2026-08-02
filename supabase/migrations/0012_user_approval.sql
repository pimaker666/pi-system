-- 0012_user_approval.sql
-- 新用户注册审核：
--  1) 新增 user_status 枚举 ('pending','approved')；
--  2) profiles 增加 status 列，默认 'pending'（新注册用户需管理员审核后才能使用）；
--  3) 仅在首次添加该列时，把所有既有用户回填为 'approved'，避免现有账号（含管理员）被锁在系统外；
--  4) 重建 handle_new_user 触发器，新注册用户显式写入 status='pending'。
-- 幂等：可安全重复执行（重复执行不会误改已在审核中的新用户）。

-- 1) 状态枚举
do $$ begin
  create type user_status as enum ('pending', 'approved');
exception when duplicate_object then null; end $$;

-- 2)+3) 仅当 status 列尚不存在时才新增并回填，保证重复执行时不会把
--        正在等待审核的新用户误标记为已通过。
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'status'
  ) then
    alter table public.profiles
      add column status user_status not null default 'pending';
    -- 回填：迁移前已存在的所有用户视为已审核通过
    update public.profiles set status = 'approved';
  end if;
end $$;

comment on column public.profiles.status is '账号审核状态：pending 待管理员审核 / approved 已通过';

-- 4) 重建注册触发器：新注册用户默认待审核
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'pending'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
