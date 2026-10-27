begin;

revoke delete on public.finance_journal_entries from public, anon, authenticated;
drop policy if exists finance_journal_entries_delete on public.finance_journal_entries;

create or replace function public.finance_journal_entry_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  account_currency public.currency_code;
  category_kind public.finance_transaction_type;
begin
  if tg_op = 'UPDATE' and old.voided_at is not null then
    raise exception '已作废的日记账分录不能修改';
  end if;
  select currency into account_currency from public.finance_journal_accounts
  where id = new.account_id for share;
  if not found or account_currency is distinct from new.currency then
    raise exception '分录币种必须与银行账户币种一致';
  end if;
  select kind into category_kind from public.finance_journal_categories
  where id = new.category_id for share;
  if not found or category_kind is distinct from new.kind then
    raise exception '分类与收支类型不一致';
  end if;
  return new;
end;
$$;
revoke all on function public.finance_journal_entry_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_journal_entry_guard() to authenticated;

create or replace function public.finance_journal_account_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.currency is distinct from old.currency and exists (
    select 1 from public.finance_journal_entries where account_id = old.id
  ) then
    raise exception '账户已有分录，不能修改币种';
  end if;
  return new;
end;
$$;
revoke all on function public.finance_journal_account_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_journal_account_guard() to authenticated;
drop trigger if exists trg_finance_journal_accounts_guard on public.finance_journal_accounts;
create trigger trg_finance_journal_accounts_guard
  before update on public.finance_journal_accounts
  for each row execute function public.finance_journal_account_guard();

create or replace function public.finance_journal_category_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.kind is distinct from old.kind and exists (
    select 1 from public.finance_journal_entries where category_id = old.id
  ) then
    raise exception '分类已被分录使用，不能修改收支类型';
  end if;
  return new;
end;
$$;
revoke all on function public.finance_journal_category_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_journal_category_guard() to authenticated;
drop trigger if exists trg_finance_journal_categories_guard on public.finance_journal_categories;
create trigger trg_finance_journal_categories_guard
  before update on public.finance_journal_categories
  for each row execute function public.finance_journal_category_guard();

commit;
