-- 0127_company_pi_currency.sql
-- 公司信息（系统默认 + 个人账户档案）新增开具 PI 币种选项：
-- pi_currency 仅允许 USD / CNY，默认 USD。PI 创建时读取当时生效值并快照到
-- proforma_invoices.currency，因此修改只影响修改后生成的 PI，历史 PI 不变。

begin;

alter table public.company_settings
  add column if not exists pi_currency text not null default 'USD';

alter table public.company_profiles
  add column if not exists pi_currency text not null default 'USD';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'company_settings_pi_currency_check'
  ) then
    alter table public.company_settings
      add constraint company_settings_pi_currency_check check (pi_currency in ('USD', 'CNY'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'company_profiles_pi_currency_check'
  ) then
    alter table public.company_profiles
      add constraint company_profiles_pi_currency_check check (pi_currency in ('USD', 'CNY'));
  end if;
end $$;

commit;
