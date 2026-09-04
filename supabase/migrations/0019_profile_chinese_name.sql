-- Add a separately managed Chinese display name to user profiles.
-- Only approved administrators and finance users may change this field.

alter table public.profiles
  add column if not exists chinese_name text;

alter table public.profiles
  drop constraint if exists profiles_chinese_name_valid;

alter table public.profiles
  add constraint profiles_chinese_name_valid check (
    chinese_name is null
    or (
      chinese_name = btrim(chinese_name)
      and char_length(chinese_name) between 1 and 50
    )
  );

comment on column public.profiles.chinese_name is
  'Chinese name maintained by approved administrators or finance users.';

-- Existing admin policies must not treat a pending account with role=admin as
-- privileged, otherwise it could approve itself through profiles_update_self.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role::text = 'admin'
      and status::text = 'approved'
  );
$$;

-- Extend the existing privileged-field guard so ordinary users cannot update
-- chinese_name through the broad self-update policy.
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (select auth.uid()) is not null
     and (
       new.role is distinct from old.role
       or new.status is distinct from old.status
     )
     and not public.is_admin()
  then
    raise exception 'Only administrators can change role or status';
  end if;

  if new.chinese_name is distinct from old.chinese_name
     and not public.is_finance_or_admin()
  then
    raise exception 'Only approved finance users or administrators can change Chinese names';
  end if;

  return new;
end;
$$;

create or replace function public.update_profile_chinese_name(
  p_user_id uuid,
  p_chinese_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chinese_name text := nullif(btrim(p_chinese_name), '');
  v_updated_id uuid;
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only approved finance users or administrators can change Chinese names';
  end if;

  if p_user_id is null then
    raise exception 'User ID is required';
  end if;

  if v_chinese_name is not null and char_length(v_chinese_name) > 50 then
    raise exception 'Chinese name cannot exceed 50 characters';
  end if;

  update public.profiles
  set chinese_name = v_chinese_name
  where id = p_user_id
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'User does not exist';
  end if;

  return v_updated_id;
end;
$$;

revoke all on function public.update_profile_chinese_name(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_profile_chinese_name(uuid, text) to authenticated;
